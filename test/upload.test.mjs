import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { offlineDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';
import {
  UploadConfigError, normalizeUploadConfig, parseUploadConfigFile, resolveCredential,
  resolveUploadConfig, sha256Hex, uploadBundle, uploadChunkBytes,
} from '../dist/upload.js';
import { enqueueUpload, processUploadQueue, retryDelayMs } from '../dist/upload-queue.js';
import { startUploadApi } from './support/upload-api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const signal = new AbortController().signal;
const example = name => JSON.parse(readFileSync(join(root, 'examples', `${name}.json`), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cuekeeper-upload-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const directory = temporary(t);
  const flow = example('textedit.flow');
  const snapshot = example('textedit.snapshot');
  const report = await runFlow(flow, offlineDesktop(snapshot, flow.target), { dryRun: true, signal });
  const bytes = Buffer.from(packReport(report, parseFlow(flow)));
  const zipPath = join(directory, 'report.zip');
  writeFileSync(zipPath, bytes);
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
  writeFileSync(join(directory, 'flow.json'), JSON.stringify(flow));
  return { directory, flow, report, bytes, zipPath };
}

function configFor(api, tokenEnv = 'CQ_TEST_TOKEN') {
  return normalizeUploadConfig({ url: api.url, projectId: 'p1', tokenEnv });
}

async function queued(t, api, tokenEnv = 'CQ_TEST_TOKEN') {
  const data = await fixture(t);
  const queueDir = join(data.directory, 'queue');
  const config = configFor(api, tokenEnv);
  const result = await enqueueUpload({ queueDir, config, bundlePath: data.zipPath, bytes: data.bytes });
  return { ...data, queueDir, config, item: result.item, itemPath: join(queueDir, `${result.item.id}.json`) };
}

function itemOf(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function cleanEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CUEKEEPER_')) env[key] = value;
  }
  return { ...env, ...overrides };
}

function cli(args, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result;
}

function cliAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('upload config stays disabled without configuration and validates its sources', async t => {
  const directory = temporary(t);
  assert.equal(await resolveUploadConfig({ env: {}, configPath: null }), undefined);
  assert.equal(await resolveUploadConfig({ env: {}, configPath: join(directory, 'absent.json') })
    .then(() => 'resolved', error => error instanceof UploadConfigError ? 'config-error' : 'other'), 'config-error');

  const env = await resolveUploadConfig({
    env: {
      CUEKEEPER_UPLOAD_URL: 'https://reports.example.com',
      CUEKEEPER_UPLOAD_PROJECT: 'project-1',
      CUEKEEPER_UPLOAD_TOKEN: 'inline-token',
    },
    configPath: null,
  });
  assert.deepEqual(env, {
    url: 'https://reports.example.com',
    projectId: 'project-1',
    credentialRef: 'env:CUEKEEPER_UPLOAD_TOKEN',
  });

  const file = join(directory, 'upload.json');
  writeFileSync(file, JSON.stringify({ version: 1, url: 'https://reports.example.com/', projectId: 'p1', tokenEnv: 'CQ_TOKEN' }));
  assert.deepEqual(await resolveUploadConfig({ env: {}, configPath: file }), {
    url: 'https://reports.example.com', projectId: 'p1', credentialRef: 'env:CQ_TOKEN',
  });
  writeFileSync(file, JSON.stringify({ enabled: false }));
  assert.equal(await resolveUploadConfig({ env: {}, configPath: file }), undefined);
  assert.equal(parseUploadConfigFile({ enabled: false }), undefined);
  writeFileSync(file, JSON.stringify({ url: 'https://reports.example.com', projectId: 'p1' }));
  await assert.rejects(resolveUploadConfig({ env: {}, configPath: file }), /tokenEnv/);

  assert.throws(() => normalizeUploadConfig({ url: 'http://reports.example.com', projectId: 'p1', tokenEnv: 'T' }),
    /HTTPS|loopback/);
  assert.doesNotThrow(() => normalizeUploadConfig({ url: 'http://127.0.0.1:8080', projectId: 'p1', tokenEnv: 'T' }));
  assert.throws(() => normalizeUploadConfig({ url: 'https://user:pass@reports.example.com', projectId: 'p1', tokenEnv: 'T' }),
    /credentials/);
  assert.throws(() => normalizeUploadConfig({ url: 'https://reports.example.com/api', projectId: 'p1', tokenEnv: 'T' }),
    /path/);
  assert.throws(() => normalizeUploadConfig({ url: 'https://reports.example.com', projectId: 'bad id', tokenEnv: 'T' }),
    /projectId/);
  assert.equal(resolveCredential('env:CQ_TOKEN', { CQ_TOKEN: 'secret' }), 'secret');
  assert.throws(() => resolveCredential('env:MISSING_TOKEN', {}), /MISSING_TOKEN is not set/);
});

test('local report packing is byte-for-byte unchanged and does not queue without config', async t => {
  const data = await fixture(t);
  const env = cleanEnv({ HOME: data.directory });
  const packed = join(data.directory, 'packed.zip');
  const result = cli(['report', 'pack', join(data.directory, 'report.json'), '--flow', join(data.directory, 'flow.json'),
    '--out', packed, '--json'], env);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.data, { output: packed, bytes: data.bytes.length, assets: 0 });
  assert.deepEqual(readFileSync(packed), data.bytes);
  assert.equal(existsSync(join(data.directory, 'queue')), false);
  assert.equal(readdirSync(data.directory).some(name => name.includes('queue')), false);
});

