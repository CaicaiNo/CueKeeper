import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultCheckpointTimeoutMs, flowV2Check } from './contracts-v2.js';
import type { FlowV2, StepV2, WindowScope } from './contracts-v2.js';
import { parseCaptureEvent } from './capture-protocol.js';
import type { CaptureEvent, CaptureGapCode } from './capture-protocol.js';
import type { Desktop } from './desktop.js';
import { scopeKey, validateFlowV2 } from './flow-v2.js';
import type { InputSource } from './ime.js';
import type { ElementLocator } from './contracts.js';
import { Fault, flatten, hitTest, object, resolve, toLocator } from './locator.js';
import type { Located, Point, Snapshot } from './locator.js';

// Global recording turns the helper's evidence stream into a version 2 flow.
// Attribution is frozen when the event happened: every step is generated from
// the app/window the event named, never from a snapshot read for a later event.
// When the evidence is incomplete or contradictory the engine emits a `gap`
// step instead of guessing, so a flow with a gap is refused by `flow validate`
// and by replay before any desktop call.

const textGapMs = 1500;
const scrollGapMs = 350;
const multiClickGapMs = 1500;
const multiClickDistance = 4;
const deltaLimit = 1000;
const staleCaptureMs = 2000;
const defaultStepLimit = 500;
const dragCenterTolerance = 4;
const dragPathLimit = 64;
const clickTextFallbackMs = 5000;
const maxWindowBindings = 64;

const editable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);
const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const flowIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type CaptureWarning = { code: string; message: string };

/** One app window as the helper named it at event time. */
export interface WindowEvidence {
  app: string;
  pid: number;
  processInstance?: number;
  windowNumber: number;
  windowTitle: string;
}

/** Reads one window's accessibility tree; a failure becomes a capture gap. */
export type WindowReader = (window: WindowEvidence) => Promise<Snapshot>;

export interface GlobalRecordingOptions {
  /** Bundle IDs whose events are dropped before any content is read. */
  exclude?: string[];
  /** Injectable wall clock, used to detect snapshots that arrive too late. */
  now?: () => number;
  stepLimit?: number;
}

type WindowBinding = {
  key: string;
  app: string;
  title: string;
  pid: number;
  processInstance?: number;
  windowNumber: number;
};

type StepDraft = Record<string, unknown> & { kind: StepV2['kind'] };

function nearPoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) <= multiClickDistance && Math.abs(a[1] - b[1]) <= multiClickDistance;
}

function locatorKey(locator: ElementLocator) {
  return JSON.stringify(locator);
}

function clampDelta(value: number) {
  return Math.max(-deltaLimit, Math.min(deltaLimit, Math.round(value)));
}

/** A display label is stored, never the raw window title from arbitrary apps. */
function displayTitle(title: string | undefined) {
  const trimmed = (title ?? '').trim();
  if (!trimmed) return '(untitled)';
  return trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
}

function keySlug(app: string) {
  const last = app.split('.').pop() ?? app;
  const slug = last.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  if (!slug) return 'app';
  return /^[a-z]/.test(slug) ? slug : `app${slug}`;
}

function captureCode(code: unknown) {
  return typeof code === 'string' && /^[A-Z_]{1,48}$/.test(code) ? code : 'CAPTURE_FAILED';
}

/**
 * Converts capture events into `version: 2` steps. It is fully offline: the
 * snapshot reader is supplied by the caller, so the same engine is exercised by
 * fixtures and by a live session.
 */
export class GlobalRecording {
  private steps: StepV2[] = [];
  private inputs = new Set<string>();
  private bindings = new Map<string, WindowBinding>();
  private appKeys = new Map<string, number>();
  private apps = new Set<string>();
  private current?: { app: string; key: string };
  private lastGeneration = 0;
  private generationWindow = new Map<number, string>();
  private secureOpen = false;
  private securityAgentWarned = false;
  private textBurst?: { at: number; scope: string; locator: string; snapshot: Snapshot };
  private scrollBurst?: {
    at: number; startedAt: number; scope: string; locator: string;
    deltaX: number; deltaY: number; index: number;
  };
  private lastClick?: {
    at: number; point: Point; index: number; scope: string; locator: string; button: 'left' | 'right';
  };
  private textAnchor?: { at: number; scope: string; locator: ElementLocator };
  private notes = new Map<string, string>();
  private exclude: Set<string>;
  private now: () => number;
  private stepLimit: number;
  private truncated = false;
  private inputCount = 0;

