import { execFile } from 'node:child_process';
import { access, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { appPathPattern } from './contracts.js';
import type { AppIdentity, AppIdentityReason, Ensure, Target } from './contracts.js';
import type { Desktop, WindowInfo } from './desktop.js';
import { Fault, object } from './locator.js';
import type { Snapshot } from './locator.js';

export type IdentityMode = 'bundle_path' | 'legacy_bundle_id';
export type IdentityCode = 'APP_PATH_INVALID' | 'APP_AMBIGUOUS' | 'UNSUPPORTED_PLATFORM' | 'UNSAFE_POINT';
export type PathShape = 'posix' | 'windows-drive' | 'windows-unc';

const appPathShape = new RegExp(appPathPattern, 'u');

/**
 * A path is importable on every platform; only a live entry enforces where it
 * can be resolved. Rejecting the shape here keeps `~`, relative paths and file
 * URLs out of every flow.
 */
export function classifyAppPath(path: string): PathShape | undefined {
  if (!appPathShape.test(path)) return undefined;
  if (path.startsWith('//')) return undefined;
  if (path.startsWith('/')) return 'posix';
  if (/^[A-Za-z]:[/\\]/.test(path)) return 'windows-drive';
  if (path.startsWith('\\\\')) return 'windows-unc';
  return undefined;
}

/**
 * One terminating identity problem. The code is the public error code; the
 * reason is the stable report value that never carries another copy's path.
 */
export class IdentityFault extends Fault {
  constructor(
    public identityCode: IdentityCode,
    public reason: AppIdentityReason,
    message: string,
    private app: string,
    private mode: IdentityMode,
  ) {
    super(identityCode, message);
  }

  identity(entryId?: string): AppIdentity {
    return {
      app: this.app, mode: this.mode, status: 'blocked',
      code: this.identityCode, reason: this.reason,
      ...(entryId ? { entryId } : {}),
    } as AppIdentity;
  }
}

export interface RunningInstance {
  pid: number;
  /** Opaque generation marker; a changed value means PID reuse. */
  startedAt: string;
  bundleId: string;
  /** Canonical bundle path, absent when the system cannot prove it. */
  bundlePath?: string;
}

export interface NativeWindow {
  number: number;
  ownerPid: number;
  title: string;
}

/** Read-only runtime facts. The macOS helper is one implementation. */
export interface IdentityProbe {
  available(): Promise<boolean>;
  describe(pid: number): Promise<RunningInstance | undefined>;
  instances(bundleId: string): Promise<RunningInstance[]>;
  /** On-screen windows with their owner PID, used to prove a window's owner. */
  windows(): Promise<NativeWindow[]>;
  /** Resolve a bundle path and read its identifier without launching it. */
  validate(path: string): Promise<{ bundleId: string; bundlePath: string } | undefined>;
  /** Open exactly this copy, without letting the system substitute another. */
  open(path: string, activate: boolean): Promise<void>;
}

export interface IdentityDeps {
  platform?: NodeJS.Platform;
  probe?: IdentityProbe;
  realpath?(path: string): Promise<string>;
  stat?(path: string): Promise<{ isDirectory(): boolean }>;
  readBundleId?(path: string): Promise<string | undefined>;
  sleep?(ms: number): Promise<void>;
  /** Installed copies of one bundle ID, used only for a legacy launch. */
  installed?(app: string): Promise<string[]>;
}

function parseInstance(value: unknown): RunningInstance | undefined {
  const record = object(value);
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return undefined;
  if (typeof record.startedAt !== 'string' || !record.startedAt) return undefined;
  if (typeof record.bundleId !== 'string' || !record.bundleId) return undefined;
  return {
    pid: record.pid,
    startedAt: record.startedAt,
    bundleId: record.bundleId,
    ...(typeof record.bundlePath === 'string' && record.bundlePath ? { bundlePath: record.bundlePath } : {}),
  };
}

function helperPath() {
  return process.env.CUEKEEPER_APP_IDENTITY ?? fileURLToPath(new URL('./cuekeeper-identity', import.meta.url));
}

/**
 * Calls the native helper. The helper prints one JSON envelope per invocation
 * and never asks for Accessibility or Input Monitoring: it only reads
 * NSRunningApplication, CGWindowList and the bundle on disk.
 */
export function nativeIdentityProbe(executable = helperPath()): IdentityProbe {
  async function call(command: string, args: string[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(executable, [command, ...args], { encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          return reject(new Fault('IDENTITY_DEPENDENCY', 'The app identity helper is unavailable. Build it with pnpm build:recorder', true));
        }
        try {
          const envelope = object(JSON.parse(stdout));
          if (envelope.ok === true) return resolve(envelope.data);
          const fault = object(envelope.error ?? {});
          reject(new Fault(
            typeof fault.code === 'string' && /^[A-Z_]+$/.test(fault.code) ? fault.code : 'BAD_RESPONSE',
            typeof fault.message === 'string' ? fault.message : `app identity ${command} failed`,
          ));
        } catch {
          reject(new Fault('IDENTITY_DEPENDENCY', 'The app identity helper returned no JSON envelope', true));
        }
      });
    });
  }

  return {
    async available() {
      try {
        await access(executable);
        return true;
      } catch {
        return false;
      }
    },
    async describe(pid) {
      const data = await call('describe', ['--pid', String(pid)]);
      if (data === null) return undefined;
      return parseInstance(data);
    },
    async instances(bundleId) {
      const data = await call('instances', ['--bundle-id', bundleId]);
      const record = object(data);
      if (!Array.isArray(record.instances)) throw new Fault('BAD_RESPONSE', 'Expected an instance list');
      return record.instances.map(parseInstance).filter((instance): instance is RunningInstance => !!instance);
    },
    async windows() {
      const data = await call('windows');
      if (!Array.isArray(data)) throw new Fault('BAD_RESPONSE', 'Expected a window list');
      return data.map(object).flatMap(window => {
        const number = window.number;
        const ownerPid = window.ownerPid;
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return [];
        if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return [];
        return [{ number, ownerPid, title: typeof window.title === 'string' ? window.title : '' }];
      });
    },
    async validate(path) {
      const data = await call('validate', ['--path', path]);
      if (data === null) return undefined;
      const record = object(data);
      if (typeof record.bundleId !== 'string' || typeof record.bundlePath !== 'string') return undefined;
      return { bundleId: record.bundleId, bundlePath: record.bundlePath };
    },
    async open(path, activate) {
      await call('open', ['--path', path, ...(activate ? ['--activate'] : [])]);
    },
  };
}

