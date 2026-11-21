import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowCheck, reportCheck } from '../dist/contracts.js';
import { packReport } from '../dist/report.js';
import { blockedShellReport, runFlow } from '../dist/run.js';
import {
  createFileRegistry, createRootPrivilegeRunner, createSudoPrivilegeRunner, disabledPrivilegeRunner,
  interpretPrivilegeOutput, sudoInvocation,
} from '../dist/shell-privilege.js';
import { ShellFault } from '../dist/shell.js';
import { parseFlow, plan } from '../dist/flow.js';
import { fileURLToPath } from 'node:url';

const signal = new AbortController().signal;
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const privilegedPath = '/Library/CueKeeper/privileged/reset-fixture';
const target = { app: 'com.example.Shell', window: 'Fixture' };

function flowOf(steps, extra = {}) {
  return parseFlow({ version: 1, id: 'shell-flow', name: 'Shell', target, steps, ...extra });
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-shell-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeScript(root, name, source) {
  const path = join(root, name);
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

const nodeScript = (root, name, source) =>
  writeScript(root, name, `#!${process.execPath}\n${source}\n`);

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const baseOptions = root => ({
  dryRun: false,
  signal,
  shell: { allowShell: true, allowSudo: false, baseDir: root, captureOutput: true, hostEnv: {} },
});

test('argv passes spaces, quotes, globs and metacharacters literally without a shell', async t => {
  const root = await scratch(t);
  const out = join(root, 'argv.json');
  const script = await nodeScript(root, 'argv.mjs', `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OUT_FILE, JSON.stringify(process.argv.slice(2)));
`);
  const args = ['a b', 'quote"inside', "single'quote", 'dollar$HOME', 'semi;colon', '*', 'glob?', '', '  padded  '];
  const flow = flowOf([{
    id: 'argv', kind: 'shell', argv: [process.execPath, script, ...args],
    env: { OUT_FILE: out }, expectedExitCode: 0,
  }]);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), args);
  const entry = report.entries[0];
  assert.equal(entry.kind, 'shell');
  assert.equal(entry.shell.mode, 'argv');
  assert.equal(entry.shell.privilege, 'user');
  assert.equal(entry.shell.execution, 'finished');
  assert.equal(entry.shell.exitCode, 0);
});

test('an explicit script enables pipes and redirection while cwd defaults to the input directory', async t => {
  const root = await scratch(t);
  const flow = flowOf([{
    id: 'script', kind: 'shell', shell: true,
    command: "pwd > where.txt; printf 'alpha\\nbeta\\n' | tr a-z A-Z > upper.txt; cat upper.txt",
  }]);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.equal((await readFile(join(root, 'where.txt'), 'utf8')).trim(), await realpath(root));
  assert.equal(await readFile(join(root, 'upper.txt'), 'utf8'), 'ALPHA\nBETA\n');
  assert.equal(report.entries[0].shell.mode, 'shell');
});

test('the fixed environment is visible, host credentials are not, and secrets stay out of the report', async t => {
  const root = await scratch(t);
  const out = join(root, 'env.json');
  const script = await nodeScript(root, 'env.mjs', `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OUT_FILE, JSON.stringify({
  cwd: process.cwd(), path: process.env.PATH, fixture: process.env.FIXTURE,
  token: process.env.TOKEN, home: process.env.HOME, lang: process.env.LANG,
  leaked: process.env.CUEKEEPER_SECRET_FIXTURE ?? null,
  ludicrous: process.env.CUEKEEPER_SECRET_UNRELATED ?? null,
}));
`);
  const secret = 'fixture-secret-value-93';
  const flow = flowOf([{
    id: 'env', kind: 'shell', argv: [process.execPath, script],
    env: { OUT_FILE: out, FIXTURE: 'plain fixture', TOKEN: { secretEnv: 'CUEKEEPER_SECRET_FIXTURE' } },
    cwd: '.',
  }]);
  const options = baseOptions(root);
  options.shell.hostEnv = {
    HOME: '/host/home', PATH: '/host/path:/usr/local/bin', LANG: 'zh_CN.UTF-8',
    CUEKEEPER_SECRET_FIXTURE: secret, CUEKEEPER_SECRET_UNRELATED: 'host-only-value',
  };
  const report = await runFlow(flow, undefined, options);
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const observed = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(observed.cwd, await realpath(root));
  assert.equal(observed.path, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(observed.fixture, 'plain fixture');
  assert.equal(observed.token, secret);
  assert.equal(observed.home, '/host/home');
  assert.equal(observed.lang, 'C');
  // The host environment passes only what the step declares.
  assert.equal(observed.leaked, null);
  assert.equal(observed.ludicrous, null);

  // Secret-bearing steps keep metadata only even when capture is requested.
  assert.equal(report.entries[0].shell.stdout.kind, 'omitted');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /fixture-secret-value-93/);
  assert.doesNotMatch(serialized, /plain fixture/);
  assert.doesNotMatch(serialized, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('missing secrets and bad working directories fail before the process starts', async t => {
  const root = await scratch(t);
  const marker = join(root, 'started.txt');
  const script = await writeScript(root, 'mark.sh', `#!/bin/sh\ntouch '${marker}'\n`);
  const missingSecret = flowOf([{
    id: 'secret', kind: 'shell', argv: [script],
    env: { TOKEN: { secretEnv: 'CUEKEEPER_SECRET_MISSING' } },
  }]);
  const report = await runFlow(missingSecret, undefined, baseOptions(root));
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'SHELL_START_FAILED');
  assert.equal(report.entries[0].shell.execution, 'not-run');
  assert.match(report.entries[0].message, /CUEKEEPER_SECRET_MISSING/);
  assert.equal(existsSync(marker), false);

  const badCwd = flowOf([{ id: 'cwd', kind: 'shell', argv: [script], cwd: 'does/not/exist' }]);
  const cwdReport = await runFlow(badCwd, undefined, baseOptions(root));
  assert.equal(cwdReport.entries[0].code, 'SHELL_START_FAILED');
  assert.equal(cwdReport.entries[0].shell.execution, 'not-run');
  assert.equal(existsSync(marker), false);
});

test('a timeout signals the whole group, escalates, and reclaims a TERM-ignoring grandchild', async t => {
  const root = await scratch(t);
  const pidFile = join(root, 'grandchild.pid');
  const script = await writeScript(root, 'hang.sh', `#!/bin/sh
trap '' TERM
( trap '' TERM; sleep 30 ) &
GRAND=$!
echo $GRAND > '${pidFile}'
sleep 30
`);
  const flow = flowOf([{ id: 'hang', kind: 'shell', argv: [script], timeoutMs: 1000 }]);
  const started = Date.now();
  const report = await runFlow(flow, undefined, baseOptions(root));
  const elapsed = Date.now() - started;
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'SHELL_TIMEOUT');
  assert.equal(report.entries[0].shell.execution, 'terminated');
  assert.equal(report.entries[0].shell.cleanup, 'complete');
  assert.equal(await waitFor(() => existsSync(pidFile), 2000), true, 'the grandchild pid was recorded');
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.equal(await waitFor(() => !alive(pid), 2000), true, 'the grandchild should be gone');
  // One second SIGTERM grace plus bounded cleanup, not the full 30 second sleep.
  assert.ok(elapsed < 6000, `timeout took ${elapsed} ms`);
});

test('expected exit codes pass, other exits and self-signals fail with real values', async t => {
  const root = await scratch(t);
  const expected = flowOf([{
    id: 'nonzero', kind: 'shell', shell: true, command: 'exit 3', expectedExitCode: 3,
  }]);
  const ok = await runFlow(expected, undefined, baseOptions(root));
  assert.equal(ok.status, 'passed');
  assert.equal(ok.entries[0].shell.exitCode, 3);

  const unexpected = flowOf([{ id: 'bad', kind: 'shell', shell: true, command: 'exit 4' }]);
  const failed = await runFlow(unexpected, undefined, baseOptions(root));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.entries[0].code, 'SHELL_EXIT');
  assert.equal(failed.entries[0].shell.exitCode, 4);

  const signalled = flowOf([{ id: 'signal', kind: 'shell', shell: true, command: 'kill -TERM $$' }]);
  const signalReport = await runFlow(signalled, undefined, baseOptions(root));
  assert.equal(signalReport.status, 'failed');
  assert.equal(signalReport.entries[0].code, 'SHELL_EXIT');
  assert.equal(signalReport.entries[0].shell.signal, 'SIGTERM');
  assert.equal(signalReport.entries[0].shell.exitCode, undefined);
});