  constructor(private read: WindowReader, options: GlobalRecordingOptions = {}) {
    this.exclude = new Set(options.exclude ?? []);
    this.now = options.now ?? Date.now;
    this.stepLimit = options.stepLimit ?? defaultStepLimit;
  }

  get captureWarnings(): CaptureWarning[] {
    return [...this.notes].map(([code, message]) => ({ code, message }));
  }

  get stepCount() {
    return this.steps.length;
  }

  get hasGaps() {
    return this.steps.some(step => step.kind === 'gap');
  }

  /** Public so a live session can report helper warnings without a step. */
  warn(code: string, message: string) {
    if (!this.notes.has(code)) this.notes.set(code, message);
  }

  /** Ends text and scroll merging, for pauses and helper boundaries. */
  endBursts() {
    this.textBurst = undefined;
    this.scrollBurst = undefined;
  }

  /**
   * Consumes one validated capture event. A text burst is merged by scope and
   * control, never across windows; a continuous secure interval becomes one
   * manual checkpoint and every piece of content inside it is discarded.
   */
  async add(event: CaptureEvent): Promise<void> {
    // The system authorization UI is evidence of a secure boundary even when the
    // system-wide flag has not caught up yet; its own window never becomes a scope.
    const secureBoundary = event.secure || event.owner?.securityAgent === true;
    if (event.kind === 'gap') {
      if (secureBoundary) {
        this.openSecure(event);
        return;
      }
      if (this.secureOpen) this.closeSecure();
      this.endBursts();
      this.pushGap(event.gapCode);
      return;
    }
    // An excluded app produces no step at all, not even a privacy marker.
    const app = event.owner?.app;
    if (app && this.exclude.has(app)) return;
    if (secureBoundary) {
      this.openSecure(event);
      return;
    }
    if (this.secureOpen) this.closeSecure();
    switch (event.kind) {
      case 'focus':
        this.onFocus(event);
        return;
      case 'click':
        await this.onClick(event);
        return;
      case 'scroll':
        await this.onScroll(event);
        return;
      case 'hover':
        await this.onHover(event);
        return;
      case 'drag':
        await this.onDrag(event);
        return;
      case 'text':
        await this.onText(event);
        return;
      case 'key':
        this.onKey(event);
        return;
    }
  }

  /**
   * A focus notification only confirms a window that the event stream already
   * named. A late notification (an older generation) never moves the flow back
   * to a window it already left. When the notification is new and confirmed, it
   * becomes the navigation step the user actually performed.
   */
  private onFocus(event: Extract<CaptureEvent, { kind: 'focus' }>) {
    if (event.focusGeneration < this.lastGeneration) return;
    const binding = this.bindingFor(event);
    if (!binding) {
      this.lastGeneration = Math.max(this.lastGeneration, event.focusGeneration);
      return;
    }
    if (!this.claim(event, binding)) return;
    if (!this.current) {
      this.current = { app: binding.app, key: binding.key };
      return;
    }
    if (this.current.key !== binding.key) this.ensureScope(binding);
  }

