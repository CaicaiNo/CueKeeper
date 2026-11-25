import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Fault } from '../dist/locator.js';
import {
  SystemChecks, isLiveState, maxArgCandidates, parsePidTable, psArgs, psTimeoutMs, runPs,
} from '../dist/system-check.js';

// These tests observe real temporary files and real processes. They never start
// a GUI, focus a window or need any macOS authorization. The argv tests build
// the read-only native helper and drive a controlled child process.

/** A bounded wait: unref'd, so a passed test never lingers on its timer. */
function timeoutAfter(ms, message) {
  return sleep(ms, undefined, { ref: false }).then(() => {
    throw new Error(message);
  });
}

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cuekeeper-system-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const process_ = (pid, executable, options = {}) => {
  const startedAt = 'startedAt' in options ? options.startedAt : `1.${pid}`;
  return {
    pid, uid: options.uid ?? 501, executable, live: options.live ?? true,
    ...(startedAt === undefined || startedAt === null ? {} : { startedAt }),
  };
};

function fakeProbe(identities, onArgs = async () => 'unmatched') {
  const calls = [];
  return {
    calls,
    probe: {
      async identities() { return identities; },
      async matchArgs(candidate, args) {
        calls.push({ candidate, args: [...args] });
        return onArgs(candidate, args);
      },
    },
  };
}

test('a file check keeps stat semantics: regular files exist, everything else does not', async t => {
  const directory = await root(t);
  const file = join(directory, 'report.txt');
  await writeFile(file, ''); // zero-byte regular files still exist
  await mkdir(join(directory, 'folder'));
  await symlink(file, join(directory, 'link-file'));
  await symlink(join(directory, 'folder'), join(directory, 'link-dir'));
  const checks = new SystemChecks();

  assert.equal(await checks.fileExists(file), true);
  assert.equal(await checks.fileExists(join(directory, 'folder')), false);
  assert.equal(await checks.fileExists(join(directory, 'missing.txt')), false);
  // A symlink is followed: to a file it exists, to a directory it does not.
  assert.equal(await checks.fileExists(join(directory, 'link-file')), true);
  assert.equal(await checks.fileExists(join(directory, 'link-dir')), false);
});

