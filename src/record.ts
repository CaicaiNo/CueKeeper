import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { captureActionCheck, flowSchema } from './contracts.js';
import type { Action, Flow, Locator, Target } from './contracts.js';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import type { ClipboardRead, Desktop } from './desktop.js';
import { parseFlow } from './flow.js';
import { Fault, contains, flatten, hitTest, object, resolve, toLocator } from './locator.js';
import type { Located, Point, Snapshot } from './locator.js';
import { inferSetup } from './setup.js';

type RawEvent =
  | { kind: 'click'; t: number; point: Point; count?: number; button?: 'left' | 'right' }
  | { kind: 'scroll'; t: number; point: Point; deltaX: number; deltaY: number; phase?: string }
  | {
    kind: 'drag'; t: number; from: Point; to: Point; path: Point[]; durationMs: number;
    button: 'left' | 'right'; modifiers: string[];
  }
  | { kind: 'hover'; t: number; point: Point; dwellMs: number }
  | { kind: 'text'; t: number; chars: string; ime?: boolean }
  | { kind: 'key'; t: number; key: string; modifiers: NonNullable<Extract<Action, { kind: 'key' }>['modifiers']> };
type TimedEvent = RawEvent & { seen: number };
type Recorded = { event: RawEvent; snapshot: Snapshot };

const textGapMs = 1500;
// Wheel ticks arrive in bursts; merging them keeps one gesture as one step.
const scrollGapMs = 350;
const multiClickGapMs = 1500;
const multiClickDistance = 4;
const deltaLimit = 1000;
const editable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);
const stepLimit = flowSchema.properties.steps.maxItems!;
// A clipboard paste pins at most one text field's worth of text. Anything
// larger, binary, or NUL-bearing stays a shortcut and is reported as skipped.
const clipboardLimit = 4000;

type CaptureOptions = {
  seconds: number; indicator: boolean; sound: boolean; traceClicks?: boolean;
  /** Explicit opt-in: record plain-text clipboard content at Cmd+V. */
  clipboard?: boolean;
  /** Identity session for a path-fixed target; created from the target otherwise. */
  identity?: AppIdentitySession;
};
type CaptureWarning = { code: string; message: string };
type CaptureResult = { flow: Flow; warnings: CaptureWarning[]; partial: boolean; failure?: Fault };

const pointerWarningMessages = new Map([
  ['DRAG_MODIFIERS_SKIPPED', 'A drag with held modifiers was skipped because v1 replays plain left drags only'],
  ['DRAG_OUTSIDE_WINDOW', 'A drag that did not start inside the target window was skipped'],
  ['DRAG_UNVERIFIED', 'A drag was skipped because its start state could not be read'],
  ['UNTARGETED_DRAG', 'A drag that could not be tied to an element was skipped in this path-bound recording'],
  ['UNTARGETED_POINT', 'A click that could not be tied to an element was skipped in this path-bound recording'],
  ['UNTARGETED_HOVER', 'A hover that could not be tied to an element was skipped in this path-bound recording'],
  ['MULTI_CLICK_TRUNCATED', 'A click sequence longer than three clicks was recorded as a triple click'],
  ['CLIPBOARD_UNSUPPORTED_TYPE', 'The clipboard did not hold plain text, so the paste was recorded as the shortcut only'],
  ['CLIPBOARD_TOO_LARGE', 'The clipboard text exceeded the recording limit, so the paste was recorded as the shortcut only'],
  ['CLIPBOARD_INVALID_TEXT', 'The clipboard text contained a NUL character, so the paste was recorded as the shortcut only'],
  ['CLIPBOARD_READ_FAILED', 'The clipboard could not be read, so the paste was recorded as the shortcut only'],
  ['UNSAFE_CLIPBOARD_TARGET', 'A paste had no single editable, non-secure target, so it was recorded as the shortcut only'],
  ['IME_COMPOSITION_UNSUPPORTED', 'IME composition was recorded as its committed Unicode text; candidate keys are not replayed'],
]);

// A drag endpoint only becomes an element locator when the recorded point sits
// on the element's center, because replaying an element drag starts from that
// center. A text-selection point or a title-bar grab stays a coordinate.
const dragCenterTolerance = 4;
const dragPathLimit = 64;