/** Reads CFBundleIdentifier from an .app bundle without launching it. */
export async function plistBundleId(path: string) {
  return new Promise<string | undefined>(resolve => {
    execFile('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${path}/Contents/Info.plist`],
      { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
        if (error) return resolve(undefined);
        const value = stdout.trim();
        resolve(value && !value.includes('\n') ? value : undefined);
      });
  });
}

/** Installed copies indexed by LaunchServices metadata. */
async function installedCopies(app: string): Promise<string[]> {
  const { listApps } = await import('./app-catalog.js');
  const entry = (await listApps()).find(item => item.bundleId === app);
  return entry?.paths ?? [];
}

export function parseWindowId(windowId: string): number | undefined {
  const match = /^w-(\d+)$/.exec(windowId);
  return match ? Number(match[1]) : undefined;
}

/**
 * Binds one flow target to one installed copy and one running instance, then
 * proves every later window action still belongs to that instance. A blocked
 * action never falls back to a bundle ID or the global foreground.
 */
export class AppIdentitySession {
  readonly app: string;
  readonly mode: IdentityMode;
  readonly probe: IdentityProbe;
  private readonly platform: NodeJS.Platform;
  private readonly realpath: (path: string) => Promise<string>;
  private readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  private readonly readBundleId: (path: string) => Promise<string | undefined>;
  private readonly installed: (app: string) => Promise<string[]>;
  private readonly wait: (ms: number) => Promise<void>;
  private target: Target;
  canonicalPath?: string;
  instance?: RunningInstance;
  /** Set once a window of the bound instance was read or focused. */
  private checked = false;
  private offline = false;

