import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Fault, contains, object, parseSnapshot, parseSurface } from './locator.js';
import type { Node, Point, Snapshot } from './locator.js';
import type { Delivery, Ensure, Target } from './contracts.js';
import { createDesktopWorkdir } from './workdir.js';

export interface WindowInfo {
  id: string;
  title: string;
  /** PID the driver reports for the window owner, when it exposes one. */
  processInstance?: number;
  /** Owner PID the driver reports for the window, when it exposes one. */
  pid?: number;
  /** Whether the window is its app's front window; absent means unproven. */
  isFocused?: boolean;
  /** A minimized window cannot be clicked, so it never stands in for another. */
  minimized?: boolean;
}

/** One display's virtual-desktop rectangle, in Quartz points. */
export interface DisplayInfo {
  id?: string;
  /** A second display can sit to the left or above: negative x/y is normal. */
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary?: boolean;
}

/** One running application from the driver's app inventory. */
export interface RunningApp {
  /** The process the app owns windows through; the join key to WindowInfo.pid. */
  pid: number;
  bundleId?: string;
  name?: string;
}

export interface ClickOptions {
  /** Physical click count. 2 and 3 need headed mode. */
  count?: 1 | 2 | 3;
  button?: 'left' | 'right';
}

export interface ScrollOptions {
  direction: 'up' | 'down' | 'left' | 'right';
  amount: number;
}

export interface WheelOptions {
  deltaX: number;
  deltaY: number;
}

export interface HoverOptions {
  /**
   * Walk the pointer in with a short path instead of jumping. The path is built
   * from the window bounds read at delivery time, so every point sent was inside
   * the window the driver had just answered for.
   */
  travel?: boolean;
  /**
   * Move the pointer without focusing, raising or clicking anything. The caller
   * must have proven the window is in front; the adapter re-reads the window and
   * the foreground, and refuses to move when either cannot be proven now.
   */
  readOnly?: boolean;
}

/**
 * One drag endpoint. A resolved element keeps the drop target semantic; a point
 * keeps the exact recorded position (text selection, window moves).
 */
export interface DragEndpoint {
  ref?: string;
  point?: Point;
}

export interface DragOptions {
  durationMs: number;
  button?: 'left' | 'right';
}

/** The plain-text form of the clipboard, or a type we do not record. */
export type ClipboardRead =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file_urls' | 'empty' };

export interface Desktop {
  snapshot(target: Target, timeoutMs?: number, windowId?: string, exactWindow?: boolean): Promise<Snapshot>;
  property(node: Node, property: 'text' | 'value' | 'visible', timeoutMs?: number): Promise<string | boolean | undefined>;
  ensure(action: Ensure, timeoutMs: number, windowId?: string): Promise<string | undefined>;
  click(ref: string, options?: ClickOptions): Promise<Delivery | undefined>;
  clickPoint(snapshot: Snapshot, target: Target, point: Point, options?: ClickOptions): Promise<Delivery | undefined>;
  /** Semantic scroll of an element. */
  scroll(ref: string, options: ScrollOptions): Promise<Delivery | undefined>;
  /** Physical wheel at a screen point; requires headed mode. */
  scrollPoint(snapshot: Snapshot, target: Target, point: Point, options: WheelOptions): Promise<Delivery | undefined>;
  /**
   * Physical pointer move to a screen point; requires headed mode. Read-only:
   * it re-reads the bound window instead of focusing it.
   */
  hoverAt(snapshot: Snapshot, target: Target, point: Point, options?: HoverOptions): Promise<Delivery | undefined>;
  /**
   * Physical pointer move to a recorded screen point with no window binding.
   * Requires headed mode; the point and the driver's own pre-move must fall
   * inside one display, and the path is built from that display's bounds.
   */
  hoverScreen(point: Point, options?: { travel?: boolean }): Promise<Delivery | undefined>;
  /** The connected displays and their virtual-desktop bounds, read-only. */
  listDisplays(timeoutMs?: number): Promise<DisplayInfo[]>;
  /** Physical press, move and release between two endpoints; requires headed mode. */
  drag(snapshot: Snapshot, target: Target, from: DragEndpoint, to: DragEndpoint, options: DragOptions): Promise<Delivery | undefined>;
  type(ref: string, text: string): Promise<Delivery | undefined>;
  press(combo: string, snapshot: Snapshot): Promise<Delivery | undefined>;
  /** Put keyboard focus on one element before a clipboard paste. */
  focus(ref: string): Promise<void>;
  /** Read the plain-text clipboard without writing anything. */
  readClipboard(): Promise<ClipboardRead>;
  /** Write plain text to the clipboard; the text travels through stdin. */
  writeClipboard(text: string): Promise<Delivery | undefined>;
  /** Read-only application window inventory for window assertions. */
  listWindows(app: string, timeoutMs?: number): Promise<WindowInfo[]>;
  /** Read-only inventory without an app filter, for identity cross-checks. */
  listAllWindows(timeoutMs?: number): Promise<WindowInfo[]>;
  /**
   * The window the system currently treats as frontmost, read without moving
   * focus. Absent when the driver does not report `is_focused` at all.
   */
  focusedWindow?(timeoutMs?: number): Promise<WindowInfo | undefined>;
  /** Read-only application inventory, for mapping a window's owner PID to a bundle ID. */
  listApps(timeoutMs?: number): Promise<RunningApp[]>;
  /** Window-only calls; no bundle ID is resolved by the driver. */
  snapshotWindow(
    windowId: string,
    title?: string,
    timeoutMs?: number,
    options?: {
      forceElectronA11y?: boolean;
      /**
       * Ceiling for the driver process itself, when it differs from the
       * observation budget plus the usual startup margin. A recorder that
       * retries a slow read keeps the two attempts inside one bounded window
       * this way.
       */
      commandTimeoutMs?: number;
    },
  ): Promise<Snapshot>;
  /** Menu/menubar surfaces, which have no window of their own. */
  snapshotSurface(surface: 'menu' | 'menubar', timeoutMs?: number): Promise<Snapshot>;
  /** A physical click at a screen point, with no window binding of its own. */
  clickScreen(point: Point, options?: { button?: 'left' | 'right' }): Promise<Delivery | undefined>;
  /** Type into the keyboard focus, for controls that AX does not expose. */
  typeFocused(text: string, app?: string, options?: { selectAll?: boolean }): Promise<void>;
  /** Semantic AX press with no physical delivery, for transient menus. */
  clickSemantic(ref: string): Promise<Delivery | undefined>;
  focusWindow(windowId: string, timeoutMs?: number): Promise<void>;
  screenshotWindow(windowId: string, timeoutMs?: number): Promise<Uint8Array>;
  /** Capture the whole window as PNG bytes without touching the window. */
  screenshot(app: string, windowId: string, timeoutMs?: number): Promise<Uint8Array>;
}