  private async onClick(event: Extract<CaptureEvent, { kind: 'click' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (event.decision === 'gap') {
      this.pushGap(event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    // A click on a window that is not the flow's current window either only
    // activated it or delivered a first mouse-down. Only the activation case is
    // provable, and it is recorded as navigation, not as a click.
    if (event.decision === 'navigate') {
      this.ensureScope(binding);
      return;
    }
    if (this.current && this.current.key !== binding.key) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    const snapshot = await this.snapshot(binding, event);
    if (!snapshot) return;
    const hit = this.hit(snapshot, event.point);
    if (!hit) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (hit.node.secure) {
      this.enterSecure();
      return;
    }
    const locator = toLocator(snapshot, hit);
    const scope = this.windowScope(binding);
    const button = event.button ?? 'left';
    const count = Math.max(1, Math.min(3, event.count ?? 1));
    if (button === 'left' && hit.node.ref && editable.has(hit.node.role)) {
      this.textAnchor = { at: event.t, scope: scopeKey(scope), locator };
    }
    const previous = this.lastClick;
    if (count > 1 && previous && previous.index === this.steps.length - 1 && previous.button === 'left' &&
        event.t - previous.at <= multiClickGapMs && nearPoint(previous.point, event.point)) {
      const step = this.steps[previous.index];
      if (step?.kind === 'click') {
        (step as { count?: number }).count = count;
        previous.at = event.t;
        previous.point = event.point;
        return;
      }
    }
    this.push({
      kind: 'click', scope, target: locator,
      ...(count > 1 ? { count } : {}),
      ...(button === 'right' ? { button } : {}),
    });
    if (this.steps.length && this.steps[this.steps.length - 1].kind === 'click') {
      this.lastClick = {
        at: event.t, point: event.point, index: this.steps.length - 1,
        scope: scopeKey(scope), locator: locatorKey(locator), button,
      };
    }
  }

  private async onScroll(event: Extract<CaptureEvent, { kind: 'scroll' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (event.decision === 'gap') {
      this.pushGap(event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    const burst = this.scrollBurst;
    const scope = this.windowScope(binding);
    const scopeId = scopeKey(scope);
    const deltaX = clampDelta(event.deltaX);
    const deltaY = clampDelta(event.deltaY);
    if (burst && burst.scope === scopeId && event.t - burst.at <= scrollGapMs) {
      const step = this.steps[burst.index];
      if (step?.kind === 'scroll') {
        burst.deltaX = clampDelta(burst.deltaX + deltaX);
        burst.deltaY = clampDelta(burst.deltaY + deltaY);
        burst.at = event.t;
        const durationMs = Math.max(0, Math.round(burst.at - burst.startedAt));
        this.steps[burst.index] = {
          ...step, deltaX: burst.deltaX, deltaY: burst.deltaY,
          ...(durationMs ? { durationMs } : {}),
        };
        return;
      }
    }
    const snapshot = await this.snapshot(binding, event);
    if (!snapshot) return;
    const hit = this.hit(snapshot, event.point);
    if (!hit) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (hit.node.secure) {
      this.enterSecure();
      return;
    }
    this.endBursts();
    const target = toLocator(snapshot, hit);
    this.push({ kind: 'scroll', scope, target, deltaX, deltaY });
    if (!this.steps.length || this.steps[this.steps.length - 1].kind !== 'scroll') return;
    this.scrollBurst = {
      at: event.t, startedAt: event.t, scope: scopeId, locator: locatorKey(target),
      deltaX, deltaY, index: this.steps.length - 1,
    };
  }

  private async onHover(event: Extract<CaptureEvent, { kind: 'hover' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (event.decision === 'gap') {
      this.pushGap(event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    const snapshot = await this.snapshot(binding, event);
    if (!snapshot) return;
    const hit = this.hit(snapshot, event.point);
    // A hover without a named element cannot be replayed: v2 has no coordinate
    // hover. It is noise, not a missing step, so it is skipped with a warning.
    if (!hit) {
      this.warn('UNTARGETED_HOVER', 'A hover did not land on a re-addressable control and was skipped');
      return;
    }
    if (hit.node.secure) return;
    this.push({
      kind: 'hover', scope: this.windowScope(binding), target: toLocator(snapshot, hit),
      durationMs: Math.max(0, Math.min(60_000, Math.round(event.dwellMs))),
    });
  }

  private async onDrag(event: Extract<CaptureEvent, { kind: 'drag' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (event.fromWindowNumber && event.toWindowNumber && event.fromWindowNumber !== event.toWindowNumber) {
      this.pushGap('CROSS_SCOPE_GESTURE');
      return;
    }
    if (event.modifiers.length) {
      this.warn('DRAG_MODIFIERS_SKIPPED', 'A drag with held modifiers was skipped; v2 replays plain drags');
      return;
    }
    if (event.decision === 'gap') {
      this.pushGap(event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    const snapshot = await this.snapshot(binding, event);
    if (!snapshot) return;
    const from = this.hit(snapshot, event.from);
    const to = this.hit(snapshot, event.to);
    // A v2 drag names two elements and replays from their centers. An endpoint
    // that was not grabbed by its center cannot be represented safely.
    if (!from || !to || !this.centered(from, event.from) || !this.centered(to, event.to)) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (from.node.secure || to.node.secure) {
      this.enterSecure();
      return;
    }
    this.push({
      kind: 'drag', scope: this.windowScope(binding),
      from: toLocator(snapshot, from), to: toLocator(snapshot, to),
      durationMs: Math.max(0, Math.min(60_000, Math.round(event.durationMs))),
      ...(event.path.length ? { path: event.path.slice(0, dragPathLimit) } : {}),
      ...(event.button === 'right' ? { button: 'right' } : {}),
    });
  }

  private async onText(event: Extract<CaptureEvent, { kind: 'text' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    if (event.ime) {
      // Global recording stores an input parameter, never the committed string,
      // so an unverifiable IME commit is a warning rather than a blocking gap.
      this.warn('IME_COMMIT_UNVERIFIED', 'Text committed by an input method was stored as a runtime input parameter');
    }
    const scope = this.windowScope(binding);
    const scopeId = scopeKey(scope);
    const now = this.now();
    let snapshot: Snapshot;
    const burst = this.textBurst;
    if (burst && burst.scope === scopeId && event.t - burst.at <= textGapMs) {
      // Reuse the burst's snapshot: re-reading it for every keystroke would cost
      // far more than it proves inside a short burst.
      if (now - event.seen > staleCaptureMs) {
        this.pushGap('STALE_CAPTURE');
        return;
      }
      snapshot = burst.snapshot;
    } else {
      const captured = await this.snapshot(binding, event);
      if (!captured) return;
      snapshot = captured;
    }
    const field = this.textField(snapshot, scopeId, event);
    if (!field) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    const locatorId = locatorKey(field);
    if (this.textBurst && this.textBurst.scope === scopeId &&
        this.textBurst.locator === locatorId && event.t - this.textBurst.at <= textGapMs) {
      this.textBurst.at = event.t;
      this.textAnchor = { at: event.t, scope: scopeId, locator: field };
      return;
    }
    this.endBursts();
    const input = `input_${++this.inputCount}`;
    this.inputs.add(input);
    this.push({ kind: 'type', scope, target: field, input });
    if (!this.steps.length || this.steps[this.steps.length - 1].kind !== 'type') return;
    this.textBurst = { at: event.t, scope: scopeId, locator: locatorId, snapshot };
    this.textAnchor = { at: event.t, scope: scopeId, locator: field };
  }

  private onKey(event: Extract<CaptureEvent, { kind: 'key' }>) {
    const binding = this.bindingFor(event);
    if (!binding) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (event.decision === 'gap') {
      this.pushGap(event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    this.endBursts();
    this.push({
      kind: 'key', scope: this.windowScope(binding), key: event.key,
      ...(event.modifiers.length ? { modifiers: event.modifiers } : {}),
    });
  }

  /**
   * Focus is the normal evidence for a text event. Safari can report the caret
   * before its accessibility focus flag, so a recent click on an editable field
   * may stand in once that field itself shows the typed character.
   */
  private textField(
    snapshot: Snapshot, scope: string, event: Extract<CaptureEvent, { kind: 'text' }>,
  ): ElementLocator | undefined {
    const focused = flatten(snapshot.tree).filter(entry => entry.node.states.includes('focused'));
    const [single] = focused;
    if (focused.length === 1 && single.node.ref && editable.has(single.node.role)) {
      if (single.node.secure) {
        this.enterSecure();
        return undefined;
      }
      return toLocator(snapshot, single);
    }
    if (focused.some(entry => entry.node.secure)) {
      this.enterSecure();
      return undefined;
    }
    const anchor = this.textAnchor;
    if (!anchor || anchor.scope !== scope || event.t - anchor.at > clickTextFallbackMs) return undefined;
    try {
      const field = resolve(snapshot, anchor.locator);
      if (!field.node.ref || field.node.secure || !editable.has(field.node.role)) return undefined;
      if (event.chars && !(field.node.value ?? field.node.text ?? '').includes(event.chars)) return undefined;
      return anchor.locator;
    } catch {
      return undefined;
    }
  }

  private enterSecure() {
    this.openSecure();
  }

  /**
   * Opens a secure interval without reading anything. The helper's evidence only
   * explains why the interval was secure; the checkpoint carries no content.
   */
  private openSecure(event?: CaptureEvent) {
    if (event?.owner?.securityAgent && !this.securityAgentWarned) {
      this.securityAgentWarned = true;
      this.warn('SECURE_AUTHORIZATION',
        'A system authorization surface was handled as a manual checkpoint; no content was read');
    }
    if (this.secureOpen) return;
    this.secureOpen = true;
    this.endBursts();
  }

  /** Closes a secure interval and emits the one checkpoint it becomes. */
  private closeSecure() {
    this.secureOpen = false;
    this.endBursts();
    this.pushCheckpoint();
  }

  /**
   * A checkpoint must sit immediately after the step that opened the secure
   * interval and share its window. Without such a trigger the interval cannot be
   * replayed safely, so it stays an explicit `SECURE_INPUT` gap.
   */
  private pushCheckpoint() {
    const trigger = this.steps.at(-1);
    if (!trigger) {
      this.pushGap('SECURE_INPUT');
      return;
    }
    // Consecutive secure intervals merge: the previous checkpoint already ends
    // the run at this window, and no step was recorded in between.
    if (trigger.kind === 'manual_checkpoint') return;
    if (trigger.kind === 'gap' || !('scope' in trigger) || trigger.scope.kind !== 'window') {
      this.pushGap('SECURE_INPUT');
      return;
    }
    const scope = trigger.scope;
    this.push({
      kind: 'manual_checkpoint',
      scope,
      triggerStepId: trigger.id,
      reason: 'secure_input',
      resume: { scope, check: { kind: 'window_exists', equals: true } },
      timeoutMs: defaultCheckpointTimeoutMs,
    });
  }

  private bindingFor(event: CaptureEvent): WindowBinding | undefined {
    const owner = event.owner;
    if (!owner?.app || !bundleIdPattern.test(owner.app)) return undefined;
    if (!owner.pid || !owner.windowNumber) return undefined;
    const id = `${owner.pid}:${owner.processInstance ?? 0}:${owner.windowNumber}`;
    const title = displayTitle(owner.windowTitle);
    const existing = this.bindings.get(id);
    if (existing) {
      // The same native window can retitle; the key keeps following it.
      if (existing.title !== title) existing.title = title;
      return existing;
    }
    if (this.bindings.size >= maxWindowBindings) return undefined;
    const binding: WindowBinding = {
      key: this.nextKey(owner.app), app: owner.app, title,
      pid: owner.pid, windowNumber: owner.windowNumber,
      ...(owner.processInstance === undefined ? {} : { processInstance: owner.processInstance }),
    };
    this.bindings.set(id, binding);
    this.apps.add(owner.app);
    return binding;
  }

  private nextKey(app: string) {
    const next = (this.appKeys.get(app) ?? 0) + 1;
    this.appKeys.set(app, next);
    return `${keySlug(app)}-${next}`;
  }

  /**
   * Records which window an event at this focus generation named. Two different
   * windows on the same generation is conflicting evidence, never a preference.
   */
  private claim(event: CaptureEvent, binding: WindowBinding): boolean {
    const generation = event.focusGeneration;
    this.lastGeneration = Math.max(this.lastGeneration, generation);
    const id = this.bindingId(binding);
    const used = this.generationWindow.get(generation);
    if (used && used !== id) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return false;
    }
    this.generationWindow.set(generation, id);
    return true;
  }

  private bindingId(binding: WindowBinding) {
    return `${binding.pid}:${binding.processInstance ?? 0}:${binding.windowNumber}`;
  }

  private windowScope(binding: WindowBinding): WindowScope {
    return {
      kind: 'window', app: binding.app, windowKey: binding.key, windowTitle: binding.title,
    };
  }

  /**
   * Emits the navigation the flow needs to reach a new window: a new app is an
   * `activate_app`, another window of the same app is a `focus_window`. The
   * first window is the recording's starting point and needs no navigation.
   */
  private ensureScope(binding: WindowBinding) {
    const scope = this.windowScope(binding);
    if (!this.current) {
      this.current = { app: binding.app, key: binding.key };
      return;
    }
    if (this.current.app === binding.app && this.current.key === binding.key) return;
    this.endBursts();
    if (this.current.app === binding.app) {
      this.push({ kind: 'focus_window', scope });
    } else {
      this.push({
        kind: 'activate_app', scope: { kind: 'app', app: binding.app }, focusAfter: scope,
      });
    }
    this.current = { app: binding.app, key: binding.key };
  }

  private hit(snapshot: Snapshot, point: Point): Located | undefined {
    try {
      return hitTest(snapshot, point);
    } catch {
      return undefined;
    }
  }

  private centered(entry: Located, point: Point) {
    const bounds = entry.node.bounds;
    if (!bounds) return false;
    return Math.abs(bounds.x + bounds.width / 2 - point[0]) <= dragCenterTolerance &&
      Math.abs(bounds.y + bounds.height / 2 - point[1]) <= dragCenterTolerance;
  }

  private async snapshot(binding: WindowBinding, event: CaptureEvent): Promise<Snapshot | undefined> {
    if (this.now() - event.seen > staleCaptureMs) {
      this.pushGap('STALE_CAPTURE');
      return undefined;
    }
    try {
      const snapshot = await this.read({
        app: binding.app, pid: binding.pid, windowNumber: binding.windowNumber,
        windowTitle: binding.title,
        ...(binding.processInstance === undefined ? {} : { processInstance: binding.processInstance }),
      });
      if (this.now() - event.seen > staleCaptureMs) {
        this.pushGap('STALE_CAPTURE');
        return undefined;
      }
      return snapshot;
    } catch {
      this.warn('STALE_CAPTURE', 'An accessibility read for a capture event failed; the step is a gap');
      this.pushGap('STALE_CAPTURE');
      return undefined;
    }
  }

  private pushGap(code: CaptureGapCode) {
    this.endBursts();
    this.push({ kind: 'gap', code });
  }

  private push(step: StepDraft) {
    if (this.steps.length >= this.stepLimit) {
      this.truncated = true;
      return;
    }
    this.steps.push({ id: `s${this.steps.length + 1}`, ...step } as unknown as StepV2);
  }

  /**
   * The finished flow is schema-validated. Semantic validation is skipped when a
   * gap remains, because a gap is exactly what `parseFlowV2` refuses: the file
   * still has to reach the workbench so the gap can be resolved there.
   */
  finish(): FlowV2 {
    this.endBursts();
    if (this.secureOpen) this.closeSecure();
    if (!this.steps.length) throw new Fault('EMPTY_RECORDING', 'No supported actions were captured');
    if (this.truncated) this.warn('STEP_LIMIT', `The flow retains the first ${this.stepLimit} steps`);
    const id = randomUUID();
    const flow: FlowV2 = {
      version: 2,
      id: flowIdPattern.test(id) ? `global-${id.slice(0, 8)}` : 'global-recording',
      name: `${this.apps.size} 个 App / ${this.bindings.size} 个窗口的全局录制`,
      ...(this.inputs.size ? { inputs: [...this.inputs] } : {}),
      steps: this.steps,
    };
    if (!flowV2Check.Check(flow)) {
      const error = flowV2Check.Errors(flow).First();
      throw new Fault('CAPTURE_PROTOCOL', `Global recording did not form a valid v2 flow: ${error?.message ?? 'schema mismatch'}`);
    }
    if (!this.hasGaps) validateFlowV2(flow);
    return flow;
  }
}

export interface GlobalCaptureOptions {
  /** Hard session limit in seconds; no more input is accepted afterwards. */
  seconds: number;
  indicator: boolean;
  sound: boolean;
  exclude?: string[];
  inputSource?: InputSource;
}

export interface GlobalCaptureResult {
  flow: FlowV2;
  warnings: CaptureWarning[];
  partial: boolean;
  failure?: Fault;
}

function indicatorConfirmed(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const { window, display, level, bounds } = object(value);
  return [window, display, level].every(entry => typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0) &&
    Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite) &&
    (bounds[2] as number) > 0 && (bounds[3] as number) > 0;
}

/**
 * Runs a live global session: spawn the helper, validate each event, attribute
 * it against the named window, and finish a v2 flow. Everything that needs the
 * desktop happens here, never in the offline engine.
 */
export async function recordGlobal(
  desktop: Desktop, options: GlobalCaptureOptions, signal: AbortSignal,
): Promise<GlobalCaptureResult> {
  const executable = process.env.CUEKEEPER_RECORDER?.trim() ||
    fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
  const exclude = options.exclude ?? [];
  const args = ['--global', String(options.seconds)];
  if (!options.indicator) args.push('--no-indicator');
  if (options.sound) args.push('--sound');
  if (exclude.length) args.push('--exclude', exclude.join(','));
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const completion = new Promise<number | null>(resolveClose => {
    child.once('error', () => { /* close also fires after a failed spawn. */ });
    child.once('close', resolveClose);
  });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  let startupTimedOut = false;
  const startupTimeout = setTimeout(() => {
    startupTimedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  let sessionTimeout: NodeJS.Timeout | undefined;

  const recording = new GlobalRecording(
    window => desktop.snapshotWindow(`w-${window.windowNumber}`, window.windowTitle, 1200),
    { exclude },
  );
  if (options.inputSource && !options.inputSource.ascii) {
    recording.warn('IME_ACTIVE',
      `录制开始时输入源为「${options.inputSource.name}」，物理按键可能被改写成带分隔符的文本。全局录制只保存参数名，建议切到 ABC/U.S.`);
  }

  let ready = false;
  let failure: Fault | undefined;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      const data = object(JSON.parse(line));
      if (data.kind === 'error') {
        const code = captureCode(data.code);
        const dependency = !ready && ['INPUT_MONITORING_REQUIRED', 'ACCESSIBILITY_REQUIRED',
          'TAP_UNAVAILABLE', 'HOTKEY_TAP_UNAVAILABLE'].includes(code);
        const detail = typeof data.detail === 'string' && /^[ -~]{1,240}$/.test(data.detail) ? ` (${data.detail})` : '';
        throw new Fault(code, `Capture helper stopped: ${code}${detail}`, dependency);
      }
      if (data.kind === 'ready' && !ready) {
        if (data.global !== true || data.hotkeysFiltered !== true) {
          throw new Fault('CAPTURE_PROTOCOL',
            'Capture helper did not confirm global mode. Rebuild it with pnpm build:recorder', true);
        }
        if (options.indicator && !indicatorConfirmed(data.indicator)) {
          throw new Fault('INDICATOR_UNCONFIRMED',
            'Capture helper did not confirm the requested indicator state. Rebuild it with pnpm build:recorder', true);
        }
        ready = true;
        clearTimeout(startupTimeout);
        sessionTimeout = setTimeout(() => child.kill('SIGKILL'), (options.seconds + 5) * 1000);
        process.stderr.write(
          `Recording globally for up to ${options.seconds} seconds. Ctrl+Option+P pauses or resumes. ` +
          'Ctrl+Option+X stops and saves.\n');
        continue;
      }
      if (!ready) throw new Fault('CAPTURE_PROTOCOL', 'Input arrived before the helper was ready');
      if (data.kind === 'warning') {
        recording.warn(captureCode(data.code), `Some input may have been skipped: ${captureCode(data.code)}`);
        continue;
      }
      if (data.kind === 'boundary') {
        recording.endBursts();
        continue;
      }
      await recording.add(parseCaptureEvent(data));
    }

    const code = await completion;
    signal.throwIfAborted();
    if (startupTimedOut) throw new Fault('CAPTURE_START_TIMEOUT', 'Capture helper did not become ready within five seconds');
    if (!ready) throw new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable. Build it with pnpm build:recorder', true);
    if (code !== 0) throw new Fault('CAPTURE_FAILED', 'Capture helper exited before recording finished');
  } catch (error) {
    failure = signal.aborted ? new Fault('INTERRUPTED', 'Recording interrupted') :
      error instanceof Fault ? error : new Fault('CAPTURE_PROTOCOL', 'Could not read the global capture stream');
  } finally {
    lines.close();
    child.kill();
    await completion;
    clearTimeout(startupTimeout);
    clearTimeout(sessionTimeout);
    signal.removeEventListener('abort', abort);
  }

  if (!ready) throw failure ?? new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable');
  let flow: FlowV2;
  try {
    flow = recording.finish();
  } catch (error) {
    if (failure) throw failure;
    throw error;
  }
  return {
    flow,
    warnings: recording.captureWarnings,
    partial: Boolean(failure),
    ...(failure ? { failure } : {}),
  };
}
