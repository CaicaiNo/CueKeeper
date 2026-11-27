import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppIdentitySession, parseWindowId } from './app-identity.js';
import type { WindowScope } from './contracts-v2.js';
import type { Desktop, WindowInfo } from './desktop.js';
import { Fault, flatten } from './locator.js';
import type { Snapshot } from './locator.js';

// A v2 step names a scope, not a window title: the resolver binds a window key
// to one native window number inside one running process and keeps that binding
// for the whole run. Titles are labels for the first bind only; a new window
// never takes over an existing key.

/** One window key bound to the running process that owns it. */
export interface WindowBinding {
  app: string;
  windowKey: string;
  pid: number;
  /** Opaque instance marker; a restarted process gets a different value. */
  processInstance: string;
  windowNumber: number;
  windowId: string;
  /** Title recorded in the flow; used only to find the window the first time. */
  title: string;
  /** Last title the driver reported for the same window; may have changed. */
  observedTitle: string;
  /** Incremented each time this run brings the window to the front. */
  focusGeneration: number;
  /** The recorded title no longer matched; the app's only window was used. */
  rebound?: boolean;
  /**
   * Several windows carried the recorded title. `target` means the step's own
   * target told them apart, `focused` that the app's focused window was used.
   */
  sharedTitle?: 'target' | 'focused' | false;
}

export interface AppBinding {
  app: string;
  pid: number;
  processInstance: string;
}

export interface ScopeResolverOptions {
  desktop: Desktop;
  signal: AbortSignal;
  /** One pinned identity session per bundle ID. */
  identityFor(app: string): AppIdentitySession;
  launchTimeoutMs?: number;
  focusTimeoutMs?: number;
  wait?(ms: number): Promise<void>;
}

function titleOf(window: WindowInfo): string {
  return window.title;
}

/**
 * Resolves app and window scopes against a live desktop, proves ownership before
 * every read or input, and detects a foreground the run did not expect.
 */
export class ScopeResolver {
  private readonly desktop: Desktop;
  private readonly signal: AbortSignal;
  private readonly identityFor: (app: string) => AppIdentitySession;
  private readonly launchTimeoutMs: number;
  private readonly focusTimeoutMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly windows = new Map<string, WindowBinding>();
  private readonly processes = new Map<string, AppBinding>();
  /** Window this run last saw (or left) in front; a different one is a steal. */
  private expectedForeground: string | undefined;

  constructor(options: ScopeResolverOptions) {
    this.desktop = options.desktop;
    this.signal = options.signal;
    this.identityFor = options.identityFor;
    this.launchTimeoutMs = options.launchTimeoutMs ?? 15_000;
    this.focusTimeoutMs = options.focusTimeoutMs ?? 5_000;
    this.wait = options.wait ?? (ms => sleep(ms, undefined, { signal: options.signal }));
  }

  get foreground(): string | undefined { return this.expectedForeground; }

  identity(app: string): AppIdentitySession {
    return this.identityFor(app);
  }

  /** Launches the pinned copy of an app. Idempotent while it is already running. */
  async launch(app: string): Promise<AppBinding> {
    this.signal.throwIfAborted();
    const instance = await this.identityFor(app).prepare(this.desktop, {
      launch: true, timeoutMs: this.launchTimeoutMs,
    });
    const binding: AppBinding = { app, pid: instance.pid, processInstance: instance.startedAt };
    this.processes.set(app, binding);
    return binding;
  }

  /** Requires the app to be running; never launches and never rebinds. */
  async requireRunning(app: string): Promise<AppBinding> {
    this.signal.throwIfAborted();
    const instance = await this.identityFor(app).prepare(this.desktop, { launch: false, timeoutMs: 0 });
    const binding: AppBinding = { app, pid: instance.pid, processInstance: instance.startedAt };
    this.processes.set(app, binding);
    return binding;
  }