test('cancellation records the terminated step, skips the rest, and leaves no live group', async t => {
  const root = await scratch(t);
  const pidFile = join(root, 'cancel.pid');
  const second = join(root, 'second.txt');
  const script = await writeScript(root, 'cancel.sh', `#!/bin/sh
echo $$ > '${pidFile}'
sleep 30
`);
  const flow = flowOf([
    { id: 'first', kind: 'shell', argv: [script] },
    { id: 'second', kind: 'shell', shell: true, command: `touch '${second}'` },
  ]);
  const cancellation = new AbortController();
  const options = baseOptions(root);
  options.signal = cancellation.signal;
  const running = runFlow(flow, undefined, options);
  assert.equal(await waitFor(() => existsSync(pidFile)), true);
  cancellation.abort(new Error('stop'));
  const report = await running;
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'SHELL_CANCELLED');
  assert.equal(report.entries[0].shell.execution, 'terminated');
  assert.equal(report.entries[0].shell.cleanup, 'complete');
  assert.deepEqual(report.entries.slice(1).map(entry => [entry.id, entry.status]), [['second', 'skipped']]);
  assert.deepEqual(report.entries[1].shell.execution, 'not-run');
  assert.equal(reportCheck.Check(report), true);
  assert.equal(existsSync(second), false, 'no later step runs after cancellation');
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.equal(await waitFor(() => !alive(pid), 2000), true);
});

test('output is bounded per stream, binary streams keep metadata only, and truncation warns', async t => {
  const root = await scratch(t);
  const big = flowOf([{
    id: 'big', kind: 'shell', shell: true,
    command: "printf '%40960s' '' | tr ' ' a; printf '%40960s' '' | tr ' ' b >&2",
  }]);
  const report = await runFlow(big, undefined, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const entry = report.entries[0];
  assert.equal(entry.shell.stdout.kind, 'text');
  assert.equal(entry.shell.stdout.bytes, 40960);
  assert.equal(entry.shell.stdout.truncated, true);
  assert.equal(entry.shell.stdout.text.length, 16384);
  assert.equal(entry.shell.stderr.kind, 'text');
  assert.equal(entry.shell.stderr.bytes, 40960);
  assert.deepEqual(entry.shell.warnings, ['SHELL_OUTPUT_TRUNCATED']);

  const binary = flowOf([{
    id: 'binary', kind: 'shell', shell: true,
    command: "printf '\\000\\001\\377\\376binary'",
  }]);
  const binaryReport = await runFlow(binary, undefined, baseOptions(root));
  assert.equal(binaryReport.entries[0].shell.stdout.kind, 'binary');
  assert.equal(binaryReport.entries[0].shell.stdout.text, undefined);

  // Capture is off by default: the same output carries no text.
  const quiet = baseOptions(root);
  quiet.shell.captureOutput = false;
  const quietReport = await runFlow(big, undefined, quiet);
  assert.equal(quietReport.entries[0].shell.stdout.kind, 'omitted');
  assert.equal(quietReport.entries[0].shell.stdout.text, undefined);
});

test('the whole-run text budget stops publishing text after 1 MiB', async t => {
  const root = await scratch(t);
  const steps = Array.from({ length: 66 }, (_, index) => ({
    id: `chunk-${index}`, kind: 'shell', shell: true,
    command: "printf '%16384s' '' | tr ' ' x",
  }));
  const flow = flowOf(steps);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'passed');
  const kinds = report.entries.map(entry => entry.shell.stdout.kind);
  assert.equal(kinds.slice(0, 64).every(kind => kind === 'text'), true);
  assert.equal(kinds[64], 'omitted');
  assert.equal(kinds[65], 'omitted');
  assert.deepEqual(report.entries[65].shell.warnings, ['SHELL_OUTPUT_TRUNCATED']);
  assert.equal(reportCheck.Check(report), true);
});

