import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fixed chunk size from the v1 upload protocol. */
export const uploadChunkBytes = 8_388_608;
/** Protocol hard limit for a bundle. */
export const uploadMaxBundleBytes = 1_073_741_824;
export const uploadMaxChunks = 128;

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const credentialPrefix = 'env:';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** A resolved upload target. The token itself is never part of this record. */
export interface UploadConfig {
  /** HTTPS origin (or loopback HTTP origin for a local mock server). */
  url: string;
  projectId: string;
  /** Credential reference such as `env:CUEKEEPER_UPLOAD_TOKEN`. */
  credentialRef: string;
}

export interface UploadProgress {
  uploadId: string;
  chunkBytes: number;
  committedBytes: number;
  expiresAt: string;
}

export interface CreateRunTicket {
  runId: string;
  state: 'pending' | 'ready';
  upload?: UploadProgress;
}

export type Recovery = 'stop' | 'retry' | 'recreate' | 'recomplete';

export class UploadConfigError extends Error {
  readonly code = 'UPLOAD_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'UploadConfigError';
  }
}

export class UploadError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(options: {
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = 'UploadError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface UploadContext {
  config: UploadConfig;
  token: string;
  fetch: Fetcher;
  signal?: AbortSignal;
  /** Per-request timeout; network stalls become retryable failures. */
  timeoutMs?: number;
}

const defaultRequestTimeoutMs = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUEKEEPER_UPLOAD_CONFIG || join(homedir(), '.cuekeeper', 'upload.json');
}

export function defaultQueueDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUEKEEPER_UPLOAD_QUEUE || join(homedir(), '.cuekeeper', 'upload-queue');
}

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Validate one upload target. The base URL is an origin only: paths, queries,
 * fragments and credentials in the URL are rejected so a token can never be
 * smuggled into a request URL.
 */