test('packing with config enqueues the exact bundle once and never stores the token', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await fixture(t);
  const token = 'top-secret-token-value';
  const env = cleanEnv({
    HOME: data.directory,
    CUEKEEPER_UPLOAD_URL: api.url,
    CUEKEEPER_UPLOAD_PROJECT: 'p1',
    CUEKEEPER_UPLOAD_TOKEN_ENV: 'CQ_TEST_TOKEN',
    CQ_TEST_TOKEN: token,
    CUEKEEPER_UPLOAD_QUEUE: join(data.directory, 'queue'),
  });
  const args = ['report', 'pack', join(data.directory, 'report.json'), '--flow', join(data.directory, 'flow.json'), '--json'];
  const result = cli([...args, '--out', join(data.directory, 'first.zip')], env);
  assert.equal(result.status, 0, result.stderr);
  const first = JSON.parse(result.stdout).data;
  assert.equal(first.upload.queued, true);
  assert.equal(first.upload.duplicate, false);
  assert.equal(first.bytes, data.bytes.length);

  const queueDir = join(data.directory, 'queue');
  const files = readdirSync(queueDir).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const item = itemOf(join(queueDir, files[0]));
  assert.equal(item.bundleSha256, sha256(data.bytes));
  assert.equal(item.bundleBytes, data.bytes.length);
  assert.equal(item.server, api.url);
  assert.equal(item.projectId, 'p1');
  assert.equal(item.credentialRef, 'env:CQ_TEST_TOKEN');
  assert.equal(item.state, 'pending');
  assert.equal(item.bundlePath, join(data.directory, 'first.zip'));
  assert.doesNotMatch(readFileSync(join(queueDir, files[0]), 'utf8'), new RegExp(token));
  assert.doesNotMatch(result.stdout, new RegExp(token));
  for (const contents of Object.values(unzipSync(readFileSync(join(data.directory, 'first.zip'))))) {
    assert.equal(Buffer.from(contents).includes(Buffer.from(token)), false);
  }

  const second = cli([...args, '--out', join(data.directory, 'second.zip'), '--no-upload'], env);
  assert.equal(second.status, 0, second.stderr);
  const secondData = JSON.parse(second.stdout).data;
  assert.equal(secondData.upload, undefined);
  assert.deepEqual(readFileSync(join(data.directory, 'second.zip')), data.bytes);
  assert.equal(readdirSync(queueDir).filter(name => name.endsWith('.json')).length, 1);
});