  /**
   * A fresh read-only "is any instance of this app running" check for waits. It
   * never touches the bound session, so an app that exits and is reinstalled
   * mid-flow can be observed instead of tripping over the old instance.
   */
  async appRunning(app: string): Promise<boolean> {
    this.signal.throwIfAborted();
    const instances = await this.identityFor(app).probe.instances(app);
    return instances.length > 0;
  }

  /**
   * Resolves a window scope. The first resolution matches the recorded title
   * inside the bound process; every later one follows the bound window number,
   * so a retitled or moved window keeps its key and a same-titled new window
   * cannot capture it.
   */
  async resolveWindow(
    scope: WindowScope,
    pick?: (candidates: WindowInfo[]) => Promise<{ window: WindowInfo; reason: 'target' | 'focused' } | undefined>,
    { repair = true }: { repair?: boolean } = {},
  ): Promise<WindowBinding> {
    this.signal.throwIfAborted();
    const existing = this.windows.get(scope.windowKey);
    if (existing) return this.refresh(existing);
    const app = await this.requireRunning(scope.app);
    const identity = this.identityFor(scope.app);
    const owned = await identity.ownedWindows(this.desktop);
    const matches = owned.filter(window => window.title === scope.windowTitle);
    let chosen = matches[0];
    let rebound = false;
    let sharedTitle: WindowBinding['sharedTitle'] = false;
    if (matches.length > 1) {
      // Two windows can carry one title — a folder open twice, two documents
      // saved under one name. The flow was recorded in one of them, and the
      // step's own target is what tells them apart, so the runner supplies that
      // test; without one the title stays ambiguous.
      if (!pick) {
        throw new Fault('AMBIGUOUS_TARGET', `More than one window titled "${scope.windowTitle}" belongs to ${scope.app}`);
      }
      // A minimized window cannot be clicked, so it only stands in when every
      // candidate is minimized.
      const visible = matches.filter(window => window.minimized !== true);
      const picked = await pick(visible.length ? visible : matches);
      if (!picked) {
        throw new Fault('AMBIGUOUS_TARGET', `More than one window titled "${scope.windowTitle}" belongs to ${scope.app}`);
      }
      chosen = picked.window;
      sharedTitle = picked.reason;
    }
    if (!chosen && repair && scope.app === 'com.apple.finder') {
      // Finder's sidebar view ("最近使用") is a window title the replay can
      // reopen: the recorded click on that view only exists because the view
      // was already open. Pressing the sidebar item is preparation, not a
      // recorded step, so it is best-effort and never fails the run by itself.
      await this.openFinderSidebar(scope.windowTitle);
      const refreshed = await identity.ownedWindows(this.desktop);
      const retry = refreshed.filter(window => window.title === scope.windowTitle);
      if (retry.length === 1) {
        chosen = retry[0];
        rebound = true;
      }
    }
    if (!chosen) {
      // Finder and editors retitle their window as the user navigates
      // ("最近使用" → a folder name, "untitled" → a file name). When the app
      // has exactly one window, that window is the recorded one; refusing it
      // would block a replay whose target is still there.
      if (owned.length === 1) {
        chosen = owned[0];
        rebound = true;
      } else {
        // Which windows the app does have is what tells the operator whether the
        // recorded one was closed, renamed, or never reopened.
        const open = owned.map(window => `"${titleOf(window)}"`).join(', ');
        throw new Fault('WINDOW_NOT_FOUND',
          `No window titled "${scope.windowTitle}" belongs to ${scope.app} (its windows: ${open || 'none'}); a flow starts in the window it was recorded in`);
      }
    }
    const windowNumber = parseWindowId(chosen.id);
    if (windowNumber === undefined) {
      throw new Fault('WINDOW_CHANGED', 'The driver reported a window ID that is not a native window number');
    }
    const binding: WindowBinding = {
      app: scope.app,
      windowKey: scope.windowKey,
      pid: app.pid,
      processInstance: app.processInstance,
      windowNumber,
      windowId: chosen.id,
      title: scope.windowTitle,
      observedTitle: titleOf(chosen),
      focusGeneration: 0,
      ...(rebound ? { rebound: true } : {}),
      ...(sharedTitle ? { sharedTitle } : {}),
    };
    this.windows.set(scope.windowKey, binding);
    return binding;
  }