  constructor(target: Target, deps: IdentityDeps = {}) {
    this.target = target;
    this.app = target.app;
    this.mode = target.appPath ? 'bundle_path' : 'legacy_bundle_id';
    this.probe = deps.probe ?? nativeIdentityProbe();
    this.platform = deps.platform ?? process.platform;
    this.realpath = deps.realpath ?? (path => fsRealpath(path));
    this.stat = deps.stat ?? (path => fsStat(path));
    this.readBundleId = deps.readBundleId ?? plistBundleId;
    this.installed = deps.installed ?? installedCopies;
    this.wait = deps.sleep ?? (ms => sleep(ms));
  }

  get path(): string | undefined { return this.target.appPath; }

  get runningInstance(): RunningInstance | undefined { return this.instance; }

  get offlineUnverified(): boolean { return this.offline; }

  private fault(code: IdentityCode, reason: AppIdentityReason, message: string) {
    return new IdentityFault(code, reason, message, this.app, this.mode);
  }

  /**
   * Validates the configured copy on disk before any command can focus or
   * launch something. Offline runs skip the live platform check so a flow
   * captured on another machine still imports and resolves.
   */
  async preflight(options: { offline?: boolean } = {}): Promise<void> {
    this.offline = options.offline === true;
    if (this.mode === 'legacy_bundle_id') return;
    const path = this.target.appPath!;
    const shape = classifyAppPath(path);
    if (!shape) {
      throw this.fault('APP_PATH_INVALID', 'invalid_bundle_path',
        '选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。');
    }
    if (this.offline) return;
    if (shape !== 'posix' && this.platform !== 'win32') {
      throw this.fault('UNSUPPORTED_PLATFORM', 'unsupported_path_platform',
        '该应用路径属于另一平台。本机可验证流程或使用离线快照。');
    }
    if (this.platform !== 'darwin') {
      throw new Fault('UNSUPPORTED_PLATFORM', 'Live desktop replay requires macOS', true);
    }
    let canonical: string;
    try {
      canonical = await this.realpath(path);
      const info = await this.stat(canonical);
      if (!info.isDirectory()) throw new Error('Not a directory');
    } catch {
      throw this.fault('APP_PATH_INVALID', 'invalid_bundle_path',
        '选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。');
    }
    if (!canonical.endsWith('.app')) {
      throw this.fault('APP_PATH_INVALID', 'invalid_bundle_path',
        '选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。');
    }
    let bundleId: string | undefined;
    try {
      bundleId = await this.readBundleId(canonical);
    } catch {
      bundleId = undefined;
    }
    if (!bundleId) {
      throw this.fault('APP_PATH_INVALID', 'invalid_bundle_path',
        '选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。');
    }
    if (bundleId !== this.app) {
      throw this.fault('APP_PATH_INVALID', 'bundle_id_mismatch',
        '选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。');
    }
    this.canonicalPath = canonical;
  }

  /** Offline reports never claim a live instance was verified. */
  offlineIdentity(): AppIdentity {
    return { app: this.app, mode: this.mode, status: 'offline_unverified' } as AppIdentity;
  }

  verifiedIdentity(): AppIdentity {
    return { app: this.app, mode: this.mode, status: 'verified' } as AppIdentity;
  }

  /**
   * Resolves the running instance before the first window action. A path-fixed
   * flow accepts exactly one instance whose canonical bundle path matches; a
   * legacy flow accepts one provable same-ID instance.
   */
  async bindInstances(desktop: Desktop | undefined): Promise<void> {
    if (this.offline) return;
    if (this.mode === 'bundle_path') return this.bindPath();
    return this.bindLegacy(desktop);
  }

