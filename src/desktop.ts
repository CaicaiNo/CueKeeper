import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fault, contains, object, parseSnapshot } from './locator.js';
import type { Node, Point, Snapshot } from './locator.js';
import type { Entry, Target } from './contracts.js';

export interface Desktop {
  snapshot(target: Target, timeoutMs?: number): Promise<Snapshot>;
  property(node: Node, property: 'text' | 'value' | 'visible'): Promise<string | boolean | undefined>;
  click(ref: string): Promise<Entry['delivery']>;
  clickPoint(snapshot: Snapshot, target: Target, point: Point): Promise<Entry['delivery']>;
  type(ref: string, text: string): Promise<Entry['delivery']>;
  press(combo: string, snapshot: Snapshot): Promise<Entry['delivery']>;
}

export const agentDesktopVersion = '1.3.1';
const deliveryStates = new Set(['delivered_verified', 'delivered_unverified', 'delivery_uncertain', 'not_delivered', 'unknown']);

export class DesktopFault extends Fault {
  constructor(code: string, command: string, public delivery: Entry['delivery']) {
    super(code, `agent-desktop ${command} returned ${code}`);
  }
}

function delivery(result: Record<string, unknown>): Entry['delivery'] {
  if (result.disposition === undefined) return undefined;
  const value = object(result.disposition).delivery;
  return typeof value === 'string' && deliveryStates.has(value) ? value as Entry['delivery'] : undefined;
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
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESKTOP_')));
    env.AGENT_DESKTOP_HOME = state;
    const call = commandRunner(env, options.signal);
    const version = object(await call('version', []));
    if (version.version !== agentDesktopVersion) {
      throw new Fault('DESKTOP_VERSION', `Expected agent-desktop ${agentDesktopVersion}`, true);
    }

    const snapshot = async (target: Target, timeoutMs = 3000, windowId?: string) =>
      parseSnapshot(await call('snapshot', [
        '--app', target.app, '--include-bounds', '--max-depth', '50', '--timeout-ms', String(timeoutMs),
        ...(windowId ? ['--window-id', windowId] : []),
      ], undefined, timeoutMs + 3000), target);

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
      async property(node, property) {
        if (!node.ref) return snapshotProperty(node, property);
        if (property === 'visible') {
          const value = object(await call('is', [node.ref, '--property', 'visible']));
          return value.applicable === true && typeof value.result === 'boolean' ? value.result : undefined;
        }
        const value = object(await call('get', [node.ref, '--property', property])).value;
        return typeof value === 'string' ? value : undefined;
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
    snapshot: async () => snap,
    property: async (node, property) => snapshotProperty(node, property),
    click: mutate, clickPoint: mutate, type: mutate, press: mutate,
  };
}
