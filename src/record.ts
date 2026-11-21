import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Action, Flow, Locator, Target } from './contracts.js';
import type { Desktop } from './desktop.js';
import { parseFlow } from './flow.js';
import { Fault, contains, flatten, hitTest, object, resolve, toLocator } from './locator.js';
import type { Point, Snapshot } from './locator.js';

type RawEvent =
  | { kind: 'click'; t: number; point: Point }
  | { kind: 'text'; t: number; chars: string }
  | { kind: 'key'; t: number; key: string; modifiers: NonNullable<Extract<Action, { kind: 'key' }>['modifiers']> };
type TimedEvent = RawEvent & { seen: number };
type Recorded = { event: RawEvent; snapshot: Snapshot };

const textGapMs = 1500;
const editable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);

export class Recording {
  private steps: Action[] = [];
  private text?: { at: number; target: Extract<Locator, { kind: 'element' }>; value: string; ref: string };

  constructor(private target: Target) {}

  private nextId() { return `step-${this.steps.length + 1}`; }

  private flush() {
    if (!this.text) return;
    this.steps.push({ id: this.nextId(), kind: 'type', target: this.text.target, text: this.text.value });
    this.text = undefined;
  }

  add({ event, snapshot }: Recorded) {
    const focused = flatten(snapshot.tree).filter(entry => entry.node.states.includes('focused'));
    if (focused.some(entry => entry.node.secure)) {
      throw new Fault('SECURE_INPUT', 'Recording encountered a protected control');
    }

    if (event.kind === 'click') {
      this.flush();
      if (!contains(snapshot.tree.bounds, event.point)) {
        throw new Fault('OUTSIDE_WINDOW', 'Click fell outside the requested window');
      }
      const hit = hitTest(snapshot, event.point);
      if (hit?.node.secure) throw new Fault('SECURE_INPUT', 'Click hit a protected control');
      const target: Locator = hit ? toLocator(snapshot, hit) : { kind: 'point', point: event.point };
      this.steps.push({ id: this.nextId(), kind: 'click', target });
      return;
    }

    if (event.kind === 'key') {
      this.flush();
      this.steps.push({ id: this.nextId(), kind: 'key', key: event.key, modifiers: event.modifiers });
      return;
    }

    const [field] = focused;
    if (focused.length !== 1 || !field.node.ref || !editable.has(field.node.role)) {
      throw new Fault('UNSAFE_TEXT_TARGET', 'Printable input needs one focused, non-secure text control');
    }
    const locator = toLocator(snapshot, field);
    if (this.text && (this.text.ref !== field.node.ref || event.t - this.text.at > textGapMs ||
        this.text.value.length + event.chars.length > 4000)) {
      this.flush();
    }
    // Re-resolution verifies the locator selected by the recorder against this same tree.
    resolve(snapshot, locator);
    this.text ??= { at: event.t, target: locator, value: '', ref: field.node.ref };
    this.text.value += event.chars;
    this.text.at = event.t;
  }

  finish(): Flow {
    this.flush();
    if (!this.steps.length) throw new Fault('EMPTY_RECORDING', 'No supported actions were captured');
    return parseFlow({
      version: 1, id: randomUUID(), name: this.target.window, target: this.target, steps: this.steps,
    });
  }
}

const modifiers = new Set(['meta', 'ctrl', 'alt', 'shift']);

function parseEvent(data: Record<string, unknown>): TimedEvent {
  const { kind, t, seen } = data;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0 ||
      typeof seen !== 'number' || !Number.isSafeInteger(seen)) {
    throw new Fault('CAPTURE_PROTOCOL', 'Invalid capture timestamps');
  }
  if (kind === 'click' && Array.isArray(data.point) && data.point.length === 2 && data.point.every(Number.isSafeInteger)) {
    return { kind, t, seen, point: data.point as Point };
  }
  if (kind === 'text' && typeof data.chars === 'string' && /^[ -~]{1,16}$/.test(data.chars)) {
    return { kind, t, seen, chars: data.chars };
  }
  if (kind === 'key' && typeof data.key === 'string' && Array.isArray(data.modifiers) &&
      data.modifiers.every(value => typeof value === 'string' && modifiers.has(value))) {
    return { kind, t, seen, key: data.key, modifiers: data.modifiers as Extract<RawEvent, { kind: 'key' }>['modifiers'] };
  }
  throw new Fault('CAPTURE_PROTOCOL', 'Invalid input event from capture helper');
}

export async function record(
  desktop: Desktop, target: Target, seconds: number, signal: AbortSignal,
): Promise<Flow> {
  const initial = await desktop.snapshot(target);
  const executable = fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
  const child = spawn(executable, [target.app, String(seconds)], {
    signal,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const completion = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), (seconds + 5) * 1000);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const recording = new Recording(target);

  let ready = false;
  let burst: { at: number; snapshot: Snapshot } | undefined;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      const data = object(JSON.parse(line));
      if (data.kind === 'error') {
        const code = typeof data.code === 'string' && /^[A-Z_]+$/.test(data.code) ? data.code : 'CAPTURE_FAILED';
        throw new Fault(code, `Capture helper stopped: ${code}`, code === 'INPUT_MONITORING_REQUIRED');
      }
      if (data.kind === 'ready' && !ready) {
        ready = true;
        process.stderr.write(`Recording for ${seconds} seconds. Switch to the test window, then perform the steps.\n`);
        continue;
      }
      if (!ready) throw new Fault('CAPTURE_PROTOCOL', 'Input arrived before the helper was ready');
      const event = parseEvent(data);
      if (event.kind === 'text' && burst && event.t - burst.at <= textGapMs) {
        recording.add({ event, snapshot: burst.snapshot });
        burst.at = event.t;
        continue;
      }
      if (Date.now() - event.seen > 2000) {
        throw new Fault('STALE_CAPTURE', 'The accessibility snapshot could not keep up with input');
      }
      const captured = await desktop.snapshot(target, 1200);
      if (captured.windowId !== initial.windowId) {
        throw new Fault('WINDOW_CHANGED', 'Capture switched away from the initial window');
      }
      recording.add({ event, snapshot: captured });
      burst = event.kind === 'text' ? { at: event.t, snapshot: captured } : undefined;
    }

    const code = await completion;
    signal.throwIfAborted();
    if (!ready) throw new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable. Build it with pnpm build:recorder', true);
    if (code !== 0) throw new Fault('CAPTURE_FAILED', 'Capture helper exited before recording finished');
    return recording.finish();
  } finally {
    lines.close();
    child.kill();
    await completion;
    clearTimeout(timeout);
  }
}
