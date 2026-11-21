import { open, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EntryCounts } from './server-bundle.js';

export type RunState = 'pending' | 'ready' | 'rejected';
export type UploadState = 'receiving' | 'verifying' | 'completed' | 'closed';

export interface ApiFailure {
  status: number;
  code: string;
}

export interface RunSummaryRecord {
  flowId: string;
  flowSha256: string;
  startedAt: string;
  mode: 'replay' | 'dry-run';
  status: 'passed' | 'failed' | 'blocked';
  durationMs: number;
  entryCounts: EntryCounts;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  storageKey: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface ChunkRecord {
  index: number;
  bytes: number;
  sha256: string;
  storageKey: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  bundleSha256: string;
  bundleBytes: number;
  state: RunState;
  createdAt: string;
  completedAt?: string;
  currentUploadId?: string;
  rejection?: ApiFailure;
  summary?: RunSummaryRecord;
  artifact?: ArtifactRecord;
}

export interface UploadRecord {
  id: string;
  runId: string;
  state: UploadState;
  committedBytes: number;
  createdAt: string;
  expiresAt: string;
  verificationLeaseUntil?: string;
  verificationOwner?: string;
  chunks: ChunkRecord[];
  rejection?: ApiFailure;
}

interface StoredState {
  version: 1;
  runs: RunRecord[];
  uploads: UploadRecord[];
}

const stateVersion = 1;
let temporaryCounter = 0;

async function syncDirectory(directory: string) {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best effort; the rename is still atomic without it.
  }
}

/** Write a file in one rename so a crash leaves either the old or the new content. */
export async function writeFileAtomic(path: string, data: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${temporaryCounter++}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

/**
 * File-system metadata store.
 *
 * A single JSON snapshot (`meta/state.json`) is replaced atomically after each
 * mutation. The dataset is one workspace on one node: request rates and row
 * counts are small, and JSON keeps backup, inspection and recovery to plain
 * file copies. Bundle and chunk bytes stay outside the snapshot; only their
 * content-addressed keys are recorded. A second server process on the same
 * data directory is not supported (there is no cross-process lock).
 */
export class ServerStore {
  readonly dataDir: string;
  state: StoredState = { version: stateVersion, runs: [], uploads: [] };
  runsById = new Map<string, RunRecord>();
  uploadsById = new Map<string, UploadRecord>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  get statePath() {
    return join(this.dataDir, 'meta', 'state.json');
  }

  get stagingRoot() {
    return join(this.dataDir, 'staging');
  }

  get viewRoot() {
    return join(this.dataDir, 'views');
  }

  objectPath(projectId: string, sha256: string) {
    return join(this.dataDir, 'objects', projectId, `${sha256}.zip`);
  }

  viewPath(runId: string) {
    return join(this.viewRoot, `${runId}.html`);
  }

  stagingPath(uploadId: string) {
    return join(this.stagingRoot, uploadId);
  }

  chunkPath(upload: UploadRecord, chunk: Pick<ChunkRecord, 'index' | 'sha256'>) {
    return join(this.stagingPath(upload.id), `${chunk.index}-${chunk.sha256}.bin`);
  }

  async open() {
    await mkdir(join(this.dataDir, 'meta'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataDir, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.viewRoot, { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Server state ${this.statePath} is not valid JSON; restore the last backup`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Server state ${this.statePath} is not a state object; restore the last backup`);
    }
    const state = parsed as StoredState;
    if (state.version !== stateVersion || !Array.isArray(state.runs) || !Array.isArray(state.uploads)) {
      throw new Error(`Server state ${this.statePath} has an unsupported version; restore the last backup`);
    }
    this.state = { version: stateVersion, runs: state.runs, uploads: state.uploads };
    this.runsById = new Map(state.runs.map(run => [run.id, run]));
    this.uploadsById = new Map(state.uploads.map(upload => [upload.id, upload]));
    // One data directory is served by one process, so a verifying session in a
    // loaded state belongs to a process that no longer exists.
    let reclaimed = false;
    for (const upload of this.state.uploads) {
      if (upload.state !== 'verifying') continue;
      upload.state = 'receiving';
      upload.verificationOwner = undefined;
      upload.verificationLeaseUntil = undefined;
      reclaimed = true;
    }
    if (reclaimed) await this.persist();
  }

  /** Serialize mutations and persist one snapshot at the end of each one. */
  async locked<T>(action: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async persist() {
    await writeFileAtomic(this.statePath, `${JSON.stringify(this.state)}\n`);
  }

  addRun(run: RunRecord) {
    this.state.runs.push(run);
    this.runsById.set(run.id, run);
  }

  addUpload(upload: UploadRecord) {
    this.state.uploads.push(upload);
    this.uploadsById.set(upload.id, upload);
  }

  runFor(projectId: string, runId: string): RunRecord | undefined {
    const run = this.runsById.get(runId);
    return run && run.projectId === projectId ? run : undefined;
  }

  uploadFor(run: RunRecord, uploadId: string): UploadRecord | undefined {
    const upload = this.uploadsById.get(uploadId);
    return upload && upload.runId === run.id ? upload : undefined;
  }

  async objectExists(path: string) {
    try {
      const info = await stat(path);
      return info.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Drop staged chunks for finished sessions and expired artifacts. Run
   * summaries and idempotency records stay forever; only bytes are removed.
   */
  async cleanup(now = Date.now()) {
    await this.locked(async () => {
      let changed = false;
      for (const upload of this.state.uploads) {
        if (upload.state === 'verifying' && upload.verificationLeaseUntil !== undefined &&
            Date.parse(upload.verificationLeaseUntil) <= now) {
          // The verifying process died; the session may be verified again.
          upload.state = 'receiving';
          upload.verificationLeaseUntil = undefined;
          upload.verificationOwner = undefined;
          changed = true;
        }
        const finished = upload.state === 'completed' || upload.state === 'closed';
        const expired = upload.state !== 'completed' && Date.parse(upload.expiresAt) <= now;
        if (expired && upload.state !== 'closed') {
          upload.state = 'closed';
          changed = true;
        }
        if ((finished || expired) && upload.chunks.length > 0) {
          upload.chunks = [];
          await rm(this.stagingPath(upload.id), { recursive: true, force: true });
          changed = true;
        }
      }
      for (const run of this.state.runs) {
        const artifact = run.artifact;
        if (!artifact || artifact.deletedAt) continue;
        if (Date.parse(artifact.expiresAt) <= now) {
          artifact.deletedAt = new Date(now).toISOString();
          await rm(this.objectPath(run.projectId, run.bundleSha256), { force: true });
          await rm(this.viewPath(run.id), { force: true });
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }
}