function validateAction(action: Action) {
  if (!captureActionCheck.Check(action)) {
    throw new Fault('UNREPRESENTABLE_ACTION', 'An input action could not be represented in the flow');
  }
  return action;
}

function locatorKey(target: Locator) {
  return JSON.stringify(target);
}

function clampDelta(value: number) {
  return Math.max(-deltaLimit, Math.min(deltaLimit, Math.round(value)));
}

function nearPoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) <= multiClickDistance && Math.abs(a[1] - b[1]) <= multiClickDistance;
}

/** Cmd+V with no other chord modifier is the only paste shortcut we pin. */
export function isPasteChord(event: { kind: 'key'; key: string; modifiers?: string[] }) {
  const held = event.modifiers ?? [];
  return event.key === 'v' && held.length === 1 && held[0] === 'meta';
}

/**
 * Decides whether Cmd+V becomes a content-pinned paste. Clipboard recording is
 * opt-in (no clipboard means the shortcut is kept), and only bounded plain text
 * is representable. Every rejection returns a warning code instead of dropping
 * the paste silently.
 */
export function pasteIntent(
  event: { kind: 'key'; key: string; modifiers?: string[] },
  clipboard: ClipboardRead | undefined,
): { text: string } | { warning: string } | undefined {
  if (!isPasteChord(event) || !clipboard) return undefined;
  if (clipboard.type !== 'text' || !clipboard.text) return { warning: 'CLIPBOARD_UNSUPPORTED_TYPE' };
  if (clipboard.text.length > clipboardLimit) return { warning: 'CLIPBOARD_TOO_LARGE' };
  if (clipboard.text.includes('\u0000')) return { warning: 'CLIPBOARD_INVALID_TEXT' };
  return { text: clipboard.text };
}

/**
 * Element endpoints only replay from their center. Keep the exact point unless
 * the gesture started/ended on that center; otherwise the replay would grab a
 * different character or row than the recording did.
 */
function dragLocator(snapshot: Snapshot, point: Point, hit: Located | undefined): Locator {
  const bounds = hit?.node.bounds;
  if (!hit || !bounds) return { kind: 'point', point };
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  if (Math.abs(centerX - point[0]) > dragCenterTolerance || Math.abs(centerY - point[1]) > dragCenterTolerance) {
    return { kind: 'point', point };
  }
  return toLocator(snapshot, hit);
}

export class Recording {
  private steps: Action[] = [];
  private text?: {
    at: number; target: Extract<Locator, { kind: 'element' }>; value: string; ref: string; ime?: boolean;
  };
  private scroll?: { at: number; startedAt: number; target: Locator; deltaX: number; deltaY: number };
  private lastClick?: { at: number; point: Point; index: number; button: 'left' | 'right' };

  constructor(private target: Target, private options: { requireElementLocator?: boolean } = {}) {}

  private nextId() { return `step-${this.steps.length + 1}`; }

  endTextBurst() {
    if (!this.text) return;
    this.steps.push(validateAction({
      id: this.nextId(), kind: 'type', target: this.text.target, text: this.text.value,
      ...(this.text.ime ? { ime: true } : {}),
    }));
    this.text = undefined;
  }

  /** One wheel gesture becomes one step with its summed deltas. */
  endScrollBurst() {
    const pending = this.scroll;
    if (!pending) return;
    this.scroll = undefined;
    const deltaX = clampDelta(pending.deltaX);
    const deltaY = clampDelta(pending.deltaY);
    if (!deltaX && !deltaY) return;
    const durationMs = Math.max(0, Math.round(pending.at - pending.startedAt));
    this.steps.push(validateAction({
      id: this.nextId(), kind: 'scroll', target: pending.target, deltaX, deltaY,
      ...(durationMs ? { durationMs } : {}),
    }));
  }

