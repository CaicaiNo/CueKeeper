import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { startWorkbench } from '../dist/workbench.js';

// Stands in for `dist/cli.js record --global`: it records the arguments it was
// given, writes a v2 flow on SIGINT, and answers with the same JSON envelope
// the real CLI prints, so the server paths under test are the real ones.
const stub = `
const { appendFile, writeFile } = await import('node:fs/promises');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const marker = process.env.CUEKEEPER_RECORD_MARKER;
const argvLog = process.env.CUEKEEPER_RECORD_ARGV;
const mode = process.env.CUEKEEPER_RECORD_STUB ?? 'signal';
const flow = {
  version: 2, id: 'global-stub', name: 'stub 全局录制',
  steps: [
    { id: 's1', kind: 'activate_app', scope: { kind: 'app', app: 'com.example.Stub' } },
    { id: 's2', kind: 'gap', code: 'CAPTURE_GAP' },
  ],
};
const log = value => process.stdout.write(JSON.stringify(value) + '\\n');
const keepAlive = setInterval(() => {}, 1000);
// Registered before the run is announced so a stop that lands during start-up
// is a normal recording stop, not the default SIGINT kill.
process.on('SIGINT', async () => {
  if (marker) await writeFile(marker, 'SIGINT');
  if (mode === 'hang') return;
  await writeFile(out, JSON.stringify(flow, null, 2) + '\\n');
  log({
    ok: false,
    data: {
      version: 2, output: out, flowId: flow.id, actions: flow.steps.length, partial: true,
      warnings: [{ code: 'STEP_LIMIT', message: 'stub warning' }],
    },
    error: { code: 'INTERRUPTED', message: 'Recording interrupted' },
  });
  clearInterval(keepAlive);
  process.exitCode = 130;
});
if (mode === 'crash') {
  log({ ok: false, error: { code: 'PERMISSIONS_REQUIRED', message: 'Recording needs macOS permission.' } });
  clearInterval(keepAlive);
  process.exitCode = 2;
} else if (mode === 'empty') {
  log({ ok: false, error: { code: 'EMPTY_RECORDING', message: 'No supported actions were captured' } });
  clearInterval(keepAlive);
  process.exitCode = 1;
} else {
  if (argvLog) await appendFile(argvLog, JSON.stringify(args) + '\\n');
}
`;

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function fixture(t, { stopTimeoutMs = 5000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'stub-cli.mjs');
  await writeFile(cli, stub);
  const recordings = join(root, 'recordings');
  const marker = join(root, 'signal.txt');
  const argvLog = join(root, 'argv.log');
  process.env.CUEKEEPER_RECORD_MARKER = marker;
  process.env.CUEKEEPER_RECORD_ARGV = argvLog;
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'),
    signal: cancellation.signal,
    record: { cli, recordings, stopTimeoutMs },
  });
  t.after(async () => {
    cancellation.abort();
    await closed;
    delete process.env.CUEKEEPER_RECORD_MARKER;
    delete process.env.CUEKEEPER_RECORD_ARGV;
    delete process.env.CUEKEEPER_RECORD_STUB;
  });
  const post = async (route, payload = {}, status = 200) => {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  const status = async () => {
    const response = await fetch(`${url}/api/record/status`, {
      headers: { 'x-cuekeeper-workbench': '1' },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const runs = async () => {
    const text = await readFile(argvLog, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  // The stub only answers SIGINT once it has announced itself; waiting for the
  // announcement keeps the test about stop semantics, not process start-up.
  const started = async nth => {
    assert.ok(await waitFor(async () => (await runs()).length >= nth), `run ${nth} did not start`);
    return (await runs())[nth - 1];
  };
  return { root, url, recordings, marker, post, status, runs, started };
}

test('starting a web recording spawns the global CLI once and stopping imports its flow', async t => {
  const { recordings, marker, post, status, started } = await fixture(t);
  const first = await post('record/start', { mode: 'global', countdown: 0, maxSeconds: 12, exclude: ['com.apple.Safari'] });
  assert.equal(first.recording, true);
  assert.match(first.flowPath, /recordings\/recording-\d{8}T\d{6}Z\.flow\.json$/);
  assert.equal(first.countdownMs, 0);

  const args = await started(1);
  assert.deepEqual(args.slice(0, 3), ['record', '--global', '--out']);
  assert.equal(args[3], first.flowPath);
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('--countdown') + 1], '0');
  assert.equal(args[args.indexOf('--max-seconds') + 1], '12');
  assert.equal(args[args.indexOf('--exclude') + 1], 'com.apple.Safari');

  // Only one recording at a time.
  const duplicate = await post('record/start', { mode: 'global' }, 400);
  assert.match(duplicate.error, /already in progress/);

  const running = await status();
  assert.equal(running.recording, true);
  assert.ok(running.elapsedMs >= 0);
  assert.equal(running.flowPath, first.flowPath);

  const stopped = await post('record/stop');
  assert.equal(stopped.recording, false);
  assert.equal(stopped.exitCode, 130);
  assert.equal(stopped.partial, true);
  assert.equal(stopped.steps, 2);
  assert.deepEqual(stopped.warnings, [{ code: 'STEP_LIMIT', message: 'stub warning' }]);
  assert.equal(stopped.error, undefined);
  assert.equal(await readFile(marker, 'utf8'), 'SIGINT');
  assert.ok((await stat(stopped.flowPath)).isFile());

  // The timeline is the freshly stopped recording, not whatever came before.
  assert.equal(stopped.session.version, 2);
  assert.equal(stopped.session.directory, await realpath(recordings));
  assert.deepEqual(stopped.session.timeline.map(row => row.action.kind), ['activate_app', 'gap']);
  const state = await post('state');
  assert.equal(state.session.id, stopped.session.id);

  // Stopping again reports the same finished recording instead of failing.
  const again = await post('record/stop');
  assert.equal(again.recording, false);
  assert.equal(again.flowPath, first.flowPath);

  // The one-session lock is released, and the new name never replaces the old.
  const second = await post('record/start', { mode: 'global', countdown: 0 });
  assert.equal(second.recording, true);
  assert.notEqual(second.flowPath, first.flowPath);
  assert.match(second.flowPath, /recordings\/recording-\d{8}T\d{6}Z(-\d+)?\.flow\.json$/);
  await started(2);
  const secondStop = await post('record/stop');
  assert.equal(secondStop.recording, false);
  assert.equal(secondStop.steps, 2);
  assert.ok((await stat(first.flowPath)).isFile());
});

test('a recording that ignores the stop is killed and reported without a flow', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'hang';
  const { marker, post, started } = await fixture(t, { stopTimeoutMs: 300 });
  const first = await post('record/start', { mode: 'global', countdown: 0 });
  await started(1);
  const stopped = await post('record/stop');
  assert.equal(stopped.recording, false);
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.signal, 'SIGKILL');
  assert.equal(stopped.error.code, 'RECORD_STOP_TIMEOUT');
  assert.match(stopped.error.message, /did not stop within 300 ms/);
  assert.deepEqual(stopped.warnings.map(warning => warning.code), ['RECORD_NOT_SAVED']);
  assert.equal(stopped.session, undefined);
  assert.equal(await readFile(marker, 'utf8'), 'SIGINT');
  assert.match(first.flowPath, /\.flow\.json$/);
});

test('a recorder that exits by itself is reported as failed, not as recording', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'crash';
  const { post, status } = await fixture(t);
  await post('record/start', { mode: 'global', countdown: 0 });
  assert.ok(await waitFor(async () => (await status()).recording === false));
  const crashed = await status();
  assert.equal(crashed.error.code, 'PERMISSIONS_REQUIRED');
  assert.equal(crashed.exitCode, 2);
  // Finish through the same stop path; nothing was written to import.
  const stopped = await post('record/stop');
  assert.equal(stopped.error.code, 'PERMISSIONS_REQUIRED');
  assert.deepEqual(stopped.warnings.map(warning => warning.code), ['RECORD_NOT_SAVED']);
  assert.equal(stopped.session, undefined);
});

