import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { nativeIdentityProbe, plistBundleId } from './app-identity.js';
import { Fault } from './locator.js';

// Read-only install evidence for waits. A process exit alone never proves an
// install or uninstall: an app counts as installed only when its pinned bundle
// is on disk with the expected CFBundleIdentifier, or a pkg receipt proves the
// package. Downloads count as complete only when exactly one finished file can
// be located; a partial download is not a completed one.

export interface FileFacts {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface ProcessFacts {
  pid: number;
  bundleId?: string;
  startedAt?: string;
}

export interface InstallStateDeps {
  stat?(path: string): Promise<FileFacts | undefined>;
  readdir?(directory: string): Promise<string[] | undefined>;
  /** Bundle identifier of an installed .app, undefined when unreadable. */
  bundleId?(path: string): Promise<string | undefined>;
  /** Installed pkg receipt identifiers, e.g. from /var/db/receipts. */
  receipts?(): Promise<string[]>;
  /** Facts for a live pid; undefined once the process is gone. */
  process?(pid: number): Promise<ProcessFacts | undefined>;
}

export interface DownloadLocation {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Read-only result of one file wait. An ambiguous match and an unreadable
 * directory are hard stops; a missing, partial or still-growing file is an
 * observation the wait keeps polling.
 */
export interface FileEvidence {
  /** Exactly one finished file matches the directory and name/suffix. */
  present: boolean;
  /** A matching partial or zero-byte file exists, so it is not finished yet. */
  incomplete: boolean;
  /** The matched file's name, for the wait's timeout message; never a path. */
  name?: string;
  size?: number;
  mtimeMs?: number;
}

export interface InstallEvidence {
  /** True only with bundle or receipt evidence; never from a process exit. */
  installed: boolean;
  /** `bundle` and/or `receipt:<pkgId>` entries; empty when unevidenced. */
  evidence: string[];
}

export interface RemovalEvidence {
  /** True when the pinned bundle is gone from disk. */
  removed: boolean;
  /** True when the given pid is gone, or no pid was bound. */
  processExited: boolean;
  evidence: string[];
}

const partialDownload = /\.(crdownload|download|part|tmp)$/i;

function invalid(what: string): never {
  throw new Fault('DOWNLOAD_PATH_INVALID', `Download location is invalid: ${what}`);
}

function invalidApp(what: string): never {
  throw new Fault('APP_PATH_INVALID', `App path is invalid: ${what}`);
}

function safeDirectory(directory: string): string {
  if (typeof directory !== 'string' || !isAbsolute(directory)) invalid('expected an absolute directory');
  if (directory.split('/').includes('..')) invalid('a directory must not climb with ..');
  return normalize(directory);
}

function safeName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    invalid('expected a plain file name');
  }
  return name;
}

/** `.app` bundle path with the same absolute, non-climbing rule as appPaths. */
function safeAppPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.split(sep).includes('..')) {
    invalidApp('expected an absolute .app path');
  }
  if (!/\.app$/i.test(path)) invalidApp('expected a .app bundle path');
  return normalize(path);
}

/**
 * One read-only view of downloads and installed state. Every method is
 * observation only: nothing is launched, focused, renamed or written.
 */
export class InstallState {
  private readonly stat: (path: string) => Promise<FileFacts | undefined>;
  private readonly readdir: (directory: string) => Promise<string[] | undefined>;
  private readonly bundleId: (path: string) => Promise<string | undefined>;
  private readonly receipts: () => Promise<string[]>;
  private readonly process: (pid: number) => Promise<ProcessFacts | undefined>;

  constructor(deps: InstallStateDeps = {}) {
    this.stat = deps.stat ?? (async path => {
      try {
        const info = await stat(path);
        return {
          isFile: () => info.isFile(), isDirectory: () => info.isDirectory(),
          size: info.size, mtimeMs: info.mtimeMs,
        };
      } catch {
        return undefined;
      }
    });
    this.readdir = deps.readdir ?? (async directory => {
      try {
        return await readdir(directory);
      } catch {
        return undefined;
      }
    });
    this.bundleId = deps.bundleId ?? plistBundleId;
    this.receipts = deps.receipts ?? nativeReceipts;
    this.process = deps.process ?? nativeProcessFacts;
  }