test('shell steps keep their expanded order around UI actions', async t => {
  const root = await scratch(t);
  const order = [];
  const mark = async name => { order.push(name); };
  const snapshot = {
    windowId: 'w-1',
    tree: {
      role: 'AXWindow', name: 'Fixture', states: [], secure: false,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      children: [{ role: 'button', name: 'Go', ref: '@s1:e1', states: [], secure: false,
        bounds: { x: 10, y: 10, width: 20, height: 20 }, children: [] }],
    },
  };
  const desktop = {
    snapshot: async () => snapshot,
    property: async () => undefined,
    ensure: async () => undefined,
    click: async () => { await mark('click'); return 'delivered_verified'; },
    type: async () => 'delivered_verified',
    press: async () => 'delivered_verified',
    clickPoint: async () => 'delivered_verified',
    listWindows: async () => [{ id: 'w-1', title: 'Fixture' }],
    screenshot: async () => new Uint8Array(),
  };
  const first = await writeScript(root, 'first.sh', `#!/bin/sh\necho first >> '${join(root, 'order.txt')}'\n`);
  const flow = flowOf([
    { id: 'before', kind: 'shell', argv: [first] },
    { id: 'ui', kind: 'click', target: { kind: 'element', role: 'button', name: 'Go' } },
    { id: 'after', kind: 'shell', shell: true, command: `echo after >> '${join(root, 'order.txt')}'` },
  ]);
  const report = await runFlow(flow, desktop, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(report.entries.map(entry => entry.kind), ['shell', 'click', 'shell']);
  assert.deepEqual((await readFile(join(root, 'order.txt'), 'utf8')).trim().split('\n'), ['first', 'after']);
  assert.deepEqual(order, ['click']);
});

test('a missing shell permission blocks before any process or desktop starts', async t => {
  const root = await scratch(t);
  const marker = join(root, 'blocked.txt');
  const flow = flowOf([
    { id: 'one', kind: 'shell', shell: true, command: `touch '${marker}'` },
    { id: 'two', kind: 'shell', shell: true, command: 'true' },
  ]);
  const options = baseOptions(root);
  options.shell.allowShell = false;
  const report = await runFlow(flow, undefined, options);
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[0].status, 'blocked');
  assert.equal(report.entries[0].code, 'SHELL_NOT_ALLOWED');
  assert.equal(report.entries[0].shell.execution, 'not-run');
  assert.deepEqual(report.entries.slice(1).map(entry => entry.status), ['skipped']);
  assert.equal(existsSync(marker), false);

  const privileged = flowOf([{
    id: 'root-task', kind: 'shell', argv: [privilegedPath], privilege: 'sudo',
  }]);
  const noSudo = baseOptions(root);
  const sudoReport = await runFlow(privileged, undefined, noSudo);
  assert.equal(sudoReport.status, 'blocked');
  assert.equal(sudoReport.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.equal(sudoReport.entries[0].shell.privilege, 'sudo');

  // allow-sudo passes the gate, but privileged execution stays disabled.
  const allowed = baseOptions(root);
  allowed.shell.allowSudo = true;
  allowed.shell.privilege = disabledPrivilegeRunner;
  const disabled = await runFlow(privileged, undefined, allowed);
  assert.equal(disabled.status, 'blocked');
  assert.equal(disabled.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');

  const direct = blockedShellReport(flow, plan(flow),
    { code: 'SHELL_NOT_ALLOWED', stepId: 'one' });
  assert.equal(reportCheck.Check(direct), true);
});

test('dry-run previews shell steps without secrets, processes or working-directory checks', async t => {
  const root = await scratch(t);
  const marker = join(root, 'dry.txt');
  const flow = flowOf([
    { id: 'missing-secret', kind: 'shell', shell: true, command: `touch '${marker}'`, cwd: 'missing',
      env: { TOKEN: { secretEnv: 'CUEKEEPER_SECRET_ABSENT' } }, timeoutMs: 5000 },
    { id: 'plain', kind: 'shell', argv: ['/bin/echo', 'hello'] },
  ]);
  const options = baseOptions(root);
  options.dryRun = true;
  options.shell.captureOutput = true;
  const report = await runFlow(flow, undefined, options);
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(entry => [entry.status, entry.shell.execution]),
    [['resolved', 'preview'], ['resolved', 'preview']]);
  assert.deepEqual(report.entries.map(entry => [entry.shell.mode, entry.shell.privilege]),
    [['shell', 'user'], ['argv', 'user']]);
  assert.equal(existsSync(marker), false);
  assert.equal(reportCheck.Check(report), true);
});

function sudoFlow(exitCode = 0) {
  return flowOf([{
    id: 'root-task', kind: 'shell', argv: [privilegedPath], privilege: 'sudo',
    expectedExitCode: exitCode,
  }]);
}

test('the injected sudo adapter covers authorization and failure branches without running sudo', async t => {
  const root = await scratch(t);
  const calls = [];
  const mock = result => ({
    async preflight(path) { calls.push(['preflight', path]); return { taskId: 'reset-fixture' }; },
    async run(request) { calls.push(['run', request]); return typeof result === 'function' ? result() : result; },
  });
  const options = runner => ({ ...baseOptions(root), shell: { ...baseOptions(root).shell, allowSudo: true, privilege: runner } });

  const passed = await runFlow(sudoFlow(), undefined, options(mock({ started: true, state: 'finished', exitCode: 0 })));
  assert.equal(passed.status, 'passed');
  assert.equal(passed.entries[0].shell.privilege, 'sudo');
  assert.equal(passed.entries[0].shell.execution, 'finished');
  assert.equal(passed.entries[0].shell.exitCode, 0);
  assert.deepEqual(calls, [['preflight', privilegedPath], ['run', { taskId: 'reset-fixture', path: privilegedPath }]]);

  calls.length = 0;
  const refused = await runFlow(sudoFlow(), undefined, options(mock({ started: false, state: 'failed' })));
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');

  const startFailed = await runFlow(sudoFlow(), undefined, options(mock({ started: false, state: 'failed', startFailed: true })));
  assert.equal(startFailed.status, 'failed');
  assert.equal(startFailed.entries[0].code, 'SHELL_START_FAILED');

  const protocol = await runFlow(sudoFlow(), undefined, options(mock({ started: true, state: 'failed' })));
  assert.equal(protocol.status, 'failed');
  assert.equal(protocol.entries[0].code, 'SHELL_START_FAILED');
  assert.equal(protocol.entries[0].shell.execution, 'unknown');
  assert.equal(protocol.entries[0].shell.cleanup, 'unknown');

  const realExit = await runFlow(sudoFlow(), undefined, options(mock({ started: true, state: 'finished', exitCode: 1 })));
  assert.equal(realExit.status, 'failed');
  assert.equal(realExit.entries[0].code, 'SHELL_EXIT');
  assert.equal(realExit.entries[0].shell.exitCode, 1);
  assert.match(realExit.entries[0].message, /1 instead of 0/);

  const timedOut = await runFlow(sudoFlow(), undefined, options(mock({ started: true, state: 'terminated', timedOut: true, cleanup: 'unknown' })));
  assert.equal(timedOut.entries[0].code, 'SHELL_TIMEOUT');
  assert.equal(timedOut.entries[0].shell.execution, 'terminated');
  assert.equal(timedOut.entries[0].shell.cleanup, 'unknown');

  const cancelled = await runFlow(sudoFlow(), undefined, options(mock({ started: true, state: 'terminated', cancelled: true, cleanup: 'complete' })));
  assert.equal(cancelled.entries[0].code, 'SHELL_CANCELLED');

  const unregistered = {
    async preflight() { throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task is not registered'); },
    async run() { throw new Error('must not run'); },
  };
  const blocked = await runFlow(sudoFlow(), undefined, options(unregistered));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');
});

test('the fixed task invocation is exact and its records fail closed', () => {
  assert.deepEqual(sudoInvocation(privilegedPath), {
    program: '/usr/bin/sudo',
    args: ['-n', '-k', '-u', 'root', '--', privilegedPath],
    cwd: '/',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
  });
  const start = JSON.stringify({ record: 'start', task: 'reset-fixture' });
  const finish = JSON.stringify({ record: 'finish', task: 'reset-fixture', state: 'finished', exitCode: 1 });
  assert.deepEqual(interpretPrivilegeOutput(`${start}\n${finish}\n`, 'reset-fixture'),
    { started: true, state: 'finished', exitCode: 1 });
  assert.equal(interpretPrivilegeOutput('', 'reset-fixture').started, false);
  assert.match(interpretPrivilegeOutput(`${start}\nnot-json\n`, 'reset-fixture').error, /Malformed/);
  assert.match(interpretPrivilegeOutput(`${start}\n${JSON.stringify({ record: 'finish', task: 'reset-fixture', state: 'finished' })}\n`, 'reset-fixture').error, /exit code/);
  assert.match(interpretPrivilegeOutput(`${start}\n${finish}\n${finish}\n`, 'reset-fixture').error, /Unexpected/);
  assert.match(interpretPrivilegeOutput(`${JSON.stringify({ record: 'start', task: 'other' })}\n`, 'reset-fixture').error, /another task/);
});

test('the registry preflight rejects missing, unregistered, linked and writable tasks', async t => {
  const root = await scratch(t);
  const rootDir = join(root, 'privileged');
  await mkdir(rootDir);
  const tasks = {
    'reset-fixture': join(rootDir, 'reset-fixture'),
    'link-task': join(rootDir, 'link-task'),
  };
  await writeFile(tasks['reset-fixture'], '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(rootDir, 'registry.json'), JSON.stringify({
    version: 1,
    tasks: {
      'reset-fixture': { path: '/Library/CueKeeper/privileged/reset-fixture' },
    },
  }), { mode: 0o600 });
  const local = path => `/Library/CueKeeper/privileged/${path}`;

  // A symlinked executable is rejected even when registered.
  await symlink(tasks['reset-fixture'], tasks['link-task']);
  await writeFile(join(rootDir, 'registry.json'), JSON.stringify({
    version: 1,
    tasks: {
      'reset-fixture': { path: '/Library/CueKeeper/privileged/reset-fixture' },
      'link-task': { path: '/Library/CueKeeper/privileged/link-task' },
    },
  }), { mode: 0o600 });
  const fileRegistry = createFileRegistry({ root: rootDir, ownerUid: process.getuid() });
  // A task that is not listed in the registry is rejected.
  await assert.rejects(fileRegistry.lookup(local('unknown-task')), /not registered/);
  assert.equal((await fileRegistry.lookup(privilegedPath)).taskId, 'reset-fixture');
  await assert.rejects(fileRegistry.lookup(local('link-task')), /symbolic link/);

  // Group-writable tasks are rejected.
  await chmod(tasks['reset-fixture'], 0o770);
  await assert.rejects(fileRegistry.lookup(privilegedPath), /writable/);
  await chmod(tasks['reset-fixture'], 0o700);

  // A sudo runner reports a missing binary as a start failure, not a refusal.
  const runner = createSudoPrivilegeRunner({
    registry: { lookup: async () => ({ taskId: 'reset-fixture' }) },
    spawn: () => { throw new Error('missing sudo'); },
  });
  assert.deepEqual((await runner.run({ taskId: 'reset-fixture', path: privilegedPath }, signal)),
    { started: false, state: 'failed', startFailed: true });
});

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const baseFlow = overrides => ({
  version: 1, id: 'schema-flow', name: 'Schema', target, steps: [{ id: 'one', kind: 'shell', ...overrides }],
});

