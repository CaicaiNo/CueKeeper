import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Fault } from '../dist/locator.js';
import {
  SystemChecks, isLiveProcess, parseProcessTable, processMatches, psArgs, psTimeoutMs, runPs,
} from '../dist/system-check.js';

// These tests observe real temporary files and the real /bin/ps table. They
// never start a GUI, focus a window or need any macOS authorization.

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

const table = [
  '  101 S     /Applications/Safari.app/Contents/MacOS/Safari',
  '  102 S+    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '  103 Z     /Applications/Safari.app/Contents/MacOS/Safari',
  '  104 R     node',
].join('\n');

test('the process table keeps a path with spaces whole and excludes zombies', () => {
  const entries = parseProcessTable(table);
  assert.deepEqual(entries[1], {
    pid: 102, state: 'S+', comm: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  assert.equal(isLiveProcess(entries[2]), false);

  // A name is the basename of the visible executable, matched case-sensitively.
  assert.equal(processMatches(entries, { kind: 'process', name: 'Google Chrome' }), true);
  assert.equal(processMatches(entries, { kind: 'process', name: 'Safari' }), true);
  assert.equal(processMatches(entries, { kind: 'process', name: 'safari' }), false);
  assert.equal(processMatches(entries, { kind: 'process', name: 'Chrome' }), false);
  // A path is compared verbatim, with no symlink or prefix equivalence.
  assert.equal(processMatches(entries, {
    kind: 'process', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }), true);
  assert.equal(processMatches(entries, { kind: 'process', path: '/usr/bin/Safari' }), false);
  assert.equal(processMatches(entries, { kind: 'process', name: 'not-running' }), false);
});

test('a zombie never satisfies a running check', async () => {
  const checks = new SystemChecks({ ps: async () => '  7 Z     /usr/bin/zombie' });
  assert.equal(await checks.processRunning({ kind: 'process', name: 'zombie' }), false);
  assert.equal(await checks.processRunning({ kind: 'process', path: '/usr/bin/zombie' }), false);
});

test('unreadable or failed process output is an unknown, not an empty table', async () => {
  const malformed = new SystemChecks({ ps: async () => 'this line is not a ps row' });
  await assert.rejects(malformed.processRunning({ kind: 'process', name: 'Safari' }), error => {
    assert.ok(error instanceof Fault);
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    return true;
  });

  const failed = new SystemChecks({
    ps: async () => {
      throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe failed: timed out after 3000 ms');
    },
  });
  await assert.rejects(failed.processRunning({ kind: 'process', name: 'Safari' }), error => {
    assert.equal(error.code, 'SYSTEM_CHECK_FAILED');
    assert.match(error.message, /timed out/);
    return true;
  });
});

test('a controlled process is seen running and gone once it has exited', async t => {
  const directory = await root(t);
  // A unique executable name that contains a space proves the real ps output
  // keeps the whole basename and the whole path in one comparison.
  const executable = join(directory, 'controlled sleep');
  await copyFile('/bin/sleep', executable);
  await chmod(executable, 0o755);
  const child = spawn(executable, ['30'], { stdio: 'ignore' });
  // Await the spawn result explicitly: a binary this machine refuses to run
  // must fail the test at once, never leave it waiting for an exit event that
  // was never going to fire.
  const spawned = Promise.race([
    new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }),
    timeoutAfter(10_000, 'the controlled process never started'),
  ]);
  const waitExit = () => Promise.race([
    new Promise(resolve => {
      // `exit` may already have fired, so the state check comes first.
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    }),
    timeoutAfter(10_000, 'the controlled process did not exit after SIGKILL'),
  ]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await spawned;
  const checks = new SystemChecks();
  const sees = async (expected, check) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await check() === expected) return true;
      await sleep(50);
    }
    return false;
  };
  assert.equal(await sees(true, () => checks.processRunning({
    kind: 'process', name: 'controlled sleep',
  })), true);
  assert.equal(await checks.processRunning({ kind: 'process', path: executable }), true);
  // Case-sensitive, so a different casing is not the same process.
  assert.equal(await checks.processRunning({ kind: 'process', name: 'Controlled sleep' }), false);

  child.kill('SIGKILL');
  await waitExit();
  // A killed child is reaped by the exit event; the table no longer lists it.
  assert.equal(await sees(false, () => checks.processRunning({
    kind: 'process', name: 'controlled sleep',
  })), true);
  assert.equal(await checks.processRunning({ kind: 'process', path: executable }), false);
});

test('the fixed probe has no user input, a bounded time and reads the real table', async () => {
  // Fixed argv, bounded time: a flow value is never appended to the command.
  assert.deepEqual([...psArgs], ['-axww', '-o', 'pid=', '-o', 'state=', '-o', 'comm=']);
  assert.equal(psTimeoutMs, 3000);

  const entries = parseProcessTable(await runPs());
  const own = entries.find(entry => entry.pid === process.pid);
  assert.ok(own, 'the running test process appears in /bin/ps output');
  // The real table confirms both matching forms from this machine's ps output.
  assert.equal(processMatches(entries, { kind: 'process', name: basename(process.execPath) }), true);
  assert.equal(processMatches(entries, { kind: 'process', path: own.comm }), true);
  assert.equal(processMatches(entries, {
    kind: 'process', name: `no-such-process-${process.pid}`,
  }), false);
});