  /** Re-proves the bound window still exists inside the same process. */
  /** Press Finder's sidebar item for a view the flow expects to be open. */
  private async openFinderSidebar(title: string) {
    try {
      const windows = await this.desktop.listWindows('com.apple.finder');
      const window = windows[0];
      if (!window) return;
      const snapshot = await this.desktop.snapshotWindow(window.id, undefined, 3000);
      const item = flatten(snapshot.tree).find(({ node }) =>
        /^(treeitem|row|cell)$/.test(node.role) && node.ref &&
        (node.name === title || node.value === title));
      if (item?.node.ref) await this.desktop.click(item.node.ref);
    } catch {
      // Best-effort preparation; the caller reports a missing window.
    }
  }

  private async refresh(binding: WindowBinding): Promise<WindowBinding> {
    const identity = this.identityFor(binding.app);
    // The inventory already proves the instance and every window's owner, so a
    // single read decides whether the bound window is still open.
    const owned = await identity.ownedWindows(this.desktop);
    const found = owned.find(window => window.id === binding.windowId);
    if (found) {
      binding.pid = identity.pid ?? binding.pid;
      binding.processInstance = identity.processInstance ?? binding.processInstance;
      binding.observedTitle = titleOf(found);
      return binding;
    }
    // The recorded window was closed or recreated (Finder reopens a window when
    // the folder is reopened). Rebind the same app's window when the recorded
    // title matches, or when that app has exactly one window, and mark the
    // binding so the report can say a rebind happened.
    const byTitle = owned.filter(window => titleOf(window) === binding.title);
    const chosen = byTitle.length === 1 ? byTitle[0] : owned.length === 1 ? owned[0] : undefined;
    if (!chosen) {
      throw new Fault('WINDOW_CHANGED', 'The bound window is no longer open; the run does not rebind to another window');
    }
    const windowNumber = parseWindowId(chosen.id);
    if (windowNumber === undefined) {
      throw new Fault('WINDOW_CHANGED', 'The driver reported a window ID that is not a native window number');
    }
    binding.pid = identity.pid ?? binding.pid;
    binding.processInstance = identity.processInstance ?? binding.processInstance;
    binding.windowId = chosen.id;
    binding.windowNumber = windowNumber;
    binding.observedTitle = titleOf(chosen);
    binding.rebound = true;
    return binding;
  }

  /** Reads the bound window's tree with owner checks before and after. */
  async snapshot(binding: WindowBinding, timeoutMs?: number): Promise<Snapshot> {
    this.signal.throwIfAborted();
    const identity = this.identityFor(binding.app);
    await identity.verifyOwnedWindow(binding.windowId);
    const snapshot = await this.desktop.snapshotWindow(binding.windowId, undefined, timeoutMs);
    if (snapshot.windowId !== binding.windowId) {
      throw new Fault('WINDOW_CHANGED', 'The driver read a different window than the bound one');
    }
    await identity.verifyOwnedWindow(binding.windowId);
    return snapshot;
  }

  /** The window the driver reports in front, without moving focus. */
  private async observedForeground(): Promise<WindowInfo | undefined> {
    if (this.desktop.focusedWindow) return this.desktop.focusedWindow();
    const windows = await this.desktop.listAllWindows();
    return windows.find(window => window.isFocused === true);
  }