test('a recording that captured nothing reports the CLI fault and saves no flow', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'empty';
  const { post, status } = await fixture(t);
  await post('record/start', { mode: 'global', countdown: 0 });
  assert.ok(await waitFor(async () => (await status()).recording === false));
  const stopped = await post('record/stop');
  assert.equal(stopped.recording, false);
  assert.equal(stopped.error.code, 'EMPTY_RECORDING');
  assert.equal(stopped.exitCode, 1);
  assert.equal(stopped.session, undefined);
  assert.deepEqual(stopped.warnings.map(warning => warning.code), ['RECORD_NOT_SAVED']);
});

test('the record API rejects unknown modes and out-of-range options', async t => {
  const { url, post } = await fixture(t);
  for (const body of [
    { mode: 'window' },
    { mode: 'global', countdown: 61 },
    { mode: 'global', maxSeconds: 0 },
    { mode: 'global', exclude: ['not a bundle id'] },
    { mode: 'global', exclude: 'com.apple.Safari' },
  ]) {
    const rejected = await post('record/start', body, 400);
    assert.match(rejected.error, /global|countdown|maxSeconds|exclude/);
  }
  const idle = await post('record/stop', {}, 400);
  assert.match(idle.error, /No recording is in progress/);
  assert.equal((await fetch(`${url}/api/record/status`)).status, 403);
});

test('the workbench serves the recording controls without inline alerts', async t => {
  const { url } = await fixture(t);
  const script = await (await fetch(`${url}/record.js`)).text();
  assert.match(script, /api\/record\/start/);
  assert.match(script, /api\/record\/stop/);
  assert.match(script, /api\/record\/status/);
  assert.match(script, /record-timer/);
  assert.doesNotMatch(script, /\balert\(/);
  assert.match(await (await fetch(url)).text(), /<script type="module" src="\/record\.js"><\/script>/);
});