test('the generated schemas accept the new shell forms and keep old documents valid', async t => {
  const argvFlow = baseFlow({ argv: ['/bin/echo', 'hi'] });
  const scriptFlow = baseFlow({ shell: true, command: 'echo hi' });
  const sudoFlowShape = baseFlow({ argv: [privilegedPath], privilege: 'sudo', expectedExitCode: 1 });
  for (const flow of [argvFlow, scriptFlow, sudoFlowShape]) {
    assert.equal(flowCheck.Check(flow), true, JSON.stringify(flow));
  }
  assert.equal((await flowCheck.Check(await example('textedit.flow'))), true);
  assert.equal(reportCheck.Check(await example('textedit.report')), true);

  const behaviorFlow = {
    version: 1, id: 'behavior-shell', name: 'Behavior shell', target,
    behaviors: [{ id: 'cleanup', name: 'Cleanup', steps: [{ id: 'wipe', kind: 'shell', argv: ['/bin/rm', '-f', 'x'] }] }],
    steps: [{ id: 'call', kind: 'behavior', behavior: 'cleanup' }],
  };
  assert.equal(flowCheck.Check(behaviorFlow), true);
  const behavior = {
    version: 1, id: 'cleanup', name: 'Cleanup',
    steps: [{ id: 'wipe', kind: 'shell', shell: true, command: 'rm -f x' }],
  };
  const { TypeCompiler } = await import('@sinclair/typebox/compiler');
  const { schemas } = await import('../dist/contracts.js');
  assert.equal(TypeCompiler.Compile(schemas.behavior).Check(behavior), true);
  const { version: _version, ...embedded } = behavior;
  assert.equal(flowCheck.Check({ ...behaviorFlow, behaviors: [embedded] }), true);

  const invalid = [
    baseFlow({ argv: ['/bin/echo'], command: 'echo hi', shell: true }),
    baseFlow({ command: 'echo hi' }),
    baseFlow({ argv: ['/bin/echo'], shell: true }),
    baseFlow({ argv: ['/bin/echo'], extra: true }),
    baseFlow({ argv: ['/bin/echo'], shell: false, command: 'echo' }),
    baseFlow({ argv: ['/bin/echo'], env: { HOME: '/tmp' } }),
    baseFlow({ argv: ['/bin/echo'], env: { PATH: '/tmp' } }),
    baseFlow({ argv: ['/bin/echo'], env: { SUDO_USER: 'root' } }),
    baseFlow({ argv: ['/bin/echo'], env: { DYLD_INSERT_LIBRARIES: '/tmp/x' } }),
    baseFlow({ argv: ['/bin/echo'], env: { LD_PRELOAD: '/tmp/x' } }),
    baseFlow({ argv: ['/bin/echo'], env: { CUEKEEPER_HOME: '/tmp' } }),
    baseFlow({ argv: ['/bin/echo'], env: { NODE_OPTIONS: '--x' } }),
    baseFlow({ argv: ['/bin/echo'], env: { 'bad-key': 'x' } }),
    baseFlow({ argv: ['/bin/echo'], env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, 'x'])) }),
    baseFlow({ argv: ['Library/CueKeeper/privileged/task'], privilege: 'sudo' }),
    baseFlow({ argv: [privilegedPath, 'extra'], privilege: 'sudo' }),
    baseFlow({ argv: [privilegedPath], privilege: 'sudo', cwd: '/' }),
    baseFlow({ argv: [privilegedPath], privilege: 'sudo', env: { FIXTURE: 'x' } }),
    baseFlow({ argv: [privilegedPath], privilege: 'sudo', timeoutMs: 1000 }),
    baseFlow({ argv: [privilegedPath], privilege: 'sudo', shell: true, command: 'true' }),
    baseFlow({ argv: ['/bin/echo'], timeoutMs: 0 }),
    baseFlow({ argv: ['/bin/echo'], timeoutMs: 120001 }),
    baseFlow({ argv: ['/bin/echo'], expectedExitCode: 256 }),
    baseFlow({ argv: ['/bin/echo'], expectedExitCode: -1 }),
    baseFlow({ argv: Array.from({ length: 66 }, (_, i) => `arg-${i}`) }),
  ];
  for (const [index, flow] of invalid.entries()) {
    assert.equal(flowCheck.Check(flow), false, `invalid case ${index} was accepted`);
  }
  // The schema allows an empty program slot; parseFlow still rejects it.
  assert.throws(() => parseFlow(baseFlow({ argv: [''] })), /must not be empty/);
});