test('uploading a packed report sends the exact zip and one idempotent run', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  const summary = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.deepEqual({ done: summary.done, pending: summary.pending, paused: summary.paused }, { done: 1, pending: 0, paused: 0 });
  const item = itemOf(data.itemPath);
  assert.equal(item.state, 'done');
  assert.equal(item.bundleSha256, sha256(data.bytes));
  assert.equal(item.committedBytes, data.bytes.length);
  assert.ok(item.runId);
  assert.equal(api.state.runs.size, 1);
  assert.deepEqual(Buffer.from(api.state.bundles.get(item.runId)), data.bytes);
  assert.equal(sha256(api.state.bundles.get(item.runId)), sha256(readFileSync(data.zipPath)));
  assert.equal(api.state.requests.filter(request => request.route === 'create').length, 1);

  const again = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(again.done, 0);
  assert.equal(again.skipped, 1);
  assert.equal(api.state.runs.size, 1);
  assert.equal(api.state.requests.filter(request => request.route === 'create').length, 1);
});

test('a lost create response is retried with the same key and still creates one run', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  api.inject({ route: 'create', drop: true });
  const first = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(first.pending, 1);
  let item = itemOf(data.itemPath);
  assert.equal(item.lastError.code, 'NETWORK_ERROR');
  assert.equal(item.lastError.retryable, true);
  assert.equal(api.state.runs.size, 1);

  const later = new Date(Date.parse(item.nextAttemptAt) + 1000);
  const second = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, now: () => later, wait: async () => undefined,
  });
  assert.equal(second.done, 1);
  assert.equal(api.state.runs.size, 1);
  assert.equal(api.state.requests.filter(request => request.route === 'create').length, 2);
  item = itemOf(data.itemPath);
  assert.equal(item.state, 'done');
  assert.deepEqual(Buffer.from(api.state.bundles.get(item.runId)), data.bytes);
});

test('offline failures keep the zip and resume after the network returns', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  api.setOffline(true);
  const first = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, random: () => 0,
    wait: async () => undefined,
  });
  assert.equal(first.pending, 1);
  const item = itemOf(data.itemPath);
  assert.equal(item.state, 'pending');
  assert.equal(item.lastError.code, 'NETWORK_ERROR');
  assert.equal(item.lastError.retryable, true);
  assert.ok(Date.parse(item.nextAttemptAt) > Date.now());
  assert.equal(existsSync(data.zipPath), true);
  assert.equal(readFileSync(data.zipPath).length, data.bytes.length);

  api.setOffline(false);
  const later = new Date(Date.parse(item.nextAttemptAt) + 1);
  const second = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, now: () => later,
    wait: async () => undefined,
  });
  assert.equal(second.done, 1);
  assert.equal(api.state.runs.size, 1);
  assert.deepEqual(Buffer.from(api.state.bundles.get(itemOf(data.itemPath).runId)), data.bytes);
});

test('missing or changed bundles pause locally and re-enqueue restores the original bytes', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  writeFileSync(data.zipPath, Buffer.concat([data.bytes, Buffer.from('tampered')]));
  const changed = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(changed.paused, 1);
  let item = itemOf(data.itemPath);
  assert.equal(item.state, 'paused');
  assert.equal(item.lastError.code, 'BUNDLE_CHANGED');
  assert.equal(item.lastError.retryable, false);
  assert.equal(existsSync(data.zipPath), true);
  assert.equal(api.state.requests.length, 0);

  const restored = await enqueueUpload({
    queueDir: data.queueDir, config: data.config, bundlePath: data.zipPath, bytes: data.bytes,
  });
  assert.equal(restored.duplicate, true);
  item = itemOf(data.itemPath);
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0);

  rmSync(data.zipPath);
  const missing = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(missing.paused, 1);
  assert.equal(itemOf(data.itemPath).lastError.code, 'BUNDLE_MISSING');

  writeFileSync(data.zipPath, data.bytes);
  const finished = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, retryPaused: true, wait: async () => undefined,
  });
  assert.equal(finished.done, 1);
  assert.equal(api.state.runs.size, 1);
});

