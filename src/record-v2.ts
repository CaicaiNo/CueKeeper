import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { defaultCheckpointTimeoutMs, flowV2Check } from './contracts-v2.js';
import type { FlowV2, StepV2, WindowScope } from './contracts-v2.js';
import { parseCaptureEvent } from './capture-protocol.js';
import type { CaptureEvent, CaptureFocus, CaptureGapCode } from './capture-protocol.js';
import type { Desktop } from './desktop.js';
import {
  ElectronAccessibilityGuard, electronAccessibilityCode, electronAccessibilityHint,
  electronAccessibilityUnverifiedCode,
} from './electron-accessibility.js';
import { scopeKey, validateFlowV2 } from './flow-v2.js';
import type { InputSource } from './ime.js';
import type { ElementLocator } from './contracts.js';
import { defaultLifecyclePollMs, LifecycleWatcher } from './lifecycle.js';
import type { LifecycleObservation, LifecycleWatchOptions } from './lifecycle.js';
import {
  clickIdentity, contains, Fault, flatten, hitTest, object, resolve, toLocator,
} from './locator.js';
import type { Located, Point, Snapshot } from './locator.js';
import type { LifecycleEvent } from './wait-candidates.js';

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
/**
 * A text event this far behind the helper's clock can no longer be tied to the
 * live focus; the helper's own queue reported the same lag. It is dropped with
 * one CAPTURE_BACKLOG warning instead of becoming a gap per character.
 */
const captureBacklogMs = 8000;
/**
 * A window-tree read is the fallback, never the recording's normal path. The
 * desktop call enforces this budget itself, so a slow tree cannot hold the
 * event stream past it.
 */
const snapshotTimeoutMs = 3000;
/**
 * A recording can start with a click that dismisses a dialog before its window
 * is provable. Unverified events in this opening window are startup noise, not
 * user actions, and are dropped without a gap.
 */
const startupGraceMs = 500;
const defaultStepLimit = 500;
const dragCenterTolerance = 4;
const dragPathLimit = 64;
const clickTextFallbackMs = 5000;
const maxWindowBindings = 64;
const maxFocusEntries = 64;

const editable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);
/** Keys that can move accessibility focus away from the control a click selected. */
const focusMovingKeys = new Set([
  'return', 'tab', 'escape', 'home', 'end', 'pageup', 'pagedown', 'left', 'right', 'up', 'down',
]);
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
/** A recorded click target: the element under the pointer, or its raw point. */
type ClickTarget = ElementLocator | { kind: 'point'; point: Point };

function nearPoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) <= multiClickDistance && Math.abs(a[1] - b[1]) <= multiClickDistance;
}

function locatorKey(locator: ClickTarget) {
  return JSON.stringify(locator);
}

/** The AX role/name the helper read under the pointer, when it is usable. */
function nativeLabel(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : undefined;
}

/**
 * The helper reports AX roles ("AXTextField") while the window snapshot names
 * the same element in lower case ("textfield"). Only the snapshot vocabulary is
 * re-addressable at replay, so a native fallback target is converted into it.
 */
function snapshotRole(role: string) {
  const stripped = role.startsWith('AX') ? role.slice(2) : role;
  return /^[A-Za-z][A-Za-z0-9]*$/.test(stripped) ? stripped.toLowerCase() : role;
}

function clampDelta(value: number) {
  return Math.max(-deltaLimit, Math.min(deltaLimit, Math.round(value)));
}

/**
 * Whether a role names an editable control. Native evidence spells roles the
 * AX way (`AXTextField`), window snapshots use the bare name (`textfield`).
 */
function editableRole(role: string | undefined): boolean {
  if (!role) return false;
  const bare = role.replace(/^AX/, '').toLowerCase();
  return editable.has(bare);
}

/** The snapshot's spelling of an AX role, so a recorded target can resolve. */
function bareRole(role: string) {
  return role.replace(/^AX/, '').toLowerCase();
}

