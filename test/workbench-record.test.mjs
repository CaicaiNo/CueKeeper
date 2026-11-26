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
const { appendFileSync, writeSync } = await import('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const marker = process.env.CUEKEEPER_RECORD_MARKER;
const argvLog = process.env.CUEKEEPER_RECORD_ARGV;
const envLog = process.env.CUEKEEPER_RECORD_ENV;
const stageLog = process.env.CUEKEEPER_RECORD_STAGES;
const mode = process.env.CUEKEEPER_RECORD_STUB ?? 'signal';
// The stage-report descriptor the workbench asks for; the log records the same
// lines so a test can compare the server's status with what was reported.
const fdIndex = args.indexOf('--progress-fd');
const progressFd = fdIndex < 0 ? undefined : Number(args[fdIndex + 1]);
const report = value => {
  if (stageLog) appendFileSync(stageLog, JSON.stringify(value) + '\\n');
  if (progressFd === undefined) return;
  try {
    writeSync(progressFd, JSON.stringify(value) + '\\n');
  } catch {
    // The supervisor already closed the channel.
  }
};
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
} else if (mode === 'slow-ready') {
  // The helper needs a moment before it really captures; the countdown is over
  // long before that. Nothing may count this gap as recording time.
  await new Promise(resolve => setTimeout(resolve, 900));
  report({ stage: 'preparing' });
  await new Promise(resolve => setTimeout(resolve, 500));
  report({ stage: 'recording', readyAt: Date.now() });
} else if (mode === 'countdown') {
  // The CLI's own countdown end, which replaces the start-up estimate.
  report({ stage: 'countdown', endsAt: Date.now() + 4000 });
} else if (mode === 'slow-countdown') {
  // Preflight and the input-source switch take a moment before the CLI's real
  // countdown starts; nothing may count down during that gap.
  await new Promise(resolve => setTimeout(resolve, 1200));
  report({ stage: 'countdown', endsAt: Date.now() + 3000 });
} else {
  if (argvLog) await appendFile(argvLog, JSON.stringify(args) + '\\n');
  if (envLog) await appendFile(envLog, JSON.stringify({
    workRoot: process.env.CUEKEEPER_WORKDIR, tmpdir: process.env.TMPDIR,
  }) + '\\n');
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

async function fixture(t, { stopTimeoutMs = 5000, base } = {}) {
  const root = await mkdtemp(join(base ?? tmpdir(), 'cuekeeper-workbench-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'stub-cli.mjs');
  await writeFile(cli, stub);
  const recordings = join(root, 'recordings');
  const marker = join(root, 'signal.txt');
  const argvLog = join(root, 'argv.log');
  const envLog = join(root, 'env.log');
  const stageLog = join(root, 'stages.log');
  process.env.CUEKEEPER_RECORD_MARKER = marker;
  process.env.CUEKEEPER_RECORD_ARGV = argvLog;
  process.env.CUEKEEPER_RECORD_ENV = envLog;
  process.env.CUEKEEPER_RECORD_STAGES = stageLog;
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
    delete process.env.CUEKEEPER_RECORD_ENV;
    delete process.env.CUEKEEPER_RECORD_STAGES;
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
  const environments = async () => {
    const text = await readFile(envLog, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const stages = async () => {
    const text = await readFile(stageLog, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  // The stub only answers SIGINT once it has announced itself; waiting for the
  // announcement keeps the test about stop semantics, not process start-up.
  const started = async nth => {
    assert.ok(await waitFor(async () => (await runs()).length >= nth), `run ${nth} did not start`);
    return (await runs())[nth - 1];
  };
  return { root, url, recordings, marker, post, status, runs, environments, stages, started };
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
  // Stopping also loads the editor: the page replays the file the recorder
  // just wrote, without asking for a revision the operator never made.
  const recorded = stopped.flowPath;
  assert.equal(state.session.v2.flowPath, recorded);
  assert.deepEqual(state.session.v2.live, { path: recorded, revision: false });
  assert.equal(state.session.v2.saved.length, 0);

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

test('a slow recorder start dates the clock from the helper ready moment, not from the spawn', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'slow-ready';
  const { post, status, stages } = await fixture(t);
  const requestedAt = Date.now();
  const start = await post('record/start', { mode: 'global', countdown: 0 });
  assert.equal(start.recording, true);
  // The process exists, but nothing is captured yet: no clock and no
  // "recording" stage, while the stop route stays reachable.
  assert.equal(start.phase, 'starting');
  assert.equal(start.startedAt, undefined);
  assert.equal(start.elapsedMs, 0);
  const before = await status();
  assert.equal(before.phase, 'starting');
  assert.equal(before.startedAt, undefined);
  assert.equal(before.elapsedMs, 0);

  // The helper reports ready ~1.4 s later. Whatever long that took must not be
  // counted as recording time.
  assert.ok(await waitFor(async () => (await stages()).some(entry => entry.stage === 'recording'), 8000),
    'the stub never reported ready');
  const ready = (await stages()).find(entry => entry.stage === 'recording');
  assert.ok(ready.readyAt - requestedAt >= 900,
    `the gap between start and ready is ${ready.readyAt - requestedAt} ms; the test needs it to be long`);
  assert.ok(await waitFor(async () => (await status()).phase === 'recording'));
  const live = await status();
  assert.equal(live.phase, 'recording');
  assert.equal(Date.parse(live.startedAt), ready.readyAt);
  assert.ok(live.elapsedMs < 900,
    `elapsed ${live.elapsedMs} ms counts from the ready moment, not from the spawn`);

  // Stopping still imports the flow, and the saved result keeps the same clock.
  const stopped = await post('record/stop');
  assert.equal(stopped.recording, false);
  assert.equal(stopped.steps, 2);
  assert.equal(stopped.startedAt, live.startedAt);
});

test('the CLI countdown end replaces the spawn-time estimate', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'countdown';
  const { post, status, stages } = await fixture(t);
  await post('record/start', { mode: 'global', countdown: 3 });
  assert.ok(await waitFor(async () => (await stages()).some(entry => entry.stage === 'countdown')));
  const reported = (await stages()).find(entry => entry.stage === 'countdown');
  assert.ok(await waitFor(async () => (await status()).countdownEndsAt !== undefined));
  const live = await status();
  assert.equal(live.phase, 'countdown');
  // The CLI knows when its countdown really ends; the pre-spawn estimate does not.
  assert.equal(Date.parse(live.countdownEndsAt), reported.endsAt);
  assert.equal(live.startedAt, undefined);
  assert.equal(live.elapsedMs, 0);
  await post('record/stop');
});

test('a slow CLI start does not run the countdown before the recorder does', async t => {
  process.env.CUEKEEPER_RECORD_STUB = 'slow-countdown';
  const { post, status, stages } = await fixture(t);
  const requestedAt = Date.now();
  const start = await post('record/start', { mode: 'global', countdown: 3 });
  // Preflight and the input-source switch run before the CLI's countdown. Until
  // it reports that countdown, there is no end to show and nothing counts down.
  assert.equal(start.phase, 'starting');
  assert.equal(start.countdownEndsAt, undefined);
  assert.equal(start.countdownMs, 3000);
  const early = await status();
  assert.equal(early.phase, 'starting');
  assert.equal(early.countdownEndsAt, undefined);

  assert.ok(await waitFor(async () => (await stages()).some(entry => entry.stage === 'countdown'), 8000),
    'the stub never reported its countdown');
  const reported = (await stages()).find(entry => entry.stage === 'countdown');
  assert.ok(await waitFor(async () => (await status()).phase === 'countdown'));
  const live = await status();
  assert.equal(live.phase, 'countdown');
  assert.equal(Date.parse(live.countdownEndsAt), reported.endsAt);
  // The countdown the page shows ends where the CLI really ends it, later than
  // spawn+countdown would have been — so the digits never run ahead and jump back.
  assert.ok(reported.endsAt - requestedAt > 3900,
    `the reported end is ${reported.endsAt - requestedAt} ms after the request; the test needs the start to be slow`);
  await post('record/stop');
});

test('the recorder child gets the workbench work root, not the inherited TMPDIR', async t => {
  // The reported failure: a workbench started from a finished task's shell
  // inherits a TMPDIR that no longer exists.
  const home = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const gone = join(home, 'deleted', 'tmp');
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = home;
  process.env.TMPDIR = gone;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { post, started, environments } = await fixture(t, { base: home });
  const workRoot = join(home, '.cuekeeper', 'tmp');
  await post('record/start', { mode: 'global', countdown: 0 });
  await started(1);
  assert.ok(await waitFor(async () => (await environments()).length >= 1), 'the stub did not report its environment');
  assert.deepEqual((await environments())[0], { workRoot, tmpdir: gone });
  assert.ok((await stat(workRoot)).isDirectory(), 'the durable root exists before the child runs');
  await post('record/stop');
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