export const agentDesktopVersion = '1.3.1';
/**
 * Pause between two moves of a hover approach. Long enough for the app to see
 * separate mouse-moved events, short enough that a hover still lands quickly.
 */
const hoverStepMs = 40;
/** How far from the resting point the pointer starts its approach, in pixels. */
const hoverApproachOffsetPx = 20;

/**
 * The pointer path of a travel hover: a start 20 px away, two steps along the
 * way, then the resting point. A single move can produce no event at all when
 * the pointer already sits on the target, and apps that only open a tooltip
 * after a run of mouse-moved events never react to a teleport.
 */
function hoverPath(point: Point, window: NonNullable<Snapshot['tree']['bounds']>): Point[] {
  const dx = window.x + window.width / 2 - point[0];
  const dy = window.y + window.height / 2 - point[1];
  const length = Math.hypot(dx, dy);
  // A point at the very centre has no direction to walk in; head up-left.
  const [ux, uy] = length < 1 ? [-Math.SQRT1_2, -Math.SQRT1_2] : [dx / length, dy / length];
  const clamp = (value: number, low: number, high: number) =>
    high < low ? low : Math.min(Math.max(value, low), high);
  const start: Point = [
    clamp(Math.round(point[0] + ux * hoverApproachOffsetPx), window.x + 1, window.x + window.width - 2),
    clamp(Math.round(point[1] + uy * hoverApproachOffsetPx), window.y + 1, window.y + window.height - 2),
  ];
  const approach = [0, 1 / 3, 2 / 3].map((fraction): Point => [
    Math.round(start[0] + (point[0] - start[0]) * fraction),
    Math.round(start[1] + (point[1] - start[1]) * fraction),
  ]);
  return [...approach, point];
}

const deliveryStates = new Set(['delivered_verified', 'delivered_unverified', 'delivery_uncertain', 'not_delivered', 'unknown']);

export class DesktopFault extends Fault {
  constructor(code: string, command: string, public delivery: Delivery | undefined) {
    super(code, `agent-desktop ${command} returned ${code}`);
  }
}

export function isMissingWindow(error: unknown): error is Fault {
  return error instanceof Fault && (error.code === 'APP_NOT_FOUND' || error.code === 'WINDOW_NOT_FOUND');
}

