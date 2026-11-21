import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { parseFlow } from '../dist/flow.js';
import { packReport } from '../dist/report.js';
import { startServer } from '../dist/server.js';
import {
  hashToken, parseServerConfig, ServerConfigError,
} from '../dist/server-config.js';
import { normalizeUploadConfig, uploadBundle } from '../dist/upload.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const chunkBytes = 8_388_608;
const example = name => JSON.parse(readFileSync(join(root, 'examples', `${name}.json`), 'utf8'));
const report = example('textedit.report');
const flow = example('textedit.flow');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function bundleFor(overrides = {}, assets = []) {
  return Buffer.from(packReport({ ...report, ...overrides }, parseFlow(flow), { assets }));
}

const smallBundle = bundleFor();
const bigBundle = bundleFor({}, [{
  path: 'payload.bin',
  bytes: randomBytes(chunkBytes + 4096),
}]);

function serverConfig(options = {}) {
  const maxBundleBytes = options.maxBundleBytes ?? 64 * 1024 * 1024;
  const artifactTtlDays = options.artifactTtlDays ?? 30;
  const projects = [
    { id: 'p1', name: 'Project one', maxBundleBytes, artifactTtlDays },
    { id: 'p2', name: 'Project two', maxBundleBytes, artifactTtlDays },
  ];
  return parseServerConfig({
    version: 1,
    projects,
    tokens: [
      { id: 'workspace', tokenSha256: hashToken('workspace-token'), scopes: ['runs:write', 'runs:read'] },
      { id: 'p1-writer', tokenSha256: hashToken('p1-write'), scopes: ['runs:write', 'runs:read'], projectId: 'p1' },
      { id: 'reader', tokenSha256: hashToken('read-only'), scopes: ['runs:read'], projectId: 'p1' },
    ],
  });
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cuekeeper-server-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function cleanEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CUEKEEPER_')) env[key] = value;
  }
  return { ...env, ...overrides };
}

/** Run the CLI without blocking the in-process server's event loop. */
function cliAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function serve(t, options = {}) {
  const dataDir = options.dataDir ?? temporary(t);
  const server = await startServer({ config: serverConfig(options), dataDir, port: 0 });
  t.after(() => server.close());
  return { server, dataDir };
}

function endpoint(server, project, path) {
  return `${server.url}/api/v1/projects/${project}${path}`;
}

function headers(token = 'workspace-token', extra = {}) {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function request(server, method, project, path, options = {}) {
  return fetch(endpoint(server, project, path), {
    method,
    headers: headers(options.token, options.headers),
    ...(options.body === undefined ? {} : { body: options.body }),
    redirect: 'manual',
  });
}

async function createRun(server, bytes, options = {}) {
  return request(server, 'POST', options.project ?? 'p1', '/runs', {
    token: options.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': options.key ?? sha256(bytes) },
    body: JSON.stringify({ bundleBytes: options.size ?? bytes.length }),
  });
}

function putChunk(server, runId, uploadId, index, chunk, options = {}) {
  return request(server, 'PUT', options.project ?? 'p1', `/runs/${runId}/uploads/${uploadId}/chunks/${index}`, {
    token: options.token,
    headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(chunk) },
    body: chunk,
  });
}

function complete(server, runId, uploadId, options = {}) {
  return request(server, 'POST', options.project ?? 'p1', `/runs/${runId}/uploads/${uploadId}/complete`, {
    token: options.token,
  });
}

async function upload(server, bytes, options = {}) {
  const created = await createRun(server, bytes, options);
  assert.equal(created.status, 201);
  const ticket = await created.json();
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    const put = await putChunk(server, ticket.runId, ticket.upload.uploadId, offset / chunkBytes, chunk, options);
    assert.equal(put.status, 204);
  }
  const done = await complete(server, ticket.runId, ticket.upload.uploadId, options);
  assert.equal(done.status, 200);
  return { ticket, summary: await done.json() };
}

async function errorBody(response) {
  const body = await response.json();
  assert.equal(body.error.status, response.status);
  return body.error;
}