test('the report schema accepts shell results and refuses contradictory ones', () => {
  const entry = shell => ({
    id: 'step', kind: 'shell', status: 'passed', atMs: 0, durationMs: 1, shell,
  });
  const report = entries => ({
    version: 1, flowId: 'schema-flow', flowSha256: 'a'.repeat(64),
    startedAt: '2026-11-21T00:00:00.000Z', mode: 'replay', status: 'passed', entries,
  });
  const preview = { mode: 'argv', privilege: 'user', execution: 'preview' };
  const finished = {
    mode: 'argv', privilege: 'user', execution: 'finished', exitCode: 0,
    stdout: { kind: 'text', bytes: 2, truncated: false, text: 'ok' },
    stderr: { kind: 'binary', bytes: 3, truncated: true },
    warnings: ['SHELL_OUTPUT_TRUNCATED'],
  };
  const terminated = {
    mode: 'argv', privilege: 'sudo', execution: 'terminated', cleanup: 'unknown',
  };
  const signalled = { mode: 'shell', privilege: 'user', execution: 'finished', signal: 'SIGTERM' };
  const unknown = { mode: 'argv', privilege: 'sudo', execution: 'unknown', cleanup: 'complete' };
  for (const value of [preview, finished, terminated, signalled, unknown]) {
    assert.equal(reportCheck.Check(report([entry(value)])), true, JSON.stringify(value));
  }

  const invalid = [
    { ...preview, exitCode: 0 },
    { ...finished, signal: 'SIGTERM' },
    { ...finished, warnings: ['OTHER'] },
    { ...finished, stdout: { kind: 'text', bytes: 0, truncated: false } },
    { ...finished, stdout: { kind: 'omitted', bytes: 0, truncated: false, text: 'x' } },
    { ...finished, exitCode: 300 },
    { ...preview, cleanup: 'complete' },
  ];
  for (const value of invalid) {
    assert.equal(reportCheck.Check(report([entry(value)])), false, JSON.stringify(value));
  }
  const withDelivery = { ...entry(preview), delivery: 'delivered_verified' };
  assert.equal(reportCheck.Check(report([withDelivery])), false);
  assert.equal(reportCheck.Check(report([{ id: 'step', kind: 'shell', status: 'preview', atMs: 0, durationMs: 0 }])), false);
});

test('report packing refuses shell definitions, including behaviors the flow never calls', async t => {
  const root = await scratch(t);
  const flow = await example('textedit.flow');
  const report = await example('textedit.report');
  assert.ok(packReport(report, flow).length > 0);

  const direct = flowOf([{ id: 'one', kind: 'shell', argv: ['/bin/true'] }]);
  assert.throws(() => packReport({ ...report, flowId: direct.id, flowSha256: 'a'.repeat(64) }, direct),
    /shell steps/);

  const uncalled = parseFlow({
    version: 1, id: 'uncalled', name: 'Uncalled', target,
    behaviors: [{ id: 'later', name: 'Later', steps: [{ id: 'task', kind: 'shell', argv: ['/bin/true'] }] }],
    steps: [{ id: 'only', kind: 'key', key: 'tab' }],
  });
  assert.throws(() => packReport({ ...report, flowId: 'uncalled', flowSha256: 'a'.repeat(64) }, uncalled),
    /shell steps/);
  assert.equal(root.length > 0, true);
});

test('the CLI gates live shell runs, previews dry-runs and refuses to pack shell flows', async t => {
  const root = await scratch(t);
  const marker = join(root, 'ran.txt');
  const flowPath = join(root, 'flow.json');
  const flow = {
    version: 1, id: 'cli-shell', name: 'CLI shell', target,
    steps: [
      { id: 'touch', kind: 'shell', shell: true, command: `touch '${marker}'` },
      { id: 'ask', kind: 'shell', argv: [`${privilegedPath}`], privilege: 'sudo' },
    ],
  };
  await writeFile(flowPath, JSON.stringify(flow));
  const run = (...args) => spawnSync(process.execPath, [cliPath, 'run', flowPath, ...args, '--json'], { encoding: 'utf8' });

  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  const dryReport = JSON.parse(dry.stdout).data;
  assert.deepEqual(dryReport.entries.map(entry => [entry.status, entry.shell.execution]),
    [['resolved', 'preview'], ['resolved', 'preview']]);
  assert.equal(existsSync(marker), false);

  const blocked = run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  const blockedReport = JSON.parse(blocked.stdout).data;
  assert.equal(blockedReport.status, 'blocked');
  assert.equal(blockedReport.entries[0].code, 'SHELL_NOT_ALLOWED');
  assert.equal(existsSync(marker), false);

  // Missing sudo authorization blocks the whole plan before the user step runs.
  const partial = run('--allow-shell');
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  const partialReport = JSON.parse(partial.stdout).data;
  assert.equal(partialReport.entries[0].status, 'skipped');
  assert.equal(partialReport.entries[1].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.equal(existsSync(marker), false);

  // With both flags the user step runs, then privileged execution stays disabled.
  const reportPath = join(root, 'report.json');
  const allowed = run('--allow-shell', '--allow-sudo', '--report', reportPath);
  assert.equal(allowed.status, 1, allowed.stdout + allowed.stderr);
  assert.equal(existsSync(marker), true);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.entries[0].status, 'passed');
  assert.equal(report.entries[1].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.equal(report.status, 'blocked');
  assert.equal(reportCheck.Check(report), true);

  const pack = spawnSync(process.execPath, [cliPath, 'report', 'pack', reportPath,
    '--flow', flowPath, '--out', join(root, 'report.zip'), '--json'], { encoding: 'utf8' });
  assert.equal(pack.status, 2, pack.stdout + pack.stderr);
  assert.match(JSON.parse(pack.stdout).error.message, /shell steps/);
  assert.equal(existsSync(join(root, 'report.zip')), false);
});

test('shell steps defined inside behaviors expand and run in order', async t => {
  const root = await scratch(t);
  const log = join(root, 'behavior.txt');
  const flow = parseFlow({
    version: 1, id: 'behavior-shell', name: 'Behavior shell', target,
    behaviors: [{
      id: 'cleanup', name: 'Cleanup',
      steps: [
        { id: 'wipe', kind: 'shell', shell: true, command: `echo wipe >> '${log}'` },
        { id: 'report', kind: 'shell', argv: ['/bin/sh', '-c', `echo report >> '${log}'`] },
      ],
    }],
    steps: [
      { id: 'call', kind: 'behavior', behavior: 'cleanup' },
      { id: 'tail', kind: 'shell', shell: true, command: `echo tail >> '${log}'` },
    ],
  });
  assert.equal(reachableCount(flow), 3);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['wipe', 'report', 'tail']);
  assert.deepEqual(report.entries.map(entry => entry.id), ['call/wipe', 'call/report', 'tail']);

  const unallowed = baseOptions(root);
  unallowed.shell.allowShell = false;
  await rm(log, { force: true });
  const blocked = await runFlow(flow, undefined, unallowed);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.entries[0].code, 'SHELL_NOT_ALLOWED');
  assert.equal(existsSync(log), false);
});