function isCommandTimeout(error: unknown) {
  return error instanceof Fault && (error.code === 'TIMEOUT' || error.code === 'COMMAND_TIMEOUT');
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value :
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

function windowList(data: unknown): WindowInfo[] {
  if (!Array.isArray(data)) throw new Fault('BAD_RESPONSE', 'Expected a window inventory');
  return data.map(object).map(window => {
    if (typeof window.id !== 'string' || !/^w-[a-zA-Z0-9_.:-]+$/.test(window.id)) {
      throw new Fault('BAD_RESPONSE', 'Missing or invalid window ID');
    }
    const raw = window.process_instance ?? window.processInstance;
    const processInstance = positiveInteger(raw);
    const pid = positiveInteger(window.pid);
    return {
      id: window.id,
      title: typeof window.title === 'string' ? window.title : '',
      ...(processInstance === undefined ? {} : { processInstance }),
      ...(pid === undefined ? {} : { pid }),
      ...(typeof window.is_focused === 'boolean' ? { isFocused: window.is_focused } : {}),
      ...(typeof window.minimized === 'boolean' ? { minimized: window.minimized } : {}),
    };
  });
}

/** The display layout, parsed fail-closed: a malformed answer is no layout. */
function displayList(data: unknown): DisplayInfo[] {
  if (!Array.isArray(data)) throw new Fault('BAD_RESPONSE', 'Expected a display inventory');
  const displays = data.map(object).map(display => {
    const bounds = object(display.bounds);
    const numbers = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (!numbers.every(value => typeof value === 'number' && Number.isFinite(value)) ||
        (bounds.width as number) <= 0 || (bounds.height as number) <= 0) {
      throw new Fault('BAD_RESPONSE', 'Missing or invalid display bounds');
    }
    return {
      ...(typeof display.id === 'string' ? { id: display.id } : {}),
      bounds: {
        x: bounds.x as number, y: bounds.y as number,
        width: bounds.width as number, height: bounds.height as number,
      },
      ...(typeof display.is_primary === 'boolean' ? { isPrimary: display.is_primary } : {}),
    };
  });
  if (!displays.length) throw new Fault('BAD_RESPONSE', 'The display inventory is empty');
  return displays;
}

function appList(data: unknown): RunningApp[] {
  const inventory = object(data);
  if (!Array.isArray(inventory.apps)) throw new Fault('BAD_RESPONSE', 'Expected an application inventory');
  const apps: RunningApp[] = [];
  for (const item of inventory.apps) {
    const app = object(item);
    const pid = positiveInteger(app.pid);
    // An entry without a process ID cannot be joined to a window; skip it
    // rather than failing the whole inventory on a partial record.
    if (pid === undefined) continue;
    apps.push({
      pid,
      ...(typeof app.bundle_id === 'string' && app.bundle_id ? { bundleId: app.bundle_id } : {}),
      ...(typeof app.name === 'string' && app.name ? { name: app.name } : {}),
    });
  }
  return apps;
}

/** The window one snapshot answer describes, as the driver reported it. */
function readWindow(data: unknown): { id: string; title: string } {
  try {
    const window = object(object(data).window);
    return {
      id: typeof window.id === 'string' ? window.id : '',
      title: typeof window.title === 'string' ? window.title : '',
    };
  } catch {
    // The parse that follows reports the malformed answer with this context.
    return { id: '', title: '' };
  }
}

/** Where a tree read landed: its window number, its title then, and any hint. */
function describeWindow(window: { id: string; title: string }, hint?: string) {
  const recorded = hint && hint !== window.title ? `; recorded title "${hint}"` : '';
  return `window ${window.id}, title "${window.title}"${recorded}`;
}

function delivery(result: Record<string, unknown>): Delivery | undefined {
  if (result.disposition === undefined) return undefined;
  const value = object(result.disposition).delivery;
  return typeof value === 'string' && deliveryStates.has(value) ? value as Delivery : undefined;
}

function commandRunner(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const executable = process.env.CUEKEEPER_AGENT_DESKTOP || 'agent-desktop';
  return (command: string, args: string[], input?: string, timeout = 15_000) =>
    new Promise<unknown>((resolve, reject) => {
      const child = execFile(executable, [command, ...args], {
        encoding: 'utf8', env, signal, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      }, (error, stdout) => {
        if (signal.aborted) return reject(signal.reason);
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          return reject(new Fault('DESKTOP_DEPENDENCY', 'Cannot execute agent-desktop', true));
        }
        try {
          const envelope = object(JSON.parse(stdout));
          if (envelope.command !== command) throw new Error('Command mismatch');
          if (envelope.ok === true && !error) return resolve(envelope.data);
          const fault = object(envelope.error);
          const code = typeof fault.code === 'string' && /^[A-Z_]+$/.test(fault.code) ? fault.code : 'ACTION_FAILED';
          reject(new DesktopFault(code, command, delivery(fault)));
        } catch {
          const code = error?.killed ? 'COMMAND_TIMEOUT' : 'BAD_RESPONSE';
          reject(new DesktopFault(code, command, 'unknown'));
        }
      });
      child.stdin?.on('error', () => { /* Child exit is handled by execFile. */ });
      child.stdin?.end(input);
    });
}