  /**
   * Brings the bound window forward only when the run owns the foreground. A
   * window the run did not leave in front is a user switch, not a hand-off, so
   * the step stops instead of stealing focus back.
   *
   * `signal` is aborted when the caller's deadline passes, and `live` re-checks
   * that deadline after the foreground read and immediately before the focus
   * command. A foreground read that lands after the deadline therefore cannot
   * start the side effect it was waiting for, even when the deadline's timer
   * could not run while the driver blocked the event loop.
   */
  async confirmForeground(
    binding: WindowBinding,
    signal?: AbortSignal,
    live?: () => void,
  ): Promise<void> {
    this.signal.throwIfAborted();
    const focused = await this.observedForeground();
    // A caller that gave the observation a deadline must not have the focus
    // command it was waiting for issued by a read that landed afterwards.
    signal?.throwIfAborted();
    live?.();
    if (this.expectedForeground !== undefined && focused !== undefined &&
        focused.id !== this.expectedForeground && focused.id !== binding.windowId) {
      throw new Fault('FOCUS_INTERRUPTED',
        `Another window (${focused.id}) took the foreground; the run does not take focus back`);
    }
    if (focused?.id === binding.windowId) {
      this.expectedForeground = binding.windowId;
      return;
    }
    await this.focus(binding, signal, live);
  }

  /**
   * Read-only foreground proof for a step that must not move focus (a hover).
   * A window frame does not prove a window receives pointer events, so the
   * foreground must be observable and must be the bound window: an inventory
   * without `is_focused`, or one that names another window, stops the step
   * instead of raising it.
   */
  async requireForeground(binding: WindowBinding): Promise<void> {
    this.signal.throwIfAborted();
    const focused = await this.observedForeground();
    if (focused === undefined) {
      throw new Fault('HOVER_NOT_FOREGROUND',
        `Cannot prove the hover window "${binding.title}" is in front; ` +
        'a hover is read-only and never takes focus');
    }
    if (focused.id !== binding.windowId) {
      throw new Fault('HOVER_NOT_FOREGROUND',
        `The hover window "${binding.title}" is not in front (${focused.id} is); ` +
        'a hover is read-only and does not bring a window forward');
    }
    this.expectedForeground = binding.windowId;
  }

  /**
   * After an operator hand-off the desktop focus belongs to the operator, not to
   * an earlier step. The next step may bring its own window forward without that
   * counting as an unexpected focus steal.
   */
  acceptHandoff(): void {
    this.expectedForeground = undefined;
  }

  /** Focuses a bound window and proves its owner after the driver call. */
  private async focus(binding: WindowBinding, signal?: AbortSignal, live?: () => void): Promise<void> {
    // Checked immediately before the driver command: the command is the side
    // effect, and a deadline that passed while waiting for the foreground must
    // not start it.
    signal?.throwIfAborted();
    live?.();
    const identity = this.identityFor(binding.app);
    try {
      await identity.focusOwnedWindow(this.desktop, binding.windowId, this.focusTimeoutMs);
    } catch (error) {
      // Some Electron windows do come forward while the driver's own settle
      // check still reports ACTION_FAILED. The observed inventory is the
      // authority: accept the call only when it names this window as focused.
      if (!(error instanceof Fault) || error.code !== 'ACTION_FAILED') throw error;
      const windows = await identity.ownedWindows(this.desktop, this.focusTimeoutMs);
      if (!windows.some(window => window.id === binding.windowId && window.isFocused === true)) throw error;
    }
    binding.pid = identity.pid ?? binding.pid;
    binding.processInstance = identity.processInstance ?? binding.processInstance;
    binding.focusGeneration += 1;
    this.expectedForeground = binding.windowId;
  }

  /** Explicitly focuses a declared window after a step. */
  async focusAfter(scope: WindowScope, timeoutMs = 5_000): Promise<WindowBinding> {
    // A window opened by the step may take a moment to appear; only wait for
    // the declared hand-off to become observable, never for a different window.
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try {
        const binding = await this.resolveWindow(scope);
        await this.focus(binding);
        return binding;
      } catch (error) {
        const transient = error instanceof Fault &&
          ['WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'WINDOW_CHANGED'].includes(error.code);
        if (!transient || performance.now() >= deadline) throw error;
        await this.wait(100);
      }
    }
  }