function reachableCount(flow) {
  let count = 0;
  for (const step of plan(flow)) if (step.action.kind === 'shell') count++;
  return count;
}

test('output strips ANSI and control characters, and reports never include paths or arguments', async t => {
  const root = await scratch(t);
  const marker = 'unique-argv-marker-77';
  const flow = flowOf([{
    id: 'ansi', kind: 'shell', argv: ['/bin/sh', '-c',
      "printf '\\033[31mred\\033[0m\\001 done'", marker],
  }]);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.equal(report.entries[0].shell.stdout.text, 'red done');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, new RegExp(marker));
});

test('arguments and environment above 64 KiB fail before spawn', async t => {
  const root = await scratch(t);
  const flow = flowOf([{
    id: 'huge', kind: 'shell', shell: true, command: 'true',
    env: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`BIG_${index}`, 'x'.repeat(4000)])),
  }]);
  const report = await runFlow(flow, undefined, baseOptions(root));
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'SHELL_START_FAILED');
  assert.match(report.entries[0].message, /64 KiB/);
});

test('a blocked mixed flow never initializes the desktop adapter', async t => {
  const root = await scratch(t);
  const flowPath = join(root, 'mixed.json');
  await writeFile(flowPath, JSON.stringify({
    version: 1, id: 'mixed', name: 'Mixed',
    target: { app: 'com.example.ThisAppDoesNotExist', window: 'Missing' },
    steps: [
      { id: 'click-first', kind: 'click', target: { kind: 'element', role: 'button', name: 'Go' } },
      { id: 'shell-later', kind: 'shell', shell: true, command: 'true' },
    ],
  }));
  // Without --allow-shell the gate wins; desktop start-up would exit 2 instead.
  const cli = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.data.status, 'blocked');
  assert.equal(payload.data.entries[1].code, 'SHELL_NOT_ALLOWED');
  assert.equal(payload.data.entries[0].status, 'skipped');
});

test('SIGINT cancels a running shell step, writes the report, and exits 130', async t => {
  const root = await scratch(t);
  const pidFile = join(root, 'sigint.pid');
  const after = join(root, 'after.txt');
  const flowPath = join(root, 'flow.json');
  const reportPath = join(root, 'report.json');
  await writeFile(flowPath, JSON.stringify({
    version: 1, id: 'sigint', name: 'SIGINT', target,
    steps: [
      { id: 'slow', kind: 'shell', shell: true,
        command: `echo $$ > '${pidFile}'; sleep 30` },
      { id: 'after', kind: 'shell', shell: true, command: `touch '${after}'` },
    ],
  }));
  const child = spawn(process.execPath, [cliPath, 'run', flowPath, '--allow-shell',
    '--report', reportPath, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => output.push(chunk));
  assert.equal(await waitFor(() => existsSync(pidFile), 5000), true);
  child.kill('SIGINT');
  const code = await new Promise(resolve => child.once('exit', (value, signal) => resolve(value ?? signal)));
  assert.equal(code, 130, Buffer.concat(output).toString());
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.entries[0].code, 'SHELL_CANCELLED');
  assert.equal(report.entries[0].shell.execution, 'terminated');
  assert.equal(report.entries[0].shell.cleanup, 'complete');
  assert.equal(report.entries[1].status, 'skipped');
  assert.equal(report.status, 'failed');
  assert.equal(existsSync(after), false);
});

// --- Interactive root steps -------------------------------------------------

/**
 * A stand-in for the sudo front-end. It implements only the shapes CueKeeper
 * uses: `-A -k -v` (authenticate), `-A -u root -- cmd` (prompted command),
 * `-n -l -- cmd` (sudoers policy check) and `-n -k -u root -- cmd`. The
 * password lives in the test fixture config so the `ask` log can record only
 * whether it was accepted, never the value.
 */
function fakeSudo(configPath) {
  return `
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify({
  args, cwd: process.cwd(), env: Object.keys(process.env).sort(),
  askpass: process.env.SUDO_ASKPASS ?? null,
}) + '\\n');
function ask() {
  const child = spawnSync(process.env.SUDO_ASKPASS ?? '/usr/bin/false', [], { encoding: 'utf8' });
  const answer = (child.stdout ?? '').replace(/\\n$/, '');
  appendFileSync(config.log, JSON.stringify({
    ask: true, exit: child.status, accepted: answer === config.password,
  }) + '\\n');
  return { exit: child.status, answer };
}
if (args.includes('-l')) process.exit(config.sudoersAllows ? 0 : 1);
if (args.includes('-v')) {
  if (ask().answer === config.password) process.exit(0);
  ask();
  process.exit(1);
}
const dashdash = args.indexOf('--');
const command = args.slice(dashdash + 1);
if (args.includes('-n')) {
  if (!config.sudoersAllows) process.exit(1);
} else if (config.askOnCommand) {
  if (ask().answer !== config.password) { ask(); process.exit(1); }
}
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? (result.signal ? 128 : 1));
`;
}

