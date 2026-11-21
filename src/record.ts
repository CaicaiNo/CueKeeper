import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { captureActionCheck, flowSchema } from './contracts.js';
import type { Action, Flow, Locator, Target } from './contracts.js';
import type { Desktop } from './desktop.js';
import { parseFlow } from './flow.js';
import { Fault, contains, flatten, hitTest, object, resolve, toLocator } from './locator.js';
import type { Point, Snapshot } from './locator.js';
import { inferSetup } from './setup.js';

type RawEvent =
  | { kind: 'click'; t: number; point: Point }
  | { kind: 'text'; t: number; chars: string }
  | { kind: 'key'; t: number; key: string; modifiers: NonNullable<Extract<Action, { kind: 'key' }>['modifiers']> };
type TimedEvent = RawEvent & { seen: number };
type Recorded = { event: RawEvent; snapshot: Snapshot };

const textGapMs = 1500;
const editable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);
const stepLimit = flowSchema.properties.steps.maxItems!;

type CaptureOptions = { seconds: number; indicator: boolean; sound: boolean; traceClicks?: boolean };
type CaptureWarning = { code: string; message: string };
type CaptureResult = { flow: Flow; warnings: CaptureWarning[]; partial: boolean; failure?: Fault };

const pointerWarningMessages = new Map([
  ['MULTI_CLICK_COLLAPSED', 'Only the first click of a multi-click sequence can be replayed as a single click in v1'],
  ['DRAG_SKIPPED', 'A drag was skipped because v1 only records clicks'],
]);

function validateAction(action: Action) {
  if (!captureActionCheck.Check(action)) {
    throw new Fault('UNREPRESENTABLE_ACTION', 'An input action could not be represented in the flow');
  }
  return action;
}

export class Recording {
  private steps: Action[] = [];
  private text?: { at: number; target: Extract<Locator, { kind: 'element' }>; value: string; ref: string };

  constructor(private target: Target) {}

  private nextId() { return `step-${this.steps.length + 1}`; }

  endTextBurst() {
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
      this.endTextBurst();
      if (!contains(snapshot.tree.bounds, event.point)) {
        throw new Fault('OUTSIDE_WINDOW', 'Click fell outside the requested window');
      }
      const hit = hitTest(snapshot, event.point);
      if (hit?.node.secure) throw new Fault('SECURE_INPUT', 'Click hit a protected control');
      const target: Locator = hit ? toLocator(snapshot, hit) : { kind: 'point', point: event.point };
      this.steps.push(validateAction({ id: this.nextId(), kind: 'click', target }));
      return;
    }

    if (event.kind === 'key') {
      this.endTextBurst();
      this.steps.push(validateAction({ id: this.nextId(), kind: 'key', key: event.key, modifiers: event.modifiers }));
      return;
    }

    const [field] = focused;
    if (focused.length !== 1 || !field.node.ref || !editable.has(field.node.role)) {
      throw new Fault('UNSAFE_TEXT_TARGET', 'Printable input needs one focused, non-secure text control');
    }
    const locator = toLocator(snapshot, field);
    if (this.text && (this.text.ref !== field.node.ref || event.t - this.text.at > textGapMs ||
        this.text.value.length + event.chars.length > 4000)) {
      this.endTextBurst();
    }
    // Re-resolution verifies the locator selected by the recorder against this same tree.
    resolve(snapshot, locator);
    if (!this.text) {
      validateAction({ id: this.nextId(), kind: 'type', target: locator, text: event.chars });
      this.text = { at: event.t, target: locator, value: '', ref: field.node.ref };
    }
    this.text.value += event.chars;
    this.text.at = event.t;
  }

  finish(): Flow {
    this.endTextBurst();
    if (!this.steps.length) throw new Fault('EMPTY_RECORDING', 'No supported actions were captured');
    // Capture stays on one window, so every recorded action belongs to the target.
    const setup = inferSetup(this.target);
    return parseFlow({
      version: 1, id: randomUUID(), name: this.target.window, target: this.target,
      ...(setup.length ? { setup } : {}),
      steps: this.steps.slice(0, stepLimit),
    });
  }

  get exceededStepLimit() { return this.steps.length > stepLimit; }
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

