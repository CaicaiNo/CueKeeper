import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Fault, contains, object, parseSnapshot } from './locator.js';
import type { Node, Point, Snapshot } from './locator.js';
import type { Delivery, Ensure, Target } from './contracts.js';

export interface WindowInfo {
  id: string;
  title: string;
  /** PID the driver reports for the window owner, when it exposes one. */
  processInstance?: number;
}

export interface Desktop {
  snapshot(target: Target, timeoutMs?: number, windowId?: string, exactWindow?: boolean): Promise<Snapshot>;
  property(node: Node, property: 'text' | 'value' | 'visible', timeoutMs?: number): Promise<string | boolean | undefined>;
  ensure(action: Ensure, timeoutMs: number, windowId?: string): Promise<string | undefined>;
  click(ref: string): Promise<Delivery | undefined>;
  clickPoint(snapshot: Snapshot, target: Target, point: Point): Promise<Delivery | undefined>;
  type(ref: string, text: string): Promise<Delivery | undefined>;
  press(combo: string, snapshot: Snapshot): Promise<Delivery | undefined>;
  /** Read-only application window inventory for window assertions. */
  listWindows(app: string, timeoutMs?: number): Promise<WindowInfo[]>;
  /** Read-only inventory without an app filter, for identity cross-checks. */
  listAllWindows(timeoutMs?: number): Promise<WindowInfo[]>;
  /** Window-only calls; no bundle ID is resolved by the driver. */
  snapshotWindow(windowId: string, title: string, timeoutMs?: number): Promise<Snapshot>;
  focusWindow(windowId: string, timeoutMs?: number): Promise<void>;
  screenshotWindow(windowId: string, timeoutMs?: number): Promise<Uint8Array>;
  /** Capture the whole window as PNG bytes without touching the window. */
  screenshot(app: string, windowId: string, timeoutMs?: number): Promise<Uint8Array>;
}

export const agentDesktopVersion = '1.3.1';
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

function windowList(data: unknown): WindowInfo[] {
  if (!Array.isArray(data)) throw new Fault('BAD_RESPONSE', 'Expected a window inventory');
  return data.map(object).map(window => {
    if (typeof window.id !== 'string' || !/^w-[a-zA-Z0-9_.:-]+$/.test(window.id)) {
      throw new Fault('BAD_RESPONSE', 'Missing or invalid window ID');
    }
    const raw = window.process_instance ?? window.processInstance;
    const processInstance = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw :
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
    return {
      id: window.id,
      title: typeof window.title === 'string' ? window.title : '',
      ...(processInstance === undefined ? {} : { processInstance }),
    };
  });
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
  options: { headed: boolean; signal: AbortSignal },
  work: (desktop: Desktop) => Promise<T>,
): Promise<T> {
  const state = await mkdtemp(join(tmpdir(), 'cuekeeper-'));
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

    const act = async (command: string, args: string[], input?: string, headed = options.headed) => {
      const result = delivery(object(await call(command, [...(headed ? ['--headed'] : []), ...args],
        input, 15_000 + (input?.length ?? 0) * 30)));
      if (result === 'not_delivered') throw new DesktopFault('NOT_DELIVERED', command, result);
      if (!result || result === 'unknown' || result === 'delivery_uncertain') {
        throw new DesktopFault('DELIVERY_UNCERTAIN', command, result ?? 'unknown');
      }
      return result;
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
      async snapshotWindow(windowId, title, timeoutMs = 3000) {
        const data = await call('snapshot', [
          '--include-bounds', '--max-depth', '50', '--timeout-ms', String(timeoutMs), '--window-id', windowId,
        ], undefined, timeoutMs + 3000);
        return parseSnapshot(data, { app: '', window: title });
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
      click: ref => act('click', [ref]),
      async clickPoint(current, target, point) {
        if (!options.headed) throw new Fault('HEADED_REQUIRED', 'Coordinate clicks require --headed');
        const result = object(await call('focus-window', ['--window-id', current.windowId]));
        const focused = object(result.focused);
        const observed = await snapshot(target);
        if (focused.id !== current.windowId || observed.windowId !== current.windowId ||
            !contains(observed.tree.bounds, point)) {
          throw new Fault('UNSAFE_POINT', 'The coordinate is outside the selected window');
        }
        return act('mouse-click', ['--xy', point.join(',')]);
      },
      // Keep text out of process arguments. Headed click does not require headed text injection.
      type: (ref, input) => act('type', [ref, '--stdin'], input, false),
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
    async snapshotWindow(windowId, title) {
      if (windowId !== snap.windowId) {
        throw new Fault('WINDOW_CHANGED', 'Offline fixture does not cover the requested window');
      }
      if (title !== expected.window) {
        throw new Fault('WINDOW_MISMATCH', 'Offline fixture does not cover the requested window');
      }
      return snap;
    },
    async focusWindow() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures cannot focus windows'); },
    async screenshotWindow() { throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include window screenshots'); },
    async screenshot() {
      throw new Fault('WINDOW_MISMATCH', 'Offline fixtures do not include window screenshots');
    },
    click: mutate, clickPoint: mutate, type: mutate, press: mutate, ensure: mutate,
  };
}