async function rootFixture(t, options = {}) {
  const root = await scratch(t);
  const directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    log: join(root, 'sudo.log'),
    password: options.password ?? 'test-password-42',
    sudoersAllows: options.sudoersAllows ?? true,
    askOnCommand: options.askOnCommand ?? false,
  }));
  const sudo = join(root, 'fake-sudo.mjs');
  await writeFile(sudo, `#!${process.execPath}\n${fakeSudo(configPath)}`, { mode: 0o700 });
  await chmod(sudo, 0o700);
  const prompt = join(root, 'prompt.sh');
  const answer = options.answer ?? 'ok:test-password-42';
  await writeFile(prompt, answer === '' ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`,
    { mode: 0o700 });
  await chmod(prompt, 0o700);
  const runner = createRootPrivilegeRunner({
    sudoPath: sudo, prompt, platform: options.platform ?? 'darwin',
    allowSudoers: options.allowSudoers ?? true, promptTimeoutMs: 5000,
  });
  const log = join(root, 'sudo.log');
  const calls = async () => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { root, directory, runner, calls, sudo, prompt };
}

const rootRequest = (root, directory, extra = {}) => ({
  program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root,
  mode: 'prompt', timeoutMs: 5000, directory, ...extra,
});

test('the askpass dialog authenticates once, runs exact argv, and never stores the password', async t => {
  const { root, directory, runner, calls } = await rootFixture(t);
  const marker = join(root, 'root-ran.json');
  const script = await nodeScript(root, 'root.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ROOT_MARKER ?? ${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
  const result = await runner.runRoot(rootRequest(root, directory, {
    program: process.execPath, args: [script, 'a b', '--flag'], timeoutMs: 10_000,
  }), signal);
  assert.equal(result.state, 'finished', JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  const written = JSON.parse(await readFile(marker, 'utf8'));
  assert.deepEqual(written.argv, ['a b', '--flag']);
  assert.equal(written.cwd, await realpath(root));

  const all = await calls();
  const entries = all.filter(entry => !entry.ask);
  assert.deepEqual(entries[0].args, ['-A', '-k', '-v']);
  assert.deepEqual(entries[1].args, ['-A', '-u', 'root', '--', process.execPath, script, 'a b', '--flag']);
  assert.equal(entries[1].cwd, await realpath(root));
  assert.equal(entries[1].askpass.endsWith('-run.sh'), true);
  assert.deepEqual(all.filter(entry => entry.ask).map(entry => entry.accepted), [true]);

  // The password never reaches argv, the environment, the status files or the
  // report: the askpass pipe is its only path.
  const password = 'test-password-42';
  assert.doesNotMatch(JSON.stringify(entries), new RegExp(password));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
  for (const name of await readdir(directory)) {
    const content = await readFile(join(directory, name), 'utf8');
    assert.doesNotMatch(content, new RegExp(password), `${name} leaked the password`);
  }
  // The cached ticket covers the command, so only the auth prompt ran.
  const statuses = (await readdir(directory)).filter(name => name.endsWith('.status'));
  assert.deepEqual(statuses.map(name => name.endsWith('-auth.status')), [true]);
  assert.equal((await readFile(join(directory, statuses[0]), 'utf8')).trim(), 'provided');
  // The generated askpass helpers are valid POSIX sh and contain no password.
  const helpers = (await readdir(directory)).filter(name => name.endsWith('.sh'));
  assert.equal(helpers.length, 2);
  for (const name of helpers) {
    const check = spawnSync('/bin/sh', ['-n', join(directory, name)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${name}: ${check.stderr}`);
    const source = await readFile(join(directory, name), 'utf8');
    assert.match(source, /printf '%s\\n' "\$\{out#ok:\}"/);
    assert.doesNotMatch(source, /test-password-42/);
  }
});

test('a cancelled or timed-out dialog blocks the root step before any command runs', async t => {
  for (const [answer, outcome] of [['cancelled', 'cancelled'], ['timeout', 'timeout']]) {
    const { root, directory, runner, calls } = await rootFixture(t, { answer });
    const marker = join(root, `marker-${outcome}`);
    const result = await runner.runRoot(rootRequest(root, directory, {
      program: '/usr/bin/touch', args: [marker],
    }), signal);
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.equal(result.authentication, outcome);
    assert.equal(existsSync(marker), false);
    assert.deepEqual((await calls()).filter(entry => !entry.ask).map(entry => entry.args), [['-A', '-k', '-v']]);
  }
});

test('a rejected password is reported as SHELL_PRIVILEGE_REQUIRED and never retried into a command', async t => {
  const { root, directory, runner, calls } = await rootFixture(t, { answer: 'ok:wrong-password' });
  const marker = join(root, 'never');
  const result = await runner.runRoot(rootRequest(root, directory, {
    program: '/usr/bin/touch', args: [marker],
  }), signal);
  assert.equal(result.authentication, 'rejected');
  assert.equal(existsSync(marker), false);
  const entries = await calls();
  assert.deepEqual(entries.filter(entry => entry.ask).map(entry => entry.accepted), [false, false]);
  assert.equal((await readFile(join(directory, (await readdir(directory)).find(n => n.endsWith('-auth.status'))), 'utf8'))
    .trim().split('\n').join(','), 'provided,retry');
});

test('a missing graphical session and a non-macOS host fail with a clear privilege error', async t => {
  const { root, directory, runner } = await rootFixture(t, { answer: '' });
  const missing = await runner.runRoot(rootRequest(root, directory), signal);
  assert.equal(missing.authentication, 'unavailable');

  const linux = createRootPrivilegeRunner({ platform: 'linux', sudoPath: '/usr/bin/sudo', prompt: '/bin/echo' });
  await assert.rejects(linux.preflightRoot({ program: '/usr/bin/true', args: [], cwd: root, mode: 'prompt' }),
    error => error.code === 'SHELL_PRIVILEGE_UNAVAILABLE' && /only available on macOS/.test(error.message));
});

test('a second password prompt keeps the command exit code instead of reporting a rejection', async t => {
  const { root, directory, runner, calls } = await rootFixture(t, { askOnCommand: true });
  const result = await runner.runRoot(rootRequest(root, directory, {
    program: process.execPath, args: ['-e', 'process.exit(5)'], timeoutMs: 10_000,
  }), signal);
  assert.equal(result.state, 'finished', JSON.stringify(result));
  assert.equal(result.exitCode, 5);
  assert.equal(result.authentication, undefined);
  assert.deepEqual((await calls()).filter(entry => entry.ask).map(entry => entry.accepted), [true, true]);
});