test('uploads, lists, downloads and renders a run', async t => {
  const { server } = await serve(t);
  const { ticket, summary } = await upload(server, smallBundle);
  assert.equal(summary.projectId, 'p1');
  assert.equal(summary.runId, ticket.runId);
  assert.equal(summary.flowId, 'textedit-save');
  assert.equal(summary.status, 'passed');
  assert.equal(summary.mode, 'dry-run');
  assert.deepEqual(summary.entryCounts, { passed: 0, failed: 0, blocked: 0, skipped: 0, resolved: 3 });
  assert.equal(summary.artifact.bundleSha256, sha256(smallBundle));
  assert.equal(summary.artifact.state, 'available');

  const listed = await request(server, 'GET', 'p1', '/runs');
  assert.equal(listed.status, 200);
  const page = await listed.json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].runId, ticket.runId);
  assert.equal(page.nextCursor, null);

  const detail = await request(server, 'GET', 'p1', `/runs/${ticket.runId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), summary);

  const bundle = await request(server, 'GET', 'p1', `/runs/${ticket.runId}/bundle`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('content-type'), 'application/zip');
  assert.match(bundle.headers.get('content-disposition'), /^attachment; filename="textedit-save-/);
  assert.equal(bundle.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), smallBundle);

  const viewer = await request(server, 'GET', 'p1', `/runs/${ticket.runId}/viewer`);
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get('content-type'), /^text\/html/);
  const policy = viewer.headers.get('content-security-policy');
  assert.match(policy, /sandbox/);
  assert.match(policy, /default-src 'none'/);
  assert.doesNotMatch(policy, /allow-scripts/);
  assert.match(await viewer.text(), /textedit-save/);

  // Replaying the same bytes and key returns the same ready run.
  const replay = await createRun(server, smallBundle);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { runId: ticket.runId, state: 'ready' });
  const afterReplay = await (await request(server, 'GET', 'p1', '/runs')).json();
  assert.equal(afterReplay.items.length, 1);
});

test('enforces bearer tokens, project ownership and scopes', async t => {
  const { server } = await serve(t);
  const missing = await request(server, 'GET', 'p1', '/runs', { token: null });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await errorBody(missing)).code, 'UNAUTHENTICATED');

  const wrong = await request(server, 'GET', 'p1', '/runs', { token: 'nope' });
  assert.equal(wrong.status, 401);

  const crossProject = await request(server, 'GET', 'p2', '/runs', { token: 'p1-write' });
  assert.equal(crossProject.status, 403);
  assert.equal((await errorBody(crossProject)).code, 'FORBIDDEN');

  const unknownProject = await request(server, 'GET', 'p9', '/runs');
  assert.equal(unknownProject.status, 404);
  assert.equal((await errorBody(unknownProject)).code, 'NOT_FOUND');

  const readOnlyWrite = await createRun(server, smallBundle, { token: 'read-only' });
  assert.equal(readOnlyWrite.status, 403);
  assert.equal((await errorBody(readOnlyWrite)).code, 'FORBIDDEN');

  const readOnlyRead = await request(server, 'GET', 'p1', '/runs', { token: 'read-only' });
  assert.equal(readOnlyRead.status, 200);
});

test('resumes an interrupted second chunk and reports chunk conflicts', async t => {
  const { server } = await serve(t);
  const created = await createRun(server, bigBundle, { token: 'p1-write' });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  const length = bigBundle.length;
  assert.ok(length > chunkBytes, 'fixture must span two chunks');
  const first = bigBundle.subarray(0, chunkBytes);
  const second = bigBundle.subarray(chunkBytes);

  // Chunk 1 before chunk 0 is out of order even though its length is valid.
  const skipped = await putChunk(server, ticket.runId, ticket.upload.uploadId, 1, second);
  assert.equal(skipped.status, 409);
  assert.equal((await errorBody(skipped)).code, 'CHUNK_OUT_OF_ORDER');

  assert.equal((await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, first)).status, 204);

  // A retried create returns the same active session and its confirmed offset.
  const resumed = await createRun(server, bigBundle);
  assert.equal(resumed.status, 200);
  const resumedTicket = await resumed.json();
  assert.equal(resumedTicket.upload.uploadId, ticket.upload.uploadId);
  assert.equal(resumedTicket.upload.committedBytes, chunkBytes);

  // The same chunk is idempotent, a different chunk at that index is not.
  assert.equal((await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, first)).status, 204);
  const conflicting = Buffer.from(first);
  conflicting[0] ^= 0xff;
  const conflict = await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, conflicting);
  assert.equal(conflict.status, 409);
  assert.equal((await errorBody(conflict)).code, 'CHUNK_CONFLICT');

  const incomplete = await complete(server, ticket.runId, ticket.upload.uploadId);
  assert.equal(incomplete.status, 409);
  assert.equal((await errorBody(incomplete)).code, 'UPLOAD_INCOMPLETE');

  assert.equal((await putChunk(server, ticket.runId, ticket.upload.uploadId, 1, second)).status, 204);
  const done = await complete(server, ticket.runId, ticket.upload.uploadId);
  assert.equal(done.status, 200);

  const after = await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, first);
  assert.equal(after.status, 409);
  assert.equal((await errorBody(after)).code, 'UPLOAD_FINALIZED');

  const bundle = await request(server, 'GET', 'p1', `/runs/${ticket.runId}/bundle`);
  assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), bigBundle);
});

test('rejects idempotency conflicts, wrong media types and chunk digests', async t => {
  const { server } = await serve(t, { maxBundleBytes: 1024 * 1024 });
  const key = sha256(smallBundle);
  const first = await createRun(server, smallBundle);
  assert.equal(first.status, 201);
  const ticket = await first.json();

  const differentSize = await createRun(server, smallBundle, { key, size: smallBundle.length + 1 });
  assert.equal(differentSize.status, 409);
  assert.equal((await errorBody(differentSize)).code, 'IDEMPOTENCY_CONFLICT');

  const overLimit = await createRun(server, smallBundle, { key: 'a'.repeat(64), size: 2 * 1024 * 1024 });
  assert.equal(overLimit.status, 413);
  assert.equal((await errorBody(overLimit)).code, 'PAYLOAD_TOO_LARGE');

  const beyondProtocol = await createRun(server, smallBundle, { key: 'b'.repeat(64), size: 1_073_741_825 });
  assert.equal(beyondProtocol.status, 400);
  assert.equal((await errorBody(beyondProtocol)).code, 'BAD_REQUEST');

  const wrongType = await request(server, 'PUT', 'p1',
    `/runs/${ticket.runId}/uploads/${ticket.upload.uploadId}/chunks/0`, {
      headers: { 'content-type': 'text/plain', 'x-chunk-sha256': sha256(smallBundle) },
      body: smallBundle,
    });
  assert.equal(wrongType.status, 415);
  assert.equal((await errorBody(wrongType)).code, 'UNSUPPORTED_MEDIA_TYPE');

  const badChunk = await request(server, 'PUT', 'p1',
    `/runs/${ticket.runId}/uploads/${ticket.upload.uploadId}/chunks/0`, {
      headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': 'c'.repeat(64) },
      body: smallBundle,
    });
  assert.equal(badChunk.status, 422);
  assert.equal((await errorBody(badChunk)).code, 'CHUNK_DIGEST_MISMATCH');

  // The failed digest did not advance the session.
  const state = await createRun(server, smallBundle);
  assert.equal((await state.json()).upload.committedBytes, 0);
});

test('rejects a tampered or escaping archive and records the rejection', async t => {
  const { server } = await serve(t);
  const files = unzipSync(smallBundle);
  const tampered = Buffer.from(zipSync({ ...files, 'report.json': strToU8('{"version":1}') }));
  const created = await createRun(server, tampered);
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal((await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, tampered)).status, 204);
  const done = await complete(server, ticket.runId, ticket.upload.uploadId);
  assert.equal(done.status, 422);
  assert.equal((await errorBody(done)).code, 'BUNDLE_INVALID');

  assert.equal((await request(server, 'GET', 'p1', `/runs/${ticket.runId}`)).status, 404);
  assert.equal((await request(server, 'GET', 'p1', '/runs')).status, 200);
  assert.equal((await (await request(server, 'GET', 'p1', '/runs')).json()).items.length, 0);

  const replay = await createRun(server, tampered);
  assert.equal(replay.status, 422);
  assert.equal((await errorBody(replay)).code, 'BUNDLE_INVALID');

  const escaping = Buffer.from(zipSync({ ...files, '../escape.txt': strToU8('x') }));
  const escapeCreate = await createRun(server, escaping);
  const escapeTicket = await escapeCreate.json();
  assert.equal((await putChunk(server, escapeTicket.runId, escapeTicket.upload.uploadId, 0, escaping)).status, 204);
  const escaped = await complete(server, escapeTicket.runId, escapeTicket.upload.uploadId);
  assert.equal(escaped.status, 422);
  assert.equal((await errorBody(escaped)).code, 'BUNDLE_INVALID');
});

test('rejects a bundle whose bytes do not match the idempotency key', async t => {
  const { server } = await serve(t);
  const otherBytes = Buffer.from(smallBundle);
  otherBytes[otherBytes.length - 1] ^= 0xff;
  assert.notEqual(sha256(otherBytes), sha256(smallBundle));
  const key = sha256(otherBytes);
  const created = await createRun(server, otherBytes, { key, size: smallBundle.length });
  assert.equal(created.status, 201);
  const ticket = await created.json();
  assert.equal((await putChunk(server, ticket.runId, ticket.upload.uploadId, 0, smallBundle)).status, 204);
  const done = await complete(server, ticket.runId, ticket.upload.uploadId);
  assert.equal(done.status, 422);
  assert.equal((await errorBody(done)).code, 'BUNDLE_DIGEST_MISMATCH');

  // The run stays pending with a fresh session; the key can be retried.
  const retry = await createRun(server, otherBytes, { key, size: smallBundle.length });
  assert.equal(retry.status, 200);
  const ticket2 = await retry.json();
  assert.equal(ticket2.state, 'pending');
  assert.notEqual(ticket2.upload.uploadId, ticket.upload.uploadId);
  assert.equal(ticket2.upload.committedBytes, 0);
});

test('persists runs across a restart', async t => {
  const dataDir = temporary(t);
  const first = await serve(t, { dataDir });
  const { ticket } = await upload(first.server, smallBundle);
  await first.server.close();

  const second = await serve(t, { dataDir });
  const listed = await (await request(second.server, 'GET', 'p1', '/runs')).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].runId, ticket.runId);
  const bundle = await request(second.server, 'GET', 'p1', `/runs/${ticket.runId}/bundle`);
  assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), smallBundle);
  const replay = await createRun(second.server, smallBundle);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).runId, ticket.runId);
});

test('paginates and filters runs by flow, status and start time', async t => {
  const { server } = await serve(t);
  const runs = [];
  for (const startedAt of ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']) {
    runs.push(await upload(server, bundleFor({ startedAt })));
  }
  assert.deepEqual(runs.map(run => run.summary.startedAt),
    ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);

  const first = await (await request(server, 'GET', 'p1', '/runs?limit=2')).json();
  assert.deepEqual(first.items.map(item => item.startedAt),
    ['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z']);
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 1024);

  const second = await (await request(server, 'GET', 'p1',
    `/runs?limit=2&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map(item => item.startedAt), ['2026-01-01T00:00:00.000Z']);
  assert.equal(second.nextCursor, null);

  const filtered = await (await request(server, 'GET', 'p1', '/runs?flowId=textedit-save')).json();
  assert.equal(filtered.items.length, 3);
  const empty = await (await request(server, 'GET', 'p1', '/runs?status=failed')).json();
  assert.equal(empty.items.length, 0);
  const ranged = await (await request(server, 'GET', 'p1',
    '/runs?from=2026-01-02T00:00:00.000Z&to=2026-01-03T00:00:00.000Z')).json();
  assert.deepEqual(ranged.items.map(item => item.startedAt), ['2026-01-02T00:00:00.000Z']);

  const rebound = await request(server, 'GET', 'p1',
    `/runs?flowId=other-flow&cursor=${first.nextCursor}`);
  assert.equal(rebound.status, 400);
  assert.equal((await errorBody(rebound)).code, 'BAD_REQUEST');
  const unknownQuery = await request(server, 'GET', 'p1', '/runs?offset=1');
  assert.equal(unknownQuery.status, 400);
  const badRange = await request(server, 'GET', 'p1',
    '/runs?from=2026-01-03T00:00:00.000Z&to=2026-01-02T00:00:00.000Z');
  assert.equal(badRange.status, 400);
});