function captureCode(code: unknown) {
  return typeof code === 'string' && /^[A-Z_]{1,48}$/.test(code) ? code : 'CAPTURE_FAILED';
}

function announceIndicator(confirmation: unknown, enabled: boolean) {
  if (!enabled && confirmation === false) return;
  if (enabled && confirmation !== null && typeof confirmation === 'object' && !Array.isArray(confirmation)) {
    const { window, display, level, bounds } = object(confirmation);
    if ([window, display, level].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) &&
        Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
      process.stderr.write(`INDICATOR_READY window=${window} display=${display} level=${level} bounds=${bounds.join(',')}\n`);
      return;
    }
  }
  throw new Fault('INDICATOR_UNCONFIRMED', 'Capture helper did not confirm the requested indicator state. Rebuild it with pnpm build:recorder', true);
}

export async function record(
  desktop: Desktop, target: Target, options: CaptureOptions, signal: AbortSignal,
): Promise<CaptureResult> {
  const { seconds, indicator, sound, traceClicks } = options;
  const initial = await desktop.snapshot(target);
  const windowNumber = /^w-([1-9]\d*)$/.exec(initial.windowId)?.[1];
  if (!windowNumber) throw new Fault('WINDOW_ID', 'Capture requires a macOS window number');
  signal.throwIfAborted();
  const executable = process.env.CUEKEEPER_RECORDER?.trim() ||
    fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
  const args = [target.app, windowNumber, String(seconds)];
  if (!indicator) args.push('--no-indicator');
  if (sound) args.push('--sound');
  if (traceClicks) args.push('--trace-clicks');
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const completion = new Promise<number | null>(resolve => {
    child.once('error', () => { /* close also fires after a failed spawn. */ });
    child.once('close', resolve);
  });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  let startupTimedOut = false;
  const startupTimeout = setTimeout(() => {
    startupTimedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  let sessionTimeout: NodeJS.Timeout | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const recording = new Recording(target);
  const warnings = new Map<string, CaptureWarning>();

  let ready = false;
  let targetActive = true;
  let failure: Fault | undefined;
  let burst: { at: number; snapshot: Snapshot } | undefined;
  function endTextBurst() {
    burst = undefined;
    recording.endTextBurst();
  }
  function warn(code: string, message: string) {
    warnings.set(code, { code, message });
  }
  function trace(row: Record<string, unknown>) {
    process.stderr.write(`CLICK_TRACE ${JSON.stringify(row)}\n`);
  }

  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      const data = object(JSON.parse(line));
      if (data.kind === 'click_trace') {
        if (traceClicks && data.stage === 'native') trace(data);
        continue;
      }
      if (data.kind === 'error') {
        const code = captureCode(data.code);
        const dependency = !ready && ['INPUT_MONITORING_REQUIRED', 'ACCESSIBILITY_REQUIRED',
          'TAP_UNAVAILABLE', 'HOTKEY_TAP_UNAVAILABLE'].includes(code);
        const detail = typeof data.detail === 'string' && /^[ -~]{1,240}$/.test(data.detail) ? ` (${data.detail})` : '';
        throw new Fault(code, `Capture helper stopped: ${code}${detail}`, dependency);
      }
      if (data.kind === 'ready' && !ready) {
        if (data.hotkeysFiltered !== true) {
          throw new Fault('HOTKEY_FILTER_UNCONFIRMED',
            'Capture helper did not confirm hotkey filtering. Rebuild it with pnpm build:recorder', true);
        }
        announceIndicator(data.indicator, indicator);
        ready = true;
        clearTimeout(startupTimeout);
        sessionTimeout = setTimeout(() => child.kill('SIGKILL'), (seconds + 5) * 1000);
        process.stderr.write(`Recording for up to ${seconds} seconds. Ctrl+Option+P pauses or resumes. Ctrl+Option+X stops and saves.\n`);
        continue;
      }
      if (!ready) throw new Fault('CAPTURE_PROTOCOL', 'Input arrived before the helper was ready');
      if (data.kind === 'focus' && typeof data.active === 'boolean') {
        endTextBurst();
        targetActive = data.active;
        if (!targetActive) warn('FOCUS_CHANGED', 'Input in other apps was skipped. Target actions were retained.');
        continue;
      }
      if (data.kind === 'boundary' || data.kind === 'warning') {
        endTextBurst();
        if (data.kind === 'warning') {
          const code = captureCode(data.code);
          warn(code, pointerWarningMessages.get(code) ?? `Some input may have been skipped: ${code}`);
        }
        continue;
      }

      const event = parseEvent(data);
      const traceId = traceClicks && event.kind === 'click' && typeof data.traceId === 'string'
        ? data.traceId : undefined;
      // The helper hit-tests mouse-down against the selected native window. Its focus
      // update can reach us after the click that activated that window.
      if (!targetActive && event.kind !== 'click') continue;
      try {
        if (event.kind === 'text' && burst && event.t - burst.at <= textGapMs) {
          recording.add({ event, snapshot: burst.snapshot });
          burst.at = event.t;
          continue;
        }
        if (Date.now() - event.seen > 2000) {
          throw new Fault('STALE_CAPTURE', 'The accessibility snapshot could not keep up with input');
        }
        const captured = await desktop.snapshot(target, 1200, event.kind === 'click' ? initial.windowId : undefined);
        if (captured.windowId !== initial.windowId) {
          throw new Fault('WINDOW_CHANGED', 'Capture switched away from the initial window');
        }
        recording.add({ event, snapshot: captured });
        burst = event.kind === 'text' ? { at: event.t, snapshot: captured } : undefined;
        if (traceId) trace({ stage: 'flow', id: traceId, decision: 'collected', windowId: captured.windowId });
      } catch (error) {
        if (traceId) {
          trace({ stage: 'flow', id: traceId, decision: 'filtered',
            reason: error instanceof Fault ? error.code : 'CAPTURE_FAILED' });
        }
        if (!(error instanceof Fault) || error.dependency ||
            ['PERM_DENIED', 'APP_NOT_FOUND', 'WINDOW_NOT_FOUND', 'WINDOW_MISMATCH', 'WINDOW_CHANGED'].includes(error.code)) {
          throw error;
        }
        endTextBurst();
        warn(error.code, error.message);
      }
    }

    const code = await completion;
    signal.throwIfAborted();
    if (startupTimedOut) throw new Fault('CAPTURE_START_TIMEOUT', 'Capture helper did not become ready within five seconds');
    if (!ready) throw new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable. Build it with pnpm build:recorder', true);
    if (code !== 0) throw new Fault('CAPTURE_FAILED', 'Capture helper exited before recording finished');
  } catch (error) {
    failure = signal.aborted ? new Fault('INTERRUPTED', 'Recording interrupted') :
      error instanceof Fault ? error : new Fault('CAPTURE_PROTOCOL', 'Could not read the capture stream');
  } finally {
    lines.close();
    child.kill();
    await completion;
    clearTimeout(startupTimeout);
    clearTimeout(sessionTimeout);
    signal.removeEventListener('abort', abort);
  }

  let flow: Flow;
  try {
    flow = recording.finish();
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof Fault && error.code === 'EMPTY_RECORDING' && warnings.size) {
      throw new Fault(error.code, `${error.message}. ${[...warnings.keys()].join(', ')}`);
    }
    throw error;
  }
  if (recording.exceededStepLimit) warn('STEP_LIMIT', `The flow retains the first ${stepLimit} actions`);
  return { flow, warnings: [...warnings.values()], partial: !!failure, failure };
}