export function normalizeUploadConfig(input: { url: string; projectId: string; tokenEnv: string }): UploadConfig {
  if (!idPattern.test(input.projectId)) {
    throw new UploadConfigError('Upload projectId must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');
  }
  if (!envNamePattern.test(input.tokenEnv)) {
    throw new UploadConfigError('Upload tokenEnv must be an environment variable name');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new UploadConfigError(`Invalid upload URL: ${input.url}`);
  }
  if (parsed.username || parsed.password) {
    throw new UploadConfigError('Upload URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new UploadConfigError('Upload URL must not contain a query or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new UploadConfigError('Upload URL must be an origin without a path');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new UploadConfigError('Upload URL must use HTTPS; HTTP is only accepted for loopback mock servers');
  }
  return { url: parsed.origin, projectId: input.projectId, credentialRef: `${credentialPrefix}${input.tokenEnv}` };
}

function configFromEnv(env: NodeJS.ProcessEnv): UploadConfig | undefined {
  const url = env.CUEKEEPER_UPLOAD_URL?.trim();
  const projectId = env.CUEKEEPER_UPLOAD_PROJECT?.trim();
  const tokenEnv = env.CUEKEEPER_UPLOAD_TOKEN_ENV?.trim();
  const directToken = env.CUEKEEPER_UPLOAD_TOKEN;
  if (!url && !projectId && !tokenEnv && !directToken) return undefined;
  if (!url) throw new UploadConfigError('CUEKEEPER_UPLOAD_URL is required when upload is configured');
  if (!projectId) throw new UploadConfigError('CUEKEEPER_UPLOAD_PROJECT is required when upload is configured');
  if (!tokenEnv && !directToken) {
    throw new UploadConfigError('Set CUEKEEPER_UPLOAD_TOKEN_ENV (recommended) or CUEKEEPER_UPLOAD_TOKEN');
  }
  return normalizeUploadConfig({ url, projectId, tokenEnv: tokenEnv ?? 'CUEKEEPER_UPLOAD_TOKEN' });
}

export function parseUploadConfigFile(value: unknown): UploadConfig | undefined {
  if (!isRecord(value)) throw new UploadConfigError('Upload config must be a JSON object');
  const allowed = new Set(['version', 'enabled', 'url', 'projectId', 'tokenEnv']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new UploadConfigError(`Unknown upload config field: ${key}`);
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new UploadConfigError('Unsupported upload config version');
  }
  if (value.enabled === false) return undefined;
  if (typeof value.url !== 'string' || !value.url) throw new UploadConfigError('Upload config url is required');
  if (typeof value.projectId !== 'string' || !value.projectId) {
    throw new UploadConfigError('Upload config projectId is required');
  }
  if (typeof value.tokenEnv !== 'string' || !value.tokenEnv) {
    throw new UploadConfigError('Upload config tokenEnv is required (the token value is read from the environment)');
  }
  return normalizeUploadConfig({ url: value.url, projectId: value.projectId, tokenEnv: value.tokenEnv });
}

/**
 * Resolve the optional upload target. Environment fields win over the config
 * file. `undefined` means upload is not configured, which keeps local report
 * packing unchanged.
 */
export async function resolveUploadConfig(options: {
  env?: NodeJS.ProcessEnv;
  /** `null` skips the config file entirely. */
  configPath?: string | null;
} = {}): Promise<UploadConfig | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = configFromEnv(env);
  if (fromEnv) return fromEnv;
  if (options.configPath === null) return undefined;
  if (env.CUEKEEPER_UPLOAD_CONFIG && !options.configPath) options = { ...options, configPath: env.CUEKEEPER_UPLOAD_CONFIG };
  let raw: string;
  try {
    raw = await readFile(options.configPath ?? defaultConfigPath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !options.configPath) return undefined;
    throw new UploadConfigError(
      `Cannot read upload config ${options.configPath ?? defaultConfigPath(env)}: ${errorMessage(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new UploadConfigError('Upload config is not valid JSON');
  }
  return parseUploadConfigFile(value);
}

/** Read the token for a credential reference. Only environment references exist in v1. */
export function resolveCredential(credentialRef: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!credentialRef.startsWith(credentialPrefix)) {
    throw new UploadConfigError(`Unsupported credential reference: ${credentialRef}`);
  }
  const name = credentialRef.slice(credentialPrefix.length);
  const token = env[name];
  if (!token) throw new UploadConfigError(`Credential ${name} is not set`);
  return token;
}

function apiUrl(context: UploadContext, suffix: string) {
  return `${context.config.url}/api/v1/projects/${encodeURIComponent(context.config.projectId)}${suffix}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

async function call(context: UploadContext, url: string, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(context.timeoutMs ?? defaultRequestTimeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await context.fetch(url, { ...init, redirect: 'manual', signal });
  } catch (error) {
    if (context.signal?.aborted) {
      throw new UploadError({ code: 'INTERRUPTED', message: 'Upload interrupted', retryable: true });
    }
    if (timeout.aborted) {
      throw new UploadError({
        code: 'TIMEOUT',
        message: 'The upload request timed out',
        retryable: true,
      });
    }
    throw new UploadError({
      code: 'NETWORK_ERROR',
      message: `Cannot reach the upload server: ${errorMessage(error)}`,
      retryable: true,
    });
  }
  // API redirects are refused so the bearer token never follows a Location.
  if (response.status >= 300 && response.status < 400) {
    throw new UploadError({
      code: 'REDIRECT_REJECTED',
      status: response.status,
      message: 'The upload API returned a redirect, which is not allowed',
      retryable: false,
    });
  }
  return response;
}

function fallbackCode(status: number) {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return `HTTP_${status}`;
}

function fallbackRetryable(code: string, status: number) {
  if (code === 'RATE_LIMITED' || code === 'SERVER_ERROR') return true;
  return status >= 500;
}

async function responseError(response: Response): Promise<UploadError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    body = undefined;
  }
  if (isRecord(body) && isRecord(body.error)) {
    const detail = body.error;
    const code = typeof detail.code === 'string' && detail.code ? detail.code : fallbackCode(response.status);
    const message = typeof detail.message === 'string' && detail.message
      ? detail.message : `Upload request failed with HTTP ${response.status}`;
    return new UploadError({
      code,
      message,
      status: response.status,
      retryable: typeof detail.retryable === 'boolean' ? detail.retryable : fallbackRetryable(code, response.status),
      requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
      retryAfterMs,
    });
  }
  const code = fallbackCode(response.status);
  return new UploadError({
    code,
    message: `Upload request failed with HTTP ${response.status}`,
    status: response.status,
    retryable: fallbackRetryable(code, response.status),
    retryAfterMs,
  });
}

export function recoveryFor(error: UploadError): Recovery {
  switch (error.code) {
    case 'CHUNK_OUT_OF_ORDER':
    case 'UPLOAD_INCOMPLETE':
    case 'UPLOAD_EXPIRED':
    case 'UPLOAD_FINALIZED':
      return 'recreate';
    case 'UPLOAD_VERIFYING':
      return 'recomplete';
    case 'RATE_LIMITED':
    case 'SERVER_ERROR':
    case 'NETWORK_ERROR':
      return 'retry';
    default:
      return error.retryable ? 'retry' : 'stop';
  }
}

function invalidResponse(message: string) {
  return new UploadError({ code: 'INVALID_RESPONSE', message, retryable: false });
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json() as unknown;
  } catch {
    throw invalidResponse('Upload API returned an invalid JSON response');
  }
  if (!isRecord(body)) throw invalidResponse('Upload API returned an unexpected response shape');
  return body;
}

