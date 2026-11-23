import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withDesktop } from '../dist/desktop.js';
import { startWorkbench } from '../dist/workbench.js';
import { createDesktopWorkdir, workdirRoot } from '../dist/workdir.js';
import { imeStub } from './support/ime-stub.mjs';

// The workbench inherits TMPDIR from the shell that started it. That directory
// can be deleted while the workbench is still running (a finished task's temp
// directory, or macOS reaping an idle /var/folders entry), and every recording
// then died in mkdtemp with a bare ENOENT. These tests pin the durable root.

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** A throwaway home, so the durable root never touches the real one. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-workdir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  return { root, home, gone: join(root, 'deleted', 'tmp') };
}

/** Records every agent-desktop call and the private home it was given. */
function desktopStub(dir) {
  const path = join(dir, 'desktop');
  const log = join(dir, 'desktop.log');
  writeFileSync(log, '');
  writeFileSync(path, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [command] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, home: process.env.AGENT_DESKTOP_HOME }) + '\\n');
if (command === 'version') {
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: { version: '1.3.1' } }));
  process.exit(0);
}
console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'WINDOW_NOT_FOUND' } }));
process.exit(1);
`, { mode: 0o700 });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { path, calls };
}

/** The global capture helper: announces itself, then replays one click. */
function captureStub(dir) {
  const path = join(dir, 'capture');
  const click = {
    kind: 'click', t: 100, point: [150, 110], focusGeneration: 1, secure: false,
    decision: 'record', count: 1,
    owner: {
      app: 'com.example.Plain', pid: 100, processInstance: 1, windowNumber: 31,
      windowTitle: 'main', role: 'AXButton', name: 'Save', pressable: true,
    },
  };
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
const seen = Date.now();
const messages = [
  { kind: 'ready', global: true, hotkeysFiltered: true, indicator: false },
  ${JSON.stringify(click)},
];
console.log(messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n'));
process.exitCode = 0;
`, { mode: 0o700 });
  return path;
}

function record(fixture, { env = {}, out = join(fixture.root, 'recorded.flow.json') }) {
  const stubDir = join(fixture.root, 'stubs');
  mkdirSync(stubDir, { recursive: true });
  const desktop = desktopStub(stubDir);
  const ime = imeStub(stubDir);
  const result = spawnSync(process.execPath, [
    cliPath, 'record', '--global', '--countdown', '0', '--no-indicator',
    '--max-seconds', '2', '--out', out, '--json',
  ], {
    env: {
      ...process.env,
      HOME: fixture.home,
      CUEKEEPER_AGENT_DESKTOP: desktop.path,
      CUEKEEPER_RECORDER: captureStub(stubDir),
      CUEKEEPER_ELECTRON_APPS: '',
      CUEKEEPER_APP_IDENTITY: join(stubDir, 'identity'),
      CUEKEEPER_IME: ime.helper,
      CUEKEEPER_IME_DIR: join(stubDir, 'ime-root'),
      ...env,
    },
    encoding: 'utf8', timeout: 30_000,
  });
  return {
    code: result.status,
    response: JSON.parse(result.stdout),
    stderr: result.stderr,
    written: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : undefined,
  };
}

test('a recording still starts and saves its flow when TMPDIR no longer exists', {
  skip: process.platform !== 'darwin',
}, t => {
  const home = fixture(t);
  const out = join(home.root, 'recorded.flow.json');
  // A plain CLI run falls back to the system temp dir instead of failing.
  const direct = record(home, { env: { TMPDIR: home.gone }, out });
  assert.equal(direct.code, 0, direct.stderr + JSON.stringify(direct.response));
  assert.deepEqual(direct.written.steps.map(step => step.kind), ['click']);

  // The workbench hands its recorder the durable root, so the run never
  // depends on the inherited TMPDIR at all.
  const workroot = join(home.home, '.cuekeeper', 'tmp');
  const durable = record(home, {
    env: { TMPDIR: home.gone, CUEKEEPER_WORKDIR: workroot },
    out: join(home.root, 'durable.flow.json'),
  });
  assert.equal(durable.code, 0, durable.stderr + JSON.stringify(durable.response));
  assert.deepEqual(durable.response.data.output, join(home.root, 'durable.flow.json'));
  assert.deepEqual(durable.written.steps.map(step => step.kind), ['click']);
  assert.ok(statSync(workroot).isDirectory(), 'the durable root is created on demand');
  assert.deepEqual(readdirSync(workroot), [], 'the per-run directory is removed afterwards');
  assert.equal(existsSync(home.gone), false, 'a deleted TMPDIR is not resurrected');
});