test('keeps summaries but returns 410 for expired artifacts', async t => {
  const { server } = await serve(t, { artifactTtlDays: 0 });
  const { ticket } = await upload(server, smallBundle);
  const detail = await (await request(server, 'GET', 'p1', `/runs/${ticket.runId}`)).json();
  assert.equal(detail.artifact.state, 'expired');
  const bundle = await request(server, 'GET', 'p1', `/runs/${ticket.runId}/bundle`);
  assert.equal(bundle.status, 410);
  assert.equal((await errorBody(bundle)).code, 'ARTIFACT_EXPIRED');
  const viewer = await request(server, 'GET', 'p1', `/runs/${ticket.runId}/viewer`);
  assert.equal(viewer.status, 410);
  const listed = await (await request(server, 'GET', 'p1', '/runs')).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].artifact.state, 'expired');
});

test('the shipped upload client can upload to this server', async t => {
  const { server } = await serve(t);
  const context = {
    config: normalizeUploadConfig({ url: server.url, projectId: 'p1', tokenEnv: 'CQ_SERVER_TOKEN' }),
    token: 'p1-write',
    fetch,
  };
  const first = await uploadBundle(context, new Uint8Array(smallBundle));
  const second = await uploadBundle(context, new Uint8Array(smallBundle));
  assert.equal(first.runId, second.runId);
  const listed = await (await request(server, 'GET', 'p1', '/runs')).json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].runId, first.runId);
});