test('401 pauses with a readable reason, keeps the zip, and resumes without a new run', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  const denied = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'wrong-token' }, wait: async () => undefined,
  });
  assert.equal(denied.paused, 1);
  let item = itemOf(data.itemPath);
  assert.equal(item.state, 'paused');
  assert.equal(item.lastError.code, 'UNAUTHENTICATED');
  assert.equal(item.lastError.status, 401);
  assert.equal(item.lastError.retryable, false);
  assert.match(item.lastError.message, /Invalid token/);
  assert.equal(existsSync(data.zipPath), true);
  assert.equal(api.state.runs.size, 0);

  const resumed = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, retryPaused: true, wait: async () => undefined,
  });
  assert.equal(resumed.done, 1);
  item = itemOf(data.itemPath);
  assert.equal(item.state, 'done');
  assert.equal(api.state.runs.size, 1);
  assert.equal(api.state.requests.filter(request => request.route === 'create').length, 2);
});

test('403 and 413 are non-retryable and keep the local zip', async t => {
  const foreign = await startUploadApi({ tokens: { 'test-token': 'p2' } });
  t.after(() => foreign.close());
  const data = await queued(t, foreign);
  const forbidden = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(forbidden.paused, 1);
  assert.equal(itemOf(data.itemPath).lastError.code, 'FORBIDDEN');
  assert.equal(existsSync(data.zipPath), true);

  const small = await startUploadApi({ maxBundleBytes: 1024 });
  t.after(() => small.close());
  const second = await queued(t, small, 'CQ_SECOND_TOKEN');
  const tooLarge = await processUploadQueue({
    queueDir: second.queueDir, env: { CQ_SECOND_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(tooLarge.paused, 1);
  assert.equal(itemOf(second.itemPath).lastError.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(itemOf(second.itemPath).lastError.status, 413);
  assert.equal(existsSync(second.zipPath), true);
  assert.equal(small.state.runs.size, 0);
});

test('multi-chunk uploads follow 8 MiB boundaries and resend only committed bytes', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const bytes = Buffer.alloc(uploadChunkBytes + 1234, 7);
  const result = await uploadBundle({
    config: configFor(api), token: 'test-token', fetch,
  }, bytes, { wait: async () => undefined });
  assert.equal(result.bundleBytes, bytes.length);
  assert.deepEqual(Buffer.from(api.state.bundles.get(result.runId)), bytes);
  const chunks = api.state.requests.filter(request => request.route === 'chunk');
  assert.deepEqual(chunks.map(request => request.path.split('/').at(-1)), ['0', '1']);

  const upload = [...api.state.uploads.values()][0];
  assert.equal(upload.committedBytes, bytes.length);
  assert.equal(upload.chunks.get(0).bytes.length, uploadChunkBytes);
  assert.equal(upload.chunks.get(1).bytes.length, 1234);
});

test('a stalled request times out as a retryable failure', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  api.inject({ route: 'create', status: 503, code: 'SERVER_ERROR', retryable: true, delayMs: 150 });
  await assert.rejects(
    uploadBundle({ config: configFor(api), token: 'test-token', fetch, timeoutMs: 30 },
      Buffer.from('stalled-bundle'), { wait: async () => undefined }),
    error => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  await new Promise(resolve => setTimeout(resolve, 200));
});

test('recoverable session conflicts replace the session through the same idempotency key', async t => {
  for (const scenario of [
    { route: 'chunk', status: 409, code: 'CHUNK_OUT_OF_ORDER', retryable: true, creates: 2 },
    { route: 'complete', status: 409, code: 'UPLOAD_INCOMPLETE', retryable: true, creates: 2 },
    { route: 'complete', status: 409, code: 'UPLOAD_EXPIRED', retryable: true, creates: 2 },
    { route: 'complete', status: 409, code: 'UPLOAD_FINALIZED', retryable: true, creates: 2 },
  ]) {
    const api = await startUploadApi();
    try {
      const data = await queued(t, api);
      api.inject({ ...scenario, times: 1 });
      const summary = await processUploadQueue({
        queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
      });
      assert.equal(summary.done, 1, scenario.code);
      assert.equal(api.state.runs.size, 1, scenario.code);
      assert.equal(api.state.requests.filter(request => request.route === 'create').length,
        scenario.creates, scenario.code);
      assert.deepEqual(Buffer.from(api.state.bundles.get(itemOf(data.itemPath).runId)), data.bytes, scenario.code);
    } finally {
      await api.close();
    }
  }

  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  const waits = [];
  api.inject({ route: 'complete', status: 409, code: 'UPLOAD_VERIFYING', retryable: true, retryAfter: 2 });
  const summary = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' },
    wait: async ms => { waits.push(ms); },
  });
  assert.equal(summary.done, 1);
  assert.deepEqual(waits, [2000]);
  assert.equal(api.state.runs.size, 1);
});

test('the protocol error table maps to pause or backoff exactly as documented', async t => {
  const cases = [
    { route: 'create', status: 400, code: 'BAD_REQUEST', retryable: false, state: 'paused' },
    { route: 'create', status: 401, code: 'UNAUTHENTICATED', retryable: false, state: 'paused' },
    { route: 'create', status: 403, code: 'FORBIDDEN', retryable: false, state: 'paused' },
    { route: 'create', status: 404, code: 'NOT_FOUND', retryable: false, state: 'paused' },
    { route: 'create', status: 409, code: 'IDEMPOTENCY_CONFLICT', retryable: false, state: 'paused' },
    { route: 'chunk', status: 409, code: 'CHUNK_CONFLICT', retryable: false, state: 'paused' },
    { route: 'complete', status: 410, code: 'ARTIFACT_EXPIRED', retryable: false, state: 'paused' },
    { route: 'create', status: 413, code: 'PAYLOAD_TOO_LARGE', retryable: false, state: 'paused' },
    { route: 'chunk', status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', retryable: false, state: 'paused' },
    { route: 'chunk', status: 422, code: 'CHUNK_DIGEST_MISMATCH', retryable: false, state: 'paused' },
    { route: 'complete', status: 422, code: 'BUNDLE_DIGEST_MISMATCH', retryable: false, state: 'paused' },
    { route: 'complete', status: 422, code: 'BUNDLE_INVALID', retryable: false, state: 'paused' },
    { route: 'create', status: 302, code: 'MOVED', retryable: false, state: 'paused', clientCode: 'REDIRECT_REJECTED' },
    { route: 'create', status: 500, code: 'SERVER_ERROR', retryable: true, state: 'pending' },
    { route: 'create', status: 503, code: 'SERVER_ERROR', retryable: true, state: 'pending' },
    { route: 'create', status: 429, code: 'RATE_LIMITED', retryable: true, state: 'pending', retryAfter: 2 },
  ];
  for (const scenario of cases) {
    const api = await startUploadApi();
    try {
      const data = await queued(t, api);
      api.inject({ ...scenario, times: 1 });
      const clock = new Date();
      const summary = await processUploadQueue({
        queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, now: () => clock,
        random: () => 0, wait: async () => undefined,
      });
      const item = itemOf(data.itemPath);
      assert.equal(summary[scenario.state], 1, `${scenario.status} ${scenario.code}`);
      assert.equal(item.state, scenario.state, `${scenario.status} ${scenario.code}`);
      assert.equal(item.lastError.code, scenario.clientCode ?? scenario.code, `${scenario.status} ${scenario.code}`);
      assert.equal(item.lastError.retryable, scenario.retryable, `${scenario.status} ${scenario.code}`);
      assert.equal(item.lastError.status, scenario.status, `${scenario.status} ${scenario.code}`);
      if (scenario.state === 'pending') {
        const delay = Date.parse(item.nextAttemptAt) - clock.getTime();
        if (scenario.retryAfter !== undefined) assert.equal(delay, scenario.retryAfter * 1000);
        else assert.ok(delay > 0);
        assert.equal(item.attempts, 1);
      } else {
        assert.equal(item.nextAttemptAt, undefined);
        assert.equal(existsSync(data.zipPath), true);
      }
    } finally {
      await api.close();
    }
  }
});

test('retry budget pauses an item and manual resume keeps the key', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  api.inject({ route: 'create', status: 503, code: 'SERVER_ERROR', retryable: true, times: 20 });
  let clock = new Date();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await processUploadQueue({
      queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, now: () => clock,
      maxAttempts: 3, random: () => 0, wait: async () => undefined,
    });
    const item = itemOf(data.itemPath);
    if (attempt < 3) {
      assert.equal(item.state, 'pending');
      clock = new Date(Date.parse(item.nextAttemptAt) + 1);
    } else {
      assert.equal(item.state, 'paused');
      assert.match(item.lastError.message, /retry budget exhausted/);
      assert.equal(item.lastError.code, 'SERVER_ERROR');
      assert.equal(item.attempts, 3);
    }
  }
  const key = itemOf(data.itemPath).bundleSha256;
  const resumed = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, retryPaused: true,
    maxAttempts: 3, random: () => 0, wait: async () => undefined,
  });
  assert.equal(resumed.pending, 1);
  assert.equal(itemOf(data.itemPath).bundleSha256, key);
  assert.equal(itemOf(data.itemPath).attempts, 1);
  assert.equal(api.state.requests.filter(request => request.route === 'create').length >= 4, true);
});

