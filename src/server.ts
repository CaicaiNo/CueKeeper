import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { ServerStore, writeFileAtomic } from './server-store.js';
import type { RunRecord, UploadRecord } from './server-store.js';
import { hashToken, protocolMaxBundleBytes } from './server-config.js';
import type { ServerConfig, ServerProject, ServerToken } from './server-config.js';
import { bundleDigest, BundleValidationError, validateBundle } from './server-bundle.js';
import type { BundleSummary } from './server-bundle.js';
import { sha256Hex, uploadChunkBytes } from './upload.js';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const cursorPattern = /^[A-Za-z0-9_-]+$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uploadSessionTtlMs = 24 * 60 * 60 * 1000;
const verificationLeaseMs = 120_000;
const maxJsonBodyBytes = 64 * 1024;
const cleanupIntervalMs = 10 * 60 * 1000;
const viewerCsp = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const retryableCodes = new Set([
  'CHUNK_OUT_OF_ORDER', 'UPLOAD_INCOMPLETE', 'UPLOAD_EXPIRED', 'UPLOAD_FINALIZED',
  'UPLOAD_VERIFYING', 'RATE_LIMITED', 'SERVER_ERROR',
]);

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryableCodes.has(code) || status >= 500;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A staged chunk disappeared or changed under a verifying session. */
class StagingLostError extends Error {}

const errors = {
  badRequest: (message: string) => new HttpError(400, 'BAD_REQUEST', message),
  unauthenticated: (message = 'A bearer token is required') => new HttpError(401, 'UNAUTHENTICATED', message),
  forbidden: (message: string) => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string, retryAfterSeconds?: number) =>
    new HttpError(409, code, message, retryAfterSeconds),
  artifactExpired: (message = 'The bundle and viewer have expired; the run summary is still available') =>
    new HttpError(410, 'ARTIFACT_EXPIRED', message),
  tooLarge: (message: string) => new HttpError(413, 'PAYLOAD_TOO_LARGE', message),
  unsupported: (message: string) => new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message),
  chunkDigest: (message: string) => new HttpError(422, 'CHUNK_DIGEST_MISMATCH', message),
  bundleDigest: (message: string) => new HttpError(422, 'BUNDLE_DIGEST_MISMATCH', message),
  bundleInvalid: (message: string) => new HttpError(422, 'BUNDLE_INVALID', message),
  server: (message = 'Internal server error') => new HttpError(500, 'SERVER_ERROR', message),
};

interface ProjectContext {
  token: ServerToken;
  project: ServerProject;
}