export async function withDesktop<T>(
  options: { headed: boolean; signal: AbortSignal; workRoot?: string },
  work: (desktop: Desktop) => Promise<T>,
): Promise<T> {
  // A durable root, not the inherited TMPDIR: that directory can be deleted
  // while the process is still running, which made every run fail on mkdtemp.
  const state = (await createDesktopWorkdir(options.workRoot)).directory;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESKTOP_') && !key.startsWith('CUEKEEPER_SECRET_')));
    env.AGENT_DESKTOP_HOME = state;
    const call = commandRunner(env, options.signal);
    const version = object(await call('version', []));
    if (version.version !== agentDesktopVersion) {
      throw new Fault('DESKTOP_VERSION', `Expected agent-desktop ${agentDesktopVersion}`, true);
    }

    async function findWindow(target: Target, timeoutMs: number, windowId?: string) {
      let data: unknown;
      try {
        data = await call('list-windows', ['--app', target.app, '--timeout-ms', String(timeoutMs)], undefined, timeoutMs);
      } catch (error) {
        if (isMissingWindow(error)) return undefined;
        throw error;
      }
      if (!Array.isArray(data)) throw new Fault('BAD_RESPONSE', 'Expected a window inventory');
      const matches = data.map(object).filter(window => window.title === target.window);
      const candidates = windowId ? matches.filter(window => window.id === windowId) : matches;
      if (windowId && !candidates.length && matches.length) {
        throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
      }
      if (candidates.length > 1) throw new Fault('AMBIGUOUS_TARGET', 'More than one window matches the flow title');
      if (!candidates.length) return undefined;
      const id = candidates[0].id;
      if (typeof id !== 'string' || !/^w-[a-zA-Z0-9_.:-]+$/.test(id)) {
        throw new Fault('BAD_RESPONSE', 'Missing or invalid window ID');
      }
      return id;
    }

    async function snapshot(target: Target, timeoutMs = 3000, windowId?: string, exactWindow = false) {
      const deadline = performance.now() + timeoutMs;
      if (exactWindow && !windowId) {
        windowId = await findWindow(target, timeoutMs);
        if (!windowId) throw new Fault('WINDOW_NOT_FOUND', 'The requested window title was not found');
      }
      const remaining = exactWindow ? Math.ceil(deadline - performance.now()) : timeoutMs;
      if (exactWindow && remaining <= 0) throw new Fault('COMMAND_TIMEOUT', 'Timed out resolving the target window');
      return parseSnapshot(await call('snapshot', [
        '--app', target.app, '--include-bounds', '--max-depth', '50', '--timeout-ms', String(remaining),
        ...(windowId ? ['--window-id', windowId] : []),
      ], undefined, exactWindow ? remaining : timeoutMs + 3000), target);
    }

    async function launch(app: string, activate: boolean, timeoutMs: number) {
      // Leave time for CLI startup and for observing the result after the native launch deadline.
      const budget = Math.max(1, timeoutMs - Math.min(1000, Math.ceil(timeoutMs / 4)));
      try {
        await call('launch', ['--timeout', String(budget), ...(activate ? ['--activate'] : []), '--', app],
          undefined, timeoutMs);
      } catch (error) {
        if (error instanceof DesktopFault && isCommandTimeout(error)) {
          throw new DesktopFault('LAUNCH_TIMEOUT', 'launch', error.delivery);
        }
        throw error;
      }
    }

    const act = async (command: string, args: string[], input?: string, headed = options.headed, timeout = 15_000) => {
      if (process.env.CUEKEEPER_TRACE_DESKTOP) {
        process.stderr.write(`[desktop] ${command} ${headed ? '--headed ' : ''}${args.join(' ')}\n`);
      }
      const result = delivery(object(await call(command, [...(headed ? ['--headed'] : []), ...args],
        input, timeout + (input?.length ?? 0) * 30)));
      if (result === 'not_delivered') throw new DesktopFault('NOT_DELIVERED', command, result);
      if (!result || result === 'unknown' || result === 'delivery_uncertain') {
        throw new DesktopFault('DELIVERY_UNCERTAIN', command, result ?? 'unknown');
      }
      return result;
    };

    // Coordinate input is global, so it re-focuses the bound window and
    // re-reads it before delivery. Scrolling at a point needs the same guard.
    const requirePoint = async (current: Snapshot, target: Target, point: Point) => {
      if (!options.headed) throw new Fault('HEADED_REQUIRED', 'Physical coordinate input requires --headed');
      const result = object(await call('focus-window', ['--window-id', current.windowId]));
      const focused = object(result.focused);
      const observed = await snapshot(target);
      if (focused.id !== current.windowId || observed.windowId !== current.windowId ||
          !contains(observed.tree.bounds, point)) {
        throw new Fault('UNSAFE_POINT', 'The coordinate is outside the selected window');
      }
    };

    const clickCommand = (count: number, button: 'left' | 'right') => {
      if (button === 'right') {
        if (count !== 1) throw new Fault('UNSUPPORTED_CLICK_COUNT', 'A right click cannot carry a click count');
        return 'right-click';
      }
      if (count === 2) return 'double-click';
      if (count === 3) return 'triple-click';
      return 'click';
    };

    return await work({
      snapshot,
      async ensure(action, timeoutMs, windowId) {
        if (process.platform !== 'darwin') {
          throw new Fault('UNSUPPORTED_PLATFORM', 'Setup repair requires macOS');
        }
        const deadline = performance.now() + timeoutMs;
        const remaining = () => Math.ceil(deadline - performance.now());
        const budget = () => {
          options.signal.throwIfAborted();
          const ms = remaining();
          if (ms <= 0) throw new Fault('COMMAND_TIMEOUT', 'The setup repair deadline expired');
          return ms;
        };
        if (action.kind === 'app_running') {
          const ms = budget();
          const inventory = object(await call('list-apps', ['--app', action.app, '--timeout-ms', String(ms)],
            undefined, ms));
          if (!Array.isArray(inventory.apps)) throw new Fault('BAD_RESPONSE', 'Expected an application inventory');
          if (inventory.apps.length > 1) {
            throw new Fault('AMBIGUOUS_TARGET', 'More than one running application matches the repair target');
          }
          if (inventory.apps.length === 1) return;
          if (inventory.complete === false) throw new Fault('APP_INVENTORY_INCOMPLETE', 'Application state is unknown');
          await launch(action.app, false, budget());
          return;
        }

        const requested = { app: action.app, window: action.window };
        let id = await findWindow(requested, budget(), windowId);
        if (!id) {
          await launch(action.app, true, budget());
          while (remaining() > 0) {
            try {
              id = await findWindow(requested, budget(), windowId);
            } catch (error) {
              if (options.signal.aborted || !isCommandTimeout(error)) throw error;
              break;
            }
            if (id || remaining() <= 100) break;
            await sleep(100, undefined, { signal: options.signal });
          }
        }
        if (!id) throw new Fault('WINDOW_NOT_FOUND', 'The requested window could not be confirmed before the repair deadline');
        const result = object(await call('focus-window', ['--app', action.app, '--window-id', id], undefined, budget()));
        if (object(result.focused).id !== id) throw new Fault('WINDOW_CHANGED', 'Focused window did not match the repair target');
        return id;
      },
      async property(node, property, timeoutMs) {
        if (!node.ref) return snapshotProperty(node, property);
        if (property === 'visible') {
          const value = object(await call('is', [node.ref, '--property', 'visible'], undefined, timeoutMs));
          return value.applicable === true && typeof value.result === 'boolean' ? value.result : undefined;
        }
        const value = object(await call('get', [node.ref, '--property', property], undefined, timeoutMs)).value;
        return typeof value === 'string' ? value : undefined;
      },
      async listWindows(app, timeoutMs = 3000) {
        const data = await call('list-windows', ['--app', app, '--timeout-ms', String(timeoutMs)],
          undefined, timeoutMs + 3000);
        return windowList(data);
      },
      async listAllWindows(timeoutMs = 3000) {
        const data = await call('list-windows', ['--timeout-ms', String(timeoutMs)],
          undefined, timeoutMs + 3000);
        return windowList(data);
      },
      async focusedWindow(timeoutMs = 3000) {
        const data = await call('list-windows', ['--timeout-ms', String(timeoutMs)],
          undefined, timeoutMs + 3000);
        return windowList(data).find(window => window.isFocused === true);
      },
      async listApps(timeoutMs = 3000) {
        const data = await call('list-apps', ['--timeout-ms', String(timeoutMs)],
          undefined, timeoutMs + 3000);
        return appList(data);
      },
      async snapshotWindow(windowId, title, timeoutMs = 3000, options = {}) {
        const data = await call('snapshot', [
          '--include-bounds', '--max-depth', '50', '--timeout-ms', String(timeoutMs), '--window-id', windowId,
          // The recorder's helper holds Chromium's accessibility mode on for the
          // whole session, so the driver can skip its own activation guidance.
          ...(options.forceElectronA11y ? ['--force-electron-a11y'] : []),
        ], undefined, options.commandTimeoutMs ?? timeoutMs + 3000);
        // A v2 scope follows its window by number, so a recorded title is only a
        // hint: an editor drops its unsaved dot and a Finder window follows its
        // folder, and neither changes which window this is. Identity is the
        // driver's own window ID; the tree is parsed with the title the same
        // answer reported, so a retitle never reads as a mismatch.
        const observed = readWindow(data);
        if (observed.id && observed.id !== windowId) {
          throw new Fault('WINDOW_CHANGED',
            `The accessibility read answered ${describeWindow(observed)} instead of the bound window ${windowId}`);
        }
        try {
          return parseSnapshot(data, { app: '', window: observed.title });
        } catch (error) {
          if (!(error instanceof Fault)) throw error;
          // A failed read has to say which window and title it was of, or the
          // recording can only report the code again.
          throw new Fault(error.code,
            `${error.message} (${describeWindow({ ...observed, id: observed.id || windowId }, title)})`,
            error.dependency, error.reason);
        }
      },
      clickSemantic(ref) {
        // A context menu is transient: physical delivery races the menu, while
        // the semantic AX press lands inside it.
        return act('click', [ref], undefined, false);
      },
      async typeFocused(text, app, { selectAll = false } = {}) {
        // Finder's rename editor is not in the accessibility tree, so the
        // driver cannot address it. System Events types into whatever holds
        // keyboard focus, which is the editor the menu item just opened — but
        // only when the app is frontmost: a replay runs from a terminal that
        // would otherwise receive the keystrokes.
        if (app) {
          await promisify(execFile)('/usr/bin/osascript', [
            '-e', `tell application id "${app}" to activate`,
            '-e', 'delay 0.2',
          ]).catch(() => undefined);
        }
        // Cmd+A must be a real key event. The driver's `press meta+a` resolves
        // the app's Select All menu item and would select files, not the text.
        if (selectAll) {
          await promisify(execFile)('/usr/bin/osascript', [
            '-e', 'tell application "System Events" to keystroke "a" using command down',
            '-e', 'delay 0.1',
          ]);
        }
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await promisify(execFile)('/usr/bin/osascript', [
          '-e', `tell application "System Events" to keystroke "${escaped}"`,
        ]);
      },
      clickScreen(point, { button = 'left' } = {}) {
        return act('mouse-click', [
          '--xy', point.join(','), ...(button === 'right' ? ['--button', 'right'] : []),
        ]);
      },
      async snapshotSurface(surface, timeoutMs = 3000) {
        const data = await call('snapshot', [
          '--surface', surface, '--include-bounds', '--max-depth', '20', '--timeout-ms', String(timeoutMs),
        ], undefined, timeoutMs + 3000);
        return parseSurface(data);
      },
      async focusWindow(windowId, timeoutMs = 5000) {
        const result = object(await call('focus-window', ['--window-id', windowId], undefined, timeoutMs));
        if (object(result.focused).id !== windowId) {
          throw new Fault('WINDOW_CHANGED', 'The focused window did not match the bound window');
        }
      },
      async screenshotWindow(windowId, timeoutMs = 10_000) {
        const path = join(state, `assertion-${Date.now()}.png`);
        try {
          await call('screenshot', ['--window-id', windowId, path], undefined, timeoutMs);
          return new Uint8Array(await readFile(path));
        } catch (error) {
          if (error instanceof Fault) throw error;
          throw new Fault('ASSERTION_CAPTURE_FAILED', 'The window screenshot wrote no readable PNG');
        } finally {
          await rm(path, { force: true });
        }
      },
      async screenshot(app, windowId, timeoutMs = 10_000) {
        const path = join(state, `assertion-${Date.now()}.png`);
        try {
          await call('screenshot', ['--app', app, '--window-id', windowId, path], undefined, timeoutMs);
          return new Uint8Array(await readFile(path));
        } catch (error) {
          if (error instanceof Fault) throw error;
          throw new Fault('ASSERTION_CAPTURE_FAILED', 'The window screenshot wrote no readable PNG');
        } finally {
          await rm(path, { force: true });
        }
      },
      click(ref, { count = 1, button = 'left' } = {}) {
        if (count > 1) {
          if (!options.headed) {
            throw new Fault('HEADED_REQUIRED', 'Double and triple clicks are physical input and require --headed');
          }
          if (count !== 2 && count !== 3) {
            throw new Fault('UNSUPPORTED_CLICK_COUNT', 'Only double and triple clicks are supported');
          }
        }
        return act(clickCommand(count, button), [ref]);
      },
      async clickPoint(current, target, point, { count = 1, button = 'left' } = {}) {
        await requirePoint(current, target, point);
        return act('mouse-click', [
          '--xy', point.join(','),
          ...(button === 'right' ? ['--button', 'right'] : []),
          ...(count === 1 ? [] : ['--count', String(count)]),
        ]);
      },
      scroll(ref, { direction, amount }) {
        return act('scroll', [ref, '--direction', direction, '--amount', String(amount)]);
      },
      async scrollPoint(current, target, point, { deltaX, deltaY }) {
        await requirePoint(current, target, point);
        if (deltaX === 0 && deltaY === 0) throw new Fault('UNSUPPORTED_SCROLL', 'Scroll deltas must not both be zero');
        return act('mouse-wheel', [
          '--x', String(point[0]), '--y', String(point[1]),
          // A negative delta must be written with `=` so it is not read as a flag.
          `--dx=${deltaX}`, `--dy=${deltaY}`,
        ]);
      },
      async hoverAt(current, target, point, { travel = false, readOnly = false } = {}) {
        if (!readOnly) {
          // A hover that is allowed to prepare its window keeps the delivery
          // gate every other coordinate input uses: bring the bound window
          // forward, re-read it and prove the point is inside it.
          await requirePoint(current, target, point);
          return act('mouse-move', [`--xy=${point.join(',')}`]);
        }
        if (!options.headed) throw new Fault('HEADED_REQUIRED', 'Physical pointer movement requires --headed');
        // A read-only hover must not focus, raise or click its window. The bound
        // window is read again by ID without moving focus, the foreground is
        // read after that so the evidence is the latest the driver can give, and
        // the whole path is built from the same window answer. Any point that
        // cannot be proven inside it, or a window that is not in front, stops
        // the step before the first move.
        const observed = await snapshot(target, 3000, current.windowId);
        if (observed.windowId !== current.windowId) {
          throw new Fault('WINDOW_CHANGED',
            'The hover read answered a different window than the bound one; nothing was moved');
        }
        const inventory = windowList(await call('list-windows', ['--timeout-ms', '3000'], undefined, 6000));
        const focused = inventory.find(window => window.isFocused === true);
        if (focused?.id !== current.windowId) {
          throw new Fault('HOVER_NOT_FOREGROUND',
            focused === undefined
              ? 'The driver did not report which window is in front; a hover needs its window in front and never takes focus'
              : `The hover window is not in front (${focused.id} is); a hover never takes focus`);
        }
        const bounds = observed.tree.bounds;
        if (!bounds) {
          throw new Fault('UNSAFE_POINT', 'The hover window has no bounds to place the pointer in; nothing was moved');
        }
        const path = travel ? hoverPath(point, bounds) : [point];
        for (const step of path) {
          // agent-desktop 1.3.1 posts mouse-move as (x - 1, y) and then the
          // requested point, so both moves must land inside the window. The
          // resting point is the first that can sit on the left edge; refusing
          // it is the only way to keep the driver's own pre-move from landing
          // in whatever window is beside it.
          if (!contains(bounds, step) || !contains(bounds, [step[0] - 1, step[1]])) {
            throw new Fault('UNSAFE_POINT',
              `The hover move to ${step.join(',')} cannot be delivered inside the bound window ` +
              `(the driver first posts ${step[0] - 1},${step[1]}); nothing was moved`);
          }
        }
        // A pointer that arrives in one jump produces no motion for apps that
        // only open a tooltip after a run of mouse-moved events. The resting
        // move is last; its delivery is what the step reports.
        let delivery: Delivery | undefined;
        for (const [index, step] of path.entries()) {
          // A negative coordinate must be written with `=` so it is not read as a flag.
          delivery = await act('mouse-move', [`--xy=${step.join(',')}`]);
          if (index < path.length - 1) await sleep(hoverStepMs);
        }
        return delivery;
      },
      async listDisplays(timeoutMs = 5000) {
        return displayList(await call('list-displays', [], undefined, timeoutMs));
      },
      async hoverScreen(point, { travel = false } = {}) {
        if (!options.headed) {
          throw new Fault('HEADED_REQUIRED', 'Physical pointer movement requires --headed');
        }
        // A screen hover binds no window, so the display layout is the only
        // proof the point exists. A layout that cannot be read is treated like
        // an off-screen point: fail closed, move nothing.
        let displays: DisplayInfo[];
        try {
          displays = displayList(await call('list-displays', [], undefined, 5000));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Fault('UNSAFE_POINT',
            `The display layout could not be read (${message}); nothing was moved`);
        }
        const inside = (bounds: DisplayInfo['bounds'], step: Point) =>
          contains(bounds, step) && contains(bounds, [step[0] - 1, step[1]]);
        const display = displays.find(candidate => inside(candidate.bounds, point));
        if (!display) {
          throw new Fault('UNSAFE_POINT',
            `The recorded screen point ${point.join(',')} is not inside one display ` +
            `(the driver first posts ${point[0] - 1},${point[1]}); nothing was moved`);
        }
        const path = travel ? hoverPath(point, display.bounds) : [point];
        for (const step of path) {
          if (!inside(display.bounds, step)) {
            throw new Fault('UNSAFE_POINT',
              `The screen hover move to ${step.join(',')} leaves the display ${display.id ?? ''}` +
              `(the driver first posts ${step[0] - 1},${step[1]}); nothing was moved`.trim());
          }
        }
        let delivery: Delivery | undefined;
        for (const [index, step] of path.entries()) {
          delivery = await act('mouse-move', [`--xy=${step.join(',')}`]);
          if (index < path.length - 1) await sleep(hoverStepMs);
        }
        return delivery;
      },
      focus(ref) {
        return call('focus', [ref]).then(() => undefined);
      },
      async readClipboard() {
        // `auto` prefers file references, then images, then text. Only text is
        // recorded; any other representation stays an explicit type here.
        const data = object(await call('clipboard-get', ['--format', 'auto']));
        if (data.type === 'text' && typeof data.text === 'string') return { type: 'text', text: data.text };
        if (data.type === 'image' || data.type === 'file_urls') return { type: data.type };
        return { type: 'empty' };
      },
      writeClipboard(text) {
        // Keep clipboard text out of process arguments.
        return act('clipboard-set', ['--stdin'], text, false);
      },
      async drag(current, target, from, to, { durationMs, button = 'left' }) {
        if (!options.headed) throw new Fault('HEADED_REQUIRED', 'Drag is physical input and requires --headed');
        if (button !== 'left') {
          throw new Fault('UNSUPPORTED_DRAG_BUTTON', 'agent-desktop can only drag with the left button');
        }
        if (!from.ref && !from.point) throw new Fault('UNSUPPORTED_DRAG', 'A drag needs a start element or point');
        if (!to.ref && !to.point) throw new Fault('UNSUPPORTED_DRAG', 'A drag needs a destination element or point');
        // A point start is global input: re-focus the bound window and confirm
        // the start still lands inside it before the gesture begins. A started
        // drag cannot be cancelled, so this check must run first.
        if (from.point) await requirePoint(current, target, from.point);
        const timeout = Math.max(5000, durationMs + 5000);
        return act('drag', [
          ...(from.ref ? ['--from', from.ref] : [`--from-xy=${from.point!.join(',')}`]),
          ...(to.ref ? ['--to', to.ref] : [`--to-xy=${to.point!.join(',')}`]),
          '--duration', String(durationMs), '--timeout-ms', String(timeout),
        ], undefined, true, timeout + 5000);
      },
      // Keep text out of process arguments. Headed replay uses headed text
      // injection: Chromium web content rejects the headless AX text path
      // (ACTION_FAILED) while native controls accept both. Headless replay
      // keeps the original path.
      type: (ref, input) => act('type', [ref, '--stdin'], input, options.headed),
      press: (combo, current) => act('press', [combo, '--window-id', current.windowId]),
    });
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

function snapshotProperty(node: Node, property: 'text' | 'value' | 'visible') {
  if (property === 'visible') {
    if (node.states.includes('hidden') || node.states.includes('offscreen')) return false;
    return node.states.includes('visible') ? true : undefined;
  }
  if (property === 'value') return node.value;
  if (node.text !== undefined) return node.text;
  return ['textfield', 'combobox', 'listbox', 'datefield', 'timefield'].includes(node.role) ?
    node.value ?? node.name : node.name ?? node.value;
}

export function fixtureAppPath(data: unknown): string | undefined {
  try {
    const target = object(object(data).target);
    return typeof target.appPath === 'string' && target.appPath ? target.appPath : undefined;
  } catch {
    return undefined;
  }
}

export function offlineDesktop(data: unknown, expected: Target): Desktop {
  const fixture = object(data);
  const target = object(fixture.target);
  if (target.app !== expected.app || target.window !== expected.window) {
    throw new Fault('WINDOW_MISMATCH', 'Fixture target does not match the flow target', true);
  }
  if (fixture.version !== '2.6' || fixture.command !== 'snapshot' || fixture.ok !== true) {
    throw new Fault('BAD_RESPONSE', 'Expected an agent-desktop 2.6 snapshot envelope', true);
  }
  const snap = parseSnapshot(fixture.data, expected);
  async function mutate(): Promise<never> { throw new Error('Offline snapshots cannot execute actions'); }
  return {
    async snapshot(requested) {
      if (requested.app !== expected.app || requested.window !== expected.window) {
        throw new Fault('WINDOW_MISMATCH', 'Offline fixture does not cover the requested window', true);
      }
      return snap;
    },
    property: async (node, property) => snapshotProperty(node, property),
    async listWindows(app) {
      if (app !== expected.app) {
        throw new Fault('WINDOW_MISMATCH', 'Offline fixture does not cover the requested app');
      }
      // The fixture describes exactly one window, so window assertions resolve
      // against it and only that window is visible in the inventory.
      return [{ id: snap.windowId, title: expected.window }];
    },
    async listAllWindows() {
      return [{ id: snap.windowId, title: expected.window }];
    },
    async focusedWindow() {
      // A fixture describes one window and no focus history; it is never the
      // foreground for a live-style ownership check.
      return undefined;
    },
    async listApps() {
      throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include an application inventory');
    },
    async snapshotSurface() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include menus'); },
    async clickScreen() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot click screen points'); },
    async typeFocused() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot type into the desktop'); },
    async clickSemantic() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot click menus'); },
    async snapshotWindow(windowId, title) {
      if (windowId !== snap.windowId) {
        throw new Fault('WINDOW_CHANGED', 'Offline fixture does not cover the requested window');
      }
      if (title !== undefined && title !== expected.window) {
        throw new Fault('WINDOW_MISMATCH', 'Offline fixture does not cover the requested window');
      }
      return snap;
    },
    async focusWindow() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot focus windows'); },
    async screenshotWindow() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include window screenshots'); },
    async screenshot() {
      throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include window screenshots');
    },
    click: mutate, clickPoint: mutate, scroll: mutate, scrollPoint: mutate, drag: mutate,
    hoverAt: mutate,
    hoverScreen: mutate,
    listDisplays: mutate, type: mutate, press: mutate, ensure: mutate,
    async focus() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot focus elements'); },
    async readClipboard() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include a clipboard'); },
    async writeClipboard() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot write the clipboard'); },
  };
}