  /**
   * Locates the one finished file a download produced. `name` matches exactly;
   * `suffix` matches a download-assigned variant such as `pkg (1).pkg`. A
   * partial artifact, no match, or more than one match stops with its own code.
   */
  async locateDownload(options: {
    directory: string;
    name?: string;
    suffix?: string;
    /** Ignore files older than this wall-clock time (recording start). */
    notBeforeMs?: number;
  }): Promise<DownloadLocation> {
    const scan = await this.scanDownload(options);
    if (!scan.matches.length && scan.partial.length) {
      throw new Fault('DOWNLOAD_INCOMPLETE', `Download ${scan.partial[0]} has not finished writing`);
    }
    if (!scan.matches.length) {
      throw new Fault('DOWNLOAD_NOT_FOUND', `No completed download matches in ${scan.directory}`);
    }
    if (scan.matches.length > 1) {
      throw new Fault('DOWNLOAD_AMBIGUOUS',
        `${scan.matches.length} downloads match; the wait does not pick one by position`);
    }
    const match = scan.matches[0];
    return { path: join(scan.directory, match.name), size: match.size, mtimeMs: match.mtimeMs };
  }

  /**
   * One read-only file observation for a file wait. It reports absence and an
   * unfinished write as state, but an unreadable directory or more than one
   * matching file still stops: neither proves a download completed.
   */
  async fileEvidence(options: {
    directory: string;
    name?: string;
    suffix?: string;
    notBeforeMs?: number;
  }): Promise<FileEvidence> {
    const scan = await this.scanDownload(options);
    if (scan.matches.length > 1) {
      throw new Fault('DOWNLOAD_AMBIGUOUS',
        `${scan.matches.length} downloads match; the wait does not pick one by position`);
    }
    const [match] = scan.matches;
    if (match) {
      return { present: true, incomplete: false, name: match.name, size: match.size, mtimeMs: match.mtimeMs };
    }
    return { present: false, incomplete: scan.partial.length > 0 };
  }

  /** Lists matching files once; every caller must decide what a match means. */
  private async scanDownload(options: {
    directory: string;
    name?: string;
    suffix?: string;
    notBeforeMs?: number;
  }): Promise<{
    directory: string;
    matches: Array<{ name: string; size: number; mtimeMs: number }>;
    partial: string[];
  }> {
    const directory = safeDirectory(options.directory);
    if (options.name === undefined && options.suffix === undefined) {
      invalid('name or suffix is required');
    }
    const name = options.name === undefined ? undefined : safeName(options.name);
    const suffix = options.suffix === undefined ? undefined : safeName(options.suffix);
    const names = await this.readdir(directory);
    if (names === undefined) {
      throw new Fault('DOWNLOAD_PATH_INVALID', `Download directory ${directory} is not readable`);
    }
    const matches: Array<{ name: string; size: number; mtimeMs: number }> = [];
    const partial: string[] = [];
    for (const entry of names) {
      const exact = name !== undefined ? entry === name : entry.endsWith(suffix!);
      // A browser writes `Name.pkg.crdownload` while `Name.pkg` does not exist
      // yet; that sibling is evidence the named download is still running.
      const sibling = name !== undefined && entry.startsWith(`${name}.`) && partialDownload.test(entry);
      if (!exact && !sibling) continue;
      if (partialDownload.test(entry)) {
        partial.push(entry);
        continue;
      }
      const facts = await this.stat(join(directory, entry));
      if (!facts?.isFile()) continue;
      if (facts.size <= 0) {
        partial.push(entry);
        continue;
      }
      if (options.notBeforeMs !== undefined && facts.mtimeMs < options.notBeforeMs) continue;
      matches.push({ name: entry, size: facts.size, mtimeMs: facts.mtimeMs });
    }
    return { directory, matches, partial };
  }

