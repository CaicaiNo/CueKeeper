import { readdir, stat as fsStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { plistBundleId } from './app-identity.js';
import type { FileFacts } from './install-state.js';
import type { LifecycleKind } from './wait-candidates.js';

// A recording observes install lifecycle facts on its own instead of asking the
// user to hand-write `lifecycle.json`. The watcher is read-only: it lists the
// download directory and the application directories, reads `.app` bundle
// identifiers and the file facts a download leaves behind. It never launches,
// moves, deletes or renames anything, and it never reports a file or app that
// was already there when the recording started.

/** One fact the watcher proved, as the recording layer needs it. */
export interface LifecycleObservation {
  /** Milliseconds since the recording started. */
  at: number;
  kind: LifecycleKind;
  /** Bundle ID the event proved; absent for a download. */
  app?: string;
  /** Download path or bundle path; never stored in a flow step. */
  path?: string;
}

export interface LifecycleDeps {
  readdir?(directory: string): Promise<string[] | undefined>;
  stat?(path: string): Promise<FileFacts | undefined>;
  /** Bundle identifier of an `.app` on disk, undefined when unreadable. */
  bundleId?(path: string): Promise<string | undefined>;
  /** Wall clock; production uses Date.now, which also orders file mtimes. */
  now?(): number;
}

export interface LifecycleWatchOptions {
  /** Directories a browser or download manager writes into. */
  downloadDirectories?: string[];
  /** Directories scanned for installed `.app` bundles. */
  appDirectories?: string[];
  /** File extensions that count as an installer download. */
  downloadExtensions?: string[];
  /** A new file counts as downloaded after its size and mtime stay this long. */
  quietMs?: number;
  deps?: LifecycleDeps;
}

export const defaultLifecyclePollMs = 250;
export const defaultLifecycleQuietMs = 1000;
export const defaultDownloadExtensions = ['pkg', 'mpkg', 'dmg', 'zip'];

const partialDownload = /\.(crdownload|download|part|tmp)$/i;

/** An env-provided list uses the platform path delimiter; empty means unset. */
function envDirectories(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(delimiter).map(part => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** The default watch set: the user's Downloads and the usual application roots. */
export function lifecycleWatchDefaults(env: NodeJS.ProcessEnv = process.env) {
  const home = homedir();
  return {
    downloadDirectories: envDirectories(env.CUEKEEPER_LIFECYCLE_DOWNLOAD_DIRS) ?? [join(home, 'Downloads')],
    appDirectories: envDirectories(env.CUEKEEPER_LIFECYCLE_APP_DIRS) ??
      [join(home, 'Applications'), '/Applications'],
  };
}

interface FileState {
  size: number;
  mtimeMs: number;
  emitted: boolean;
}

/**
 * Read-only lifecycle watcher for one recording. `start` captures the baseline
 * (files and bundles that already existed); every later `poll` reports only
 * facts that became true afterwards. A download is reported once its size and
 * mtime have been quiet for `quietMs`; an install when its bundle appears with a
 * readable identifier; an uninstall when a watched bundle path disappears.
 */
export class LifecycleWatcher {
  private readonly now: () => number;
  private readonly readdir: (directory: string) => Promise<string[] | undefined>;
  private readonly stat: (path: string) => Promise<FileFacts | undefined>;
  private readonly bundleId: (path: string) => Promise<string | undefined>;
  private readonly downloadDirectories: string[];
  private readonly appDirectories: string[];
  private readonly downloadExtensions: Set<string>;
  private readonly quietMs: number;
  private readonly files = new Map<string, FileState>();
  /** Watched bundle path → proven bundle identifier. */
  private apps = new Map<string, string>();
  /** A bundle identifier is read once per path, not once per poll. */
  private readonly ids = new Map<string, string | undefined>();
  private startedAt?: number;

  constructor(options: LifecycleWatchOptions = {}) {
    const defaults = lifecycleWatchDefaults();
    const deps = options.deps ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.readdir = deps.readdir ?? (async directory => {
      try {
        return await readdir(directory);
      } catch {
        return undefined;
      }
    });
    this.stat = deps.stat ?? (async path => {
      try {
        const info = await fsStat(path);
        return {
          isFile: () => info.isFile(), isDirectory: () => info.isDirectory(),
          size: info.size, mtimeMs: info.mtimeMs,
        };
      } catch {
        return undefined;
      }
    });
    this.bundleId = deps.bundleId ?? plistBundleId;
    this.downloadDirectories = options.downloadDirectories ?? defaults.downloadDirectories;
    this.appDirectories = options.appDirectories ?? defaults.appDirectories;
    const extensions = options.downloadExtensions ?? defaultDownloadExtensions;
    this.downloadExtensions = new Set(extensions.map(extension => extension.toLowerCase()));
    this.quietMs = options.quietMs ?? defaultLifecycleQuietMs;
  }

  /** Captures the baseline; nothing that exists now can become an event later. */
  async start(): Promise<void> {
    this.startedAt = this.now();
    for (const file of await this.listDownloads()) {
      const facts = await this.stat(file);
      if (facts?.isFile() && facts.size > 0) {
        this.files.set(file, { size: facts.size, mtimeMs: facts.mtimeMs, emitted: true });
      }
    }
    this.apps = await this.scanApps();
  }

  /** One read-only scan; returns only the facts that just became true. */
  async poll(): Promise<LifecycleObservation[]> {
    if (this.startedAt === undefined) throw new Error('Lifecycle watcher was polled before start');
    const at = Math.max(0, Math.round(this.now() - this.startedAt));
    const events: LifecycleObservation[] = [];

    const present = new Set<string>();
    for (const file of await this.listDownloads()) {
      const facts = await this.stat(file);
      if (!facts?.isFile() || facts.size <= 0) continue;
      present.add(file);
      const previous = this.files.get(file);
      if (!previous) {
        this.files.set(file, { size: facts.size, mtimeMs: facts.mtimeMs, emitted: false });
        continue;
      }
      if (previous.size !== facts.size || previous.mtimeMs !== facts.mtimeMs) {
        previous.size = facts.size;
        previous.mtimeMs = facts.mtimeMs;
        previous.emitted = false;
      }
      if (!previous.emitted && this.now() - facts.mtimeMs >= this.quietMs) {
        previous.emitted = true;
        events.push({ at, kind: 'download_completed', path: file });
      }
    }
    // A removed download is not an event; drop it so a later copy is new again.
    for (const file of [...this.files.keys()]) if (!present.has(file)) this.files.delete(file);

    const next = await this.scanApps();
    for (const [path, app] of next) {
      if (!this.apps.has(path)) events.push({ at, kind: 'install_completed', app, path });
    }
    for (const [path, app] of this.apps) {
      if (!next.has(path)) events.push({ at, kind: 'uninstall_completed', app });
    }
    this.apps = next;
    return events;
  }

  private async listDownloads(): Promise<string[]> {
    const files: string[] = [];
    for (const directory of this.downloadDirectories) {
      const names = await this.readdir(directory);
      if (!names) continue;
      for (const name of names) {
        if (partialDownload.test(name)) continue;
        const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        if (!name.includes('.') || !this.downloadExtensions.has(extension)) continue;
        files.push(join(directory, name));
      }
    }
    return files;
  }

  private async scanApps(): Promise<Map<string, string>> {
    const apps = new Map<string, string>();
    for (const directory of this.appDirectories) {
      const names = await this.readdir(directory);
      if (!names) continue;
      for (const name of names) {
        if (!/\.app$/i.test(name)) continue;
        const path = join(directory, name);
        const facts = await this.stat(path);
        if (!facts?.isDirectory()) continue;
        let id: string | undefined;
        if (this.ids.has(path)) {
          id = this.ids.get(path);
        } else {
          id = await this.bundleId(path).catch(() => undefined);
          // Only a proven identifier is cached: a bundle still being copied in
          // must be readable on a later poll.
          if (id) this.ids.set(path, id);
        }
        // An unreadable bundle identifier proves no install; it is not guessed.
        if (id) apps.set(path, id);
      }
    }
    return apps;
  }
}