/** The focused element's screen frame, in the snapshot's shape. */
function focusBounds(focus: CaptureFocus | undefined) {
  if (!focus?.bounds) return undefined;
  const [x, y, width, height] = focus.bounds;
  return { x, y, width, height };
}

/**
 * The replayable target the helper's focused-element evidence names. A secure
 * control never becomes a target: its content is a manual checkpoint instead.
 */
function focusedTarget(focus: CaptureFocus | undefined): ElementLocator | undefined {
  if (!focus || focus.secure) return undefined;
  if (!focus.editable && !editableRole(focus.role)) return undefined;
  const role = nativeLabel(focus.role);
  if (!role) return undefined;
  const name = nativeLabel(focus.name);
  return { kind: 'element', role: bareRole(role), ...(name ? { name } : {}) };
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
  private systemDialogVisible = false;
  private securityAgentWarned = false;
  private textBurst?: {
    at: number; scope: string; locator: string; target: ElementLocator; snapshot?: Snapshot;
  };
  private scrollBurst?: {
    at: number; startedAt: number; scope: string; locator: string;
    deltaX: number; deltaY: number; index: number;
  };
  private lastClick?: {
    at: number; point: Point; index: number; scope: string; locator: string; button: 'left' | 'right';
  };
  private textAnchor?: { at: number; scope: string; locator: ElementLocator };
  /**
   * Focused-element evidence the helper already carried, per window and focus
   * generation. It lets the next text event reuse the proof without any read.
   */
  private focusTargets = new Map<string, ElementLocator>();
  /**
   * Text waiting for one fallback tree read. It is buffered, never awaited by
   * the text path: the read resolves in the background and the buffered burst
   * becomes one `type` step when it does. A non-text event settles it first so
   * step order still follows event order.
   */
  private pendingText?: { key: string; scope: WindowScope; scopeId: string; at: number };
  private pendingSettle?: Promise<void>;
  private startupOpen = true;
  private startupDropped = 0;
  private notes = new Map<string, string>();
  private lifecycleEvents: LifecycleEvent[] = [];
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

  /**
   * Explicit lifecycle facts the recording layer proved: a finished download, an
   * installed or removed bundle. Each event is placed after the last real step,
   * so the workbench can propose a wait at a known position instead of guessing
   * from idle time. Nothing is proposed when no step preceded the event.
   */
  recordLifecycle(observation: LifecycleObservation): void {
    const last = [...this.steps].reverse().find(step => step.kind !== 'gap');
    this.lifecycleEvents.push({
      at: Math.max(0, Math.round(observation.at)),
      kind: observation.kind,
      ...(observation.app === undefined ? {} : { app: observation.app }),
      ...(observation.path === undefined ? {} : { path: observation.path }),
      ...(last === undefined ? {} : { afterStepId: last.id }),
    });
  }

  /** Lifecycle events in the order the recording proved them. */
  get lifecycle(): LifecycleEvent[] {
    return this.lifecycleEvents;
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
    if (event.kind === 'system_dialog') {
      if (event.visible === this.systemDialogVisible) return;
      this.systemDialogVisible = event.visible;
      this.textAnchor = undefined;
      this.endBursts();
      if (event.visible) {
        this.secureOpen = false;
        this.warn('SYSTEM_DIALOG',
          'A macOS system dialog was detected. Handle it at the manual checkpoint during replay.');
        this.pushCheckpoint('system_dialog');
      }
      return;
    }
    if (this.systemDialogVisible) return;

    if (this.startupOpen && event.t > startupGraceMs) this.startupOpen = false;
    // Before the front window is provable, an event with no window at all is
    // startup noise (a click that dismissed a dialog, a queued gap); it must not
    // become the first thing the flow reports.
    if (this.startupOpen && !this.steps.length && !this.bindingFor(event)) {
      this.startupDropped += 1;
      return;
    }
    // A buffered text burst has to become its step before the next action, so
    // step order stays event order. A text event in the same window joins it.
    if (this.pendingText && this.pendingText.key !== this.eventFocusKey(event)) {
      await this.settlePending();
    }

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
    const scope = this.windowScope(binding);
    const scopeId = scopeKey(scope);
    const button = event.button ?? 'left';
    const count = Math.max(1, Math.min(3, event.count ?? 1));
    // A click moves the caret and can select another control: any burst that
    // was still open described the state before this click.
    this.endBursts();
    if (event.focus?.secure) {
      this.enterSecure();
      return;
    }
    const hitRole = nativeLabel(event.owner?.role);
    const hitName = nativeLabel(event.owner?.name);
    const field = focusedTarget(event.focus);
    if (field) this.rememberFocus(this.focusKey(binding, event.focusGeneration), field);
    const fieldHit = !!field && !editableRole(hitRole) && contains(focusBounds(event.focus), event.point);
    // A Finder click names the file or folder it landed on, not the anonymous
    // text field under the pointer, so Finder keeps the window-tree identity
    // path when the helper could not name anything. Every other click the
    // helper already hit-tested with AXUIElementCopyElementAtPosition needs no
    // tree read at all.
    const needsTree = !hitRole || (event.owner?.app === 'com.apple.finder' && !hitName && !fieldHit);
    let target: ClickTarget | undefined;
    if (!needsTree) {
      if (fieldHit) {
        // Electron exposes its text surface as a container above the editable
        // control: the click landed in the focused field, so the field is the
        // target that actually replays.
        target = field;
        this.warn('FOCUSED_EDITABLE_TARGET',
          'A click landed inside the focused editable control and was bound to it, not to the container under the pointer');
      } else if (hitName) {
        target = { kind: 'element', role: bareRole(hitRole), name: hitName };
      } else {
        // The helper named only a container; the text event that follows proves
        // the editable control and retargets this step, so no read is spent.
        target = { kind: 'element', role: bareRole(hitRole) };
      }
    }
    if (!target) {
      // Evidence that cannot name the element is the only case that still needs
      // the tree: a failed read keeps whatever the helper proved on its own.
      const snapshot = await this.snapshot(binding, { gapOnFailure: false });
      if (snapshot) {
        const hit = this.hit(snapshot, event.point);
        if (!hit) {
          this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
          return;
        }
        if (hit.node.secure) {
          this.enterSecure();
          return;
        }
        // Electron editors expose their text surface as a group above the
        // editable control. When the click lands inside the focused editable
        // but the deepest hit is a container, the control is the replay target.
        const treeField = editableRole(hit.node.role) ? undefined : this.focusedField(snapshot, event.point);
        if (treeField?.node.secure) {
          this.enterSecure();
          return;
        }
        const identity = treeField ? undefined : clickIdentity(snapshot.tree, hit);
        const chosen = identity ?? treeField;
        if (treeField) {
          this.warn('FOCUSED_EDITABLE_TARGET',
            'A click landed inside the focused editable control and was bound to it, not to the container under the pointer');
        }
        if (chosen) {
          target = toLocator(snapshot, chosen);
          if (button === 'left' && chosen.node.ref && editableRole(target.role)) {
            this.rememberFocus(this.focusKey(binding, event.focusGeneration), target);
          }
        } else {
          // The tree cannot name what the pointer hit. The helper's own element
          // evidence is the remaining proof of identity; without it the click
          // keeps its point and says so.
          target = this.evidenceTarget(event) ?? this.untargetedClick(event);
        }
      } else {
        target = this.nativeTarget(event);
      }
    }
    if (button === 'left' && target.kind === 'element' && editableRole(target.role)) {
      this.textAnchor = { at: event.t, scope: scopeId, locator: { ...target, role: bareRole(target.role) } };
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
      kind: 'click', scope, target,
      ...(count > 1 ? { count } : {}),
      ...(button === 'right' ? { button } : {}),
    });
    if (this.steps.length && this.steps[this.steps.length - 1].kind === 'click') {
      this.lastClick = {
        at: event.t, point: event.point, index: this.steps.length - 1,
        scope: scopeKey(scope), locator: locatorKey(target), button,
      };
    }
  }

  /**
   * The element target the helper's own AX evidence names. A role alone would
   * match every look-alike in the window, so only evidence that carries a name
   * becomes an element; everything else stays a point.
   */
  private evidenceTarget(event: Extract<CaptureEvent, { kind: 'click' }>): ClickTarget | undefined {
    const role = nativeLabel(event.owner?.role);
    const name = nativeLabel(event.owner?.name);
    if (!role || !name) return undefined;
    this.warn('NATIVE_ELEMENT_FALLBACK',
      'A click was kept from the helper\'s element evidence because the window tree did not name the element');
    return { kind: 'element', role: snapshotRole(role), name };
  }

  /**
   * The target a click keeps when its window tree could not be read. Named
   * element evidence is the strongest remaining proof; without it the click
   * keeps its point, marked by a warning the workbench shows.
   */
  private nativeTarget(event: Extract<CaptureEvent, { kind: 'click' }>): ClickTarget {
    const target = this.evidenceTarget(event);
    if (target) return target;
    const role = nativeLabel(event.owner?.role);
    if (role) return this.untargetedClick(event);
    this.warn('NATIVE_POINT_FALLBACK',
      'A click was kept at its screen point because the helper had no element evidence and reading its window tree failed; edit it into an element before replay');
    return { kind: 'point', point: event.point };
  }

  /**
   * A click with no proven element identity. Keeping the role alone would make
   * the step click whichever same-role element happens to be there, so the point
   * stays and the warning says the step still needs a target.
   */
  private untargetedClick(event: Extract<CaptureEvent, { kind: 'click' }>): ClickTarget {
    const file = event.owner?.app === 'com.apple.finder';
    this.warn(file ? 'UNTARGETED_FILE_CLICK' : 'UNTARGETED_ELEMENT_CLICK', file
      ? 'A Finder click hit no named file item; it is kept at its screen point and must be edited into a named element before replay'
      : 'A click hit no named element; it is kept at its screen point and must be edited into a named element before replay');
    return { kind: 'point', point: event.point };
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
    const snapshot = await this.snapshot(binding);
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
    const snapshot = await this.snapshot(binding);
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
    const snapshot = await this.snapshot(binding);
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
    // An event this far behind the helper cannot be tied to the live focus any
    // more; the whole queue is late, so one warning is more useful than a gap
    // per character. The event is dropped, never guessed.
    if (this.now() - event.seen > captureBacklogMs) {
      this.warn('CAPTURE_BACKLOG',
        'The capture stream fell more than 8 seconds behind the helper; text events from the backlog were dropped');
      return;
    }
    if (event.focus?.secure) {
      this.enterSecure();
      return;
    }
    const key = this.focusKey(binding, event.focusGeneration);
    // The helper's focused-element evidence is the normal path: role, label and
    // frame of the control that received the character, with no tree read.
    const direct = focusedTarget(event.focus);
    if (direct) {
      this.rememberFocus(key, direct);
      this.retargetClickFromEvidence(event, direct, scopeId);
      this.bindText(scope, scopeId, event.t, direct);
      return;
    }
    // A burst already proved which control receives the characters; another
    // read per keystroke would prove nothing more.
    const burst = this.textBurst;
    if (burst && burst.scope === scopeId && event.t - burst.at <= textGapMs) {
      this.bindText(scope, scopeId, event.t, burst.target);
      return;
    }
    // The click that selected the control is proven evidence even without the tree.
    const anchor = this.textAnchor;
    if (anchor && anchor.scope === scopeId && event.t - anchor.at <= clickTextFallbackMs) {
      this.warn('TEXT_TARGET_FROM_CLICK',
        'A text event carried no focused-element evidence; its target was taken from the click that selected the control');
      this.bindText(scope, scopeId, event.t, anchor.locator);
      return;
    }
    // Evidence already proven for this window and focus generation is reused.
    const cached = this.focusTargets.get(key);
    if (cached) {
      this.bindText(scope, scopeId, event.t, cached);
      return;
    }
    // Fallback: buffer the burst and read the tree once, off the event path.
    await this.bufferText(binding, key, scope, scopeId, event);
  }

  /** Records one text event against a proven control, merging a running burst. */
  private bindText(
    scope: WindowScope, scopeId: string, at: number, target: ElementLocator, snapshot?: Snapshot,
  ) {
    const locatorId = locatorKey(target);
    const burst = this.textBurst;
    if (burst && burst.scope === scopeId && burst.locator === locatorId &&
        at - burst.at <= textGapMs) {
      burst.at = at;
      burst.target = target;
      if (snapshot) burst.snapshot = snapshot;
      this.textAnchor = { at, scope: scopeId, locator: target };
      return;
    }
    this.endBursts();
    const input = `input_${++this.inputCount}`;
    this.inputs.add(input);
    this.push({ kind: 'type', scope, target, input });
    if (!this.steps.length || this.steps[this.steps.length - 1].kind !== 'type') return;
    this.textBurst = {
      at, scope: scopeId, locator: locatorId, target,
      ...(snapshot ? { snapshot } : {}),
    };
    this.textAnchor = { at, scope: scopeId, locator: target };
  }

  /**
   * Buffers text that arrived without focused-element evidence and starts one
   * tree read for its window. The read is not awaited here: the text path never
   * waits for the accessibility tree, and every later character of the burst
   * joins the buffer instead of triggering another read.
   */
  private async bufferText(
    binding: WindowBinding, key: string, scope: WindowScope, scopeId: string,
    event: Extract<CaptureEvent, { kind: 'text' }>,
  ) {
    // A pause longer than a burst ends it even while the first read is pending;
    // the read has to settle before the next burst can be its own step.
    if (this.pendingText && this.pendingText.key === key && event.t - this.pendingText.at > textGapMs) {
      await this.settlePending();
    }
    const cached = this.focusTargets.get(key);
    if (cached) {
      this.bindText(scope, scopeId, event.t, cached);
      return;
    }
    const pending = this.pendingText;
    if (pending && pending.key === key) {
      pending.at = event.t;
      return;
    }
    this.pendingText = { key, scope, scopeId, at: event.t };
    this.pendingSettle = this.resolvePendingText(binding, key);
  }

  /**
   * One fallback read for a buffered burst. A resolved focused control becomes
   * the burst's target and is cached for the rest of the focus generation; a
   * failed or late read drops the buffered characters with a warning, never a
   * gap, and never delays the events behind it.
   */
  private async resolvePendingText(binding: WindowBinding, key: string) {
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await this.read(this.windowFor(binding));
    } catch {
      snapshot = undefined;
    }
    const pending = this.pendingText;
    this.pendingText = undefined;
    this.pendingSettle = undefined;
    if (!pending || pending.key !== key) return;
    if (!snapshot) {
      this.warn('UNTARGETED_TEXT',
        'Text arrived without focused-element evidence and its window tree read failed; those characters were dropped');
      return;
    }
    const focused = flatten(snapshot.tree).filter(entry => entry.node.states.includes('focused'));
    if (focused.some(entry => entry.node.secure)) {
      this.enterSecure();
      return;
    }
    const [single] = focused;
    if (focused.length !== 1 || !single?.node.ref || !editable.has(single.node.role)) {
      this.warn('UNTARGETED_TEXT',
        'Text arrived without focused-element evidence and its window tree had no unique focused editable control; those characters were dropped');
      return;
    }
    const target = toLocator(snapshot, single);
    this.rememberFocus(key, target);
    this.retargetClick(snapshot, single, pending.scopeId, pending.at);
    this.bindText(pending.scope, pending.scopeId, pending.at, target, snapshot);
  }

  /** Waits for a buffered burst's fallback read, so its step lands in order. */
  async settlePending(): Promise<void> {
    const settle = this.pendingSettle;
    if (settle) await settle;
  }

  private windowFor(binding: WindowBinding) {
    return {
      app: binding.app, pid: binding.pid, windowNumber: binding.windowNumber,
      windowTitle: binding.title,
      ...(binding.processInstance === undefined ? {} : { processInstance: binding.processInstance }),
    };
  }

  private eventFocusKey(event: CaptureEvent) {
    const owner = event.owner;
    if (!owner?.pid || !owner.windowNumber) return '';
    return `${owner.pid}:${owner.processInstance ?? 0}:${owner.windowNumber}:${event.focusGeneration}`;
  }

  private focusKey(binding: WindowBinding, generation: number) {
    return `${binding.pid}:${binding.processInstance ?? 0}:${binding.windowNumber}:${generation}`;
  }

  private rememberFocus(key: string, target: ElementLocator) {
    if (!key) return;
    this.focusTargets.delete(key);
    this.focusTargets.set(key, target);
    if (this.focusTargets.size > maxFocusEntries) {
      const oldest = this.focusTargets.keys().next().value;
      if (oldest !== undefined) this.focusTargets.delete(oldest);
    }
  }

  /**
   * The unique focused editable control inside the point. Electron editors put
   * a group above their editable surface, and a click inside the control then
   * hits the group; this is the only evidence that recovers the real target.
   */
  private focusedField(snapshot: Snapshot, point: Point): Located | undefined {
    const focused = flatten(snapshot.tree).filter(entry =>
      entry.node.ref && entry.node.states.includes('focused') && editable.has(entry.node.role));
    const [single] = focused;
    if (focused.length !== 1 || !single) return undefined;
    return contains(single.node.bounds, point) ? single : undefined;
  }

  /**
   * A click recorded as its container is corrected in place when the following
   * text proves the field — from the helper's own bounds when it has them.
   */
  private retargetClickFromEvidence(
    event: Extract<CaptureEvent, { kind: 'text' }>, target: ElementLocator, scope: string,
  ) {
    const click = this.lastClick;
    if (!click || click.button !== 'left' || click.scope !== scope) return;
    if (click.index !== this.steps.length - 1 || event.t - click.at > clickTextFallbackMs) return;
    const step = this.steps[click.index];
    if (step?.kind !== 'click' || step.target.kind !== 'element') return;
    if (editableRole(step.target.role)) return;
    if (!contains(focusBounds(event.focus), click.point)) return;
    (step as { target: ElementLocator }).target = target;
    click.locator = locatorKey(target);
    this.warn('CLICK_RETARGETED_TO_TEXT',
      'A click recorded as its container was retargeted to the editable control the following text proved');
  }

  /**
   * A click whose tree read failed keeps the helper's role, which for an
   * Electron editor is the container. The first text event proves the control,
   * so the click that selected it is corrected in place while it is still the
   * last step. Only a click whose point was inside the control qualifies.
   */
  private retargetClick(snapshot: Snapshot, field: Located, scope: string, at: number) {
    const click = this.lastClick;
    if (!click || click.button !== 'left' || click.scope !== scope) return;
    if (click.index !== this.steps.length - 1 || at - click.at > clickTextFallbackMs) return;
    const step = this.steps[click.index];
    if (step?.kind !== 'click') return;
    // A named editable target is already correct; an unnamed container or a
    // point fallback (the tree read failed, so no name was available) is what
    // the following text can prove.
    if (step.target.kind === 'element' && editableRole(step.target.role)) return;
    if (!contains(field.node.bounds, click.point)) return;
    const target = toLocator(snapshot, field);
    (step as { target: ElementLocator }).target = target;
    click.locator = locatorKey(target);
    this.warn('CLICK_RETARGETED_TO_TEXT',
      'A click recorded as its container was retargeted to the editable control the following text proved');
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
    // The key event's own focused-element evidence is the freshest proof of
    // which control has the caret, and it costs no tree read.
    const target = focusedTarget(event.focus);
    if (target) {
      this.rememberFocus(this.focusKey(binding, event.focusGeneration), target);
      this.textAnchor = { at: event.t, scope: scopeKey(this.windowScope(binding)), locator: target };
    } else if (focusMovingKeys.has(event.key)) {
      // A key that can move accessibility focus invalidates the old control.
      this.textAnchor = undefined;
    }
    this.push({
      kind: 'key', scope: this.windowScope(binding), key: event.key,
      ...(event.modifiers.length ? { modifiers: event.modifiers } : {}),
    });
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
    // A secure boundary invalidates whatever control was proven before it.
    this.textAnchor = undefined;
  }

  /** Closes a secure interval and emits the one checkpoint it becomes. */
  private closeSecure() {
    this.secureOpen = false;
    this.endBursts();
    this.textAnchor = undefined;
    this.pushCheckpoint('secure_input');
  }

  /**
   * A checkpoint shares the window of the preceding trigger step. An interval
   * without a usable trigger stays visible as a capture gap.
   */
  private pushCheckpoint(reason: Extract<StepV2, { kind: 'manual_checkpoint' }>['reason']) {
    const trigger = this.steps.at(-1);
    // Consecutive secure intervals merge: the previous checkpoint already ends
    // the run at this window, and no step was recorded in between.
    if (trigger?.kind === 'manual_checkpoint' && reason === 'secure_input') return;
    if (!trigger || !('scope' in trigger) || trigger.scope.kind !== 'window' ||
        (reason === 'system_dialog' && trigger.kind !== 'click' && trigger.kind !== 'key')) {
      this.pushGap(reason === 'secure_input' ? 'SECURE_INPUT' : 'CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    const scope = trigger.scope;
    this.push({
      kind: 'manual_checkpoint',
      scope,
      triggerStepId: trigger.id,
      reason,
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

  /**
   * Reads the window tree for one pointer step. This is fallback evidence: the
   * helper's own element evidence is preferred, and a text event never waits for
   * this. A failed read is reported once and the caller decides; a click keeps
   * its own evidence, every other gesture becomes a gap.
   */
  private async snapshot(
    binding: WindowBinding, { gapOnFailure = true } = {},
  ): Promise<Snapshot | undefined> {
    try {
      return await this.read(this.windowFor(binding));
    } catch (error) {
      if (gapOnFailure) {
        const reason = error instanceof Fault ? error.code : 'no answer';
        this.warn('SNAPSHOT_UNAVAILABLE', `An accessibility read failed (${reason}); the step is a gap`);
        this.pushGap('STALE_CAPTURE');
      }
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
    if (this.pendingText) {
      // A buffered burst whose read never returned cannot be placed; dropping it
      // is better than a flow that silently loses every later step's order.
      this.pendingText = undefined;
      this.warn('UNTARGETED_TEXT',
        'A fallback tree read for buffered text did not finish before the recording ended; those characters were dropped');
    }
    this.endBursts();
    if (this.secureOpen) this.closeSecure();
    if (this.startupDropped) {
      this.warn('CAPTURE_STARTUP',
        `${this.startupDropped} unverified event(s) in the first ${startupGraceMs} ms of the recording were dropped as startup noise`);
    }
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
  /**
   * Install/download observation while recording. `true` (the default) watches
   * the user's Downloads and application directories; `false` disables it; an
   * object overrides the directories, quiet window or read-only seams.
   */
  lifecycle?: boolean | LifecycleWatchOptions;
}

export interface GlobalCaptureResult {
  flow: FlowV2;
  warnings: CaptureWarning[];
  partial: boolean;
  failure?: Fault;
  /** Explicit lifecycle facts, for `lifecycle.json` next to the flow. */
  lifecycle: LifecycleEvent[];
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
    window => desktop.snapshotWindow(`w-${window.windowNumber}`, window.windowTitle, snapshotTimeoutMs),
    { exclude },
  );
  // Every Electron app/window is classified once, when the recording first
  // reaches it. A disabled editor stops the session before its first step is
  // recorded; the steps captured so far stay as a partial flow.
  const accessibilityGuard = new ElectronAccessibilityGuard({
    read: window => desktop.snapshotWindow(`w-${window.windowNumber}`, window.windowTitle, 1200),
  });
  const accessibilityKinds = new Set(['focus', 'click']);
  async function checkAccessibility(event: CaptureEvent) {
    if (!accessibilityKinds.has(event.kind)) return;
    if (event.secure || event.decision === 'gap') return;
    const owner = event.owner;
    if (!owner?.app || !owner.pid || !owner.windowNumber) return;
    if (exclude.includes(owner.app)) return;
    const verdict = await accessibilityGuard.inspect({
      app: owner.app, pid: owner.pid, windowNumber: owner.windowNumber, windowTitle: owner.windowTitle,
    });
    if (verdict === 'disabled') {
      throw new Fault(electronAccessibilityCode, electronAccessibilityHint(owner.app));
    }
    if (verdict === 'unverified') {
      recording.warn(electronAccessibilityUnverifiedCode,
        'Electron 窗口里既没有编辑器控件，也没有无障碍占位提示（例如欢迎页/设置页），' +
        '无法确认无障碍模式；该窗口继续录制。');
    }
  }
  if (options.inputSource && !options.inputSource.ascii) {
    recording.warn('IME_ACTIVE',
      `录制开始时输入源为「${options.inputSource.name}」，物理按键可能被改写成带分隔符的文本。全局录制只保存参数名，建议切到 ABC/U.S.`);
  }

  let ready = false;
  let failure: Fault | undefined;
  // Install lifecycle facts are observed while recording, not hand-written
  // afterwards. The watcher only lists directories and reads bundle IDs.
  const watcher = options.lifecycle === false ? undefined : new LifecycleWatcher(
    typeof options.lifecycle === 'object' ? options.lifecycle : {},
  );
  let polling = false;
  let lifecycleTimer: NodeJS.Timeout | undefined;
  const pollLifecycle = async () => {
    if (!polling || !watcher) return;
    try {
      for (const observation of await watcher.poll()) recording.recordLifecycle(observation);
    } catch {
      recording.warn('LIFECYCLE_WATCH_FAILED',
        '安装/下载观察失败：本次录制没有这些事件的候选等待，可手工补充 lifecycle.json');
    }
    if (polling) lifecycleTimer = setTimeout(pollLifecycle, defaultLifecyclePollMs);
  };
  const startWatcher = async () => {
    if (!watcher) return;
    try {
      await watcher.start();
    } catch {
      recording.warn('LIFECYCLE_WATCH_FAILED',
        '安装/下载观察失败：本次录制没有这些事件的候选等待，可手工补充 lifecycle.json');
      return;
    }
    polling = true;
    lifecycleTimer = setTimeout(pollLifecycle, defaultLifecyclePollMs);
  };
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
        await startWatcher();
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
      const event = parseCaptureEvent(data);
      await checkAccessibility(event);
      await recording.add(event);
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
    polling = false;
    clearTimeout(lifecycleTimer);
    lines.close();
    child.kill();
    await completion;
    clearTimeout(startupTimeout);
    clearTimeout(sessionTimeout);
    signal.removeEventListener('abort', abort);
  }

  if (!ready) throw failure ?? new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable');
  // A buffered text burst may still be waiting for its one fallback read; let it
  // land before the flow is built so its step is not lost.
  await recording.settlePending();
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
    lifecycle: recording.lifecycle,
  };
}