  private async bindPath() {
    if (!this.canonicalPath) throw new Fault('IDENTITY_DEPENDENCY', 'App identity preflight did not run', true);
    const [instances] = await Promise.all([this.probe.instances(this.app)]);
    // An instance whose bundle path the system cannot prove might be the
    // selected copy, so it cannot be excluded.
    if (instances.some(instance => !instance.bundlePath)) {
      throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    let paths: Array<RunningInstance & { canonical: string }>;
    try {
      paths = await Promise.all(instances.map(async instance => ({
        ...instance, canonical: await this.realpath(instance.bundlePath!),
      })));
    } catch {
      throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    const matching = paths.filter(instance => instance.canonical === this.canonicalPath);
    if (matching.length > 1) {
      throw this.fault('APP_AMBIGUOUS', 'multiple_instances',
        '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
    }
    if (!matching.length) {
      if (paths.length) {
        throw this.fault('APP_AMBIGUOUS', 'path_mismatch',
          '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
      }
      this.instance = undefined;
      return;
    }
    this.instance = matching[0];
    this.checked = true;
  }

  private async bindLegacy(_desktop: Desktop | undefined) {
    // Without a native probe the legacy route keeps the driver's existing
    // app-scoped rules; a path-fixed flow can never take this route.
    if (!await this.probe.available()) return;
    const instances = await this.probe.instances(this.app);
    if (instances.length > 1) {
      throw this.fault('APP_AMBIGUOUS', 'multiple_instances',
        '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
    }
    if (instances.length === 1) {
      if (!instances[0].bundlePath) {
        throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
          '无法确认操作仍指向选中的副本，本轮已停止。');
      }
      this.instance = instances[0];
      this.checked = true;
      return;
    }
    this.instance = undefined;
  }

  private async requireInstance(): Promise<RunningInstance> {
    if (!this.instance) throw new Fault('APP_NOT_FOUND', 'The target application is not running');
    return this.instance;
  }

  /** Re-reads PID, generation marker and bundle path. */
  private async verifyInstance(): Promise<RunningInstance> {
    const instance = await this.requireInstance();
    const current = await this.probe.describe(instance.pid);
    if (!current) {
      throw this.fault('APP_AMBIGUOUS', 'instance_changed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    if (current.startedAt !== instance.startedAt) {
      throw this.fault('APP_AMBIGUOUS', 'instance_changed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    if (this.mode === 'bundle_path' && this.canonicalPath) {
      if (!current.bundlePath) {
        throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
          '无法确认操作仍指向选中的副本，本轮已停止。');
      }
      let canonical: string;
      try {
        canonical = await this.realpath(current.bundlePath);
      } catch {
        throw this.fault('APP_AMBIGUOUS', 'instance_changed',
          '无法确认操作仍指向选中的副本，本轮已停止。');
      }
      if (canonical !== this.canonicalPath) {
        throw this.fault('APP_AMBIGUOUS', 'instance_changed',
          '无法确认操作仍指向选中的副本，本轮已停止。');
      }
    }
    return current;
  }

  /**
   * Proves a window ID still belongs to the bound PID. A window that now
   * belongs to another process is an identity failure, not a missing window.
   */
  private async verifyWindow(windowId: string, title?: string) {
    const instance = await this.verifyInstance();
    const number = parseWindowId(windowId);
    if (number === undefined) throw new Fault('WINDOW_CHANGED', 'The bound window ID is not a native window number');
    const windows = await this.probe.windows();
    const found = windows.find(window => window.number === number);
    if (!found) throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
    if (found.ownerPid !== instance.pid) {
      throw this.fault('APP_AMBIGUOUS', 'instance_changed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    // CGWindow titles are empty without Screen Recording access; the initial
    // title match already came from the driver, so only compare a real title.
    if (title !== undefined && found.title && found.title !== title) {
      throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
    }
    return found;
  }

  /** Matches the flow title inside the bound instance, then cross-checks the driver. */
  private async findWindow(desktop: Desktop, title: string, timeoutMs: number): Promise<string> {
    const instance = await this.requireInstance();
    const owned = (await this.probe.windows()).filter(window => window.ownerPid === instance.pid);
    if (!owned.length) throw new Fault('WINDOW_NOT_FOUND', 'The requested window title was not found');
    const ids = new Set(owned.map(window => `w-${window.number}`));
    const driver = (await desktop.listAllWindows(timeoutMs)).filter(window => ids.has(window.id));
    // The driver must cover every window the system attributes to the instance;
    // an inventory that silently drops one cannot prove the title is absent.
    if (driver.length !== ids.size) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    // A driver-reported owner PID that disagrees with the system is a conflict.
    if (driver.some(window => window.processInstance !== undefined && window.processInstance !== instance.pid)) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    const matches = driver.filter(window => window.title === title);
    if (matches.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the flow title');
    if (!matches.length) throw new Fault('WINDOW_NOT_FOUND', 'The requested window title was not found');
    return matches[0].id;
  }

  /**
   * Reads a window of the bound instance with owner checks before and after
   * the driver call. Path-fixed flows never pass `--app`.
   */
  async readWindow(
    desktop: Desktop, target: Target,
    options: { timeoutMs?: number; preferredWindowId?: string } = {},
  ): Promise<Snapshot> {
    if (this.offline) throw new Fault('IDENTITY_DEPENDENCY', 'Offline reads use the saved snapshot', true);
    if (!this.instance) await this.bindInstances(desktop);
    const windowId = options.preferredWindowId ?? await this.findWindow(desktop, target.window, options.timeoutMs ?? 3000);
    await this.verifyWindow(windowId, target.window);
    const snapshot = await desktop.snapshotWindow(windowId, target.window, options.timeoutMs);
    if (snapshot.windowId !== windowId) {
      throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
    }
    await this.verifyWindow(windowId, target.window);
    this.checked = true;
    return snapshot;
  }

  /** Inventory for one app: the bound instance only for a path-fixed target. */
  async windowsFor(desktop: Desktop, target: Target, timeoutMs = 3000): Promise<WindowInfo[]> {
    if (this.offline || this.mode === 'legacy_bundle_id') {
      return desktop.listWindows(target.app, timeoutMs);
    }
    if (!this.instance) await this.bindInstances(desktop);
    const instance = await this.verifyInstance();
    const owned = (await this.probe.windows()).filter(window => window.ownerPid === instance.pid);
    const ids = new Set(owned.map(window => `w-${window.number}`));
    const driver = (await desktop.listAllWindows(timeoutMs)).filter(window => ids.has(window.id));
    // An inventory that drops a window of the bound instance cannot prove the
    // target window is absent, so it blocks instead of reading as empty.
    if (driver.length !== ids.size) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    if (driver.some(window => window.processInstance !== undefined && window.processInstance !== instance.pid)) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    this.checked = true;
    return driver;
  }

  /**
   * Only a confirmed `ensure` reaches this method. A path-fixed launch opens
   * the exact bundle URL and re-reads the launched instance.
   */
  async ensure(
    desktop: Desktop, action: Ensure, timeoutMs: number, preferredWindowId?: string,
  ): Promise<string | undefined> {
    // A secondary app keeps the existing app-scoped repair.
    if (action.app !== this.app || this.offline) {
      return desktop.ensure(action, timeoutMs, preferredWindowId);
    }
    if (this.mode === 'legacy_bundle_id') {
      return this.ensureLegacy(desktop, action, timeoutMs, preferredWindowId);
    }
    const deadline = performance.now() + timeoutMs;
    const remaining = () => {
      const value = Math.ceil(deadline - performance.now());
      if (value <= 0) throw new Fault('COMMAND_TIMEOUT', 'The setup repair deadline expired');
      return value;
    };
    if (!this.instance) await this.launch(action.kind === 'window_ready', remaining());
    if (action.kind === 'app_running') {
      await this.verifyInstance();
      return undefined;
    }
    return this.focusPrepared(desktop, action.window, timeoutMs, preferredWindowId, true);
  }

  /**
   * A legacy flow first accepts the driver's unique installed copy, then uses
   * the same exact-path launch as a path-fixed flow.
   */
  private async ensureLegacy(
    desktop: Desktop, action: Ensure, timeoutMs: number, preferredWindowId?: string,
  ): Promise<string | undefined> {
    if (!await this.probe.available()) return desktop.ensure(action, timeoutMs, preferredWindowId);
    if (!this.instance) {
      const paths = await this.installed(this.app);
      const confirmed: string[] = [];
      for (const path of paths) {
        try {
          const canonical = await this.realpath(path);
          if (await this.readBundleId(canonical) === this.app) confirmed.push(canonical);
        } catch {
          // A candidate that cannot be read is not a usable install.
        }
      }
      if (confirmed.length > 1) {
        throw this.fault('APP_AMBIGUOUS', 'multiple_installed_copies',
          '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
      }
      if (!confirmed.length) throw new Fault('APP_NOT_FOUND', 'The target application is not installed');
      this.canonicalPath = confirmed[0];
      await this.launch(action.kind === 'window_ready', timeoutMs);
    }
    if (action.kind === 'app_running') {
      await this.verifyInstance();
      return undefined;
    }
    return this.focusPrepared(desktop, action.window, timeoutMs, preferredWindowId, true);
  }

  private async focusPrepared(
    desktop: Desktop, title: string, timeoutMs: number, preferredWindowId?: string, reopen = false,
  ): Promise<string> {
    const deadline = performance.now() + timeoutMs;
    const remaining = () => {
      const value = Math.ceil(deadline - performance.now());
      if (value <= 0) throw new Fault('COMMAND_TIMEOUT', 'The setup repair deadline expired');
      return value;
    };
    let reopened = false;
    for (;;) {
      try {
        const id = preferredWindowId ?? await this.findWindow(desktop, title, remaining());
        await desktop.focusWindow(id, remaining());
        await this.verifyWindow(id, title);
        this.checked = true;
        return id;
      } catch (error) {
        // A confirmed window repair may activate the bound copy once when the
        // window is gone; substitution stays disabled in the helper.
        if (reopen && !reopened && error instanceof Fault && error.code === 'WINDOW_NOT_FOUND' &&
            this.canonicalPath) {
          reopened = true;
          await this.probe.open(this.canonicalPath, true);
          continue;
        }
        if (error instanceof IdentityFault || remaining() <= 100) throw error;
        if (!(error instanceof Fault) || !['WINDOW_NOT_FOUND', 'AMBIGUOUS_TARGET'].includes(error.code)) throw error;
        await this.wait(100);
      }
    }
  }

  /** Launches the selected copy by file URL and re-reads PID, marker and URL. */
  private async launch(activate: boolean, timeoutMs: number) {
    if (!this.canonicalPath) throw new Fault('IDENTITY_DEPENDENCY', 'App identity preflight did not run', true);
    await this.probe.open(this.canonicalPath, activate);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const instances = await this.probe.instances(this.app);
      if (instances.length) {
        let paths: Array<RunningInstance & { canonical: string }>;
        try {
          paths = await Promise.all(instances.map(async instance => ({
            ...instance, canonical: instance.bundlePath ? await this.realpath(instance.bundlePath) : '',
          })));
        } catch {
          throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
            '无法确认操作仍指向选中的副本，本轮已停止。');
        }
        const matching = paths.filter(instance => instance.canonical === this.canonicalPath);
        if (matching.length > 1) {
          throw this.fault('APP_AMBIGUOUS', 'multiple_instances',
            '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
        }
        if (!matching.length) {
          throw this.fault('APP_AMBIGUOUS', 'path_mismatch',
            '无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。');
        }
        this.instance = matching[0];
        return;
      }
      if (performance.now() >= deadline) throw new Fault('LAUNCH_TIMEOUT', 'The application did not start before the deadline');
      await this.wait(100);
    }
  }

  /**
   * Cross-app replay binds each app once. An existing instance is re-verified;
   * otherwise a pinned copy is opened only when the caller allows a launch.
   */
  async prepare(
    desktop: Desktop, options: { launch: boolean; timeoutMs: number },
  ): Promise<RunningInstance> {
    if (this.offline) {
      throw new Fault('IDENTITY_DEPENDENCY', 'Offline reads never bind a live instance', true);
    }
    if (!this.instance) await this.bindInstances(desktop);
    if (this.instance) return this.verifyInstance();
    if (!options.launch) throw new Fault('APP_NOT_FOUND', 'The target application is not running');
    if (this.mode === 'bundle_path') {
      await this.launch(false, options.timeoutMs);
    } else {
      await this.ensureLegacy(desktop, { kind: 'app_running', app: this.app }, options.timeoutMs);
    }
    if (!this.instance) {
      throw new Fault('IDENTITY_DEPENDENCY', 'The app identity helper could not bind a launched instance', true);
    }
    return this.requireInstance();
  }

  /** Every window proven to belong to the bound instance. */
  async ownedWindows(desktop: Desktop, timeoutMs = 3000): Promise<WindowInfo[]> {
    if (this.offline) {
      throw new Fault('IDENTITY_DEPENDENCY', 'Offline runs have no live window inventory', true);
    }
    if (!this.instance) await this.bindInstances(desktop);
    const instance = await this.verifyInstance();
    const owned = (await this.probe.windows()).filter(window => window.ownerPid === instance.pid);
    const ids = new Set(owned.map(window => `w-${window.number}`));
    const driver = (await desktop.listAllWindows(timeoutMs)).filter(window => ids.has(window.id));
    // An inventory that drops a window of the bound instance cannot prove a
    // title is absent, and a driver owner that disagrees with the system means
    // the two sources no longer describe the same process.
    if (driver.length !== ids.size) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    if (driver.some(window => window.processInstance !== undefined && window.processInstance !== instance.pid)) {
      throw this.fault('APP_AMBIGUOUS', 'driver_target_unconfirmed',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    this.checked = true;
    return driver;
  }

  /** Owner check for a window already bound by number (no title comparison). */
  async verifyOwnedWindow(windowId: string) {
    await this.verifyWindow(windowId);
    this.checked = true;
  }

  /** Focuses a bound window and proves the same instance still owns it. */
  async focusOwnedWindow(desktop: Desktop, windowId: string, timeoutMs?: number) {
    await desktop.focusWindow(windowId, timeoutMs);
    await this.verifyWindow(windowId);
    this.checked = true;
  }

  /**
   * Brings the bound copy's running instance forward through its exact bundle
   * URL. The helper never substitutes another copy, and the instance is
   * re-verified after the activation so a restart is still caught.
   */
  async activate(desktop: Desktop) {
    if (!await this.probe.available()) {
      throw new Fault('IDENTITY_DEPENDENCY', 'The app identity helper is unavailable', true);
    }
    if (!this.instance) await this.bindInstances(desktop);
    const instance = await this.verifyInstance();
    const path = this.canonicalPath ?? instance.bundlePath;
    if (!path) {
      throw this.fault('APP_AMBIGUOUS', 'identity_unproven',
        '无法确认操作仍指向选中的副本，本轮已停止。');
    }
    await this.probe.open(path, true);
    await this.verifyInstance();
    this.checked = true;
  }

  get pid(): number | undefined { return this.instance?.pid; }

  /** Opaque marker that changes when the process restarts. */
  get processInstance(): string | undefined { return this.instance?.startedAt; }

  /** Public pre-input owner check for an already-bound window. */
  async verifyWindowId(windowId: string, title: string) {
    await this.verifyWindow(windowId, title);
    this.checked = true;
  }

  /** Confirms the driver focus result still points at the bound window. */
  async focusWindow(desktop: Desktop, windowId: string, title: string, timeoutMs?: number) {
    await desktop.focusWindow(windowId, timeoutMs);
    await this.verifyWindow(windowId, title);
    this.checked = true;
  }

  async screenshotWindow(desktop: Desktop, windowId: string, timeoutMs?: number) {
    await this.verifyWindow(windowId);
    const bytes = await desktop.screenshotWindow(windowId, timeoutMs);
    await this.verifyWindow(windowId);
    this.checked = true;
    return bytes;
  }

  /** True after at least one window or instance check succeeded. */
  get verified(): boolean { return this.checked; }
}

/**
 * The one failure a path-fixed flow reports instead of clicking a global
 * coordinate. Legacy flows keep their headed coordinate route.
 */
export function unsafePoint(app: string, mode: IdentityMode): IdentityFault {
  return new IdentityFault('UNSAFE_POINT', 'untargeted_input',
    '该坐标操作无法绑定到选中的副本，请改用元素定位器。', app, mode);
}