test('the CLI packs a sample report and uploads it to this server', async t => {
  const { server } = await serve(t);
  const directory = temporary(t);
  const reportPath = join(directory, 'report.json');
  const flowPath = join(directory, 'flow.json');
  const zipPath = join(directory, 'report.zip');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(flowPath, `${JSON.stringify(flow, null, 2)}\n`);
  const env = cleanEnv({
    CUEKEEPER_UPLOAD_URL: server.url,
    CUEKEEPER_UPLOAD_PROJECT: 'p1',
    CUEKEEPER_UPLOAD_TOKEN: 'p1-write',
    CUEKEEPER_UPLOAD_QUEUE: join(directory, 'queue'),
  });
  const packed = await cliAsync(
    ['report', 'pack', reportPath, '--flow', flowPath, '--out', zipPath, '--json'], env);
  assert.equal(packed.code, 0, packed.stderr);
  const packData = JSON.parse(packed.stdout).data;
  assert.equal(packData.upload.queued, true);

  const uploaded = await cliAsync(['report', 'upload', '--json'], env);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(JSON.parse(uploaded.stdout).data.done, 1);

  const page = await (await request(server, 'GET', 'p1', '/runs')).json();
  assert.equal(page.items.length, 1);
  const run = page.items[0];
  assert.equal(run.artifact.bundleBytes, readFileSync(zipPath).length);
  const bundle = await request(server, 'GET', 'p1', `/runs/${run.runId}/bundle`);
  assert.deepEqual(Buffer.from(await bundle.arrayBuffer()), readFileSync(zipPath));
  const viewer = await request(server, 'GET', 'p1', `/runs/${run.runId}/viewer`);
  assert.equal(viewer.status, 200);
  assert.match(await viewer.text(), /textedit-save/);
});