interface ListQuery {
  flowId?: string;
  status?: 'passed' | 'failed' | 'blocked';
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function newId(prefix: string) {
  return `${prefix}${randomBytes(10).toString('hex')}`;
}

function mediaType(request: IncomingMessage) {
  return String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function parseIndex(value: string): number {
  if (!/^\d{1,3}$/.test(value)) throw errors.badRequest('Chunk index must be a decimal integer');
  const index = Number(value);
  if (index > 127) throw errors.badRequest('Chunk index must be between 0 and 127');
  return index;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      throw errors.badRequest('Content-Length must be a decimal integer');
    }
    if (Number(declared) > limit) throw errors.tooLarge('Request body exceeds the limit');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw errors.tooLarge('Request body exceeds the limit');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, requestId: string, error: HttpError) {
  const headers: Record<string, string> = { Connection: 'close' };
  if (error.status === 401) headers['WWW-Authenticate'] = 'Bearer';
  if (error.retryAfterSeconds !== undefined) headers['Retry-After'] = String(error.retryAfterSeconds);
  // ErrorResponse.message is capped at 512 characters and must stay readable.
  const message = error.message.length > 512 ? `${error.message.slice(0, 511)}…` : error.message;
  sendJson(response, error.status, {
    requestId,
    error: {
      status: error.status,
      code: error.code,
      retryable: error.retryable,
      message,
    },
  }, headers);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function artifactExpired(run: RunRecord, now: number) {
  const artifact = run.artifact;
  if (!artifact) return true;
  return Boolean(artifact.deletedAt) || Date.parse(artifact.expiresAt) <= now;
}

function artifactState(run: RunRecord, now: number): 'available' | 'expired' {
  return artifactExpired(run, now) ? 'expired' : 'available';
}

function summaryOf(run: RunRecord, now: number) {
  if (!run.summary || !run.artifact || !run.completedAt) {
    throw errors.server('Run summary is missing');
  }
  return {
    projectId: run.projectId,
    runId: run.id,
    flowId: run.summary.flowId,
    flowSha256: run.summary.flowSha256,
    startedAt: run.summary.startedAt,
    completedAt: run.completedAt,
    mode: run.summary.mode,
    status: run.summary.status,
    durationMs: run.summary.durationMs,
    entryCounts: run.summary.entryCounts,
    artifact: {
      artifactId: run.artifact.id,
      bundleSha256: run.bundleSha256,
      bundleBytes: run.bundleBytes,
      expiresAt: run.artifact.expiresAt,
      state: artifactState(run, now),
    },
  };
}

function compareRunsDescending(left: RunRecord, right: RunRecord) {
  const leftStarted = left.summary?.startedAt ?? left.createdAt;
  const rightStarted = right.summary?.startedAt ?? right.createdAt;
  if (leftStarted !== rightStarted) return leftStarted < rightStarted ? 1 : -1;
  return left.id < right.id ? 1 : -1;
}

function filterFingerprint(query: ListQuery) {
  return createHash('sha256')
    .update(JSON.stringify([query.flowId ?? null, query.status ?? null, query.from ?? null, query.to ?? null]))
    .digest('hex');
}

function encodeCursor(projectId: string, query: ListQuery, run: RunRecord) {
  const startedAt = run.summary!.startedAt;
  return Buffer.from(JSON.stringify({
    v: 1, p: projectId, f: filterFingerprint(query), s: startedAt, r: run.id,
  })).toString('base64url');
}

function decodeCursor(cursor: string, projectId: string, query: ListQuery): { startedAt: string; runId: string } {
  if (!cursorPattern.test(cursor) || cursor.length > 1024) throw errors.badRequest('Invalid cursor');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw errors.badRequest('Invalid cursor');
  }
  if (!isRecord(value) || value.v !== 1 || value.p !== projectId ||
      value.f !== filterFingerprint(query) ||
      typeof value.s !== 'string' || !timestampPattern.test(value.s) ||
      typeof value.r !== 'string' || !idPattern.test(value.r)) {
    throw errors.badRequest('Cursor does not match this project or filter');
  }
  return { startedAt: value.s, runId: value.r };
}

function afterCursor(run: RunRecord, cursor: { startedAt: string; runId: string }) {
  const startedAt = run.summary!.startedAt;
  if (startedAt !== cursor.startedAt) return startedAt < cursor.startedAt;
  return run.id < cursor.runId;
}

function parseListQuery(url: URL): ListQuery {
  const allowed = new Set(['flowId', 'status', 'from', 'to', 'limit', 'cursor']);
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) throw errors.badRequest(`Unknown query parameter: ${key}`);
    if (params.has(key)) throw errors.badRequest(`Duplicate query parameter: ${key}`);
    params.set(key, value);
  }
  const query: ListQuery = { limit: 50 };
  const flowId = params.get('flowId');
  if (flowId !== undefined) {
    if (!idPattern.test(flowId)) throw errors.badRequest('flowId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');
    query.flowId = flowId;
  }
  const status = params.get('status');
  if (status !== undefined) {
    if (status !== 'passed' && status !== 'failed' && status !== 'blocked') {
      throw errors.badRequest('status must be passed, failed or blocked');
    }
    query.status = status;
  }
  const from = params.get('from');
  if (from !== undefined) {
    if (!timestampPattern.test(from)) throw errors.badRequest('from must be a UTC timestamp with milliseconds');
    query.from = from;
  }
  const to = params.get('to');
  if (to !== undefined) {
    if (!timestampPattern.test(to)) throw errors.badRequest('to must be a UTC timestamp with milliseconds');
    query.to = to;
  }
  if (query.from !== undefined && query.to !== undefined && !(query.from < query.to)) {
    throw errors.badRequest('from must be earlier than to');
  }
  const limit = params.get('limit');
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit)) throw errors.badRequest('limit must be a decimal integer');
    const value = Number(limit);
    if (value < 1 || value > 100) throw errors.badRequest('limit must be from 1 to 100');
    query.limit = value;
  }
  const cursor = params.get('cursor');
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

