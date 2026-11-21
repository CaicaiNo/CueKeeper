import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  UploadConfigError, UploadError, resolveCredential, sha256Hex, uploadBundle,
} from './upload.js';
import type { Fetcher, UploadConfig } from './upload.js';

export interface UploadQueueFailure {
  code: string;
  message: string;
  retryable: boolean;
  at: string;
  status?: number;
  requestId?: string;
}

/**
 * One local upload job. The record intentionally contains only a credential
 * reference: the token value is read from the environment at send time and is
 * never written to the queue, the bundle, or an error message.
 */
export interface UploadQueueItem {
  version: 1;
  id: string;
  server: string;
  projectId: string;
  credentialRef: string;
  bundlePath: string;
  bundleBytes: number;
  bundleSha256: string;
  state: 'pending' | 'paused' | 'done';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  runId?: string;
  uploadId?: string;
  committedBytes?: number;
  completedAt?: string;
  lastError?: UploadQueueFailure;
}

export interface EnqueueResult {
  item: UploadQueueItem;
  created: boolean;
  duplicate: boolean;
}

export type QueueItemState = 'done' | 'pending' | 'paused' | 'skipped';

export interface QueueResult {
  id: string;
  bundleSha256: string;
  state: QueueItemState;
  runId?: string;
  code?: string;
  message?: string;
  nextAttemptAt?: string;
}

export interface QueueSummary {
  results: QueueResult[];
  done: number;
  pending: number;
  paused: number;
  skipped: number;
  interrupted: boolean;
}

export interface ProcessQueueOptions {
  queueDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  now?: () => Date;
  random?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** Resume paused items, keeping their idempotency key. */
  retryPaused?: boolean;
  maxAttempts?: number;
  signal?: AbortSignal;
}

const lockStaleMs = 10 * 60 * 1000;
const defaultMaxAttempts = 8;
const maxBackoffMs = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(now: Date) {
  return now.toISOString();
}

export function retryDelayMs(attempts: number, randomValue: number) {
  const base = Math.min(maxBackoffMs, 1000 * 2 ** Math.max(0, attempts - 1));
  const jitter = 0.8 + Math.min(1, Math.max(0, randomValue)) * 0.4;
  return Math.round(base * jitter);
}

/**
 * The queue file name binds a bundle to its server and project, so the same
 * bytes uploaded to two projects stay two independent jobs. Re-enqueuing the
 * same bundle for the same target is always the same job.
 */
function itemId(config: UploadConfig, bundleSha256: string) {
  return createHash('sha256').update(`${config.url}\n${config.projectId}\n${bundleSha256}`).digest('hex');
}

async function ensureQueueDir(queueDir: string) {
  await mkdir(queueDir, { recursive: true, mode: 0o700 });
}

function itemPath(queueDir: string, id: string) {
  return join(queueDir, `${id}.json`);
}

async function writeItem(path: string, item: UploadQueueItem) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

function parseItem(name: string, value: unknown): UploadQueueItem {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' ||
      typeof value.server !== 'string' || typeof value.projectId !== 'string' ||
      typeof value.credentialRef !== 'string' || typeof value.bundlePath !== 'string' ||
      typeof value.bundleBytes !== 'number' || typeof value.bundleSha256 !== 'string' ||
      (value.state !== 'pending' && value.state !== 'paused' && value.state !== 'done') ||
      typeof value.attempts !== 'number') {
    throw new Error(`Invalid upload queue item: ${name}`);
  }
  return value as unknown as UploadQueueItem;
}