test('serves pending and unknown runs as 404 and validates config', async t => {
  const { server } = await serve(t);
  const created = await createRun(server, smallBundle);
  const ticket = await created.json();
  assert.equal((await request(server, 'GET', 'p1', `/runs/${ticket.runId}`)).status, 404);
  assert.equal((await request(server, 'GET', 'p1', '/runs/run_missing')).status, 404);
  assert.equal((await request(server, 'GET', 'p1', '/nope')).status, 404);

  assert.throws(() => parseServerConfig({
    version: 1,
    projects: [{ id: 'p1' }],
    tokens: [{ id: 't', token: 'plaintext', scopes: ['runs:read'] }],
  }), ServerConfigError);
  assert.throws(() => parseServerConfig({
    version: 1,
    projects: [{ id: 'p1' }, { id: 'p1' }],
    tokens: [{ id: 't', tokenSha256: 'd'.repeat(64), scopes: ['runs:read'] }],
  }), /Duplicate server project/);
  assert.throws(() => parseServerConfig({
    version: 1,
    projects: [{ id: 'p1' }],
    tokens: [{ id: 't', tokenSha256: 'd'.repeat(64), scopes: ['runs:admin'] }],
  }), /unknown scope/);
});

test('prints a token digest for the server config', () => {
  const result = spawnSync(process.execPath, [cliPath, 'serve', '--hash-token'], {
    input: 'admin-token\n', encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), hashToken('admin-token'));
});