test('queue locking skips an item another worker owns', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await queued(t, api);
  writeFileSync(`${data.itemPath}.lock`, String(process.pid));
  const summary = await processUploadQueue({
    queueDir: data.queueDir, env: { CQ_TEST_TOKEN: 'test-token' }, wait: async () => undefined,
  });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.results[0].code, 'LOCKED');
  assert.equal(itemOf(data.itemPath).state, 'pending');
  assert.equal(api.state.requests.length, 0);
});

test('queue items stay bound to the server and project they were queued for', async t => {
  const first = await startUploadApi();
  t.after(() => first.close());
  const second = await startUploadApi({ projectId: 'p2', tokens: { 'other-token': 'p2' } });
  t.after(() => second.close());
  const data = await fixture(t);
  const queueDir = join(data.directory, 'queue');
  const one = await enqueueUpload({
    queueDir, config: normalizeUploadConfig({ url: first.url, projectId: 'p1', tokenEnv: 'CQ_TEST_TOKEN' }),
    bundlePath: data.zipPath, bytes: data.bytes,
  });
  const two = await enqueueUpload({
    queueDir, config: normalizeUploadConfig({ url: second.url, projectId: 'p2', tokenEnv: 'CQ_OTHER_TOKEN' }),
    bundlePath: data.zipPath, bytes: data.bytes,
  });
  assert.notEqual(one.item.id, two.item.id);
  assert.deepEqual(
    { server: itemOf(join(queueDir, `${one.item.id}.json`)).server, projectId: itemOf(join(queueDir, `${one.item.id}.json`)).projectId },
    { server: first.url, projectId: 'p1' },
  );
  const summary = await processUploadQueue({
    queueDir, env: { CQ_TEST_TOKEN: 'test-token', CQ_OTHER_TOKEN: 'other-token' },
    wait: async () => undefined,
  });
  assert.equal(summary.done, 2);
  assert.equal(first.state.runs.size, 1);
  assert.equal(second.state.runs.size, 1);
  const doneOne = itemOf(join(queueDir, `${one.item.id}.json`));
  const doneTwo = itemOf(join(queueDir, `${two.item.id}.json`));
  assert.equal(sha256(first.state.bundles.get(doneOne.runId)), sha256(data.bytes));
  assert.equal(sha256(second.state.bundles.get(doneTwo.runId)), sha256(data.bytes));
});