test('sudoers mode runs without a dialog and refuses an unauthorized command', async t => {
  const { root, directory, runner, calls } = await rootFixture(t);
  const ok = await runner.runRoot(rootRequest(root, directory, {
    program: process.execPath, args: ['-e', 'process.exit(3)'], mode: 'sudoers',
  }), signal);
  assert.equal(ok.state, 'finished');
  assert.equal(ok.exitCode, 3);
  assert.deepEqual((await calls()).map(entry => entry.args),
    [['-n', '-k', '-u', 'root', '--', process.execPath, '-e', 'process.exit(3)']]);

  const denied = await rootFixture(t, { sudoersAllows: false });
  await assert.rejects(denied.runner.preflightRoot({
    program: '/usr/bin/true', args: [], cwd: denied.root, mode: 'sudoers',
  }), error => error.code === 'SHELL_PRIVILEGE_REQUIRED' && /sudoers policy/.test(error.message));

  // Production keeps unattended sudoers execution off until machine verification.
  const production = createRootPrivilegeRunner({ platform: 'darwin', sudoPath: denied.sudo });
  await assert.rejects(production.preflightRoot({
    program: '/usr/bin/true', args: [], cwd: denied.root, mode: 'sudoers',
  }), error => error.code === 'SHELL_PRIVILEGE_REQUIRED' && /HAOC-76/.test(error.message));
});

test('a root command timeout reclaims the process group and skips the rest of the flow', async t => {
  const { root, directory, runner } = await rootFixture(t);
  const after = join(root, 'after.txt');
  const flow = flowOf([
    { id: 'slow-root', kind: 'shell', argv: ['/bin/sh', '-c', 'sleep 30'], privilege: 'root', timeoutMs: 300 },
    { id: 'later', kind: 'shell', argv: ['/usr/bin/touch', after] },
  ]);
  const report = await runFlow(flow, undefined, {
    dryRun: false, signal,
    shell: {
      allowShell: true, allowSudo: true, interactive: true, baseDir: root,
      captureOutput: false, privilege: runner,
    },
  });
  assert.equal(report.status, 'failed', JSON.stringify(report.entries));
  assert.equal(report.entries[0].code, 'SHELL_TIMEOUT');
  assert.equal(report.entries[0].shell.execution, 'terminated');
  assert.equal(report.entries[0].shell.cleanup, 'complete');
  assert.equal(report.entries[1].status, 'skipped');
  assert.equal(existsSync(after), false);
  assert.equal(directory.length > 0, true);
});

test('root steps appear as argv-only contract, report fields, and gate on --interactive', async t => {
  const rootStep = { id: 'root', kind: 'shell', argv: ['/usr/bin/whoami'], privilege: 'root' };
  const flow = flowOf([rootStep]);
  assert.equal(flowCheck.Check({
    version: 1, id: 'root-flow', name: 'Root', target, steps: [rootStep],
  }), true);
  assert.equal(flowCheck.Check({
    version: 1, id: 'root-flow', name: 'Root', target,
    steps: [{ ...rootStep, privilegeMode: 'sudoers' }],
  }), true);
  const invalid = [
    { ...rootStep, shell: true, command: 'true' },
    { ...rootStep, env: { FIXTURE: 'x' } },
    { ...rootStep, command: 'true' },
    { ...rootStep, privilegeMode: 'askpass' },
    { ...rootStep, privilege: 'root', cwd: '/tmp', env: { A: 'b' } },
  ];
  for (const [index, step] of invalid.entries()) {
    assert.equal(flowCheck.Check({
      version: 1, id: 'root-flow', name: 'Root', target, steps: [step],
    }), false, `invalid root step ${index} was accepted`);
  }

  // Without --interactive the gate blocks before any runner or process exists.
  const { root, runner, calls } = await rootFixture(t);
  const blocked = await runFlow(flow, undefined, {
    dryRun: false, signal,
    shell: { allowShell: true, allowSudo: true, baseDir: root, interactive: false, privilege: runner },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.match(blocked.entries[0].message, /--interactive/);
  assert.deepEqual(await calls(), []);

  // Without --allow-sudo the same step is refused earlier.
  const noSudo = await runFlow(flow, undefined, {
    dryRun: false, signal,
    shell: { allowShell: true, allowSudo: false, baseDir: root, interactive: true, privilege: runner },
  });
  assert.equal(noSudo.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.match(noSudo.entries[0].message, /--allow-sudo/);
});

test('an interactive root step reports metadata only and announces its command before running', async t => {
  const { root, runner } = await rootFixture(t);
  const marker = join(root, 'announced.txt');
  const flow = flowOf([{
    id: 'root-step', kind: 'shell', argv: ['/usr/bin/touch', marker],
    privilege: 'root', cwd: '.',
  }, { id: 'after', kind: 'shell', shell: true, command: 'true' }]);
  const announced = [];
  const report = await runFlow(flow, undefined, {
    dryRun: false, signal,
    shell: {
      allowShell: true, allowSudo: true, interactive: true, baseDir: root,
      captureOutput: true, privilege: runner,
      announceRoot: step => announced.push(step),
    },
  });
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.equal(existsSync(marker), true);
  assert.deepEqual(announced, [{
    id: 'root-step', program: '/usr/bin/touch', args: [marker], cwd: root, mode: 'prompt',
  }]);
  const entry = report.entries[0];
  assert.deepEqual(entry.shell, {
    mode: 'argv', privilege: 'root', privilegeMode: 'prompt', execution: 'finished',
    exitCode: 0, cleanup: 'complete',
  });
  // Privileged output is never captured even when --capture-shell-output is on.
  assert.equal('stdout' in entry.shell, false);
  assert.doesNotMatch(JSON.stringify(report), /test-password-42/);
  assert.equal(reportCheck.Check(report), true);
});

test('the CLI refuses interactive JSON runs and blocks root steps without --interactive', async t => {
  const root = await scratch(t);
  const flowPath = join(root, 'root.json');
  await writeFile(flowPath, JSON.stringify({
    version: 1, id: 'root-cli', name: 'Root CLI', target,
    steps: [{ id: 'root', kind: 'shell', argv: ['/usr/bin/true'], privilege: 'root' }],
  }));
  const run = (...args) => spawnSync(process.execPath, [cliPath, 'run', flowPath, ...args, '--json'],
    { encoding: 'utf8', env: { ...process.env, SUDO_ASKPASS: join(root, 'never-askpass') } });

  const machine = run('--allow-shell', '--allow-sudo', '--interactive');
  assert.equal(machine.status, 2, machine.stdout + machine.stderr);
  assert.match(JSON.parse(machine.stdout).error.message, /--interactive cannot be combined with --json/);

  const blocked = run('--allow-shell', '--allow-sudo');
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  const report = JSON.parse(blocked.stdout).data;
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[0].code, 'SHELL_PRIVILEGE_REQUIRED');
  assert.match(report.entries[0].message, /--interactive/);

  const preview = run('--allow-shell', '--allow-sudo', '--interactive', '--dry-run');
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const previewReport = JSON.parse(preview.stdout).data;
  assert.equal(previewReport.entries[0].shell.execution, 'preview');
  assert.equal(previewReport.entries[0].shell.privilege, 'root');
});