test('a file probe error stays unknown and never answers false', async () => {
  const denied = new SystemChecks({
    stat: async () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  await assert.rejects(denied.fileExists('/private/secret'), error => {
    assert.ok(error instanceof Fault);
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    assert.match(error.message, /EACCES/);
    return true;
  });

  const missing = new SystemChecks({
    stat: async () => {
      const error = new Error('gone');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(await missing.fileExists('/gone'), false);
  const notDirectory = new SystemChecks({
    stat: async () => {
      const error = new Error('not a directory');
      error.code = 'ENOTDIR';
      throw error;
    },
  });
  assert.equal(await notDirectory.fileExists('/file/child'), false);
});

test('the process table reads kernel pid, uid and state, never comm or args', () => {
  // A state with modifiers and an extra space still parses; comm (which a
  // process can rewrite) is not part of the row at all.
  const rows = parsePidTable([
    '  101   501 S',
    '  102     0 Ss+',
    '  103   501 Z',
    '',
  ].join('\n'));
  assert.deepEqual(rows, [
    { pid: 101, uid: 501, state: 'S' },
    { pid: 102, uid: 0, state: 'Ss+' },
    { pid: 103, uid: 501, state: 'Z' },
  ]);
  assert.equal(isLiveState('Z'), false);
  assert.equal(isLiveState('Z+'), false);
  assert.equal(isLiveState('Ss+'), true);
  assert.throws(() => parsePidTable('this line is not a ps row'), error => {
    assert.ok(error instanceof Fault);
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    return true;
  });
});

test('a name or path matches the real executable path and never a zombie', async () => {
  const { probe } = fakeProbe([
    process_(101, '/Applications/Safari.app/Contents/MacOS/Safari'),
    process_(102, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    process_(103, '/Applications/Safari.app/Contents/MacOS/Safari', { live: false }),
    process_(104, '/usr/bin/node'),
  ]);
  const checks = new SystemChecks({ probe });

  // A name is the basename of the real executable, matched case-sensitively.
  assert.equal(await checks.processRunning({ kind: 'process', name: 'Google Chrome' }), true);
  assert.equal(await checks.processRunning({ kind: 'process', name: 'Safari' }), true);
  assert.equal(await checks.processRunning({ kind: 'process', name: 'safari' }), false);
  assert.equal(await checks.processRunning({ kind: 'process', name: 'Chrome' }), false);
  // A path is compared verbatim, with no symlink or prefix equivalence.
  assert.equal(await checks.processRunning({
    kind: 'process', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }), true);
  assert.equal(await checks.processRunning({ kind: 'process', path: '/usr/bin/Safari' }), false);
  assert.equal(await checks.processRunning({ kind: 'process', name: 'not-running' }), false);

  // A zombie alone never satisfies a check, reverse or forward.
  const zombie = new SystemChecks({
    probe: fakeProbe([process_(9, '/usr/bin/sleep', { live: false })]).probe,
  });
  assert.equal(await zombie.processRunning({ kind: 'process', name: 'sleep' }), false);
  assert.equal(await zombie.processRunning({ kind: 'process', path: '/usr/bin/sleep' }), false);
});

test('arguments are only read for same-uid candidates of that name', async () => {
  const { probe, calls } = fakeProbe([
    process_(201, '/usr/bin/node'),
    process_(202, '/usr/bin/node', { uid: 0 }),
    process_(203, '/usr/bin/other'),
  ]);
  const checks = new SystemChecks({ probe });

  assert.equal(await checks.processRunning({ kind: 'process', name: 'node' }, ['--flag']), false);
  // The other process of another executable and the other UID are not read.
  assert.deepEqual(calls.map(call => call.candidate.pid), [201]);
  assert.deepEqual(calls[0].args, ['--flag']);

  // No same-UID candidate means the answer is a real false, not an unknown.
  calls.length = 0;
  assert.equal(await checks.processRunning({ kind: 'process', name: 'root-only' }, ['x']), false);
  assert.deepEqual(calls, []);
});

test('one proved argument match wins over an unreadable candidate', async () => {
  const statuses = new Map([[301, 'unknown'], [302, 'matched']]);
  const { probe, calls } = fakeProbe([
    process_(301, '/usr/bin/node'),
    process_(302, '/usr/bin/node'),
  ], candidate => statuses.get(candidate.pid));
  const checks = new SystemChecks({ probe });
  assert.equal(await checks.processRunning({ kind: 'process', name: 'node' }, ['--profile', 'a b']), true);
  assert.equal(calls.length, 2);

  // A readable mismatch plus an unreadable candidate is still an unknown.
  const mixed = fakeProbe([
    process_(401, '/usr/bin/node'),
    process_(402, '/usr/bin/node'),
  ], candidate => (candidate.pid === 401 ? 'unmatched' : 'unknown'));
  await assert.rejects(
    new SystemChecks({ probe: mixed.probe }).processRunning({ kind: 'process', name: 'node' }, ['x']),
    error => {
      assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
      return true;
    });
});

test('an unprovable candidate is unknown, never an absent process', async () => {
  const noMarker = fakeProbe([process_(501, '/usr/bin/node', { startedAt: null })]);
  await assert.rejects(
    new SystemChecks({ probe: noMarker.probe }).processRunning({ kind: 'process', name: 'node' }, ['x']),
    error => {
      assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
      return true;
    });

  const allUnknown = fakeProbe([process_(502, '/usr/bin/node')], async () => 'unknown');
  await assert.rejects(
    new SystemChecks({ probe: allUnknown.probe }).processRunning({ kind: 'process', name: 'node' }, ['x']),
    error => {
      assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
      assert.match(error.message, /could not be read/);
      return true;
    });

  // The candidate fan-out is bounded: too many same-name processes is unknown.
  const many = Array.from({ length: maxArgCandidates + 1 }, (_, index) =>
    process_(600 + index, '/usr/bin/node'));
  await assert.rejects(
    new SystemChecks({ probe: fakeProbe(many).probe }).processRunning({ kind: 'process', name: 'node' }, ['x']),
    error => {
      assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
      return true;
    });
});

test('a failed probe becomes an unknown, not an empty process table', async () => {
  const broken = new SystemChecks({
    probe: {
      async identities() {
        throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe failed: timeout');
      },
      async matchArgs() { return 'unknown'; },
    },
  });
  await assert.rejects(broken.processRunning({ kind: 'process', name: 'Safari' }), error => {
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    assert.match(error.message, /timeout/);
    return true;
  });
});

test('the fixed probe has no user input and reads the real process table', async () => {
  assert.deepEqual([...psArgs], ['-axww', '-o', 'pid=', '-o', 'uid=', '-o', 'state=']);
  assert.equal(psTimeoutMs, 3000);

  const rows = parsePidTable(await runPs());
  const own = rows.find(row => row.pid === process.pid);
  assert.ok(own, 'the running test process appears in /bin/ps output');
  assert.equal(own.uid, process.geteuid());
  assert.ok(rows.some(row => row.pid !== process.pid && row.uid !== process.geteuid()),
    'the table is not limited to the current UID');
  // `comm` is not part of the fixed columns at all.
  assert.equal(psArgs.some(column => String(column).includes('comm')), false);
});

test('a live process without a readable executable path stays unknown, never absent', async () => {
  // A readable match still wins, but an unmatched check next to an unnameable
  // live process cannot answer false: the flow may mean that process.
  const mixed = new SystemChecks({
    probe: fakeProbe([
      process_(701, '/usr/bin/node'),
      { pid: 702, uid: 501, live: true },
    ]).probe,
  });
  assert.equal(await mixed.processRunning({ kind: 'process', name: 'node' }), true);

  for (const check of [
    { kind: 'process', name: 'no-such-process' },
    { kind: 'process', path: '/usr/bin/no-such-process' },
  ]) {
    await assert.rejects(mixed.processRunning(check), error => {
      assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
      assert.match(error.message, /no readable executable path/);
      return true;
    }, check.kind);
  }

  // With arguments, a same-UID unnameable process is a possible candidate, so
  // even a reverse check cannot pass; a readable match still proves true.
  const args = new SystemChecks({
    probe: fakeProbe([
      process_(703, '/usr/bin/node'),
      { pid: 704, uid: 501, live: true },
    ], async () => 'unmatched').probe,
  });
  await assert.rejects(args.processRunning({ kind: 'process', name: 'node' }, ['x']), error => {
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    return true;
  });
  const proving = new SystemChecks({
    probe: fakeProbe([
      process_(705, '/usr/bin/node'),
      { pid: 706, uid: 501, live: true },
    ], async () => 'matched').probe,
  });
  assert.equal(await proving.processRunning({ kind: 'process', name: 'node' }, ['x']), true);
});

test('a probe that exits before reading its request is an unknown, never a crash', async t => {
  const directory = await root(t);
  const stub = join(directory, 'early-exit-identity');
  // The identity answer is normal; the argument request is never read.
  await writeFile(stub, `#!/usr/bin/env node
const command = process.argv[2];
if (command === 'process-identities') {
  console.log(JSON.stringify({ ok: true, data: { processes: [{
    pid: ${process.pid}, executable: ${JSON.stringify(process.execPath)}, startedAt: '1.1' }] } }));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  const previous = process.env.CUEKEEPER_APP_IDENTITY;
  process.env.CUEKEEPER_APP_IDENTITY = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_APP_IDENTITY;
    else process.env.CUEKEEPER_APP_IDENTITY = previous;
  });
  // Larger than a pipe buffer, so the write outlives the reader.
  const args = Array.from({ length: 32 }, (_, index) => `${index}`.padEnd(4096, 'x'));
  await assert.rejects(new SystemChecks().processRunning(
    { kind: 'process', name: process.execPath.split('/').at(-1) }, args), error => {
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    assert.match(error.message, /request pipe|could not receive its request/);
    return true;
  });
});

const hasSwiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;

test('the real helper reads executable identity and bounded argv of a controlled child',
  { skip: !hasSwiftc }, async t => {
    const directory = await root(t);
    const helper = join(directory, 'cuekeeper-identity');
    const identitySource = fileURLToPath(new URL('../native/app-identity.swift', import.meta.url));
    let build = spawnSync('swiftc', ['-O', '-parse-as-library', identitySource, '-o', helper], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(build.status, 0, build.stderr);

    // A unique executable name keeps the candidate set to this one child.
    const sleeperSource = join(directory, 'sleeper.swift');
    const executable = join(directory, 'controlled sleeper');
    await writeFile(sleeperSource, 'import Foundation\nThread.sleep(forTimeInterval: 30)\n');
    build = spawnSync('swiftc', ['-O', sleeperSource, '-o', executable], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(build.status, 0, build.stderr);

    // The child names itself something else in argv[0]. `ps comm` would report
    // that lie; the real executable path is the file the system started.
    // The last argument is the decomposed form `e` + U+0301, which Swift string
    // equality would consider equal to U+00E9; the bytes are not equal.
    const decomposed = 'e\u0301';
    const precomposed = '\u00e9';
    const child = spawn('/bin/sh', ['-c',
      `exec -a /not-the-executable/haoc165 ${JSON.stringify(executable)} --profile "a b" ${JSON.stringify(decomposed)}`,
    ], { stdio: 'ignore' });
    await Promise.race([
      new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      }),
      timeoutAfter(10_000, 'the controlled process never started'),
    ]);
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await sleep(300);

    const previous = process.env.CUEKEEPER_APP_IDENTITY;
    process.env.CUEKEEPER_APP_IDENTITY = helper;
    t.after(() => {
      if (previous === undefined) delete process.env.CUEKEEPER_APP_IDENTITY;
      else process.env.CUEKEEPER_APP_IDENTITY = previous;
    });
    const checks = new SystemChecks();

    // Identity comes from the system, so the custom argv[0] matches nothing.
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' }), true);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'haoc165' }), false);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'not-the-executable' }), false);
    // proc_pidpath reports the canonical path; the verbatim compare is exact.
    const canonical = await realpath(executable);
    assert.equal(await checks.processRunning({ kind: 'process', path: canonical }), true);
    assert.equal(await checks.processRunning({
      kind: 'process', path: '/not-the-executable/haoc165',
    }), false);

    // One argument containing a space is not two arguments, order matters, and
    // argv[0] is never part of the comparable run.
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['--profile', 'a b']), true);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['--profile', 'a', 'b']), false);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['a b', '--profile']), false);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['/not-the-executable/haoc165']), false);
    // Arguments compare as UTF-8 bytes: the decomposed value matches only the
    // decomposed literal, and the precomposed value is a different argument.
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      [decomposed]), true);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      [precomposed]), false);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['--profile', 'a b', decomposed]), true);
    assert.equal(await checks.processRunning({ kind: 'process', name: 'controlled sleeper' },
      ['--profile', 'a b', precomposed]), false);

    // The helper's own response carries a status only: neither the expected
    // arguments nor the observed argv travel back to Node.
    const { nativeProcessProbe } = await import('../dist/system-check.js');
    const probe = nativeProcessProbe();
    const childIdentity = (await probe.identities()).find(identity => identity.pid === child.pid);
    assert.ok(childIdentity?.executable, 'the controlled child has a real executable path');
    assert.ok(childIdentity.startedAt, 'the controlled child has a generation marker');
    const reply = spawnSync(helper, ['process-argv'], {
      input: JSON.stringify({
        pid: child.pid, executable: childIdentity.executable,
        startedAt: childIdentity.startedAt, args: ['--profile', 'a b'],
      }),
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(JSON.parse(reply.stdout).data.status, 'matched');
    assert.equal(reply.stdout.includes('a b'), false);
    assert.equal(reply.stdout.includes('--profile'), false);

    // A candidate whose identity is visible but whose argv the system refuses
    // to read (PID 1 belongs to another UID) stays unknown.
    const launchd = (await probe.identities()).find(identity => identity.pid === 1);
    assert.ok(launchd, 'launchd is listed by the fixed process table');
    assert.equal(await probe.matchArgs({
      pid: 1, executable: launchd.executable, startedAt: launchd.startedAt ?? 'unprovable',
    }, ['x']), 'unknown');

    // A running image whose file is gone: the kernel may keep the old name for
    // a while, but the PID is alive either way, so no check may answer false.
    await rm(executable);
    await sleep(300);
    assert.equal(child.exitCode, null, 'the controlled process is still alive without its file');
    const goneImage = (await probe.identities()).find(identity => identity.pid === child.pid);
    assert.ok(goneImage, 'the live PID is kept even without an executable path');

    const verdict = call => call().then(value => ({ value }), error => ({ code: error.code }));
    for (const [label, call] of [
      ['forward name', () => checks.processRunning({ kind: 'process', name: 'controlled sleeper' })],
      ['reverse name', () => checks.processRunning({ kind: 'process', name: 'controlled sleeper' }, ['--profile'])],
      ['path', () => checks.processRunning({ kind: 'process', path: canonical })],
    ]) {
      const answer = await verdict(call);
      assert.ok(answer.value === true || answer.code === 'SYSTEM_CHECK_FAILED',
        `${label} must never read as absent while the PID is alive: ${JSON.stringify(answer)}`);
    }

    // Once the system drops the name, every answer is unknown: forward and
    // reverse alike, by name and by the old path.
    if (goneImage.executable === undefined) {
      for (const [label, call] of [
        ['forward name', () => checks.processRunning({ kind: 'process', name: 'controlled sleeper' })],
        ['reverse name', () => checks.processRunning({ kind: 'process', name: 'controlled sleeper' }, ['--profile'])],
        ['forward path', () => checks.processRunning({ kind: 'process', path: canonical })],
      ]) {
        await assert.rejects(call(), error => {
          assert.equal(error.code, 'SYSTEM_CHECK_FAILED', label);
          return true;
        }, label);
      }
    }
  });