function allowedHostnames(config: ServerConfig) {
  const names = new Set<string>([config.host.replace(/^\[|\]$/g, '').toLowerCase()]);
  if (['127.0.0.1', '::1', 'localhost'].includes(config.host.replace(/^\[|\]$/g, '').toLowerCase())) {
    for (const name of ['127.0.0.1', 'localhost', '::1']) names.add(name);
  }
  return names;
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end < 0 ? undefined : host.slice(1, end).toLowerCase();
  }
  const colon = host.indexOf(':');
  return (colon < 0 ? host : host.slice(0, colon)).toLowerCase();
}

export interface StartServerOptions {
  config: ServerConfig;
  dataDir: string;
  /** Overrides `config.port` (used by tests to ask the OS for a port). */
  port?: number;
  signal?: AbortSignal;
}

export interface StartedServer {
  url: string;
  port: number;
  store: ServerStore;
  closed: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Start the upload API on a loopback address. The server owns one data
 * directory; restarting it reuses the same metadata and content-addressed
 * bundles.
 */
export async function startServer(options: StartServerOptions): Promise<StartedServer> {
  const { config } = options;
  const store = new ServerStore(options.dataDir);
  await store.open();
  await store.cleanup();

  const projects = new Map(config.projects.map(project => [project.id, project]));
  const tokens = new Map(config.tokens.map(token => [token.sha256, token]));
  const hosts = allowedHostnames(config);
  const port = options.port ?? config.port;

  function authenticate(request: IncomingMessage, projectId: string): ProjectContext {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) throw errors.unauthenticated();
    const token = tokens.get(hashToken(match[1]));
    if (!token) throw errors.unauthenticated('The bearer token is not valid');
    if (token.projectId !== undefined && token.projectId !== projectId) {
      throw errors.forbidden('The token cannot access this project');
    }
    const project = projects.get(projectId);
    if (!project) throw errors.notFound('Unknown project');
    return { token, project };
  }

  function requireScope(context: ProjectContext, scope: 'runs:write' | 'runs:read') {
    if (!context.token.scopes.includes(scope)) {
      throw errors.forbidden(`The token lacks the ${scope} scope`);
    }
  }

  function ticket(run: RunRecord, upload: UploadRecord) {
    return {
      runId: run.id,
      state: 'pending',
      upload: {
        uploadId: upload.id,
        chunkBytes: uploadChunkBytes,
        committedBytes: upload.committedBytes,
        expiresAt: upload.expiresAt,
      },
    };
  }