function parseTicket(body: Record<string, unknown>): CreateRunTicket {
  const runId = body.runId;
  if (typeof runId !== 'string' || !idPattern.test(runId)) throw invalidResponse('Create run response has no valid runId');
  if (body.state === 'ready') return { runId, state: 'ready' };
  if (body.state !== 'pending') throw invalidResponse('Create run response has an unknown state');
  const upload = body.upload;
  if (!isRecord(upload) || typeof upload.uploadId !== 'string' || !idPattern.test(upload.uploadId) ||
      typeof upload.chunkBytes !== 'number' || typeof upload.committedBytes !== 'number' ||
      typeof upload.expiresAt !== 'string') {
    throw invalidResponse('Create run response has no valid upload progress');
  }
  return {
    runId,
    state: 'pending',
    upload: {
      uploadId: upload.uploadId,
      chunkBytes: upload.chunkBytes,
      committedBytes: upload.committedBytes,
      expiresAt: upload.expiresAt,
    },
  };
}

export async function createRun(
  context: UploadContext,
  bundleBytes: number,
  bundleSha256: string,
): Promise<CreateRunTicket> {
  if (!sha256Pattern.test(bundleSha256)) throw new UploadConfigError('Idempotency key must be a lowercase SHA-256');
  const response = await call(context, apiUrl(context, '/runs'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${context.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': bundleSha256,
    },
    body: JSON.stringify({ bundleBytes }),
  });
  if (response.status !== 200 && response.status !== 201) throw await responseError(response);
  return parseTicket(await readJsonBody(response));
}