  /** Returns a warning code when the event was intentionally skipped. */
  add({ event, snapshot }: Recorded, clipboard?: ClipboardRead): string | undefined {
    const focused = flatten(snapshot.tree).filter(entry => entry.node.states.includes('focused'));

    if (event.kind === 'hover') {
      this.endTextBurst();
      this.endScrollBurst();
      this.lastClick = undefined;
      if (!contains(snapshot.tree.bounds, event.point)) {
        throw new Fault('OUTSIDE_WINDOW', 'Hover fell outside the requested window');
      }
      const hit = hitTest(snapshot, event.point);
      if (hit?.node.secure) throw new Fault('SECURE_INPUT', 'Hover touched a protected control');
      // A path-fixed flow cannot replay a global coordinate against one copy.
      if (!hit && this.options.requireElementLocator) return 'UNTARGETED_HOVER';
      const target: Locator = hit ? toLocator(snapshot, hit) : { kind: 'point', point: event.point };
      this.steps.push(validateAction({
        id: this.nextId(), kind: 'hover', target,
        durationMs: Math.max(0, Math.min(60_000, Math.round(event.dwellMs))),
      }));
      return;
    }

    if (event.kind === 'drag') {
      this.endTextBurst();
      this.endScrollBurst();
      this.lastClick = undefined;
      if (event.modifiers.length) return 'DRAG_MODIFIERS_SKIPPED';
      if (!contains(snapshot.tree.bounds, event.from)) return 'DRAG_OUTSIDE_WINDOW';
      const fromHit = hitTest(snapshot, event.from);
      const toHit = hitTest(snapshot, event.to);
      if (fromHit?.node.secure || toHit?.node.secure) {
        throw new Fault('SECURE_INPUT', 'Drag touched a protected control');
      }
      const from = dragLocator(snapshot, event.from, fromHit);
      const to = dragLocator(snapshot, event.to, toHit);
      if (this.options.requireElementLocator && (from.kind === 'point' || to.kind === 'point')) {
        return 'UNTARGETED_DRAG';
      }
      this.steps.push(validateAction({
        id: this.nextId(), kind: 'drag', from, to,
        durationMs: Math.max(0, Math.min(60_000, Math.round(event.durationMs))),
        ...(event.path.length ? { path: event.path.slice(0, dragPathLimit) } : {}),
        ...(event.button === 'right' ? { button: 'right' as const } : {}),
      }));
      return;
    }

    if (event.kind === 'click') {
      this.endTextBurst();
      this.endScrollBurst();
      if (!contains(snapshot.tree.bounds, event.point)) {
        throw new Fault('OUTSIDE_WINDOW', 'Click fell outside the requested window');
      }
      const hit = hitTest(snapshot, event.point);
      if (hit?.node.secure) throw new Fault('SECURE_INPUT', 'Click hit a protected control');
      // A path-fixed flow cannot replay a global coordinate against one copy.
      if (!hit && this.options.requireElementLocator) return 'UNTARGETED_POINT';
      const target: Locator = hit ? toLocator(snapshot, hit) : { kind: 'point', point: event.point };
      const button = event.button ?? 'left';
      const count = Math.max(1, Math.min(3, event.count ?? 1));
      // macOS reports each click of a multi-click gesture separately: the first
      // as clickState 1, then 2 and 3. Upgrade the recorded step instead of
      // appending a second click at the same place.
      const previous = this.lastClick;
      if (count > 1 && previous && previous.index === this.steps.length - 1 && previous.button === 'left' &&
          event.t - previous.at <= multiClickGapMs && nearPoint(previous.point, event.point)) {
        const step = this.steps[previous.index];
        if (step?.kind === 'click') {
          step.count = count;
          previous.at = event.t;
          previous.point = event.point;
          return;
        }
      }
      this.steps.push(validateAction({
        id: this.nextId(), kind: 'click', target,
        ...(count > 1 ? { count } : {}),
        ...(button === 'right' ? { button } : {}),
      }));
      this.lastClick = { at: event.t, point: event.point, index: this.steps.length - 1, button };
      return;
    }

    if (event.kind === 'scroll') {
      this.endTextBurst();
      if (!contains(snapshot.tree.bounds, event.point)) {
        throw new Fault('OUTSIDE_WINDOW', 'Scroll fell outside the requested window');
      }
      const hit = hitTest(snapshot, event.point);
      if (!hit && this.options.requireElementLocator) return 'UNTARGETED_POINT';
      const target: Locator = hit ? toLocator(snapshot, hit) : { kind: 'point', point: event.point };
      const pending = this.scroll;
      if (pending && event.t - pending.at <= scrollGapMs && locatorKey(pending.target) === locatorKey(target)) {
        pending.deltaX = clampDelta(pending.deltaX + event.deltaX);
        pending.deltaY = clampDelta(pending.deltaY + event.deltaY);
        pending.at = event.t;
        return;
      }
      this.endScrollBurst();
      this.scroll = { at: event.t, startedAt: event.t, target, deltaX: event.deltaX, deltaY: event.deltaY };
      return;
    }

    if (event.kind === 'key') {
      this.endTextBurst();
      this.endScrollBurst();
      const intent = pasteIntent(event, clipboard);
      if (intent && 'text' in intent) {
        if (focused.some(entry => entry.node.secure)) {
          throw new Fault('SECURE_INPUT', 'Recording encountered a protected control');
        }
        const [field] = focused;
        if (focused.length !== 1 || !field.node.ref || !editable.has(field.node.role)) {
          // Keep the shortcut so the step is still visible; the warning names
          // why the content could not be pinned.
          this.steps.push(validateAction({ id: this.nextId(), kind: 'key', key: event.key, modifiers: event.modifiers }));
          return 'UNSAFE_CLIPBOARD_TARGET';
        }
        const target = toLocator(snapshot, field);
        resolve(snapshot, target);
        this.steps.push(validateAction({
          id: this.nextId(), kind: 'paste', target, text: intent.text,
        }));
        return;
      }
      this.steps.push(validateAction({ id: this.nextId(), kind: 'key', key: event.key, modifiers: event.modifiers }));
      return intent && 'warning' in intent ? intent.warning : undefined;
    }

    this.endScrollBurst();
    if (focused.some(entry => entry.node.secure)) {
      throw new Fault('SECURE_INPUT', 'Recording encountered a protected control');
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
    if (event.ime) this.text.ime = true;
    return event.ime ? 'IME_COMPOSITION_UNSUPPORTED' : undefined;
  }

  finish(): Flow {
    this.endTextBurst();
    this.endScrollBurst();
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
  if (kind === 'drag') {
    const isPoint = (value: unknown): value is Point => Array.isArray(value) && value.length === 2 &&
      value.every(Number.isSafeInteger);
    const { from, to, path, durationMs } = data;
    const button = data.button ?? 'left';
    const held = data.modifiers ?? [];
    if (!isPoint(from) || !isPoint(to) || !Array.isArray(path) || path.length > dragPathLimit ||
        !path.every(isPoint)) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid drag endpoints from capture helper');
    }
    if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) ||
        durationMs < 0 || durationMs > 60_000) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid drag duration from capture helper');
    }
    if (button !== 'left' && button !== 'right') {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid mouse button from capture helper');
    }
    if (!Array.isArray(held) || !held.every(value => typeof value === 'string' && modifiers.has(value))) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid drag modifiers from capture helper');
    }
    return {
      kind, t, seen, from, to, path, durationMs, button, modifiers: held,
    };
  }
  if (kind === 'click' && Array.isArray(data.point) && data.point.length === 2 && data.point.every(Number.isSafeInteger)) {
    const count = data.count;
    const button = data.button ?? 'left';
    if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 3)) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid multi-click count from capture helper');
    }
    if (button !== 'left' && button !== 'right') {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid mouse button from capture helper');
    }
    return {
      kind, t, seen, point: data.point as Point,
      ...(count === undefined ? {} : { count: count as number }),
      ...(button === 'right' ? { button: 'right' as const } : {}),
    };
  }
  if (kind === 'scroll' && Array.isArray(data.point) && data.point.length === 2 && data.point.every(Number.isSafeInteger)) {
    const { deltaX, deltaY } = data;
    const valid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) &&
      Math.abs(value) <= deltaLimit;
    if (!valid(deltaX) || !valid(deltaY) || (deltaX === 0 && deltaY === 0)) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid scroll deltas from capture helper');
    }
    const phase = typeof data.phase === 'string' && /^[a-z]{2,12}$/.test(data.phase) ? data.phase : undefined;
    return {
      kind, t, seen, point: data.point as Point, deltaX: deltaX as number, deltaY: deltaY as number,
      ...(phase ? { phase } : {}),
    };
  }
  if (kind === 'hover' && Array.isArray(data.point) && data.point.length === 2 && data.point.every(Number.isSafeInteger)) {
    const { dwellMs } = data;
    if (typeof dwellMs !== 'number' || !Number.isSafeInteger(dwellMs) || dwellMs < 0 || dwellMs > 60_000) {
      throw new Fault('CAPTURE_PROTOCOL', 'Invalid hover dwell from capture helper');
    }
    return { kind, t, seen, point: data.point as Point, dwellMs };
  }
  if (kind === 'text' && typeof data.chars === 'string' &&
      data.chars.length >= 1 && data.chars.length <= 16 && !/[\u0000-\u001f\u007f]/.test(data.chars)) {
    // Non-ASCII text is the committed IME result. The capture helper marks it so
    // the flow can say that composition was text insertion, not key presses.
    return { kind, t, seen, chars: data.chars, ...(data.ime === true ? { ime: true } : {}) };
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
  const identity = options.identity ?? new AppIdentitySession(target);
  let initial: Snapshot;
  let bound: { pid: number; bundlePath: string } | undefined;
  if (target.appPath) {
    // The recording must start from the selected copy, not whichever copy is
    // frontmost under the same bundle ID.
    await identity.preflight();
    await identity.bindInstances(desktop);
    initial = await identity.readWindow(desktop, target, { timeoutMs: 5000 });
    const instance = identity.runningInstance;
    const bundlePath = identity.canonicalPath;
    if (!instance || !bundlePath) throw new Fault('APP_NOT_FOUND', 'The selected copy is not running');
    bound = { pid: instance.pid, bundlePath };
  } else {
    initial = await desktop.snapshot(target);
  }
  const windowNumber = /^w-([1-9]\d*)$/.exec(initial.windowId)?.[1];
  if (!windowNumber) throw new Fault('WINDOW_ID', 'Capture requires a macOS window number');
  signal.throwIfAborted();
  // A bound recording persists the canonical path actually proven at runtime.
  const recordedTarget: Target = bound ? { ...target, appPath: bound.bundlePath } : target;
  const executable = process.env.CUEKEEPER_RECORDER?.trim() ||
    fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
  const args = [target.app, windowNumber, String(seconds)];
  if (!indicator) args.push('--no-indicator');
  if (sound) args.push('--sound');
  if (traceClicks) args.push('--trace-clicks');
  if (bound) args.push('--pid', String(bound.pid), '--app-path', bound.bundlePath);
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
  const recording = new Recording(recordedTarget, { requireElementLocator: Boolean(target.appPath) });
  const warnings = new Map<string, CaptureWarning>();

  let ready = false;
  let targetActive = true;
  let failure: Fault | undefined;
  let burst: { kind: 'text' | 'scroll'; at: number; snapshot: Snapshot } | undefined;
  // A drag binds its endpoints from the tree read at pickup: after the drop the
  // source row may already be gone (a moved file), so a later read would point
  // at the wrong element.
  let dragSnapshot: Snapshot | undefined;
  let dragUnverified = false;
  function endBursts() {
    burst = undefined;
    recording.endTextBurst();
    recording.endScrollBurst();
  }
  function fatalCaptureError(error: unknown): boolean {
    return !(error instanceof Fault) || error.dependency || error instanceof IdentityFault ||
      ['PERM_DENIED', 'APP_NOT_FOUND', 'WINDOW_NOT_FOUND', 'WINDOW_MISMATCH', 'WINDOW_CHANGED'].includes(error.code);
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
        if (bound) {
          // The helper confirms the same PID and canonical path before the
          // first event; otherwise the capture cannot be attributed.
          const announced = data.identity === null || typeof data.identity !== 'object'
            ? undefined : object(data.identity);
          if (!announced || announced.pid !== bound.pid ||
              announced.windowOwnerPid !== bound.pid || announced.bundlePath !== bound.bundlePath) {
            throw new Fault('IDENTITY_MISMATCH', 'Capture helper did not confirm the selected copy');
          }
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
        endBursts();
        targetActive = data.active;
        if (!targetActive) warn('FOCUS_CHANGED', 'Input in other apps was skipped. Target actions were retained.');
        continue;
      }
      if (data.kind === 'boundary' || data.kind === 'warning') {
        endBursts();
        if (data.kind === 'warning') {
          const code = captureCode(data.code);
          warn(code, pointerWarningMessages.get(code) ?? `Some input may have been skipped: ${code}`);
        }
        continue;
      }
      if (data.kind === 'drag_start') {
        endBursts();
        dragSnapshot = undefined;
        dragUnverified = true;
        try {
          dragSnapshot = bound
            ? await identity.readWindow(desktop, target, { timeoutMs: 1200, preferredWindowId: initial.windowId })
            : await desktop.snapshot(target, 1200, initial.windowId);
          if (dragSnapshot.windowId !== initial.windowId) {
            throw new Fault('WINDOW_CHANGED', 'Capture switched away from the initial window');
          }
          dragUnverified = false;
        } catch (error) {
          dragSnapshot = undefined;
          if (fatalCaptureError(error)) throw error;
          warn(error instanceof Fault ? error.code : 'CAPTURE_FAILED',
            error instanceof Error ? error.message : 'The drag start could not be read');
        }
        continue;
      }

      const event = parseEvent(data);
      const traceId = traceClicks && event.kind === 'click' && typeof data.traceId === 'string'
        ? data.traceId : undefined;
      // The helper hit-tests mouse-down against the selected native window. Its focus
      // update can reach us after the click that activated that window.
      if (!targetActive && event.kind !== 'click' && event.kind !== 'drag') continue;
      try {
        if (event.kind === 'drag') {
          const captured = dragSnapshot;
          dragSnapshot = undefined;
          if (dragUnverified || !captured) {
            dragUnverified = false;
            warn('DRAG_UNVERIFIED', 'A drag was skipped because its start state could not be read');
            burst = undefined;
            continue;
          }
          const skipped = recording.add({ event, snapshot: captured });
          if (skipped) warn(skipped, pointerWarningMessages.get(skipped) ?? `Some input was skipped: ${skipped}`);
          burst = undefined;
          continue;
        }
        // A burst reuses the snapshot taken for its first event, so a fast
        // sequence of wheel ticks or keystrokes costs one accessibility read.
        if ((event.kind === 'text' || event.kind === 'scroll') && burst?.kind === event.kind &&
            event.t - burst.at <= (event.kind === 'text' ? textGapMs : scrollGapMs)) {
          const skipped = recording.add({ event, snapshot: burst.snapshot });
          if (skipped) warn(skipped, pointerWarningMessages.get(skipped) ?? `Some input was skipped: ${skipped}`);
          burst.at = event.t;
          continue;
        }
        if (Date.now() - event.seen > 2000) {
          throw new Fault('STALE_CAPTURE', 'The accessibility snapshot could not keep up with input');
        }
        const pinWindow = event.kind === 'click' || event.kind === 'scroll' || event.kind === 'hover'
          ? initial.windowId : undefined;
        const captured = bound
          ? await identity.readWindow(desktop, target, { timeoutMs: 1200, preferredWindowId: initial.windowId })
          : await desktop.snapshot(target, 1200, pinWindow);
        if (captured.windowId !== initial.windowId) {
          throw new Fault('WINDOW_CHANGED', 'Capture switched away from the initial window');
        }
        let clipboardRead: ClipboardRead | undefined;
        if (options.clipboard && event.kind === 'key' && isPasteChord(event)) {
          try {
            clipboardRead = await desktop.readClipboard();
          } catch {
            // The shortcut is still recordable; content just stays unpinned.
            warn('CLIPBOARD_READ_FAILED',
              'The clipboard could not be read, so the paste was recorded as the shortcut only');
          }
        }
        const skipped = recording.add({ event, snapshot: captured }, clipboardRead);
        if (skipped) {
          warn(skipped, pointerWarningMessages.get(skipped) ?? `Some input was skipped: ${skipped}`);
          if (traceId) trace({ stage: 'flow', id: traceId, decision: 'filtered', reason: skipped });
          burst = undefined;
          continue;
        }
        burst = event.kind === 'text' || event.kind === 'scroll'
          ? { kind: event.kind, at: event.t, snapshot: captured } : undefined;
        if (traceId) trace({ stage: 'flow', id: traceId, decision: 'collected', windowId: captured.windowId });
      } catch (error) {
        if (traceId) {
          trace({ stage: 'flow', id: traceId, decision: 'filtered',
            reason: error instanceof Fault ? error.code : 'CAPTURE_FAILED' });
        }
        if (!fatalCaptureError(error)) {
          endBursts();
          warn(error instanceof Fault ? error.code : 'CAPTURE_FAILED',
            error instanceof Error ? error.message : 'Capture failed');
          continue;
        }
        throw error;
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