  /**
   * After launching or activating an app, its own front window may legitimately
   * arrive in front of the run. Accept the observed foreground only when it
   * belongs to that app; anything else stays a focus interruption.
   */
  async absorbAppForeground(app: string, timeoutMs = 2_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (await this.foregroundBelongsTo(app)) return;
      if (performance.now() >= deadline) return;
      await this.wait(100);
    }
  }

  /** A declared app-scope hand-off must actually bring one of its windows forward. */
  async activateApp(app: string, timeoutMs = 5_000): Promise<AppBinding> {
    const identity = this.identityFor(app);
    const instance = await identity.prepare(this.desktop, { launch: false, timeoutMs: 0 });
    await identity.activate(this.desktop);
    const binding: AppBinding = { app, pid: instance.pid, processInstance: instance.startedAt };
    this.processes.set(app, binding);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (await this.foregroundBelongsTo(app)) return binding;
      if (performance.now() >= deadline) {
        throw new Fault('FOCUS_INTERRUPTED', `Activating ${app} did not bring one of its windows forward`);
      }
      await this.wait(100);
    }
  }

  private async foregroundBelongsTo(app: string): Promise<boolean> {
    const focused = await this.observedForeground();
    if (!focused) return false;
    const owned = await this.identityFor(app).ownedWindows(this.desktop);
    if (!owned.some(window => window.id === focused.id)) return false;
    this.expectedForeground = focused.id;
    return true;
  }
}

// A live cross-app replay drives the shared foreground. Two of them at once
// would interleave their launches and focus changes, so a run takes one lease
// for the whole session and always releases it.

export interface RunLeaseOptions {
  runId: string;
  /** State root; defaults to CUEKEEPER_STATE_DIR or ~/.cuekeeper. */
  directory?: string;
  ttlMs?: number;
  pid?: number;
  now?(): number;
}

export interface LeaseHolder {
  runId: string;
  pid: number;
  expiresAt: string;
}

export function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.CUEKEEPER_STATE_DIR?.trim();
  return configured ? configured : join(homedir(), '.cuekeeper');
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class RunLease {
  readonly runId: string;
  readonly path: string;
  private readonly pid: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private owned = false;

  constructor(options: RunLeaseOptions) {
    this.runId = options.runId;
    this.path = join(options.directory ?? defaultStateDirectory(), 'run.lock');
    this.pid = options.pid ?? process.pid;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  get held(): boolean { return this.owned; }

  private expiresAt() {
    return new Date(this.now() + this.ttlMs).toISOString();
  }

  private async holder(): Promise<LeaseHolder | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const record = JSON.parse(raw) as Partial<LeaseHolder>;
      if (typeof record.runId !== 'string' || typeof record.pid !== 'number' ||
          typeof record.expiresAt !== 'string') return undefined;
      return { runId: record.runId, pid: record.pid, expiresAt: record.expiresAt };
    } catch {
      return undefined;
    }
  }

  private record() {
    return JSON.stringify({ runId: this.runId, pid: this.pid, expiresAt: this.expiresAt() });
  }

  /** Takes the lease or reports the run that still holds it. */
  async acquire(): Promise<void> {
    if (this.owned) {
      await writeFile(this.path, this.record(), { mode: 0o600 });
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.path, 'wx', 0o600);
        try {
          await handle.writeFile(this.record());
        } finally {
          await handle.close();
        }
        this.owned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Fault('RUN_LEASE_FAILED', 'Could not create the foreground run lease');
        }
        const holder = await this.holder();
        const stale = !holder || Date.parse(holder.expiresAt) <= this.now() || !alive(holder.pid);
        if (!stale) {
          throw new Fault('RUN_BUSY', `Another run (${holder.runId}, pid ${holder.pid}) holds the foreground lease`);
        }
        await unlink(this.path).catch(() => {});
      }
    }
    throw new Fault('RUN_BUSY', 'Could not acquire the foreground run lease');
  }

  /** Extends the lease so a long run never expires under itself. */
  async refresh(): Promise<void> {
    if (!this.owned) return;
    await writeFile(this.path, this.record(), { mode: 0o600 }).catch(() => {});
  }

  /** Releases only this run's lease. */
  async release(): Promise<void> {
    if (!this.owned) return;
    this.owned = false;
    const holder = await this.holder();
    if (holder?.runId === this.runId) await unlink(this.path).catch(() => {});
  }
}