  /**
   * Receipt evidence for one package. A receipt identifies a package by its pkg
   * ID, so an ID that equals the bundle ID or extends it (`com.example.App.pkg`)
   * is the same package; anything else is not evidence.
   */
  async receipt(pkgId: string): Promise<string[]> {
    if (typeof pkgId !== 'string' || !pkgId || pkgId.length > 256) invalid('expected a package identifier');
    const ids = await this.receipts().catch(() => []);
    return ids.filter(id => id === pkgId || id.startsWith(`${pkgId}.`));
  }

  /** True only when the pinned bundle exists and declares the expected ID. */
  async bundle(path: string, app: string): Promise<boolean> {
    const appPath = safeAppPath(path);
    const facts = await this.stat(appPath);
    if (!facts?.isDirectory()) return false;
    const declared = await this.bundleId(appPath).catch(() => undefined);
    return declared === app;
  }

  /**
   * Installed evidence for one app. A running process is deliberately ignored:
   * the installer's own process or a stray pid never proves an install.
   */
  async appInstalled(app: string, options: { path?: string } = {}): Promise<InstallEvidence> {
    if (typeof app !== 'string' || !app) invalidApp('expected a bundle identifier');
    const evidence: string[] = [];
    if (options.path !== undefined && await this.bundle(options.path, app)) evidence.push('bundle');
    for (const id of await this.receipt(app)) evidence.push(`receipt:${id}`);
    return { installed: evidence.length > 0, evidence };
  }

  /**
   * A pid that is alive but belongs to another bundle is a wrong process, not
   * the app the flow bound. An exited pid is reported as such.
   */
  async processState(pid: number, app: string): Promise<'running' | 'exited' | 'mismatch'> {
    if (!Number.isSafeInteger(pid) || pid <= 0) invalid('expected a process ID');
    const facts = await this.process(pid);
    if (!facts) return 'exited';
    if (facts.bundleId !== undefined && facts.bundleId !== app) return 'mismatch';
    return 'running';
  }

  /**
   * Uninstall evidence: the pinned bundle must be gone. A process that exited is
   * reported separately and never by itself makes an app "removed"; a pid now
   * owned by another app is a mismatch, not a successful uninstall.
   */
  async appRemoved(app: string, options: { path?: string; pid?: number } = {}): Promise<RemovalEvidence> {
    if (typeof app !== 'string' || !app) invalid('expected a bundle identifier');
    let removed = false;
    if (options.path !== undefined) {
      const appPath = safeAppPath(options.path);
      removed = !(await this.stat(appPath))?.isDirectory();
      if (!removed) {
        const declared = await this.bundleId(appPath).catch(() => undefined);
        // A different bundle still sitting at that path is not the app, but the
        // path is occupied: evidence is ambiguous, so removal is not proven.
        if (declared !== app) {
          throw new Fault('APP_PATH_INVALID', `The path ${appPath} no longer holds ${app}`);
        }
      }
    }
    const evidence: string[] = [];
    if (removed) evidence.push('bundle_absent');
    let processExited = true;
    if (options.pid !== undefined) {
      const state = await this.processState(options.pid, app);
      if (state === 'mismatch') {
        throw new Fault('PROCESS_MISMATCH',
          `Process ${options.pid} no longer belongs to ${app}; the run does not treat it as this app`);
      }
      processExited = state === 'exited';
      if (processExited) evidence.push('process_exited');
    }
    return { removed, processExited, evidence };
  }
}

/** Installed pkg identifiers from the receipt database (read-only). */
async function nativeReceipts(): Promise<string[]> {
  const names = await readdir('/var/db/receipts');
  const ids = new Set<string>();
  for (const name of names) {
    const match = /^(.*)\.(bom|plist)$/.exec(name);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

/** Process facts through the native identity helper, without accessibility. */
async function nativeProcessFacts(pid: number): Promise<ProcessFacts | undefined> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return undefined;
  }
  const instance = await nativeIdentityProbe().describe(pid).catch(() => undefined);
  return instance === undefined
    ? { pid }
    : { pid, bundleId: instance.bundleId, startedAt: instance.startedAt };
}