test('a desktop run gets its private directory under the workbench root, not TMPDIR', async t => {
  const home = fixture(t);
  const stubs = join(home.root, 'stubs');
  mkdirSync(stubs);
  const desktop = desktopStub(stubs);
  const workRoot = join(home.home, '.cuekeeper', 'tmp');
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CUEKEEPER_AGENT_DESKTOP: process.env.CUEKEEPER_AGENT_DESKTOP };
  process.env.HOME = home.home;
  process.env.TMPDIR = home.gone;
  process.env.CUEKEEPER_AGENT_DESKTOP = desktop.path;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let duringRun;
  await withDesktop({ headed: false, signal: new AbortController().signal, workRoot }, async () => {
    duringRun = desktop.calls().at(-1).home;
    return undefined;
  });
  assert.equal(dirname(duringRun), workRoot);
  assert.match(duringRun, /\/cuekeeper-[a-zA-Z0-9]{6}$/);
  assert.equal(existsSync(duringRun), false, 'the run directory is cleaned up');
});

test('the workbench creates the durable root before its first recording', async t => {
  const home = fixture(t);
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = home.home;
  process.env.TMPDIR = home.gone;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const cancellation = new AbortController();
  const { closed } = await startWorkbench({ port: 0, allowLive: false, signal: cancellation.signal });
  t.after(async () => { cancellation.abort(); await closed; });
  assert.ok(statSync(join(home.home, '.cuekeeper', 'tmp')).isDirectory());
});

test('an unwritable work root falls back to the system directory', async t => {
  const home = fixture(t);
  const file = join(home.root, 'not-a-directory');
  writeFileSync(file, 'x');
  const work = await createDesktopWorkdir(file);
  t.after(() => rmSync(work.directory, { recursive: true, force: true }));
  assert.equal(work.fallback, true);
  assert.equal(dirname(work.directory), '/tmp');
  assert.ok(statSync(work.directory).isDirectory());
});

test('a work root and its fallback both failing is a readable fault with the paths', async t => {
  const home = fixture(t);
  const rootFile = join(home.root, 'blocked-root');
  const fallbackFile = join(home.root, 'blocked-fallback');
  writeFileSync(rootFile, 'x');
  writeFileSync(fallbackFile, 'x');
  await assert.rejects(createDesktopWorkdir(rootFile, fallbackFile), error => {
    assert.equal(error.code, 'WORKDIR_UNAVAILABLE');
    assert.match(error.message, /没有开始/);
    assert.ok(error.message.includes(rootFile), 'the message names the work root');
    assert.ok(error.message.includes(fallbackFile), 'the message names the fallback it tried');
    assert.match(error.message, /CUEKEEPER_WORKDIR/, 'the message says how to fix it');
    return true;
  });
  // Nothing about the failure is a system call name the user cannot act on.
  await assert.rejects(createDesktopWorkdir(rootFile, fallbackFile), error => {
    assert.doesNotMatch(error.message, /^ENOENT/);
    return true;
  });
});

test('the configured root is what every run uses', async t => {
  const home = fixture(t);
  const previous = process.env.CUEKEEPER_WORKDIR;
  process.env.CUEKEEPER_WORKDIR = join(home.home, 'custom-workdir');
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_WORKDIR;
    else process.env.CUEKEEPER_WORKDIR = previous;
  });
  assert.equal(workdirRoot(), join(home.home, 'custom-workdir'));
  const work = await createDesktopWorkdir();
  t.after(() => rmSync(work.root, { recursive: true, force: true }));
  assert.equal(work.root, join(home.home, 'custom-workdir'));
  assert.equal(work.fallback, false);
  assert.ok(statSync(work.directory).isDirectory());
});