export async function putChunk(
  context: UploadContext,
  runId: string,
  uploadId: string,
  index: number,
  bytes: Uint8Array,
): Promise<void> {
  const response = await call(context, apiUrl(context, `/runs/${runId}/uploads/${uploadId}/chunks/${index}`), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${context.token}`,
      'content-type': 'application/octet-stream',
      'x-chunk-sha256': sha256Hex(bytes),
    },
    body: bytes,
  });
  if (response.status !== 204) throw await responseError(response);
}

export async function completeUpload(
  context: UploadContext,
  runId: string,
  uploadId: string,
): Promise<Record<string, unknown>> {
  const response = await call(context, apiUrl(context, `/runs/${runId}/uploads/${uploadId}/complete`), {
    method: 'POST',
    headers: { authorization: `Bearer ${context.token}`, accept: 'application/json' },
  });
  if (response.status !== 200) throw await responseError(response);
  return readJsonBody(response);
}

export interface UploadResult {
  runId: string;
  bundleSha256: string;
  bundleBytes: number;
}

export interface UploadBundleOptions {
  /** Wait between verification polls. Tests inject a recorder. */
  wait?: (ms: number) => Promise<void>;
  /** How many sessions one upload attempt may replace after a recoverable conflict. */
  maxRecoveries?: number;
  /** Reports confirmed progress so the queue can persist it. */
  onProgress?: (progress: { runId: string; uploadId: string; committedBytes: number }) => Promise<void> | void;
}

function pendingUpload(ticket: CreateRunTicket, bundleBytes: number): UploadProgress {
  if (ticket.state !== 'pending' || !ticket.upload) {
    throw invalidResponse('Create run response has no pending upload');
  }
  const upload = ticket.upload;
  if (upload.chunkBytes !== uploadChunkBytes) {
    throw invalidResponse(`Upload chunk size ${upload.chunkBytes} does not match the protocol`);
  }
  if (!Number.isInteger(upload.committedBytes) || upload.committedBytes < 0 ||
      upload.committedBytes > bundleBytes ||
      (upload.committedBytes !== bundleBytes && upload.committedBytes % uploadChunkBytes !== 0)) {
    throw invalidResponse('Upload progress is not aligned to chunk boundaries');
  }
  return upload;
}

/**
 * One upload attempt: create the run, send only the chunks the server has not
 * committed, then complete. Recoverable session conflicts replace the session
 * through the same idempotency key; network failures surface to the queue for
 * a persisted backoff retry.
 */
export async function uploadBundle(
  context: UploadContext,
  bytes: Uint8Array,
  options: UploadBundleOptions = {},
): Promise<UploadResult> {
  const bundleBytes = bytes.length;
  if (!bundleBytes) {
    throw new UploadError({ code: 'BUNDLE_INVALID', message: 'Bundle is empty', retryable: false });
  }
  if (bundleBytes > uploadMaxBundleBytes) {
    throw new UploadError({
      code: 'PAYLOAD_TOO_LARGE',
      message: `Bundle is ${bundleBytes} bytes; the protocol limit is ${uploadMaxBundleBytes} bytes`,
      retryable: false,
    });
  }
  const bundleSha256 = sha256Hex(bytes);
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxRecoveries = options.maxRecoveries ?? 4;
  const progress = async (runId: string, uploadId: string, committedBytes: number) => {
    await options.onProgress?.({ runId, uploadId, committedBytes });
  };

  let ticket = await createRun(context, bundleBytes, bundleSha256);
  if (ticket.state === 'ready') {
    return { runId: ticket.runId, bundleSha256, bundleBytes };
  }
  let upload = pendingUpload(ticket, bundleBytes);
  await progress(ticket.runId, upload.uploadId, upload.committedBytes);

  let recoveries = 0;
  let verificationPolls = 0;
  for (;;) {
    try {
      for (let offset = upload.committedBytes; offset < bundleBytes; offset += upload.chunkBytes) {
        const index = offset / upload.chunkBytes;
        const chunk = bytes.subarray(offset, Math.min(offset + upload.chunkBytes, bundleBytes));
        await putChunk(context, ticket.runId, upload.uploadId, index, chunk);
        upload = { ...upload, committedBytes: offset + chunk.length };
        await progress(ticket.runId, upload.uploadId, upload.committedBytes);
      }
      await completeUpload(context, ticket.runId, upload.uploadId);
      return { runId: ticket.runId, bundleSha256, bundleBytes };
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      const recovery = recoveryFor(error);
      if (recovery === 'recomplete' && verificationPolls < 5) {
        verificationPolls++;
        await wait(error.retryAfterMs ?? 1000);
        continue;
      }
      if (recovery === 'recreate' && recoveries < maxRecoveries) {
        recoveries++;
        ticket = await createRun(context, bundleBytes, bundleSha256);
        if (ticket.state === 'ready') {
          return { runId: ticket.runId, bundleSha256, bundleBytes };
        }
        upload = pendingUpload(ticket, bundleBytes);
        await progress(ticket.runId, upload.uploadId, upload.committedBytes);
        continue;
      }
      throw error;
    }
  }
}

/** Read a bundle from disk for a queue retry. */
export async function readBundle(path: string): Promise<Uint8Array> {
  return readFile(path);
}