async function readItem(path: string): Promise<UploadQueueItem | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid upload queue item: ${basename(path)}`);
  }
  return parseItem(basename(path), value);
}

/**
 * Add a packed bundle to the local queue. The ZIP itself stays where the pack
 * step wrote it; the queue keeps its path, size and digest and verifies them
 * again before every attempt.
 */
export async function enqueueUpload(options: {
  queueDir: string;
  config: UploadConfig;
  bundlePath: string;
  bytes: Uint8Array;
  now?: Date;
}): Promise<EnqueueResult> {
  const now = timestamp(options.now ?? new Date());
  const absolute = resolve(options.bundlePath);
  const bundleSha256 = sha256Hex(options.bytes);
  const id = itemId(options.config, bundleSha256);
  await ensureQueueDir(options.queueDir);
  const path = itemPath(options.queueDir, id);
  const existing = await readItem(path);
  if (existing) {
    if (existing.state === 'done') return { item: existing, created: false, duplicate: true };
    const restored = existing.lastError?.code === 'BUNDLE_MISSING' || existing.lastError?.code === 'BUNDLE_CHANGED';
    const next: UploadQueueItem = {
      ...existing,
      bundlePath: absolute,
      bundleBytes: options.bytes.length,
      bundleSha256,
      updatedAt: now,
      ...(restored ? { state: 'pending' as const, attempts: 0, nextAttemptAt: undefined } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(existing)) await writeItem(path, next);
    return { item: next, created: false, duplicate: true };
  }
  const item: UploadQueueItem = {
    version: 1,
    id,
    server: options.config.url,
    projectId: options.config.projectId,
    credentialRef: options.config.credentialRef,
    bundlePath: absolute,
    bundleBytes: options.bytes.length,
    bundleSha256,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeItem(path, item);
  return { item, created: true, duplicate: false };
}

async function acquireLock(path: string): Promise<{ release: () => Promise<void> } | undefined> {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { release: async () => { await unlink(lockPath).catch(() => undefined); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > lockStaleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

async function readBundleFor(item: UploadQueueItem): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(item.bundlePath);
  } catch {
    throw new UploadError({
      code: 'BUNDLE_MISSING',
      message: `Bundle is missing: ${item.bundlePath}`,
      retryable: false,
    });
  }
  if (bytes.length !== item.bundleBytes) {
    throw new UploadError({
      code: 'BUNDLE_CHANGED',
      message: `Bundle size changed since it was queued (expected ${item.bundleBytes} bytes, found ${bytes.length})`,
      retryable: false,
    });
  }
  if (sha256Hex(bytes) !== item.bundleSha256) {
    throw new UploadError({
      code: 'BUNDLE_CHANGED',
      message: 'Bundle content changed since it was queued',
      retryable: false,
    });
  }
  return bytes;
}

function failureOf(error: UploadError, at: string): UploadQueueFailure {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    at,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
  };
}

/**
 * Process due queue items once, serially. Retryable failures stay pending with
 * a persisted backoff time; non-retryable failures pause until the cause is
 * fixed and the item is explicitly resumed.
 */
export async function processUploadQueue(options: ProcessQueueOptions): Promise<QueueSummary> {
  const env = options.env ?? process.env;
  const fetchImpl: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? defaultMaxAttempts;

  await ensureQueueDir(options.queueDir);
  const names = (await readdir(options.queueDir)).filter(name => name.endsWith('.json')).sort();
  const results: QueueResult[] = [];
  let interrupted = false;

  for (const name of names) {
    const path = join(options.queueDir, name);
    let item: UploadQueueItem | undefined;
    try {
      item = await readItem(path);
    } catch (error) {
      results.push({ id: name.slice(0, -5), bundleSha256: '', state: 'paused', code: 'INVALID_QUEUE_ITEM',
        message: messageOf(error) });
      continue;
    }
    if (!item) continue;
    if (item.state === 'done') {
      results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'skipped', code: 'DONE',
        runId: item.runId });
      continue;
    }

    const lock = await acquireLock(path);
    if (!lock) {
      results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'skipped', code: 'LOCKED' });
      continue;
    }
    try {
      item = await readItem(path) ?? item;
      const clock = now();
      if (item.state === 'done') {
        results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'skipped', code: 'DONE',
          runId: item.runId });
        continue;
      }
      if (item.state === 'paused' && !options.retryPaused) {
        results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'skipped', code: 'PAUSED',
          message: item.lastError?.message });
        continue;
      }
      if (item.state === 'paused' && options.retryPaused) {
        item = { ...item, state: 'pending', attempts: 0, nextAttemptAt: undefined, updatedAt: timestamp(clock) };
        await writeItem(path, item);
      }
      if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > clock.getTime()) {
        results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'skipped', code: 'NOT_DUE',
          nextAttemptAt: item.nextAttemptAt });
        continue;
      }

      const config: UploadConfig = {
        url: item.server,
        projectId: item.projectId,
        credentialRef: item.credentialRef,
      };
      try {
        const bytes = await readBundleFor(item);
        const token = resolveCredential(item.credentialRef, env);
        const completed = await uploadBundle({ config, token, fetch: fetchImpl, signal: options.signal }, bytes, {
          wait,
          onProgress: async progress => {
            item = {
              ...item!,
              runId: progress.runId,
              uploadId: progress.uploadId,
              committedBytes: progress.committedBytes,
              updatedAt: timestamp(now()),
            };
            await writeItem(path, item);
          },
        });
        item = {
          ...item,
          state: 'done',
          runId: completed.runId,
          committedBytes: completed.bundleBytes,
          completedAt: timestamp(now()),
          updatedAt: timestamp(now()),
          nextAttemptAt: undefined,
          lastError: undefined,
        };
        await writeItem(path, item);
        results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'done', runId: item.runId });
      } catch (error) {
        const clockNow = now();
        if (error instanceof UploadError && error.code === 'INTERRUPTED') {
          item = { ...item, state: 'pending', updatedAt: timestamp(clockNow), nextAttemptAt: undefined };
          await writeItem(path, item);
          results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'pending', code: 'INTERRUPTED',
            message: error.message });
          interrupted = true;
          break;
        }
        const uploadError = error instanceof UploadError ? error : undefined;
        const configError = error instanceof UploadError ? false : error instanceof UploadConfigError;
        const code = uploadError?.code ?? (configError ? 'UPLOAD_CONFIG' : 'UPLOAD_FAILED');
        const retryable = uploadError?.retryable ?? false;
        const message = messageOf(error);
        const attempts = item.attempts + 1;
        const failure: UploadQueueFailure = uploadError
          ? failureOf(uploadError, timestamp(clockNow))
          : { code, message, retryable, at: timestamp(clockNow) };
        if (retryable && attempts < maxAttempts) {
          const delay = uploadError?.retryAfterMs ?? retryDelayMs(attempts, random());
          const nextAttemptAt = timestamp(new Date(clockNow.getTime() + delay));
          item = {
            ...item, state: 'pending', attempts, nextAttemptAt,
            lastError: failure, updatedAt: timestamp(clockNow),
          };
          await writeItem(path, item);
          results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'pending', code,
            message, nextAttemptAt });
        } else {
          const exhausted = retryable && attempts >= maxAttempts;
          item = {
            ...item,
            state: 'paused',
            attempts,
            nextAttemptAt: undefined,
            lastError: exhausted
              ? { ...failure, message: `${message} (local retry budget exhausted)` }
              : failure,
            updatedAt: timestamp(clockNow),
          };
          await writeItem(path, item);
          results.push({ id: item.id, bundleSha256: item.bundleSha256, state: 'paused', code,
            message: item.lastError?.message });
        }
        // A dead network fails every queued item the same way; leave the rest untouched.
        if (retryable && code === 'NETWORK_ERROR') break;
      }
    } finally {
      await lock.release();
    }
  }

  const done = results.filter(result => result.state === 'done').length;
  const pending = results.filter(result => result.state === 'pending').length;
  const paused = results.filter(result => result.state === 'paused').length;
  const skipped = results.filter(result => result.state === 'skipped').length;
  return { results, done, pending, paused, skipped, interrupted };
}