  async function newUpload(run: RunRecord, now: number) {
    const upload: UploadRecord = {
      id: newId('upl_'),
      runId: run.id,
      state: 'receiving',
      committedBytes: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + uploadSessionTtlMs).toISOString(),
      chunks: [],
    };
    store.addUpload(upload);
    run.currentUploadId = upload.id;
    return upload;
  }

  async function closeUpload(upload: UploadRecord, rejection?: { status: number; code: string }) {
    upload.state = 'closed';
    upload.chunks = [];
    upload.verificationLeaseUntil = undefined;
    upload.verificationOwner = undefined;
    if (rejection) upload.rejection = rejection;
    await rm(store.stagingPath(upload.id), { recursive: true, force: true });
  }

  async function currentSession(run: RunRecord, now: number) {
    const current = run.currentUploadId ? store.uploadsById.get(run.currentUploadId) : undefined;
    if (current && current.state === 'completed') {
      // A completed session belongs to a ready run; a pending run at this point
      // needs a fresh session so the client can finish the same bundle.
      const upload = await newUpload(run, now);
      return { upload, changed: true };
    }
    if (current && current.state === 'receiving' && Date.parse(current.expiresAt) > now) {
      return { upload: current, changed: false };
    }
    if (current && current.state === 'verifying' && Date.parse(current.expiresAt) > now) {
      return { upload: current, changed: false };
    }
    if (current) await closeUpload(current);
    const upload = await newUpload(run, now);
    return { upload, changed: true };
  }

  function remainingBundleBytes(run: RunRecord, index: number) {
    const offset = index * uploadChunkBytes;
    if (offset >= run.bundleBytes) throw errors.badRequest('Chunk index is outside the bundle');
    return Math.min(uploadChunkBytes, run.bundleBytes - offset);
  }

  async function handleCreate(context: ProjectContext, request: IncomingMessage, response: ServerResponse) {
    requireScope(context, 'runs:write');
    if (mediaType(request) !== 'application/json') {
      throw errors.unsupported('Creating a run requires application/json');
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !sha256Pattern.test(key)) {
      throw errors.badRequest('Idempotency-Key must be a lowercase SHA-256');
    }
    const body = await readBody(request, maxJsonBodyBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    } catch {
      throw errors.badRequest('Request body is not valid JSON');
    }
    if (!isRecord(payload) || Object.keys(payload).some(field => field !== 'bundleBytes')) {
      throw errors.badRequest('Request body must contain only bundleBytes');
    }
    const bundleBytes = payload.bundleBytes;
    if (!Number.isInteger(bundleBytes) || (bundleBytes as number) < 1 ||
        (bundleBytes as number) > protocolMaxBundleBytes) {
      throw errors.badRequest(`bundleBytes must be an integer from 1 to ${protocolMaxBundleBytes}`);
    }
    const bytes = bundleBytes as number;
    const now = Date.now();
    const result = await store.locked(async () => {
      const existing = store.state.runs.find(run =>
        run.projectId === context.project.id && run.bundleSha256 === key);
      if (existing) {
        if (existing.bundleBytes !== bytes) {
          throw errors.conflict('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different size');
        }
        if (existing.state === 'ready') {
          return { status: 200, body: { runId: existing.id, state: 'ready' } };
        }
        if (existing.state === 'rejected') {
          const rejection = existing.rejection ?? { status: 422, code: 'BUNDLE_INVALID' };
          throw new HttpError(rejection.status, rejection.code, rejectionMessage(rejection.code));
        }
        const { upload, changed } = await currentSession(existing, now);
        if (changed) await store.persist();
        return { status: 200, body: ticket(existing, upload) };
      }
      if (bytes > context.project.maxBundleBytes) {
        throw errors.tooLarge(`bundleBytes exceeds the project limit of ${context.project.maxBundleBytes}`);
      }
      const run: RunRecord = {
        id: newId('run_'),
        projectId: context.project.id,
        bundleSha256: key,
        bundleBytes: bytes,
        state: 'pending',
        createdAt: new Date(now).toISOString(),
      };
      store.addRun(run);
      const upload = await newUpload(run, now);
      await store.persist();
      return { status: 201, body: ticket(run, upload) };
    });
    sendJson(response, result.status, result.body);
  }

  async function handleChunk(
    context: ProjectContext, request: IncomingMessage, response: ServerResponse,
    runId: string, uploadId: string, indexText: string,
  ) {
    requireScope(context, 'runs:write');
    const run = store.runFor(context.project.id, runId);
    const upload = run ? store.uploadFor(run, uploadId) : undefined;
    if (!run || !upload) throw errors.notFound('Unknown run or upload');
    if (mediaType(request) !== 'application/octet-stream') {
      throw errors.unsupported('Chunks require application/octet-stream');
    }
    if (request.headers['content-encoding'] !== undefined) {
      throw errors.unsupported('Chunks must use the raw request bytes');
    }
    const declared = request.headers['content-length'];
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      throw errors.badRequest('Chunk requests require Content-Length');
    }
    const index = parseIndex(indexText);
    const expected = remainingBundleBytes(run, index);
    if (Number(declared) !== expected) {
      if (Number(declared) > uploadChunkBytes) throw errors.tooLarge('Chunk exceeds the protocol chunk size');
      throw errors.badRequest(`Chunk ${index} must be ${expected} bytes`);
    }
    const headerDigest = request.headers['x-chunk-sha256'];
    if (typeof headerDigest !== 'string' || !sha256Pattern.test(headerDigest)) {
      throw errors.badRequest('X-Chunk-Sha256 must be a lowercase SHA-256');
    }
    const body = await readBody(request, uploadChunkBytes);
    if (body.length !== expected) throw errors.badRequest(`Chunk ${index} must be ${expected} bytes`);
    if (sha256Hex(body) !== headerDigest) throw errors.chunkDigest('Chunk digest does not match X-Chunk-Sha256');

    const now = Date.now();
    await store.locked(async () => {
      const currentRun = store.runFor(context.project.id, runId);
      const current = currentRun ? store.uploadFor(currentRun, uploadId) : undefined;
      if (!currentRun || !current) throw errors.notFound('Unknown run or upload');
      if (current.state === 'verifying') {
        throw errors.conflict('UPLOAD_VERIFYING', 'Upload is being verified', 1);
      }
      if (current.state === 'completed') {
        throw errors.conflict('UPLOAD_FINALIZED', 'Upload is already finalized');
      }
      if (current.state === 'closed' || Date.parse(current.expiresAt) <= now) {
        await closeUpload(current);
        await store.persist();
        throw errors.conflict('UPLOAD_EXPIRED', 'Upload session expired');
      }
      const expectedIndex = current.committedBytes / uploadChunkBytes;
      if (index > expectedIndex) {
        throw errors.conflict('CHUNK_OUT_OF_ORDER', `Expected chunk ${expectedIndex}`);
      }
      if (index < expectedIndex) {
        const existing = current.chunks.find(chunk => chunk.index === index);
        if (existing && existing.sha256 === headerDigest && existing.bytes === body.length) return;
        throw errors.conflict('CHUNK_CONFLICT', 'A different chunk was already accepted at this index');
      }
      const path = store.chunkPath(current, { index, sha256: headerDigest });
      await writeFileAtomic(path, body);
      current.chunks.push({ index, bytes: body.length, sha256: headerDigest, storageKey: path });
      current.committedBytes += body.length;
      await store.persist();
    });
    response.writeHead(204).end();
  }

  async function assembleBundle(run: RunRecord, upload: UploadRecord) {
    const chunks = [...upload.chunks].sort((left, right) => left.index - right.index);
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const chunk of chunks) {
      if (chunk.index !== offset / uploadChunkBytes) throw new StagingLostError('Staged chunks are not contiguous');
      let bytes: Uint8Array;
      try {
        bytes = await readFile(chunk.storageKey);
      } catch {
        throw new StagingLostError('A staged chunk is missing');
      }
      if (bytes.length !== chunk.bytes || sha256Hex(bytes) !== chunk.sha256) {
        throw new StagingLostError('A staged chunk no longer matches its digest');
      }
      parts.push(bytes);
      offset += bytes.length;
    }
    if (offset !== run.bundleBytes) throw new StagingLostError('Staged bytes do not cover the bundle');
    return Buffer.concat(parts);
  }

  async function rejectRun(
    run: RunRecord, upload: UploadRecord, status: number, code: string, reject: boolean,
  ) {
    await store.locked(async () => {
      const currentRun = store.runsById.get(run.id);
      const current = store.uploadsById.get(upload.id);
      if (!current || !currentRun) return;
      await closeUpload(current, { status, code });
      if (reject) {
        currentRun.state = 'rejected';
        currentRun.rejection = { status, code };
      }
      await store.persist();
    });
  }

  async function releaseVerification(uploadId: string, owner: string) {
    await store.locked(async () => {
      const current = store.uploadsById.get(uploadId);
      if (!current || current.state !== 'verifying' || current.verificationOwner !== owner) return;
      current.state = 'receiving';
      current.verificationOwner = undefined;
      current.verificationLeaseUntil = undefined;
      await store.persist();
    }).catch(() => undefined);
  }

  async function handleComplete(
    context: ProjectContext, request: IncomingMessage, response: ServerResponse,
    runId: string, uploadId: string,
  ) {
    requireScope(context, 'runs:write');
    // A completion request has no body. Refuse one instead of leaving unread
    // bytes on a keep-alive connection.
    const declared = request.headers['content-length'];
    if ((declared !== undefined && declared !== '0') || request.headers['transfer-encoding'] !== undefined) {
      throw errors.badRequest('Complete requests have no body');
    }
    const now = Date.now();
    const claim = await store.locked(async () => {
      const run = store.runFor(context.project.id, runId);
      const upload = run ? store.uploadFor(run, uploadId) : undefined;
      if (!run || !upload) throw errors.notFound('Unknown run or upload');
      if (upload.state === 'completed') return { kind: 'done' as const, run };
      if (upload.state === 'closed') {
        if (upload.rejection) {
          throw new HttpError(upload.rejection.status, upload.rejection.code, rejectionMessage(upload.rejection.code));
        }
        throw errors.conflict('UPLOAD_EXPIRED', 'Upload session expired');
      }
      if (upload.state === 'verifying') {
        const lease = upload.verificationLeaseUntil ? Date.parse(upload.verificationLeaseUntil) : 0;
        if (lease > now) throw errors.conflict('UPLOAD_VERIFYING', 'Upload is being verified', 1);
        upload.state = 'receiving';
        upload.verificationOwner = undefined;
        upload.verificationLeaseUntil = undefined;
      }
      if (Date.parse(upload.expiresAt) <= now) {
        await closeUpload(upload);
        await store.persist();
        throw errors.conflict('UPLOAD_EXPIRED', 'Upload session expired');
      }
      if (upload.committedBytes !== run.bundleBytes) {
        throw errors.conflict('UPLOAD_INCOMPLETE',
          `Committed ${upload.committedBytes} of ${run.bundleBytes} bytes`);
      }
      const owner = newId('ver_');
      upload.state = 'verifying';
      upload.verificationOwner = owner;
      upload.verificationLeaseUntil = new Date(now + verificationLeaseMs).toISOString();
      await store.persist();
      return { kind: 'verify' as const, run, upload, owner };
    });

    if (claim.kind === 'done') {
      sendJson(response, 200, summaryOf(claim.run, Date.now()));
      return;
    }
    const { run, upload, owner } = claim;
    try {
      let bundle: Uint8Array;
      try {
        bundle = await assembleBundle(run, upload);
      } catch (error) {
        if (!(error instanceof StagingLostError)) throw error;
        await rejectRun(run, upload, 409, 'UPLOAD_EXPIRED', false);
        throw errors.conflict('UPLOAD_EXPIRED', 'Staged upload data was lost; start a new session');
      }
      if (bundle.length !== run.bundleBytes || bundleDigest(bundle) !== run.bundleSha256) {
        await rejectRun(run, upload, 422, 'BUNDLE_DIGEST_MISMATCH', false);
        throw errors.bundleDigest('Bundle digest does not match the idempotency key');
      }
      let summary: BundleSummary;
      try {
        summary = validateBundle(bundle);
      } catch (error) {
        if (!(error instanceof BundleValidationError)) throw error;
        await rejectRun(run, upload, error.status, error.code, true);
        throw new HttpError(error.status, error.code, error.message);
      }
      const objectPath = store.objectPath(run.projectId, run.bundleSha256);
      // Publish the bytes before the metadata that references them.
      if (await store.objectExists(objectPath)) {
        await rm(objectPath, { force: true });
      }
      await writeFileAtomic(objectPath, bundle);
      await writeFileAtomic(store.viewPath(run.id), summary.viewerHtml);
      const completedAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(completedAt) + context.project.artifactTtlDays * 86_400_000).toISOString();
      const published = await store.locked(async () => {
        const currentRun = store.runsById.get(run.id);
        const current = store.uploadsById.get(upload.id);
        if (!currentRun || !current) throw errors.server('Run disappeared during verification');
        if (current.state !== 'verifying' || current.verificationOwner !== owner) {
          throw errors.server('Verification ownership was lost');
        }
        currentRun.state = 'ready';
        currentRun.completedAt = completedAt;
        currentRun.summary = {
          flowId: summary.flowId,
          flowSha256: summary.flowSha256,
          startedAt: summary.startedAt,
          mode: summary.mode,
          status: summary.status,
          durationMs: summary.durationMs,
          entryCounts: summary.entryCounts,
        };
        currentRun.artifact = {
          id: newId('art_'),
          runId: currentRun.id,
          storageKey: objectPath,
          expiresAt,
        };
        current.state = 'completed';
        current.chunks = [];
        current.verificationOwner = undefined;
        current.verificationLeaseUntil = undefined;
        await store.persist();
        return summaryOf(currentRun, Date.now());
      });
      await rm(store.stagingPath(upload.id), { recursive: true, force: true });
      sendJson(response, 200, published);
    } catch (error) {
      await releaseVerification(upload.id, owner);
      throw error;
    }
  }

  async function handleList(context: ProjectContext, url: URL, response: ServerResponse) {
    requireScope(context, 'runs:read');
    const query = parseListQuery(url);
    const now = Date.now();
    const ready = store.state.runs
      .filter(run => run.projectId === context.project.id && run.state === 'ready' && run.summary)
      .filter(run => query.flowId === undefined || run.summary!.flowId === query.flowId)
      .filter(run => query.status === undefined || run.summary!.status === query.status)
      .filter(run => query.from === undefined || run.summary!.startedAt >= query.from)
      .filter(run => query.to === undefined || run.summary!.startedAt < query.to)
      .sort(compareRunsDescending);
    let boundary: { startedAt: string; runId: string } | undefined;
    if (query.cursor !== undefined) boundary = decodeCursor(query.cursor, context.project.id, query);
    const filtered = boundary ? ready.filter(run => afterCursor(run, boundary!)) : ready;
    const items = filtered.slice(0, query.limit);
    const nextCursor = filtered.length > query.limit ? encodeCursor(context.project.id, query, items.at(-1)!) : null;
    sendJson(response, 200, { items: items.map(run => summaryOf(run, now)), nextCursor });
  }

  async function handleGetRun(context: ProjectContext, runId: string, response: ServerResponse) {
    requireScope(context, 'runs:read');
    const run = store.runFor(context.project.id, runId);
    if (!run || run.state !== 'ready') throw errors.notFound('Unknown run');
    sendJson(response, 200, summaryOf(run, Date.now()));
  }

  async function handleBundle(context: ProjectContext, runId: string, response: ServerResponse) {
    requireScope(context, 'runs:read');
    const run = store.runFor(context.project.id, runId);
    if (!run || run.state !== 'ready') throw errors.notFound('Unknown run');
    if (artifactExpired(run, Date.now())) throw errors.artifactExpired();
    const path = run.artifact!.storageKey;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new HttpError(503, 'SERVER_ERROR', 'The bundle storage is unavailable');
    }
    const filename = `${run.summary!.flowId}-${run.id}.zip`.replace(/[^A-Za-z0-9._-]/g, '_');
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(createReadStream(path), response);
  }

  async function handleViewer(context: ProjectContext, runId: string, response: ServerResponse) {
    requireScope(context, 'runs:read');
    const run = store.runFor(context.project.id, runId);
    if (!run || run.state !== 'ready') throw errors.notFound('Unknown run');
    if (artifactExpired(run, Date.now())) throw errors.artifactExpired();
    let html: Uint8Array;
    try {
      html = await readFile(store.viewPath(run.id));
    } catch {
      // The packed viewer is preferred; a summary page keeps the endpoint useful
      // if an older data directory only has the bundle.
      const summary = summaryOf(run, Date.now());
      html = Buffer.from(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>${escapeHtml(summary.flowId)}</title>` +
        `<body><h1>${escapeHtml(summary.flowId)}</h1><p>${escapeHtml(summary.status)} · ${summary.durationMs} ms</p>` +
        `<dl><dt>run</dt><dd>${escapeHtml(summary.runId)}</dd>` +
        `<dt>started</dt><dd>${escapeHtml(summary.startedAt)}</dd>` +
        `<dt>completed</dt><dd>${escapeHtml(summary.completedAt)}</dd></dl></body></html>`);
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': viewerCsp,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(html);
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const requestId = newId('req_');
    try {
      const host = hostnameOf(request.headers.host);
      if (!host || !hosts.has(host)) throw errors.forbidden('Invalid Host header');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const create = /^\/api\/v1\/projects\/([^/]+)\/runs$/.exec(url.pathname);
      const item = /^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
      const bundle = /^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/bundle$/.exec(url.pathname);
      const viewer = /^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/viewer$/.exec(url.pathname);
      const chunk = /^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/uploads\/([^/]+)\/chunks\/([^/]+)$/
        .exec(url.pathname);
      const complete = /^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/uploads\/([^/]+)\/complete$/
        .exec(url.pathname);
      const match = create ?? item ?? bundle ?? viewer ?? chunk ?? complete;
      if (!match) throw errors.notFound('Unknown API route');
      const projectId = match[1];
      if (!idPattern.test(projectId)) throw errors.badRequest('Invalid projectId');
      const context = authenticate(request, projectId);
      if (create) {
        if (request.method === 'POST') {
          await handleCreate(context, request, response);
          return;
        }
        if (request.method === 'GET') {
          await handleList(context, url, response);
          return;
        }
        throw errors.notFound('Unknown API route');
      }
      const runId = match[2];
      if (!idPattern.test(runId)) throw errors.badRequest('Invalid runId');
      if (item) {
        if (request.method !== 'GET') throw errors.notFound('Unknown API route');
        await handleGetRun(context, runId, response);
        return;
      }
      if (bundle) {
        if (request.method !== 'GET') throw errors.notFound('Unknown API route');
        await handleBundle(context, runId, response);
        return;
      }
      if (viewer) {
        if (request.method !== 'GET') throw errors.notFound('Unknown API route');
        await handleViewer(context, runId, response);
        return;
      }
      const uploadId = match[3];
      if (!idPattern.test(uploadId)) throw errors.badRequest('Invalid uploadId');
      if (chunk) {
        if (request.method !== 'PUT') throw errors.notFound('Unknown API route');
        await handleChunk(context, request, response, runId, uploadId, match[4]);
        return;
      }
      if (request.method !== 'POST') throw errors.notFound('Unknown API route');
      await handleComplete(context, request, response, runId, uploadId);
    } catch (error) {
      const httpError = error instanceof HttpError
        ? error : errors.server();
      if (!(error instanceof HttpError)) {
        // Never log request bodies or authorization headers. A client that
        // aborts mid-upload leaves a closed socket behind; that is not a fault.
        const reason = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET' && reason !== 'Premature close') {
          console.error(`cuekeeper serve: ${requestId} ${reason}`);
        }
      }
      if (!response.headersSent) sendError(response, requestId, httpError);
      else response.destroy();
    }
  }

  const server = createServer((request, response) => {
    void route(request, response);
  });
  const closed = new Promise<void>(resolve => {
    server.once('close', () => {
      clearInterval(timer);
      resolve();
    });
  });
  const timer = setInterval(() => {
    void store.cleanup().catch(() => undefined);
  }, cleanupIntervalMs);
  timer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const displayHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' ? '[::1]' : config.host.includes(':') ? `[${config.host.replace(/^\[|\]$/g, '')}]`
      : config.host;
  const url = `http://${displayHost}:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      server.close();
      server.closeAllConnections();
      await closed;
    })();
    return closing;
  };
  if (options.signal?.aborted) void close();
  options.signal?.addEventListener('abort', () => {
    void close();
  }, { once: true });
  return { url, port: address.port, store, closed, close };
}

/** Explain a stored rejection code without storing request details. */
function rejectionMessage(code: string) {
  if (code === 'PAYLOAD_TOO_LARGE') return 'Bundle exceeds the deployment limit';
  return 'Bundle is invalid';
}