test('retry backoff is exponential with bounded jitter', () => {
  assert.equal(retryDelayMs(1, 0.5), 1000);
  assert.equal(retryDelayMs(2, 0.5), 2000);
  assert.equal(retryDelayMs(3, 0.5), 4000);
  assert.equal(retryDelayMs(1, 0), 800);
  assert.equal(retryDelayMs(1, 1), 1200);
  assert.equal(retryDelayMs(20, 0.5), 300_000);
});

test('the CLI uploads a queued pack, reports counts, and exits non-zero when paused', async t => {
  const api = await startUploadApi();
  t.after(() => api.close());
  const data = await fixture(t);
  const queueDir = join(data.directory, 'queue');
  const env = cleanEnv({
    HOME: data.directory,
    CUEKEEPER_UPLOAD_URL: api.url,
    CUEKEEPER_UPLOAD_PROJECT: 'p1',
    CUEKEEPER_UPLOAD_TOKEN_ENV: 'CQ_TEST_TOKEN',
    CQ_TEST_TOKEN: 'test-token',
    CUEKEEPER_UPLOAD_QUEUE: queueDir,
  });
  const packed = cli(['report', 'pack', join(data.directory, 'report.json'),
    '--flow', join(data.directory, 'flow.json'), '--out', join(data.directory, 'packed.zip'), '--json'], env);
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(JSON.parse(packed.stdout).data.upload.queued, true);

  const uploaded = await cliAsync(['report', 'upload', '--json'], env);
  assert.equal(uploaded.status, 0, uploaded.stderr);
  const body = JSON.parse(uploaded.stdout).data;
  assert.deepEqual({ done: body.done, pending: body.pending, paused: body.paused }, { done: 1, pending: 0, paused: 0 });
  assert.equal(api.state.runs.size, 1);
  assert.deepEqual(Buffer.from(api.state.bundles.get(body.results[0].runId)), data.bytes);

  const repeated = await cliAsync(['report', 'upload', '--json'], env);
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeat = JSON.parse(repeated.stdout).data;
  assert.equal(repeat.done, 0);
  assert.equal(repeat.skipped, 1);
  assert.equal(api.state.runs.size, 1);

  const denied = await cliAsync(['report', 'upload', '--json'], cleanEnv({
    HOME: data.directory,
    CUEKEEPER_UPLOAD_QUEUE: join(data.directory, 'empty-queue'),
  }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).data.done, 0);
  const fresh = cli(['report', 'pack', join(data.directory, 'report.json'),
    '--flow', join(data.directory, 'flow.json'), '--out', join(data.directory, 'denied.zip'), '--json'], cleanEnv({
    HOME: data.directory,
    CUEKEEPER_UPLOAD_URL: api.url,
    CUEKEEPER_UPLOAD_PROJECT: 'p1',
    CUEKEEPER_UPLOAD_TOKEN_ENV: 'CQ_TEST_TOKEN',
    CQ_TEST_TOKEN: 'wrong-token',
    CUEKEEPER_UPLOAD_QUEUE: join(data.directory, 'fresh-queue'),
  }));
  assert.equal(fresh.status, 0, fresh.stderr);
  const refused = await cliAsync(['report', 'upload', '--json'], cleanEnv({
    HOME: data.directory,
    CQ_TEST_TOKEN: 'wrong-token',
    CUEKEEPER_UPLOAD_QUEUE: join(data.directory, 'fresh-queue'),
  }));
  assert.equal(refused.status, 1);
  const refusedBody = JSON.parse(refused.stdout).data;
  assert.equal(refusedBody.paused, 1);
  assert.equal(refusedBody.results[0].code, 'UNAUTHENTICATED');
});
