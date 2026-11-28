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
import type { ElementLocator } from './contracts.js';
import { inputValuesLimits } from './input-values.js';
import type { InputValueEntry, InputValueIssue } from './input-values.js';
import { defaultLifecyclePollMs, LifecycleWatcher } from './lifecycle.js';
import type { LifecycleObservation, LifecycleWatchOptions } from './lifecycle.js';
import type { Located, Node, Point, Snapshot } from './locator.js';
import {
  clickIdentity, contains, elementNames, Fault, flatten, hitTest, isReAddressable, object, resolve, toLocator,
} from './locator.js';
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
 * event stream past it. The read a click schedules for the window it changed
 * is the one deliberate exception: it is the screen the next click in that
 * window is made against, and it runs off the event stream.
 *
 * `complete: false` inside this budget is the driver saying it ran out of
 * observation time, which is not proof the tree is unusable (a window that is
 * retitling or loading a folder rebuilds it), so `readWindow` retries such a
 * read once, after the rebuild, before the step becomes a gap.
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
/**
 * How much of one capture warning the workbench keeps (500 characters). The
 * gap-origin report stays well inside that: a handful of short lines, then a
 * count of the gaps it left out.
 */
const gapOriginLines = 6;
const gapOriginChars = 480;
/**
 * How long one window's tree may be reused. A pointer event inside the same
 * window reuses the tree it already read; past this age the window is read
 * again, because nothing else can prove the tree still describes the screen.
 */
const defaultSnapshotTtlMs = 30_000;
/** The app whose clicks navigate the window out from under them. */
const finderBundleId = 'com.apple.finder';
/** Finder shortcuts that replace the window's content before the next click. */
const finderNavigationKeys = new Set(['up', 'down', '[', ']', 'g']);
/** How close a named control may sit to an anonymous hit before it is suspect. */
const nearbyPointTolerance = 24;
/** How many window trees may stay cached at once; the least recently used goes. */
const defaultCachedWindows = 8;
/**
 * The driver's observation budget for one fallback tree read. A pointer event
 * that carries no element of its own waits for this; it is deliberately short
 * because the read blocks the event stream it serves.
 */
const defaultSnapshotBudgetMs = 2500;
/**
 * The budget one budget-exhausted read is retried with. `complete: false` means
 * the driver ran out of its observation window, not that the tree is unusable: a
 * window that is retitling, loading a folder or drawing a new page rebuilds its
 * tree, and by the time the failed read returns that rebuild has usually
 * finished, so the read usually succeeds immediately.
 */
const snapshotRetryBudgetMs = 2500;
/**
 * Both attempts together, from the first one's start, including the driver
 * process margin. A fallback read must not hold the event stream past the 8 s
 * text-backlog window, so the retry only gets what is left of this deadline and
 * is skipped entirely when that is too little to be useful.
 */
const snapshotStepDeadlineMs = 4000;
/**
 * The driver process is given this much beyond its observation budget to start
 * up and answer. Without a bound of its own, one read could occupy
 * `budget + 3 s`, and a retried read nearly twice that — past the backlog line.
 */
const snapshotCommandMarginMs = 1200;
/**
 * How long after a click the window is read again. A click that opens a sheet
 * or switches a page changes the screen before its own tree read can run, so
 * the read that follows has to wait for the change to finish drawing.
 */
const settledTreeDelayMs = 250;
/**
 * A settle read that takes longer than this is abandoned: the next click comes
 * first. The driver is allowed 3s to observe a slow Chromium settle, so the
 * abandonment sits above that — otherwise the wait it was given is cut short.
 */
const settledTreeReadMs = 3_200;
/** How many reads one settle chain may take while the window is still changing. */
const settledTreeReads = 6;
/**
 * How long a click waits for the read already under way for its window before
 * naming itself. The read began before the click, so it describes this screen;
 * the wait only covers the part of it that has not finished yet.
 */
const settledWaitMs = 900;

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

/**
 * Reads one window's accessibility tree; a failure becomes a capture gap. The
 * second argument is the driver's observation budget, so a read that ran out of
 * a short budget can be retried with a larger one before it becomes a gap.
 */
export type WindowReader = (window: WindowEvidence, budgetMs?: number) => Promise<Snapshot>;

export interface GlobalRecordingOptions {
  /** Bundle IDs whose events are dropped before any content is read. */
  exclude?: string[];
  /** Injectable wall clock, used to detect snapshots that arrive too late. */
  now?: () => number;
  stepLimit?: number;
  /** How long a window tree may be reused; defaults to 30 s. */
  snapshotTtlMs?: number;
  /** How many window trees may be cached at once; defaults to 8. */
  maxCachedWindows?: number;
  /**
   * The driver's observation budget for one fallback window read; defaults to
   * 2.5 s. Only a read whose answer was cut short by that budget is retried.
   */
  snapshotBudgetMs?: number;
  /**
   * Runs the tree read a click schedules for the window it changed. Tests
   * inject a queue so the read happens when they say; the default is a timer
   * long enough for a page switch or a sheet to finish drawing.
   */
  scheduleSettle?: (task: () => Promise<void>) => void;
}

type WindowBinding = {
  key: string;
  app: string;
  title: string;
  pid: number;
  processInstance?: number;
  windowNumber: number;
  /** The tree this window was last read as, while it still describes it. */
  cache?: WindowTreeCache;
  /** The tree read after the last click here, which is the screen the next click is made against. */
  settled?: { snapshot: Snapshot; at: number };
  /**
   * A Finder navigation key moved this window after the last tree read. Trees
   * older than this are the screen before the navigation and cannot name the
   * next click; a later read may.
   */
  navigatedAt?: number;
};

/**
 * One window's tree and the facts that were true when it was read. A cached
 * tree is reused only while those facts still hold; the bounds are the tree
 * root's own box, so a window that shrank or moved is read again.
 */
type WindowTreeCache = {
  snapshot: Snapshot;
  at: number;
  title: string;
  bounds: Snapshot['tree']['bounds'];
};

type StepDraft = Record<string, unknown> & { kind: StepV2['kind'] };
/** A recorded click target: the element under the pointer, or its raw point. */
type ClickTarget = ElementLocator | { kind: 'point'; point: Point };
/**
 * What actually raised a scope gap, when it is not the event being consumed: a
 * held press settled later by a focus, a hover or a capture boundary.
 */
type GapOrigin = {
  handler: string;
  app?: string;
  window?: number;
  generation?: number;
  decision?: string;
};

/**
 * A press that landed in a known window whose control it could not prove. It is
 * held only while the focus that would prove it "only brought the window
 * forward" can still be the next thing that happens.
 */
type HeldClick = {
  key: string;
  at: number;
  seen: number;
  /** The focus generation the press was made in. */
  generation: number;
  /**
   * Whether this press can be the swallowed press that brought its window
   * forward at all: only a press into a window that this generation had not
   * already confirmed as focused can be that, because a window that was already
   * focused needs no activation. The flow's last scope is not this proof: while
   * the recording is paused the focus moves on without a line, and the flow
   * keeps standing where it was.
   */
  activation: boolean;
  button: 'left' | 'right';
  where: string;
  point: Point;
  binding: WindowBinding;
};

function nearPoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) <= multiClickDistance && Math.abs(a[1] - b[1]) <= multiClickDistance;
}

/** Every screen point an event names; a cached tree must still cover all of them. */
function eventPoints(event: CaptureEvent): Point[] {
  if (event.kind === 'click' || event.kind === 'scroll' || event.kind === 'hover') return [event.point];
  if (event.kind === 'drag') return [event.from, event.to];
  return [];
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

/**
 * The snapshot's spelling of an AX role, so a recorded target can resolve.
 * The desktop driver has a single editable role: its own filters fold
 * textarea, textbox and searchfield into `textfield`, and real snapshots never
 * contain those names. Keeping the AX spelling would record a target that
 * replay could never find.
 */
function bareRole(role: string) {
  const bare = role.replace(/^AX/, '').toLowerCase();
  return bare === 'textarea' || bare === 'textbox' || bare === 'searchfield' ? 'textfield' : bare;
}

/** The focused element's screen frame, in the snapshot's shape. */
function focusBounds(focus: CaptureFocus | undefined) {
  if (!focus?.bounds) return undefined;
  const [x, y, width, height] = focus.bounds;
  return { x, y, width, height };
}

/** Roles whose whole action is a press, with no text or state of their own. */
const pressRoles = new Set(['button', 'link', 'menuitem']);

/** Roles that describe where a click happened, never a control. */
const scopeRoles = new Set(['window', 'application', 'webarea']);

function pressable(node: Node) {
  return (node.actions ?? []).some(action => /^(click|press)$/i.test(action));
}

function parentOf(tree: Node, target: Node): Node | undefined {
  for (const child of tree.children) {
    if (child === target) return tree;
    const found = parentOf(child, target);
    if (found) return found;
  }
  return undefined;
}

/**
 * One pass over a tree: every node with its path, its parent, and the located
 * form a locator is built from. The fallback target rules climb and descend the
 * same tree several times, and re-walking it for each neighbour would turn one
 * click on a large Electron page into a quadratic search.
 */
function indexTree(tree: Node) {
  const byNode = new Map<Node, Located>();
  const parents = new Map<Node, Node>();
  const visit = (node: Node, path: string[]) => {
    const entry: Located = { node, path: [...path, node.role] };
    byNode.set(node, entry);
    for (const child of node.children) {
      parents.set(child, node);
      visit(child, entry.path);
    }
  };
  visit(tree, []);
  return {
    parentOf: (node: Node): Node | undefined => parents.get(node),
    located: (node: Node): Located | undefined => byNode.get(node),
  };
}

/** The text a node shows as its own label, when the driver put it in the value. */
function area(bounds?: Node['bounds']): number {
  if (!bounds) return 0;
  return Math.max(bounds.width, 0) * Math.max(bounds.height, 0);
}

/** Where a tree's root sat, for a report a person can act on. */
function boundsLabel(bounds: Node['bounds']): string {
  if (!bounds) return 'none';
  return `${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)}`;
}

/** The shape of a screen: what is on it, not where it sits. */
function signature(node: Node): string {
  const name = node.name ?? '';
  if (!node.children.length) return `${node.role}:${name}`;
  return `${node.role}:${name}(${node.children.map(signature).join(',')})`;
}

function labelText(node: Node): string | undefined {
  if (node.role !== 'textfield' && node.role !== 'statictext' && node.role !== 'text') return undefined;
  const text = (node.value ?? node.text ?? '').trim();
  return text || undefined;
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

/** The window title a tree was read under: a window snapshot's root names it. */
function windowTitleOf(snapshot: Snapshot): string | undefined {
  const name = (snapshot.tree.name ?? '').trim();
  return name || undefined;
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
/** How long a Dock click may wait for the focus that names the app it started. */
const DOCK_FOCUS_WAIT_MS = 1500;

/**
 * Appends one text event to a value without ever crossing the sidecar limit.
 * The cut is reported, never silent: a truncated value is marked incomplete so
 * the replay dialog asks the operator to check it.
 */
function appendWithinLimit(current: string, chars: string) {
  const room = inputValuesLimits.maxValueLength - current.length;
  if (chars.length > room) {
    return { text: current + chars.slice(0, Math.max(0, room)), truncated: true };
  }
  return { text: current + chars, truncated: false };
}

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
  /** Bumped whenever a secure interval opens: reads queued before it are void. */
  private secureEpoch = 0;
  private systemDialogVisible = false;
  private securityAgentWarned = false;
  /**
   * The text of every `type` step, keyed by parameter name. It never enters the
   * flow: `finish()` returns it separately so the CLI can write the sidecar. A
   * secure interval produces no `type` step, so no entry is ever created for it.
   */
  private readonly inputValues = new Map<string, {
    value: string; complete: boolean; issues: Set<InputValueIssue>;
    steps: string[]; targets: { role: string; name?: string }[];
  }>();
  private textBurst?: {
    at: number; scope: string; locator: string; target: ElementLocator; snapshot?: Snapshot;
    /** The parameter this burst writes, so its characters accumulate there. */
    name: string;
    /** Window and focus generation the burst belongs to, for drop attribution. */
    key: string;
  };
  private scrollBurst?: {
    at: number; startedAt: number; scope: string; locator: string;
    deltaX: number; deltaY: number; index: number;
  };
  private lastClick?: {
    at: number; point: Point; index: number; scope: string; locator: string; button: 'left' | 'right';
  };
  /** Warning codes for a step that is still a screen point, keyed by step index. */
  private pointClickWarning = new Map<number, Set<string>>();
  /** Codes set by the point-producing helpers; consumed when their step is pushed. */
  private pendingPointWarning = new Set<string>();
  private textAnchor?: { at: number; scope: string; locator: ElementLocator };
  /**
   * Focused-element evidence the helper already carried, per window and focus
   * generation. It lets the next text event reuse the proof without any read.
   */
  private focusTargets = new Map<string, ElementLocator>();
  /**
   * The last window this recording could prove, and where. A character event
   * whose own evidence lost its window number (one failed focus probe over the
   * same app process) keeps this window instead of becoming a gap per character.
   */
  private lastWindow?: { binding: WindowBinding; generation: number };
  /**
   * Text waiting for one fallback tree read. It is buffered, never awaited by
   * the text path: the read resolves in the background and the buffered burst
   * becomes one `type` step when it does. A non-text event settles it first so
   * step order still follows event order.
   */
  private pendingText?: {
    key: string; scope: WindowScope; scopeId: string; at: number;
    /** Buffered characters travel with the burst; a fallback read must not lose them. */
    chars: string; complete: boolean; issues: Set<InputValueIssue>;
    /**
     * Backlog drops seen while this burst waits for its tree read. Whether
     * they belong to it is only known once the read names its control, so they
     * are kept with the control evidence instead of being applied blindly.
     */
    drops: { locator?: string }[];
  };
  private pendingSettle?: Promise<void>;
  /**
   * A text event the backlog dropped. The burst it belonged to may not exist
   * yet (its first character is exactly the one that was lost), so the marker
   * is applied to the next burst in the same window and focus, within one
   * merge window. Without it a value missing its first characters would still
   * read as complete.
   */
  private droppedText?: { scopeId: string; key: string; at: number; locator?: string };
  /**
   * A Dock click names no window of its own, so the app it activates only
   * becomes provable when the focus notification arrives. Until then the click
   * is held, and hover noise from the pointer travelling to the new window is
   * held with it. When no app changed focus the click activated nothing — the
   * app it pointed at was already frontmost — so it is dropped with a warning
   * instead of blocking the flow with a step no replay could perform.
   */
  private pendingDockGap?: { at: number };
  /**
   * A click on a window that is not focused yet is the first-mouse press macOS
   * swallows to bring the window forward. Its target cannot be proven until the
   * focus notification that follows says the click only activated the window;
   * any other event means it did something, so it is recorded where it landed.
   */
  /** The tree read each window has under way, so a click can wait for it. */
  private readonly settling = new Map<string, Promise<undefined>>();
  /** Finder windows whose pre-click read is queued or running. */
  private readonly prewarming = new Set<string>();

  private pendingGapClick?: HeldClick;
  /** The event being consumed, kept so a gap can name the handler that raised it. */
  private consuming?: CaptureEvent;
  /** The handler the consuming event is going through; gap diagnostics only. */
  private gapHandler = 'unknown';
  /** Lines of the report that name what raised each scope gap. */
  private readonly gapOrigins: string[] = [];
  private gapOriginsOmitted = 0;
  private startupOpen = true;
  private startupDropped = 0;
  private notes = new Map<string, string>();
  private lifecycleEvents: LifecycleEvent[] = [];
  private exclude: Set<string>;
  private now: () => number;
  private stepLimit: number;
  private snapshotTtlMs: number;
  private maxCachedWindows: number;
  private snapshotBudgetMs: number;
  private scheduleSettle: (task: () => Promise<void>) => void;
  private ended = false;
  /** Window ids in least-recently-used order, so the cache stays bounded. */
  private cacheOrder: string[] = [];
  private snapshotReads = 0;
  private truncated = false;
  /** The event being consumed; every step it produces is stamped with its time. */
  private eventAt = 0;
  /** The wall clock of the event being consumed. */
  private eventSeen = 0;
  /** The first retained step's event time; step times are relative to it. */
  private firstStepAt?: number;
  /** The wall clock of the first retained step: the flow's `startedAt`. */
  private firstStepWall?: number;
  /** The last step time written, so the timeline never reads backwards. */
  private lastStepAt = 0;
  /** Paused time the helper reported when the session ended. */
  private pausedMs = 0;

  constructor(private read: WindowReader, options: GlobalRecordingOptions = {}) {
    this.exclude = new Set(options.exclude ?? []);
    this.now = options.now ?? Date.now;
    this.stepLimit = options.stepLimit ?? defaultStepLimit;
    this.snapshotTtlMs = options.snapshotTtlMs ?? defaultSnapshotTtlMs;
    this.maxCachedWindows = options.maxCachedWindows ?? defaultCachedWindows;
    this.snapshotBudgetMs = options.snapshotBudgetMs ?? defaultSnapshotBudgetMs;
    this.scheduleSettle = options.scheduleSettle ?? ((task) => {
      const timer = setTimeout(() => { void task(); }, settledTreeDelayMs);
      timer.unref?.();
    });
  }

  get captureWarnings(): CaptureWarning[] {
    return [...this.notes].map(([code, message]) => ({ code, message }));
  }

  /**
   * Warnings that still describe a step kept at its screen point. A point that
   * a later press or text event upgraded to an element no longer counts.
   */
  get clickWarnings(): string[] {
    return [...new Set([...this.pointClickWarning.values()].flatMap(codes => [...codes]))];
  }

  get stepCount() {
    return this.steps.length;
  }

  /**
   * How many window trees this recording actually read. Reused trees are not
   * counted, so this number is the recording's accessibility cost and the
   * evidence that a window was read once.
   */
  get snapshotReadCount() {
    return this.snapshotReads;
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

  /**
   * Paused time the helper measured for this session. Step times already
   * exclude it; recording it on the flow lets the workbench say so.
   */
  notePausedMs(ms: number) {
    if (Number.isSafeInteger(ms) && ms >= 0) this.pausedMs = ms;
  }

  /** Ends text and scroll merging, for pauses and helper boundaries. */
  endBursts() {
    this.textBurst = undefined;
    this.scrollBurst = undefined;
  }

  /**
   * Input left the recorded scope: the system app switcher, a key or scroll
   * outside the window, the overlay, or a pause boundary. A held press can no
   * longer be proven to be the press that brought its window forward, and a
   * focus on that window after the boundary must not erase it, so the press is
   * recorded where it landed before the flow moves on.
   */
  noteBoundary() {
    this.endBursts();
    this.droppedText = undefined;
    if (this.pendingGapClick) this.flushPendingGap();
  }

  /**
   * Consumes one validated capture event. A text burst is merged by scope and
   * control, never across windows; a continuous secure interval becomes one
   * manual checkpoint and every piece of content inside it is discarded.
   */
  async add(event: CaptureEvent): Promise<void> {
    this.eventAt = event.t;
    this.eventSeen = event.seen;
    this.consuming = event;
    this.gapHandler = event.kind;
    // A held first-mouse press waits for the proof of what it did: a focus over
    // its own window proves the press only brought that window forward, and an
    // event that delivers input settles it where it landed. A hover delivers no
    // input and cannot prove either, so it leaves the press untouched (onHover).
    if (this.pendingGapClick && event.kind !== 'focus' && event.kind !== 'hover') {
      this.flushPendingGap();
    }
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

    if (this.pendingDockGap) {
      const focusNamesTheApp = event.kind === 'focus' &&
        event.focusGeneration >= this.lastGeneration && this.bindingFor(event) !== undefined;
      const movingToTheApp = event.kind === 'hover' &&
        event.t - this.pendingDockGap.at <= DOCK_FOCUS_WAIT_MS;
      if (focusNamesTheApp) {
        // onFocus below turns the held click into the navigation step.
        this.pendingDockGap = undefined;
      } else if (movingToTheApp) {
        return;
      } else {
        this.pendingDockGap = undefined;
        this.endBursts();
        this.warn('DOCK_CLICK_UNPROVEN',
          'A Dock click was not recorded because no application changed focus; the app it pointed at was already frontmost, so the click activated nothing');
      }
    }

    if (this.startupOpen && event.t > startupGraceMs) this.startupOpen = false;
    // Before the front window is provable, an event with no window at all is
    // startup noise (a click that dismissed a dialog, a queued gap); it must not
    // become the first thing the flow reports. A scope gap is dropped later
    // regardless of its time, because it names no window either.
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
      this.noteGapReason(event);
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
    // The focus a Dock click was waiting for has arrived; the scope step below
    // (or the first-window branch) replaces the held gap.
    this.pendingDockGap = undefined;
    const pending = this.pendingGapClick;
    if (pending) {
      if (pending.key !== binding.key) {
        // The focus left the window the press belongs to, so the press cannot be
        // the press that brought it forward. It is recorded now, before this
        // navigation, so the timeline keeps the order the user worked in.
        this.flushPendingGap();
      } else if (this.provesHeldActivation(pending, event)) {
        // This focus is the one the press caused: macOS swallowed the press to
        // bring the window forward, so it is not a step.
        this.dropHeldClick();
      } else {
        // A focus on the press's own window that the press did not cause (the
        // user left and came back, possibly across a capture boundary). It
        // proves nothing about the press, which is kept where it landed.
        this.flushPendingGap();
      }
    }
    if (!this.current) {
      this.current = { app: binding.app, key: binding.key };
      this.prewarmFileWindow(binding);
      return;
    }
    if (this.current.key !== binding.key) this.ensureScope(binding);
    this.prewarmFileWindow(binding);
  }

  /**
   * Reads a Finder window before the next click in it.
   *
   * A click on a Finder file or folder navigates the window: by the time the
   * click's own tree read runs, the window holds the folder it opened and the
   * item that was clicked is gone, so the click can only be a screen point. A
   * tree read as soon as the window becomes current describes the screen the
   * click will be made against, and `preClickTree` names the item from it.
   *
   * The read is bounded, off the event stream and only spent when the window
   * has no tree yet: a click that lands first keeps its own evidence, and a
   * failed read costs nothing. Only Finder is prewarmed — its trees are small
   * and its clicks are the ones that replace the window under the pointer;
   * every other app still reads on demand.
   */
  private prewarmFileWindow(binding: WindowBinding) {
    if (binding.app !== finderBundleId || this.ended || this.secureOpen) return;
    const id = this.bindingId(binding);
    if (this.prewarming.has(id)) return;
    if (this.reusableTree(binding)) return;
    const epoch = this.secureEpoch;
    this.prewarming.add(id);
    const task = async () => {
      try {
        if (this.ended || epoch !== this.secureEpoch || this.secureOpen) return;
        if (this.reusableTree(binding)) return;
        this.snapshotReads += 1;
        const snapshot = await this.read(this.windowFor(binding), this.snapshotBudgetMs);
        // A read that finished across a secure boundary describes the prompt,
        // not this window.
        if (this.ended || epoch !== this.secureEpoch) return;
        this.cacheTree(binding, snapshot);
      } catch {
        // A prewarm is opportunistic; the click keeps its own evidence.
      } finally {
        this.prewarming.delete(id);
      }
    };
    this.scheduleSettle(task);
  }

  private async onClick(event: Extract<CaptureEvent, { kind: 'click' }>) {
    // A Dock click carries no window of its own: the app it activates is only
    // provable from the focus notification that follows. Hold it instead of
    // recording a gap or inventing a Dock window binding.
    if (event.owner?.app === 'com.apple.dock' && event.decision === 'gap') {
      this.pendingDockGap = { at: event.t };
      return;
    }
    const owner = event.owner;
    const prior = owner?.pid !== undefined && owner.windowNumber !== undefined
      ? this.bindings.get(`${owner.pid}:${owner.processInstance ?? 0}:${owner.windowNumber}`)
      : undefined;
    const priorTitle = prior?.title;
    const binding = this.bindingFor(event);
    if (!binding) {
      // A click that names no window has no window to be replayed in, so a gap
      // here would block a flow whose other steps are all addressable. Before
      // the first step it is startup noise; after it, it is the desktop or a
      // transient surface, and the recording continues without it.
      if (!this.steps.length) {
        this.startupDropped += 1;
        return;
      }
      const outside = !event.owner?.app
        ? 'it named no app'
        : event.owner.windowNumber === undefined
          ? 'it named no window'
          : 'the recording already tracks as many windows as it can';
      this.warn('CLICK_OUTSIDE_WINDOW',
        `A click was not recorded because ${outside}; a click with no window cannot be replayed`);
      return;
    }
    if (event.decision === 'gap') {
      // The click landed in a known window but its target could not be proven,
      // which is what a first-mouse press on an unfocused window looks like.
      // Hold the press until the focus that names this window proves the press
      // only brought it forward; input settles it where it landed (see add).
      this.endBursts();
      const where = [event.owner?.app, event.owner?.role, nativeLabel(event.owner?.name)].filter(Boolean).join(' ');
      this.pendingGapClick = {
        key: binding.key,
        at: event.t,
        seen: event.seen,
        generation: event.focusGeneration,
        // A window this generation already confirmed as focused needs no
        // activation, so this press cannot have been the swallowed press that
        // brought it forward. A generation with no confirmed window (the focus
        // moved while paused and was never reported) leaves that open.
        activation: this.generationWindow.get(event.focusGeneration) !== this.bindingId(binding),
        button: event.button ?? 'left',
        where: where || 'an unnamed control',
        point: event.point,
        binding,
      };
      return;
    }
    // A click on a window that is not the flow's current window either only
    // activated it or delivered a first mouse-down. The activation is what it
    // proves, so it is recorded as navigation; a named control inside web
    // content can be the second kind, and that click is kept after the window
    // is brought forward.
    if (event.decision === 'navigate') {
      this.ensureScope(binding);
      if (!(await this.actsOnWebContent(binding, event))) return;
      this.warn('CLICK_ACTIVATED_WINDOW',
        'The click activated its window and also landed on a named control in it; the step brings the window forward, then clicks the control');
    }
    // A click that did not name the flow's current window is a gap unless its
    // own evidence proves it was delivered to a window that was already
    // frontmost. That proof is what separates it from a first mouse-down on a
    // background window: the press reached the control, so it is navigation
    // first and then the click, never a lost step (see clickProvesOwnWindow).
    const recovering = this.current !== undefined && this.current.key !== binding.key;
    if (recovering && !this.clickProvesOwnWindow(binding, event)) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    // A recovery spends two slots: the navigation and the click. Reserving only
    // one would push the navigation and drop the click, leaving a flow that
    // looks complete but silently lost the press.
    if (recovering && this.steps.length + 2 > this.stepLimit) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
      return;
    }
    if (!this.claim(event, binding)) return;
    this.ensureScope(binding);
    // A recovered click that still cannot become a step leaves the gap behind
    // the navigation: navigation alone would hide the press it was holding.
    if (!(await this.recordClick(binding, event, {
      requireElement: recovering,
      priorTitle: priorTitle ?? binding.title,
    })) && recovering) {
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED');
    }
  }

  /**
   * Whether a click whose window is not the flow's current scope still proves
   * it landed in a frontmost window, so it can be kept after a navigation
   * instead of becoming a capture gap.
   *
   * The helper sets `decision: record` only when the pointer's window is the
   * focused window (`GlobalPointerEvidence.fields`), i.e. the press was
   * delivered rather than swallowed by activation. The binding must come from
   * the event's own app/pid/window number — the inheritance branch names no
   * window and can never stand for this proof — and the process instance and
   * focus generation must still be current. A menu item also reports
   * `record`, but its window is the app window that opened the menu, so it is
   * excluded here.
   */
  private clickProvesOwnWindow(
    binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>,
  ): boolean {
    if (event.decision !== 'record') return false;
    if (event.focus?.secure) return false;
    // Replay of a right click may address the control the previous left click
    // selected (`lastClickTarget`); a recovered right click in a new window
    // would then press a different control than the one recorded. Keep it a gap.
    if (event.button === 'right') return false;
    const owner = event.owner;
    if (!owner?.app || !owner.pid || owner.windowNumber === undefined) return false;
    const instance = owner.processInstance ?? 0;
    if (this.bindings.get(`${owner.pid}:${instance}:${owner.windowNumber}`) !== binding) return false;
    if (binding.app !== owner.app || binding.pid !== owner.pid) return false;
    if ((binding.processInstance ?? 0) !== instance) return false;
    // A late generation has already been moved past; it must not navigate back.
    if (event.focusGeneration < this.lastGeneration) return false;
    const role = bareRole(nativeLabel(owner.role) ?? '');
    if (role === 'menuitem' || role === 'menubaritem' || role === 'menu' || role === 'menubar') return false;
    return true;
  }

  /**
   * Records one click in a window the recording has already made current.
   * Returns whether a click step was kept; a secure interval, a step the limit
   * dropped, or a point both trees missed records nothing and says so.
   *
   * `requireElement` is the recovery gate: a click that can only be placed at
   * its screen point is not worth clearing a blocking gap for, because replay
   * would click a bare coordinate.
   */
  private async recordClick(
    binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>,
    { requireElement = false, priorTitle }: { requireElement?: boolean; priorTitle?: string } = {},
  ): Promise<boolean> {
    let scope = this.windowScope(binding);
    const scopeId = scopeKey(scope);
    const finder = binding.app === finderBundleId;
    this.pendingPointWarning = new Set();
    const button = event.button ?? 'left';
    const count = Math.max(1, Math.min(3, event.count ?? 1));
    // A click moves the caret and can select another control: any burst that
    // was still open described the state before this click.
    this.endBursts();
    if (event.focus?.secure) {
      this.enterSecure();
      return false;
    }
    const hitRole = nativeLabel(event.owner?.role);
    const hitName = nativeLabel(event.owner?.name);
    const field = focusedTarget(event.focus);
    if (field) this.rememberFocus(this.focusKey(binding, event.focusGeneration), field);
    const fieldHit = !!field && !editableRole(hitRole) && contains(focusBounds(event.focus), event.point);
    // A named hit is already addressable, so it needs no tree read at all. An
    // unnamed one is only a container to the helper — Chromium/Electron apps
    // answer AXUIElementCopyElementAtPosition with an anonymous group above the
    // real control, and Finder names the file rather than the text field under
    // the pointer — so those clicks read the window tree to find the element a
    // replay can address. A click inside the focused editable control keeps the
    // field the helper proved, which needs no read either.
    const needsTree = !hitRole || (!hitName && !fieldHit);
    let target: ClickTarget | undefined;
    let currentTree: Snapshot | undefined;
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
        // The helper named only a container and a role alone cannot be resolved
        // again, so the click keeps its point; the text event that follows
        // replaces it with the editable control it proves.
        target = this.untargetedClick(binding, event, undefined);
      }
      // A window tree already read for this window may add the path or index a
      // repeated control needs; it is never read for this.
      if (target.kind === 'element') {
        target = this.completeFromCache(binding, event, target) ?? target;
      }
    }
    if (!target) {
      // A page switch draws long before its accessibility tree is built, and a
      // click can arrive while the read taken after the previous click is still
      // descends that new page. That read describes the screen this click was
      // made against, so finishing it first is what keeps a click in a freshly
      // drawn page named instead of reduced to a bare point.
      await this.settledBefore(binding);
      // The tree read before the click is kept here, before the click's own read
      // can retire the window cache: a Finder click retitles its window, and the
      // cached tree is the only screen that still holds the item that was
      // clicked.
      const before = this.settledLookup(binding, event);
      // Evidence that cannot name the element is the only case that still needs
      // the tree: a failed read keeps whatever the helper proved on its own.
      const read = await this.snapshot(binding, {
        gapOnFailure: false, event,
        validate: tree => this.contentHit(tree, event.point) !== undefined,
      });
      const snapshot = read?.snapshot;
      if (snapshot) {
        currentTree = snapshot;
        const hit = this.contentHit(snapshot, event.point);
        // A Finder click on a file or folder opens it. When the tree read after
        // the click is already the directory it opened, everything in it belongs
        // to a screen the user never clicked: the same point can sit on another
        // file, so naming from it records a target the user never chose.
        // A Finder navigation key already replaced the screen before this
        // click, so the bound title is no longer the screen clicked; only a
        // title change caused by this click itself makes the tree unusable.
        const keyNavigation = finder && binding.navigatedAt !== undefined;
        const navigated = finder && this.describesOtherWindow(binding, event, snapshot, {
          recordedTitle: !keyNavigation,
          recordedTitleValue: priorTitle,
        });
        if (hit?.node.secure) {
          this.enterSecure();
          return false;
        }
        if (finder && before.target) {
          // Target and scope come from one screen: the tree read before the
          // click. Its title is the window the click was made in, whatever the
          // helper read after the navigation.
          target = before.target;
          const title = before.title && displayTitle(before.title);
          if (title && title !== scope.windowTitle) {
            scope = { ...scope, windowTitle: title };
          }
        } else if (navigated) {
          target = this.navigatedFileClick(binding, event, snapshot);
        } else if (!hit) {
          // Blank space: the window root answers every point inside the window,
          // and a click on it names nothing a replay could address.
          target = this.blankClick(binding, event, snapshot);
        } else {
          // Electron editors expose their text surface as a group above the
          // editable control. When the click lands inside the focused editable
          // but the deepest hit is a container, the control is the replay target.
          const treeField = editableRole(hit.node.role) ? undefined : this.focusedField(snapshot, event.point);
          if (treeField?.node.secure) {
            this.enterSecure();
            return false;
          }
          const identity = treeField ? undefined : clickIdentity(snapshot.tree, hit);
          const chosen = identity ?? treeField;
          if (treeField) {
            this.warn('FOCUSED_EDITABLE_TARGET',
              'A click landed inside the focused editable control and was bound to it, not to the container under the pointer');
          }
          if (chosen) {
            target = toLocator(snapshot, chosen);
            if (read?.reused) this.dropTreeIfFocusMoved(binding, snapshot, target as ElementLocator);
            if (button === 'left' && chosen.node.ref && editableRole(target.role)) {
              this.rememberFocus(this.focusKey(binding, event.focusGeneration), target);
            }
          } else {
            // The tree cannot name what the pointer hit. The helper's own
            // element evidence is the remaining proof of identity; without it
            // the click keeps its point and says so — unless it landed on blank
            // space, where there is nothing a point could replay.
            const named = (finder ? undefined : before.target) ?? this.labelTarget(binding, snapshot, hit) ??
              this.evidenceTarget(event) ?? this.identifiedTarget(snapshot, hit, { container: true }) ??
              this.pressableAncestorTarget(snapshot, hit);
            if (named) {
              target = named;
            } else {
              // Ambiguity ends the search: a labelled ancestor is a bigger
              // control that may or may not be the one meant, and the whole
              // point of the warning is that the recording refuses to guess.
              const nearby = this.nearbyControlTarget(snapshot, hit, event.point);
              target = nearby === 'ambiguous' ? this.untargetedClick(binding, event, snapshot)
                : nearby ?? this.ancestorLabel(snapshot, hit) ?? this.untargetedClick(binding, event, snapshot);
            }
          }
          if (target?.kind === 'element') this.noteUnpressable(snapshot, target);
        }
      } else {
        // The helper could not read the tree for this click. When it also saw
        // no element role, one read here can still name the element and record
        // the path/index that tells two same-named controls apart.
        if (finder && before.target) {
          // Same rule as above: the screen the click was made on names it, and
          // its title is the window the step belongs to.
          target = before.target;
          const title = before.title && displayTitle(before.title);
          if (title && title !== scope.windowTitle) {
            scope = { ...scope, windowTitle: title };
          }
        } else if (!nativeLabel(event.owner?.role)) {
          const captured = await this.snapshot(binding, { gapOnFailure: false });
          currentTree = captured?.snapshot;
          const hit = captured ? this.hit(captured.snapshot, event.point) : undefined;
          // The second read has to honour the same secure rule as the first;
          // naming a protected control from here would replay a click on it.
          if (hit?.node.secure) {
            this.enterSecure();
            return false;
          }
          if (captured && finder && this.describesOtherWindow(binding, event, captured.snapshot, {
            recordedTitle: binding.navigatedAt === undefined,
            recordedTitleValue: priorTitle,
          })) {
            target = this.navigatedFileClick(binding, event, captured.snapshot);
          } else {
            target = hit && hit.node.ref ? toLocator(captured!.snapshot, hit) : this.nativeTarget(binding, event);
          }
        } else {
          target = this.nativeTarget(binding, event);
        }
      }
    }
    // The navigation key has now been consumed by the first click on its new
    // screen; later clicks use the settle read this one schedules. The step
    // belongs to the directory Finder shows after the key.
    if (finder) {
      if (binding.navigatedAt !== undefined && currentTree) {
        const observed = windowTitleOf(currentTree);
        if (observed && !this.describesOtherWindow(binding, event, currentTree, { recordedTitle: false })) {
          scope = { ...scope, windowTitle: displayTitle(observed) };
        }
      }
      binding.navigatedAt = undefined;
    }
    // A click can open a sheet or switch the page before its own tree read ran;
    // reading the window once the change has drawn keeps the screen this click
    // was made against for the next one.
    this.startSettledTree(binding);
    if (!target) return false;
    if (requireElement && !this.addressableForRecovery(target)) {
      this.warn('CLICK_RECOVERY_UNNAMED',
        'A click was proven in another window but did not resolve to one addressable control (a bare point, a window/page root, or a control with no name or identifier); the capture gap stays');
      return false;
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
        // A first press that could only be placed, not named, is upgraded by the
        // second press of the same gesture: the double click keeps its control.
        if (step.target.kind === 'point' && target.kind === 'element') {
          (step as { target: ClickTarget }).target = target;
          this.pointClickWarning.delete(previous.index);
        }
        previous.at = event.t;
        previous.point = event.point;
        return true;
      }
    }
    const before = this.steps.length;
    this.push({
      kind: 'click', scope, target,
      ...(count > 1 ? { count } : {}),
      ...(button === 'right' ? { button } : {}),
    });
    // The step limit drops a click without throwing; reporting success here
    // would let the caller believe the press survived.
    if (this.steps.length === before) return false;
    if (target.kind === 'point' && this.pendingPointWarning.size) {
      this.pointClickWarning.set(this.steps.length - 1, new Set(this.pendingPointWarning));
    }
    this.pendingPointWarning = new Set();
    if (this.steps.length && this.steps[this.steps.length - 1].kind === 'click') {
      this.lastClick = {
        at: event.t, point: event.point, index: this.steps.length - 1,
        scope: scopeKey(scope), locator: locatorKey(target), button,
      };
    }
    return true;
  }

  /**
   * Whether a recovered click resolved to one replayable control. A bare point,
   * a window/application/page root, or a control with neither a name nor an
   * accessibility identifier cannot address a single element, so it must not
   * clear a blocking gap. An identifier alone is enough.
   */
  private addressableForRecovery(target: ClickTarget): boolean {
    if (target.kind !== 'element') return false;
    if (scopeRoles.has(target.role)) return false;
    if ((target.name ?? '').trim()) return true;
    return (target.identifier ?? '').trim().length > 0;
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
   * element evidence is the strongest remaining proof; then the tree from
   * before the click; without either the click keeps its point, marked by a
   * warning the workbench shows.
   */
  private nativeTarget(binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>): ClickTarget {
    const target = this.evidenceTarget(event);
    if (target) return target;
    const role = nativeLabel(event.owner?.role);
    if (role) return this.untargetedClick(binding, event, undefined);
    const settled = this.settledTarget(binding, event);
    if (settled) return settled;
    this.warn('NATIVE_POINT_FALLBACK',
      'A click was kept at its screen point because the helper had no element evidence and reading its window tree failed; edit it into an element before replay');
    return this.pointTarget('NATIVE_POINT_FALLBACK', event.point);
  }

  /**
   * A click on blank space. The window root answers every point inside the
   * window but names nothing a replay could click, so the click falls back to
   * the tree from before it if that one names an element. A click that both
   * trees leave empty is not recorded — nothing a replay could click was there;
   * when only one tree is empty the click keeps its point rather than losing a
   * step the user actually performed.
   */
  private blankClick(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    snapshot: Snapshot,
  ): ClickTarget | undefined {
    const settled = this.settledLookup(binding, event);
    if (settled.target) return settled.target;
    // Both trees missed the point, so the next report has to say which trees
    // were compared and where their roots sat; without that a point step is a
    // dead end no one can act on.
    const geometry = `point ${event.point[0]},${event.point[1]}; this read's root ${boundsLabel(snapshot.tree.bounds)}`;
    if (settled.nothing) {
      this.warn('UNTARGETED_ELEMENT_CLICK',
        `A click landed on empty space and named no element (${settled.miss}; ${geometry}); nothing was under the point in either tree, so it was not recorded`);
      return undefined;
    }
    this.warn('UNTARGETED_ELEMENT_CLICK',
      `A click landed on empty space and named no element (${settled.miss}; ${geometry}); it is kept at its screen point and must be edited into an element before replay`);
    return this.pointTarget('UNTARGETED_ELEMENT_CLICK', event.point);
  }

  /**
   * A control that carries an accessibility identifier but no name — Chromium's
   * AXDOMIdentifier, Cocoa's AXIdentifier. The identifier is a better target than
   * a nearby label: it addresses this exact element and survives a renamed one.
   */
  private identifiedTarget(snapshot: Snapshot, hit: Located, { container = false } = {}): ClickTarget | undefined {
    if (!hit.node.identifier) return undefined;
    if (hit.node.secure) return undefined;
    // An identifier on a page container addresses the container, not what the
    // pointer hit; only a control, a leaf, or — for a click the helper proved
    // reached this window — a container the size of a control can stand for it.
    if (scopeRoles.has(hit.node.role)) return undefined;
    if (hit.node.children.length && !pressable(hit.node) &&
        (!container || area(hit.node.bounds) > area(snapshot.tree.bounds) * 0.25)) return undefined;
    this.warn('CLICK_NAMED_BY_IDENTIFIER',
      'The control clicked exposes no accessible name; the step addresses it by its accessibility identifier');
    return toLocator(snapshot, hit) as ClickTarget;
  }

  /**
   * The nearest ancestor that both carries an identity (a name or an
   * accessibility identifier) and accepts a press. An Electron page can wrap
   * the real control in several anonymous groups, so the pointer hits a
   * container while the pressable control sits above it — the aTrust
   * "切换接入地址" row is one. A window, a page or a control sized like part of
   * the layout is never the thing the click meant.
   */
  private pressableAncestorTarget(snapshot: Snapshot, hit: Located): ClickTarget | undefined {
    const tree = snapshot.tree;
    const names = elementNames(tree);
    const index = indexTree(tree);
    let current: Node = hit.node;
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = index.parentOf(current);
      if (!parent || scopeRoles.has(parent.role)) return undefined;
      if (parent.secure || editableRole(parent.role)) return undefined;
      const named = (names.get(parent) ?? '').trim();
      const identified = (parent.identifier ?? '').trim();
      const layout = area(parent.bounds) > area(tree.bounds) * 0.25;
      if ((named || identified) && pressable(parent) && !layout) {
        const located = index.located(parent);
        if (!located) return undefined;
        this.warn('CLICK_NAMED_BY_PRESSABLE_ANCESTOR',
          'The control clicked exposes no identity of its own; the step presses the clickable control it belongs to');
        return toLocator(snapshot, located) as ClickTarget;
      }
      current = parent;
    }
    return undefined;
  }

  /**
   * The one control under an anonymous hit that the click meant: the deepest
   * named or identified node whose own bounds cover the point, or a sibling
   * that covers it when the wrapper is split into an unnamed hit area and its
   * label.
   *
   * Only a unique candidate is used. Proximity alone is not proof: a control
   * that merely sits within one control's width of the point did not receive
   * the click, and replaying it would press a place the user never clicked.
   * Two named controls under the same point also keep the point, with a warning.
   */
  private nearbyControlTarget(snapshot: Snapshot, hit: Located, point: Point): ClickTarget | 'ambiguous' | undefined {
    const tree = snapshot.tree;
    const names = elementNames(tree);
    const index = indexTree(tree);
    const windowArea = area(tree.bounds);
    // Only a control the driver can act on can stand for the click. A plain
    // label next to the point is a description of some other control, and
    // aiming the replay at its centre would press the wrong place entirely.
    const addressable = (node: Node) => {
      if (node.secure || scopeRoles.has(node.role) || editableRole(node.role)) return false;
      if (area(node.bounds) > windowArea * 0.25) return false;
      if (!node.ref && !pressable(node)) return false;
      return Boolean((names.get(node) ?? '').trim() || (node.identifier ?? '').trim());
    };
    // The landing point must be inside the candidate itself; a label merely
    // near the click is not evidence that its control received the press.
    const covering = (node: Node) => !!node.bounds && contains(node.bounds, point);
    // Nearness is not proof, but it is a reason not to let a bigger labelled
    // ancestor absorb the click: the operator must edit the point by hand.
    const near = (node: Node) => {
      const bounds = node.bounds;
      if (!bounds) return false;
      const dx = Math.max(bounds.x - point[0], 0, point[0] - (bounds.x + bounds.width));
      const dy = Math.max(bounds.y - point[1], 0, point[1] - (bounds.y + bounds.height));
      return dx <= nearbyPointTolerance && dy <= nearbyPointTolerance;
    };
    const innermost = (candidates: Node[]): Node[] => {
      // A named wrapper and one of its named children are one candidate: the
      // control is the deeper one, so a wrapper never hides what it contains.
      return candidates.filter(node => !candidates.some(other => other !== node && flatten(node).some(entry => entry.node === other)));
    };
    const descendants: Node[] = [];
    const walk = (node: Node, depth: number) => {
      for (const child of node.children) {
        if (child.secure) continue;
        if (addressable(child) && (covering(child) || near(child))) descendants.push(child);
        if (depth < 8) walk(child, depth + 1);
      }
    };
    walk(hit.node, 0);
    const parent = index.parentOf(hit.node);
    const siblings = parent
      ? parent.children.filter(child => child !== hit.node && (covering(child) || near(child)) && addressable(child))
      : [];
    const candidates = innermost([...descendants, ...siblings]);
    const covered = candidates.filter(covering);
    if (covered.length === 1) {
      const located = index.located(covered[0]);
      if (!located) return undefined;
      this.warn('CLICK_NAMED_BY_NEARBY_CONTROL',
        'The control clicked exposes no identity of its own; the step uses the single named control that covers the point');
      return toLocator(snapshot, located) as ClickTarget;
    }
    if (candidates.length) {
      const labels = candidates.map(node => {
        const name = (names.get(node) ?? '').trim() || (node.identifier ?? '').trim();
        return `${node.role}${name ? ` "${name.slice(0, 24)}"` : ''}`;
      });
      const what = covered.length > 1
        ? `${covered.length} named controls cover the click`
        : `${candidates.length} named control${candidates.length === 1 ? '' : 's'} sit near the click but do not cover it`;
      this.warn('CLICK_AMBIGUOUS_CANDIDATES',
        `${what} (${labels.join(', ')}); which one it meant cannot be proven, so it keeps its screen point`);
      this.pendingPointWarning.add('CLICK_AMBIGUOUS_CANDIDATES');
      // The caller must not go on to a bigger labelled ancestor: the point was
      // ambiguous among the controls that actually sit under or near it.
      return 'ambiguous';
    }
    return undefined;
  }

  /**
   * The nearest named element above the hit. An Electron page draws icons and
   * sprites as anonymous image or text nodes inside a named group, and that
   * group is the control the user means by clicking the glyph — the aTrust
   * "切换接入地址" icon is one. A window or application title is a scope, never a
   * target, and a field must not be clicked on the strength of its label.
   */
  private ancestorLabel(snapshot: Snapshot, hit: Located): ClickTarget | undefined {
    const tree = snapshot.tree;
    // A control is a small region of its window: a named page or card that
    // happens to sit above the point is layout, not the thing being clicked.
    const windowArea = area(tree.bounds);
    let current = hit.node;
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = parentOf(tree, current);
      if (!parent || parent.role === 'window' || parent.role === 'application') return undefined;
      const name = (parent.name ?? '').trim();
      if (name) {
        if (editableRole(parent.role) || parent.secure) return undefined;
        const parentArea = area(parent.bounds);
        if (windowArea && parentArea && parentArea > windowArea * 0.25) return undefined;
        const located = flatten(tree).find(entry => entry.node === parent);
        if (!located) return undefined;
        this.warn('CLICK_NAMED_BY_CONTAINER_LABEL',
          'The control clicked exposes no accessible name of its own; the step clicks the labelled control it belongs to');
        return toLocator(snapshot, located) as ClickTarget;
      }
      current = parent;
    }
    return undefined;
  }

  /**
   * Whether a tree read after a Finder click shows a different window title
   * than the one the click reported. A Finder click opens the item it landed
   * on, so the read that follows can be the folder it opened: everything in
   * that tree belongs to a screen the user never clicked.
   */
  private describesOtherWindow(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    snapshot: Snapshot,
    { recordedTitle = true, recordedTitleValue = binding.title }: {
      recordedTitle?: boolean;
      recordedTitleValue?: string;
    } = {},
  ): boolean {
    const reported = (event.owner?.windowTitle ?? '').trim();
    const recorded = (recordedTitleValue ?? '').trim();
    const observed = windowTitleOf(snapshot);
    if (!observed || (!reported && !recorded)) return false;
    const observedTitle = displayTitle(observed);
    // The event title can already be the destination directory when the click
    // itself navigated. Compare the bound title too: when either differs, the
    // tree is a screen the click did not start on.
    return (reported !== '' && observedTitle !== displayTitle(reported)) ||
      (recordedTitle && recorded !== '' && observedTitle !== displayTitle(recorded));
  }

  /**
   * A Finder click that opened the item it landed on, with no tree from before
   * it: the new directory may hold another file under the same point, and
   * naming that file would replay a click the user never made. The click keeps
   * its screen point and says why.
   */
  private navigatedFileClick(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    snapshot: Snapshot,
  ): ClickTarget {
    const observed = displayTitle(windowTitleOf(snapshot));
    this.warn('UNTARGETED_FILE_CLICK',
      `A Finder click hit no named file item (the window read after it is titled "${observed}", not "${displayTitle(binding.title)}": ` +
      'the click opened a folder before its tree could be read, so only the point it landed on is left); ' +
      'it is kept at its screen point and must be edited into a named element before replay');
    return this.pointTarget('UNTARGETED_FILE_CLICK', event.point);
  }

  /** A point target and the warning that still describes it, if it stays one. */
  private pointTarget(warning: string, point: Point): ClickTarget {
    this.pendingPointWarning.add(warning);
    return { kind: 'point', point };
  }

  /**
   * A click with no proven element identity. Keeping the role alone would make
   * the step click whichever same-role element happens to be there, so the tree
   * from before the click names the element when it can; otherwise the point
   * stays and the warning says the step still needs a target.
   */
  private untargetedClick(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    snapshot: Snapshot | undefined,
  ): ClickTarget {
    const settled = this.settledLookup(binding, event);
    if (settled.target) return settled.target;
    const file = event.owner?.app === 'com.apple.finder';
    // A point nothing can name is a dead end for whoever reads the report, so
    // it says what the point was actually inside.
    const where = snapshot ? `; it sat in ${this.trailAt(snapshot, event.point)}` : '';
    this.warn(file ? 'UNTARGETED_FILE_CLICK' : 'UNTARGETED_ELEMENT_CLICK', file
      ? `A Finder click hit no named file item (${settled.miss}${where}); it is kept at its screen point and must be edited into a named element before replay`
      : `A click hit no named element (${settled.miss}${where}); it is kept at its screen point and must be edited into a named element before replay`);
    return this.pointTarget(file ? 'UNTARGETED_FILE_CLICK' : 'UNTARGETED_ELEMENT_CLICK', event.point);
  }

  /** The chain of elements a point sat in, innermost first, for a report. */
  private trailAt(snapshot: Snapshot, point: Point): string {
    let located = this.hit(snapshot, point);
    if (!located) return 'nothing';
    const trail: string[] = [];
    for (let depth = 0; depth < 4; depth += 1) {
      const name = (located.node.name ?? '').trim();
      trail.push(`${located.node.role}${name ? ` "${name.slice(0, 24)}"` : ''}`);
      const parent = parentOf(snapshot.tree, located.node);
      const next = parent ? flatten(snapshot.tree).find(entry => entry.node === parent) : undefined;
      if (!next) break;
      located = next;
    }
    return trail.join(' in ');
  }

  /**
   * Reads a window once more after a click changed it. The click's own tree
   * read runs once the app has already drawn the sheet or the page it opened,
   * which leaves nothing at the click's point; this read is the screen the
   * click was made against, and the next click in the window can fall back on
   * it. A read that fails costs nothing — the click keeps its own evidence.
   */
  private startSettledTree(binding: WindowBinding) {
    if (this.ended) return;
    // Clicks are scheduled independently: a read that hangs on one click must
    // not stop the next click from getting a tree of its own. The interval
    // epoch travels with the task so a secure prompt invalidates it.
    const epoch = this.secureEpoch;
    this.scheduleSettle(() => this.settleWindow(binding, 0, epoch));
  }

  /**
   * Waits, briefly, for the tree read already under way for this window. A read
   * that began when the previous click landed describes the screen the next
   * click is made against; letting it finish is what names a click taken in a
   * page that was still drawing.
   */
  private async settledBefore(binding: WindowBinding) {
    const pending = this.settling.get(binding.key);
    if (!pending) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), settledWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async settleWindow(binding: WindowBinding, attempt: number, epoch = this.secureEpoch) {
    // A read queued before a secure interval must not run inside it: the screen
    // now belongs to the prompt, and the interval reads no window at all.
    if (this.ended || epoch !== this.secureEpoch) return;
    this.snapshotReads += 1;
    let timer: NodeJS.Timeout | undefined;
    const abandoned = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), settledTreeReadMs);
      timer.unref?.();
    });
    try {
      // A walk reads the screen it started on: the elements are captured as the
      // read descends the tree, so the tree describes the moment the read began.
      // A read that began before the next click is therefore the screen that
      // click was made against even when it only finished after it — Electron
      // pages can make a walk take most of a second — while a read that began
      // after the click still describes what the click produced and is rejected.
      const at = this.now();
      const reading = this.read(this.windowFor(binding), this.snapshotBudgetMs).catch(() => undefined);
      const settledRead = reading.then(() => undefined, () => undefined);
      this.settling.set(binding.key, settledRead);
      const snapshot = await Promise.race([reading, abandoned]);
      if (this.settling.get(binding.key) === settledRead) this.settling.delete(binding.key);
      // A read that completed across a secure boundary describes the screen of
      // the prompt, not of the window: it is discarded, not cached.
      if (!snapshot || this.ended || epoch !== this.secureEpoch) return;
      const changed = !binding.settled || signature(snapshot.tree) !== signature(binding.settled.snapshot.tree);
      // A slower read can finish after a later one; the newer read wins.
      if (!binding.settled || binding.settled.at <= at) binding.settled = { snapshot, at };
      // Chromium builds a page's accessibility tree asynchronously, so right
      // after a view change the tree is still growing. Keep reading until two
      // reads agree: the next click is then named from the finished screen
      // instead of a page that was still being built.
      if (changed && attempt + 1 < settledTreeReads && !this.ended) {
        this.scheduleSettle(() => this.settleWindow(binding, attempt + 1, epoch));
      }
    } catch {
      // A settle read is opportunistic; the click it serves keeps its own evidence.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Whether a click that activated a window also landed on a control in it.
   * Web content accepts the first mouse-down (an Electron page can open a
   * different view), while window chrome and every AppKit control swallow it;
   * a named element inside the window's web area is therefore the one case
   * where the click did more than activate.
   */
  private async actsOnWebContent(binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>): Promise<boolean> {
    const read = await this.snapshot(binding, { gapOnFailure: false });
    if (!read) return false;
    const hit = this.hit(read.snapshot, event.point);
    if (!hit || !hit.path.includes('webarea')) return false;
    if (hit.node.role === 'webarea' || hit.node.role === 'window') return false;
    return !!clickIdentity(read.snapshot.tree, hit) || !!this.labelTarget(binding, read.snapshot, hit);
  }

  /**
   * Names a click from the tree read before it, when the click's own read came
   * back too late to hold an element. Nothing is used that is newer than the
   * click, and a tree older than the window cache is not trusted either.
   */
  private settledTarget(
    binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>, options: { cache?: boolean } = {},
  ): ClickTarget | undefined {
    return this.settledLookup(binding, event, options).target;
  }

  /**
   * The tree this window was read as before the click: the read a previous
   * click scheduled (the screen the next click is made against), or the tree a
   * hover, a prewarm or an earlier gesture left in the window cache. Only a
   * tree that was read before the click may stand for it, and only while it is
   * still young enough to describe the same screen.
   *
   * The cached tree is deliberately consulted even when the window has been
   * retitled since: a Finder click that opens a folder retitles its window
   * before the click can be read again, and the tree from before it is exactly
   * the screen the click was made against.
   */
  private preClickTree(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    { cache: useCache = true } = {},
  ): { snapshot?: Snapshot; title?: string; source?: 'settled' | 'cache'; miss: string } {
    const settled = binding.settled;
    const cache = useCache ? binding.cache : undefined;
    if (!settled && !cache) return { miss: 'no window tree was read before the click' };
    const reasons: string[] = [];
    for (const [source, entry] of [['settled', settled], ['cache', cache]] as const) {
      if (!entry) continue;
      if (entry.at > event.seen) {
        reasons.push(`${source} tree started after the click did`);
        continue;
      }
      if (binding.navigatedAt !== undefined && entry.at < binding.navigatedAt) {
        reasons.push(`${source} tree was read before a Finder navigation key`);
        continue;
      }
      if (event.seen - entry.at > this.snapshotTtlMs) {
        reasons.push(`${source} tree was too old`);
        continue;
      }
      // The title this tree was read under: a Finder click that navigates must
      // record the window it was made in, not the directory it opened.
      return { snapshot: entry.snapshot, title: windowTitleOf(entry.snapshot), source, miss: '' };
    }
    return { miss: `the only trees read before it were unusable (${reasons.join('; ')})` };
  }

  /**
   * The same lookup, with the reason it found nothing. A click that keeps its
   * point reports that reason, so a recording that still ends with a point says
   * what the tree from before the click was missing.
   */
  private settledLookup(
    binding: WindowBinding,
    event: Extract<CaptureEvent, { kind: 'click' }>,
    { cache = true } = {},
  ): { target?: ClickTarget; title?: string; miss: string; nothing?: boolean } {
    const pre = this.preClickTree(binding, event, { cache });
    const snapshot = pre.snapshot;
    if (!snapshot) return { miss: pre.miss };
    const hit = this.hit(snapshot, event.point);
    if (!hit) return { miss: `the tree read before it did not cover the point (its root ${boundsLabel(snapshot.tree.bounds)})` };
    // The window covered the point but nothing inside it did: the screen really
    // was empty there. Only the tree a click scheduled right after the previous
    // one proves that; an older cached tree may describe a screen that has
    // since changed, so it may name a click but never delete one.
    const nothing = pre.source === 'settled'
      ? this.contentHit(snapshot, event.point) === undefined
      : undefined;
    const identity = clickIdentity(snapshot.tree, hit);
    // A window or page is a scope, not a control: a click on its empty surface
    // must not be recorded as "click the window".
    if (identity && !scopeRoles.has(identity.node.role)) {
      this.warn(pre.source === 'cache' ? 'CLICK_NAMED_FROM_CACHED_TREE' : 'CLICK_NAMED_FROM_SETTLED_TREE',
        pre.source === 'cache'
          ? 'The click changed the screen before its window could be read, so it is named from the window tree the recording had already read for it'
          : 'The click changed the screen before its window could be read, so it is named from the tree that was on screen when it was made');
      return { target: toLocator(snapshot, identity) as ClickTarget, title: pre.title, miss: '' };
    }
    const label = this.labelTarget(binding, snapshot, hit);
    if (label) return { target: label, title: pre.title, miss: '' };
    // A held, unproven click is named only by what the point itself proves: the
    // press may have gone to a window above this one, so a nearby control is
    // not evidence that it received the click.
    const identified = this.identifiedTarget(snapshot, hit);
    if (identified) return { target: identified, title: pre.title, miss: '' };
    return { title: pre.title, miss: 'the tree read before it named nothing at the point', nothing };
  }

  /**
   * A named control that no one can press: in an Electron page the container
   * the pointer hits carries the accessible name while the driver gives a
   * reference only to the nodes it can act on, so the recorded element has no
   * action reference and neither does anything above it. Replay still clicks
   * that exact element, at its centre, as physical input — this warns the
   * person reviewing the flow that the step is no longer a semantic press.
   * A click on a text field is left alone: clicking one to focus it is normal.
   */
  private noteUnpressable(snapshot: Snapshot, target: ClickTarget) {
    if (target.kind !== 'element' || scopeRoles.has(target.role)) return;
    let located: Located;
    try {
      located = resolve(snapshot, target as ElementLocator);
    } catch {
      return;
    }
    if (editableRole(located.node.role)) return;
    let current: Node | undefined = located.node;
    for (let depth = 0; current && depth < 50; depth += 1) {
      // The window and page roots are not controls: a reference on one of them
      // cannot stand for a press on the recorded element.
      if (scopeRoles.has(current.role)) break;
      if (current.ref || pressable(current)) return;
      current = parentOf(snapshot.tree, current);
    }
    const name = nativeLabel(located.node.name) ?? nativeLabel(located.node.value) ?? '';
    this.warn('CLICK_TARGET_UNPRESSABLE',
      `The recorded control ${located.node.role}${name ? ` "${name.slice(0, 40)}"` : ''} exposes no AX action reference ` +
      'and no container above it does; replay will click its centre as physical input — pick the target again if that is not what the step should do');
  }

  /**
   * The name a control carries outside its own AX name.
   *
   * Finder's column view keeps a file's name in the value of the row's text
   * field, and replay already matches a target by that value, so the label
   * keeps the step an element. A container whose only pressable part is
   * anonymous while its content carries one name is a labelled control with a
   * separate hit area — the drop-down half of a combo box — so the step clicks
   * the control the label names.
   */
  private labelTarget(binding: WindowBinding, snapshot: Snapshot, hit: Located): ClickTarget | undefined {
    const file = this.finderRowLabel(binding, hit);
    if (file) return file;
    const compound = this.compoundLabel(snapshot, hit);
    if (!compound) return undefined;
    this.warn('CLICK_NAMED_BY_CONTAINER_LABEL',
      'The control clicked exposes no accessible name of its own; the step clicks the labelled control it belongs to');
    return toLocator(snapshot, compound);
  }

  /**
   * A Finder row's file name. Column view shows the name in the value of the
   * row's text field rather than in a name, and replay matches a target by
   * that value, so the label is a name it can address.
   */
  private finderRowLabel(binding: WindowBinding, hit: Located): ClickTarget | undefined {
    if (binding.app !== 'com.apple.finder') return undefined;
    if (!hit.path.includes('list') && !hit.path.includes('outline')) return undefined;
    const label = labelText(hit.node) ?? flatten(hit.node).map(entry => labelText(entry.node)).find(Boolean);
    if (!label) return undefined;
    return { kind: 'element', role: hit.node.role, name: label };
  }

  /** The labelled control an anonymous press is part of, when there is exactly one. */
  private compoundLabel(snapshot: Snapshot, hit: Located): Located | undefined {
    const node = hit.node;
    if (!pressRoles.has(node.role) || !pressable(node)) return undefined;
    const parent = parentOf(snapshot.tree, node);
    if (!parent) return undefined;
    const presses = parent.children.filter(child => pressRoles.has(child.role) && pressable(child));
    if (presses.length !== 1 || presses[0] !== node) return undefined;
    const named = flatten(parent).filter(entry => entry.node !== node && (entry.node.name ?? '').trim());
    if (new Set(named.map(entry => entry.node.name!.trim())).size !== 1) return undefined;
    const label = named[0];
    if (!label || editableRole(label.node.role) || label.node.secure) return undefined;
    return label;
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
    // The scroll names the element under the pointer before the content moved,
    // so this event may use the tree this window already read; the moved
    // content is not reused by anything after it.
    const read = await this.snapshot(binding, {
      event, keep: false,
      validate: tree => this.hit(tree, event.point) !== undefined,
    });
    if (!read) return;
    const snapshot = read.snapshot;
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
    // A hover can carry a capture-side gap of its own. That is a fact about the
    // recording, not about the pointer, so it blocks here exactly as it does for
    // every other event kind — before any hover is skipped and whether or not a
    // window can be bound.
    if (event.decision === 'gap') {
      const code = event.gapCode ?? 'CAPTURE_SCOPE_UNVERIFIED';
      if (code !== 'CAPTURE_SCOPE_UNVERIFIED') {
        this.pushGap(code);
        return;
      }
    }
    // A held press is waiting for the focus that proves it only activated its
    // window. A hover delivers no input, so it cannot settle that press either
    // way: settling it here would turn a swallowed press into a click the user
    // never made, and the focus (or the next input) still gets its say.
    if (this.pendingGapClick) {
      this.warn('HOVER_WHILE_CLICK_UNPROVEN',
        'A hover arrived while a click was waiting for the focus that proves it only activated its window; the hover was not recorded and the click kept waiting');
      return;
    }
    const binding = this.bindingFor(event);
    if (!binding) {
      // A hover names no action a replay must perform. Without a window there is
      // no screen point to trust either: the pointer could have stopped on the
      // desktop, so this stays a skip and blocks nothing. A hover over a menu
      // item reaches this path as a real `record` action whose window is the app
      // window that opened the menu; the menu choice itself is still recorded by
      // the click that follows, on its own evidence.
      this.warn('UNTARGETED_HOVER',
        'A hover named no window this recording can address; it was skipped because a hover is read-only');
      return;
    }
    if (event.decision === 'gap') {
      // Only a scope gap reaches here (every other code blocked above). The
      // helper resolves a hover's evidence against the focused window, so a
      // scope gap is conflicting evidence about a read-only event, not a missing
      // user action: no replay could perform the hover anyway.
      this.warn('UNTARGETED_HOVER',
        'A hover could not prove the window under the pointer; it was skipped because a hover is read-only');
      return;
    }
    if (!this.claim(event, binding)) return;
    const read = await this.snapshot(binding, {
      event, validate: tree => this.hit(tree, event.point) !== undefined,
      // A hover changes nothing on screen, so a read that only ran out of budget
      // may be retried: the point the pointer dwelled on is still the evidence
      // this step needs, and the retry must still cover it.
      retryIncomplete: tree => this.hit(tree, event.point) !== undefined,
    });
    if (!read) return;
    const snapshot = read.snapshot;
    // A coordinate hover is only replayable while the recorded point is inside
    // the window its evidence named. A tree whose shapes extend past the window
    // (or one read without a frame) must not turn an outside point into a
    // screen hover: nothing proves it belongs to this recording.
    if (!contains(snapshot.tree.bounds, event.point)) {
      this.warn('UNTARGETED_HOVER',
        'A hover landed outside the window its evidence named; it was skipped because no replay can place that point');
      return;
    }
    const hit = this.hit(snapshot, event.point);
    // A hover is replayed by resting the pointer. When the tree names the control
    // under the pointer, the step can address it as an element; when it only
    // reaches a window/application root, or the node has no usable identity, the
    // recorded screen point is the honest address. The hint keeps a readable
    // note of what the recording saw, and replay never resolves it.
    const node = hit && hit.node.role !== 'window' && hit.node.role !== 'application'
      ? hit.node
      : undefined;
    if (node?.secure) return;
    const point: Point = [Math.round(event.point[0]), Math.round(event.point[1])];
    const durationMs = Math.max(0, Math.min(60_000, Math.round(event.dwellMs)));
    const locator = node ? toLocator(snapshot, hit!) : undefined;
    if (locator && isReAddressable(locator)) {
      this.ensureScope(binding);
      this.push({
        kind: 'hover', scope: this.windowScope(binding), target: locator,
        durationMs,
        // The element's own bounds often belong to an anonymous container whose
        // centre is not the row the pointer stopped on, so the screen point the
        // helper resolved is kept with the step. It is inside the window because
        // `hit` found the element there.
        point,
      });
      return;
    }
    // A coordinate hover names no window, so it never creates a scope or a
    // navigation step; a later click still adds whichever navigation it needs.
    this.push({
      kind: 'hover', scope: { kind: 'screen' }, point, durationMs,
      hint: {
        app: binding.app,
        windowTitle: binding.title,
        ...(locator ? {
          element: {
            kind: 'element' as const,
            role: locator.role,
            ...(locator.name === undefined ? {} : { name: locator.name }),
            ...(locator.identifier === undefined ? {} : { identifier: locator.identifier }),
          },
        } : {}),
      },
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
    const read = await this.snapshot(binding, {
      event,
      validate: tree => this.hit(tree, event.from) !== undefined && this.hit(tree, event.to) !== undefined,
    });
    if (!read) return;
    const snapshot = read.snapshot;
    const from = this.hit(snapshot, event.from);
    const to = this.hit(snapshot, event.to);
    // A drag whose two ends sit in one editable control selects text inside
    // that control. v2 has no step that reproduces a selection: a recorded drag
    // replays from element centers and would select something else, while the
    // `type` step that follows writes the field's value directly, so the
    // selection is not part of what a replay must reproduce. Dropping it with a
    // warning keeps the flow runnable; a drag that merely happened to be
    // off-center inside the address bar used to block every run.
    const fromField = from && this.editableHost(snapshot, from);
    const toField = to && this.editableHost(snapshot, to);
    if (event.button === 'left' && fromField && fromField === toField && !fromField.secure) {
      this.warn('DRAG_SELECTS_TEXT',
        'A drag selected text inside one editable control; it was not recorded because replay writes text through that control, not by selecting it');
      return;
    }
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
    // The focused control, when the helper carried it, is what separates two
    // fields inside the same window: focusGeneration does not change between
    // controls of one window.
    const droppedTarget = focusedTarget(event.focus);
    const key = this.focusKey(binding, event.focusGeneration);
    // An event this far behind the helper cannot be tied to the live focus any
    // more; the whole queue is late, so one warning is more useful than a gap
    // per character. The event is dropped, never guessed.
    if (this.now() - event.seen > captureBacklogMs) {
      this.warn('CAPTURE_BACKLOG',
        'The capture stream fell more than 8 seconds behind the helper; text events from the backlog were dropped');
      // Only a burst that is still open in this exact window and focus, and
      // whose last character is within one merge window, owns the dropped
      // event. A burst that already ended before the gap is complete and must
      // not be blamed for it.
      const sameControl = !droppedTarget || !this.textBurst ||
        locatorKey(this.textBurst.target) === locatorKey(droppedTarget);
      if (this.textBurst && sameControl && this.textBurst.scope === scopeId &&
          this.textBurst.key === this.focusKey(binding, event.focusGeneration) &&
          event.t - this.textBurst.at <= textGapMs) {
        const entry = this.inputValues.get(this.textBurst.name);
        if (entry) {
          entry.complete = false;
          entry.issues.add('backlog_dropped');
        }
      }
      // A buffered burst owns the drop only if this event belongs to the same
      // window, focus generation and merge window. A drop that arrives much
      // later belongs to the next burst, which the droppedText marker covers.
      const pending = this.pendingText;
      if (pending && pending.scopeId === scopeId && pending.key === key &&
          event.t - pending.at >= 0 && event.t - pending.at <= textGapMs) {
        pending.drops.push(droppedTarget ? { locator: locatorKey(droppedTarget) } : {});
      }
      // The first character of a burst is often the one that was lost, so the
      // burst may not exist yet: remember where it belongs and mark it when it
      // is bound.
      this.droppedText = {
        scopeId, key: this.focusKey(binding, event.focusGeneration), at: event.t,
        ...(droppedTarget ? { locator: locatorKey(droppedTarget) } : {}),
      };
      return;
    }
    if (event.focus?.secure) {
      this.enterSecure();
      return;
    }
    // The helper's focused-element evidence is the normal path: role, label and
    // frame of the control that received the character, with no tree read.
    const direct = droppedTarget;
    if (direct) {
      this.rememberFocus(key, direct);
      this.retargetClickFromEvidence(event, direct, scopeId);
      this.bindText(scope, scopeId, event.t, direct, undefined, { chars: event.chars, key });
      return;
    }
    // A burst already proved which control receives the characters; another
    // read per keystroke would prove nothing more.
    const burst = this.textBurst;
    if (burst && burst.scope === scopeId && event.t - burst.at <= textGapMs) {
      this.bindText(scope, scopeId, event.t, burst.target, undefined, { chars: event.chars, key });
      return;
    }
    // The click that selected the control is proven evidence even without the tree.
    const anchor = this.textAnchor;
    if (anchor && anchor.scope === scopeId && event.t - anchor.at <= clickTextFallbackMs) {
      this.warn('TEXT_TARGET_FROM_CLICK',
        'A text event carried no focused-element evidence; its target was taken from the click that selected the control');
      this.bindText(scope, scopeId, event.t, anchor.locator, undefined, { chars: event.chars, key });
      return;
    }
    // Evidence already proven for this window and focus generation is reused.
    const cached = this.focusTargets.get(key);
    if (cached) {
      this.bindText(scope, scopeId, event.t, cached, undefined, { chars: event.chars, key });
      return;
    }
    // Fallback: buffer the burst and read the tree once, off the event path.
    await this.bufferText(binding, key, scope, scopeId, event);
  }

  /**
   * A readable parameter name for the characters just typed. A rename keys the
   * value as `filename`, so the replay dialog asks for a file name; any other
   * text is `text_1`, `text_2`, ... The value itself is never stored.
   */
  private nextInputName() {
    const last = this.steps[this.steps.length - 1];
    const renaming = (last?.kind === 'key' && last.key === 'r' &&
        (last.modifiers ?? []).includes('meta')) ||
      (last?.kind === 'click' && last.target?.kind === 'element' &&
        last.target.role === 'menuitem' && /重命名|rename/i.test(last.target.name ?? ''));
    const base = renaming ? 'filename' : 'text';
    let name = renaming ? base : `${base}_1`;
    let suffix = 2;
    while (this.inputs.has(name)) name = `${base}_${suffix++}`;
    return name;
  }

  /** Records one text event against a proven control, merging a running burst. */
  private bindText(
    scope: WindowScope, scopeId: string, at: number, target: ElementLocator, snapshot?: Snapshot,
    text: { chars?: string; issues?: readonly InputValueIssue[]; key?: string } = {},
  ) {
    const locatorId = locatorKey(target);
    const burst = this.textBurst;
    if (burst && burst.scope === scopeId && burst.locator === locatorId &&
        at - burst.at <= textGapMs) {
      burst.at = at;
      burst.target = target;
      if (snapshot) burst.snapshot = snapshot;
      this.textAnchor = { at, scope: scopeId, locator: target };
      this.appendChars(burst.name, text);
      this.markDropped(burst.name, scopeId, text.key, at, burst.target);
      return;
    }
    this.endBursts();
    const input = this.nextInputName();
    this.inputs.add(input);
    const before = this.steps.length;
    this.push({ kind: 'type', scope, target, input }, at);
    // A flow at its step limit drops the step; a value with no step to explain
    // it would only confuse the next replay dialog.
    if (this.steps.length === before) return;
    const entry = {
      value: '', complete: text.chars !== undefined, issues: new Set<InputValueIssue>(),
      steps: [`s${this.steps.length}`],
      targets: [{ role: target.role, ...(target.name === undefined ? {} : { name: target.name }) }],
    };
    this.inputValues.set(input, entry);
    this.appendChars(input, text);
    this.markDropped(input, scopeId, text.key, at, target);
    this.textBurst = {
      at, scope: scopeId, locator: locatorId, target, name: input, key: text.key ?? '',
      ...(snapshot ? { snapshot } : {}),
    };
    this.textAnchor = { at, scope: scopeId, locator: target };
  }

  /**
   * Adds one text event's characters to the burst's value. A missing `chars`
   * (some IME commits carry none) and a value past the limit both keep what was
   * read and mark the entry incomplete, so the replay dialog can ask the
   * operator to check it instead of silently replaying half a string.
   */
  private appendChars(name: string, text: { chars?: string; issues?: readonly InputValueIssue[] }) {
    const entry = this.inputValues.get(name);
    if (!entry) return;
    for (const issue of text.issues ?? []) {
      entry.complete = false;
      entry.issues.add(issue);
    }
    if (text.chars === undefined) {
      entry.complete = false;
      entry.issues.add('chars_missing');
      return;
    }
    const grown = appendWithinLimit(entry.value, text.chars);
    entry.value = grown.text;
    if (grown.truncated) {
      entry.complete = false;
      entry.issues.add('truncated');
    }
  }

  /**
   * Applies a backlog drop to the burst it belongs to. Window, focus generation
   * and a merge-window distance all have to match, so a later burst in the same
   * window is never blamed for characters it did read.
   */
  private markDropped(
    name: string, scopeId: string, key: string | undefined, at: number, target: ElementLocator,
  ) {
    const dropped = this.droppedText;
    if (!dropped || dropped.scopeId !== scopeId || dropped.key !== key) return;
    if (Math.abs(at - dropped.at) > textGapMs) return;
    // A drop for another control in the same window must wait for that
    // control's burst instead of marking this one.
    if (dropped.locator && dropped.locator !== locatorKey(target)) return;
    this.droppedText = undefined;
    const entry = this.inputValues.get(name);
    if (!entry) return;
    entry.complete = false;
    entry.issues.add('backlog_dropped');
  }

  /** The recorded text of every `type` step, for the sidecar the CLI writes. */
  recordedInputValues(): Record<string, InputValueEntry> {
    const values: Record<string, InputValueEntry> = {};
    for (const [name, entry] of this.inputValues) {
      // A burst that never yielded a readable character has nothing to store;
      // the dialog's required field is more honest than an empty value.
      if (!entry.value.length) continue;
      values[name] = {
        value: entry.value,
        complete: entry.complete,
        ...(entry.issues.size ? { issues: [...entry.issues] } : {}),
        ...(entry.steps.length ? { steps: entry.steps } : {}),
        ...(entry.targets.length ? { targets: entry.targets } : {}),
      };
    }
    return values;
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
      this.bindText(scope, scopeId, event.t, cached, undefined, { chars: event.chars, key });
      return;
    }
    const pending = this.pendingText;
    if (pending && pending.key === key) {
      pending.at = event.t;
      this.bufferChars(pending, event.chars);
      return;
    }
    this.pendingText = {
      key, scope, scopeId, at: event.t,
      chars: '', complete: event.chars !== undefined, issues: new Set<InputValueIssue>(), drops: [],
    };
    this.bufferChars(this.pendingText, event.chars);
    this.pendingSettle = this.resolvePendingText(binding, key);
  }

  /** Accumulates one event's characters into the burst waiting for its read. */
  private bufferChars(
    pending: { chars: string; complete: boolean; issues: Set<InputValueIssue> },
    chars: string | undefined,
  ) {
    if (chars === undefined) {
      pending.complete = false;
      pending.issues.add('chars_missing');
      return;
    }
    const grown = appendWithinLimit(pending.chars, chars);
    pending.chars = grown.text;
    if (grown.truncated) {
      pending.complete = false;
      pending.issues.add('truncated');
    }
  }

  /**
   * One fallback read for a buffered burst. A resolved focused control becomes
   * the burst's target and is cached for the rest of the focus generation; a
   * failed or late read drops the buffered characters with a warning, never a
   * gap, and never delays the events behind it.
   */
  private async resolvePendingText(binding: WindowBinding, key: string) {
    // The tree this window already read is reused only while it still proves a
    // focused editable control; a reused tree read before a later click would
    // name the control the caret left.
    const read = await this.snapshot(binding, {
      gapOnFailure: false,
      validate: tree => this.uniqueFocused(tree) !== undefined,
      // Reading focus does not change the screen, so a budget-exhausted read may
      // be retried as long as it still proves one focused editable control.
      retryIncomplete: tree => this.uniqueFocused(tree) !== undefined,
    });
    const snapshot = read?.snapshot;
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
    // A drop belongs to the buffered burst only when it named this same
    // control; otherwise it stays on the droppedText marker for its own burst.
    const ownDrop = pending.drops.some(drop =>
      !drop.locator || drop.locator === locatorKey(target));
    this.bindText(pending.scope, pending.scopeId, pending.at, target, snapshot, {
      chars: pending.chars,
      issues: [...pending.issues, ...(ownDrop ? ['backlog_dropped' as const] : [])],
      key,
    });
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
    const single = this.uniqueFocused(snapshot);
    return single && contains(single.node.bounds, point) ? single : undefined;
  }

  /** The one focused editable control a tree proves, without a point. */
  private uniqueFocused(snapshot: Snapshot): Located | undefined {
    const focused = flatten(snapshot.tree).filter(entry =>
      entry.node.ref && entry.node.states.includes('focused') && editable.has(entry.node.role));
    const [single] = focused;
    return focused.length === 1 ? single : undefined;
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
    if (step?.kind !== 'click') return;
    // A named editable control is already the right target; a point or a named
    // container still describes the surface above the field the text proved.
    if (step.target.kind === 'element' && editableRole(step.target.role)) return;
    if (!contains(focusBounds(event.focus), click.point)) return;
    (step as { target: ElementLocator }).target = target;
    click.locator = locatorKey(target);
    this.pointClickWarning.delete(click.index);
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
    this.pointClickWarning.delete(click.index);
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
    if (binding.app === finderBundleId && event.modifiers.includes('meta') && finderNavigationKeys.has(event.key)) {
      // ⌘↑ / ⌘[ / ⌘] / ⌘⇧G replace the directory under the window. Any tree
      // read before the key is the screen before the navigation and must not
      // name the next click; the key itself is still recorded.
      binding.navigatedAt = event.t;
      this.dropBeforeClickTrees(binding);
    }
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
    // A secure boundary invalidates whatever control was proven before it, and
    // the prompt can replace what a window showed. Every read queued before the
    // interval is void, and a tree that finished across it is not evidence.
    this.secureEpoch += 1;
    this.settling.clear();
    for (const binding of this.bindings.values()) binding.settled = undefined;
    this.textAnchor = undefined;
    this.dropTrees();
  }

  /** Closes a secure interval and emits the one checkpoint it becomes. */
  private closeSecure() {
    this.secureOpen = false;
    this.endBursts();
    this.textAnchor = undefined;
    this.dropTrees();
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
      this.pushGap(reason === 'secure_input' ? 'SECURE_INPUT' : 'CAPTURE_SCOPE_UNVERIFIED', { evidence: true });
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
    if (!owner.pid) return undefined;
    const title = displayTitle(owner.windowTitle);
    const existing = owner.windowNumber === undefined
      ? undefined
      : this.bindings.get(`${owner.pid}:${owner.processInstance ?? 0}:${owner.windowNumber}`);
    if (existing) {
      // The same native window can retitle; the key keeps following it. A
      // surface that names no title says nothing about the window it proves.
      if ((owner.windowTitle ?? '').trim() !== '' && existing.title !== title) existing.title = title;
      this.lastWindow = { binding: existing, generation: event.focusGeneration };
      return existing;
    }
    // A surface that names no window (a sheet, a menu, a probe that read
    // nothing) and an untitled one belong to the window the app is already
    // using. Inventing a window key here records a navigation and a scope that
    // no replay can find, which is worse than reusing the proved window.
    if (owner.windowNumber === undefined || (owner.windowTitle ?? '').trim() === '') {
      const inherited = this.inheritedWindow(event);
      if (inherited) {
        this.warn('WINDOW_SCOPE_FROM_LAST_WINDOW',
          'An event named no window of its own; the window this app already proved was used instead');
        return inherited;
      }
    }
    if (owner.windowNumber === undefined) return undefined;
    if (this.bindings.size >= maxWindowBindings) return undefined;
    const binding: WindowBinding = {
      key: this.nextKey(owner.app), app: owner.app, title,
      pid: owner.pid, windowNumber: owner.windowNumber,
      ...(owner.processInstance === undefined ? {} : { processInstance: owner.processInstance }),
    };
    this.bindings.set(`${owner.pid}:${owner.processInstance ?? 0}:${owner.windowNumber}`, binding);
    this.apps.add(owner.app);
    this.lastWindow = { binding, generation: event.focusGeneration };
    return binding;
  }

  /**
   * The window an event keeps when its own evidence lost the window number or
   * names an untitled surface. The helper can fail one focus probe (Finder's
   * inline rename field, a sheet, a window mid-animation) without the app or its
   * process changing; the window this recording already proved for that process
   * is still the one receiving input. Another app, another process, or a
   * generation that already named a different window never inherits it.
   */
  private inheritedWindow(event: CaptureEvent): WindowBinding | undefined {
    const owner = event.owner;
    const last = this.lastWindow;
    if (!owner?.app || !owner.pid || !last) return undefined;
    const binding = last.binding;
    if (binding.app !== owner.app || binding.pid !== owner.pid) return undefined;
    if ((binding.processInstance ?? 0) !== (owner.processInstance ?? 0)) return undefined;
    // A late event from an older generation is never moved forward to a window
    // that later evidence already named.
    if (event.focusGeneration < last.generation) return undefined;
    const claimed = this.generationWindow.get(event.focusGeneration);
    if (claimed !== undefined && claimed !== this.bindingId(binding)) return undefined;
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
   * The editable control an endpoint sits in, itself included. A text field's
   * own children are part of the same control: a selection that starts and ends
   * on two of them is still one selection.
   */
  private editableHost(snapshot: Snapshot, entry: Located) {
    for (let node: Node | undefined = entry.node; node; node = parentOf(snapshot.tree, node)) {
      if (editableRole(node.role)) return node;
    }
    return undefined;
  }

  /**
   * The window tree for one pointer step. This is fallback evidence: the
   * helper's own element evidence is preferred, and a text event never waits for
   * this. A window is read once and every later pointer event in that window
   * reuses the same tree while it still describes the screen. A caller can
   * reject a reused tree that cannot answer its own question (`validate`), which
   * costs exactly one fresh read; `keep: false` uses the tree for this event and
   * stores nothing (a scroll moved the content it just named). A failed read is
   * reported once and the caller decides; a click keeps its own evidence, every
   * other gesture becomes a gap.
   */
  private async snapshot(
    binding: WindowBinding,
    { gapOnFailure = true, event, keep = true, retryIncomplete, validate }: {
      gapOnFailure?: boolean;
      /** The event whose points and title a cached tree must still cover. */
      event?: CaptureEvent;
      /** Whether a fresh read may be stored for later events. */
      keep?: boolean;
      /**
       * Accepts a retried read, and only for read-only evidence: the retry runs
       * after the gesture, so a click, scroll or drag read at that point can
       * already describe what the gesture produced. The caller must prove the
       * retried tree still describes this gesture (the point it acted on is
       * still covered by the same window). Without it a failed read stays a
       * failed read.
       */
      retryIncomplete?: (snapshot: Snapshot) => boolean;
      validate?: (snapshot: Snapshot) => boolean;
    } = {},
  ): Promise<{ snapshot: Snapshot; reused: boolean } | undefined> {
    const cached = this.reusableTree(binding, event);
    if (cached && (!validate || validate(cached))) {
      // This event moved the content it named; nothing after it may reuse the tree.
      if (!keep) this.dropTree(binding);
      return { snapshot: cached, reused: true };
    }
    if (cached) this.dropTree(binding);
    const read = await this.readWindow(binding, retryIncomplete);
    // The retried read may have found the window gone even though the first
    // attempt only ran out of budget: nothing may reuse a replaced window's tree.
    if (read.replaced) this.dropTree(binding);
    if (!read.snapshot) {
      const error = read.error;
      const code = error instanceof Fault ? error.code : undefined;
      // A window that is gone or was replaced cannot be the window the running
      // flow acts on: apps that hide a window when they lose focus hand it a new
      // number each time, and the click that follows binds the new one. Blocking
      // the flow over that read would ask the operator to fix nothing.
      if (code === 'WINDOW_NOT_FOUND' || code === 'WINDOW_CHANGED') {
        this.dropTree(binding);
        if (gapOnFailure) {
          this.warn('WINDOW_REPLACED', `A window read was skipped (${code}: ${error instanceof Fault ? error.message : 'no answer'}); the window it named was replaced, so it cannot be a step of this flow`);
        }
        return undefined;
      }
      if (gapOnFailure) {
        // The fault says which window and title the read was of; a warning that
        // only carried the code left the user with nothing to trace next time.
        const reason = error instanceof Fault ? `${error.code}: ${error.message}` : 'no answer';
        this.warn('SNAPSHOT_UNAVAILABLE', `An accessibility read failed (${reason}); the step is a gap`);
        this.pushGap('STALE_CAPTURE');
      }
      return undefined;
    }
    const snapshot = read.snapshot;
    if (keep) this.cacheTree(binding, snapshot);
    else this.dropTree(binding);
    return { snapshot, reused: false };
  }

  /**
   * One fresh read of the bound window, with the retry a slow tree needs.
   *
   * `complete: false` from a by-ID read (a `budget` reason) means the driver
   * spent its observation window before it finished walking the tree: the window
   * is retitling, loading a folder or drawing a new page, and the tree it is
   * rebuilding is exactly the one this event needs. By the time that answer
   * arrives the rebuild has usually finished, so a read-only caller may ask for
   * one retry — and only accepts it when its own predicate proves the tree still
   * describes the gesture.
   *
   * A failure is never downgraded by the retry: when the second read fails too,
   * the *first* error is reported, so a step that deserved a gap keeps it (a
   * window that turns out to be gone does not turn the unreadable read into a
   * silent skip). `truncated` and `identity_unproven` are about the tree itself
   * and are never retried.
   */
  private async readWindow(
    binding: WindowBinding, acceptRetry?: (snapshot: Snapshot) => boolean,
  ): Promise<{ snapshot?: Snapshot; error?: unknown; replaced?: boolean }> {
    const window = this.windowFor(binding);
    const startedAt = this.now();
    this.snapshotReads += 1;
    try {
      return { snapshot: await this.read(window, this.snapshotBudgetMs) };
    } catch (error) {
      if (!acceptRetry || !(error instanceof Fault) || error.code !== 'INCOMPLETE_TREE' ||
          error.reason !== 'budget') {
        return { error };
      }
      // Both attempts share one deadline, so a slow driver cannot hold the event
      // stream past the backlog window; too little time left means no retry.
      const budget = Math.min(snapshotRetryBudgetMs, snapshotStepDeadlineMs - (this.now() - startedAt));
      if (budget < 500) return { error };
      this.snapshotReads += 1;
      try {
        const snapshot = await this.read(window, budget);
        if (!acceptRetry(snapshot)) return { error };
        this.warn('SNAPSHOT_SLOW_READ',
          `An accessibility read ran out of its ${this.snapshotBudgetMs} ms budget; the retry read the tree again and the step kept its evidence`);
        return { snapshot };
      } catch (retryError) {
        const code = retryError instanceof Fault ? retryError.code : undefined;
        return { error, replaced: code === 'WINDOW_NOT_FOUND' || code === 'WINDOW_CHANGED' };
      }
    }
  }

  /**
   * The tree this window was read as, when it still describes the event. A
   * different title, an event point the cached bounds no longer cover, or a
   * pause longer than the TTL make the cache unusable; the next event then
   * reads the window again. Each window keeps its own tree, so focusing another
   * window never discards this one.
   */
  private reusableTree(binding: WindowBinding, event?: CaptureEvent): Snapshot | undefined {
    const cache = binding.cache;
    if (!cache) return undefined;
    if (cache.title !== binding.title || this.now() - cache.at > this.snapshotTtlMs) {
      this.dropTree(binding);
      return undefined;
    }
    const bounds = cache.bounds;
    if (event && bounds && eventPoints(event).some(point => !contains(bounds, point))) {
      this.dropTree(binding);
      return undefined;
    }
    const id = this.bindingId(binding);
    this.cacheOrder = this.cacheOrder.filter(entry => entry !== id);
    this.cacheOrder.push(id);
    return cache.snapshot;
  }

  private cacheTree(binding: WindowBinding, snapshot: Snapshot) {
    const id = this.bindingId(binding);
    binding.cache = { snapshot, at: this.now(), title: binding.title, bounds: snapshot.tree.bounds };
    this.cacheOrder = this.cacheOrder.filter(entry => entry !== id);
    this.cacheOrder.push(id);
    while (this.cacheOrder.length > this.maxCachedWindows) {
      const evicted = this.cacheOrder.shift();
      const other = evicted === undefined ? undefined : this.bindings.get(evicted);
      if (other) other.cache = undefined;
    }
  }

  private dropTree(binding: WindowBinding) {
    const id = this.bindingId(binding);
    binding.cache = undefined;
    this.cacheOrder = this.cacheOrder.filter(entry => entry !== id);
  }

  /** Drop both pre-click trees after a navigation key changed the window. */
  private dropBeforeClickTrees(binding: WindowBinding) {
    binding.settled = undefined;
    this.dropTree(binding);
  }

  /** Drops every cached tree; a secure interval leaves nothing to reuse. */
  private dropTrees() {
    for (const binding of this.bindings.values()) binding.cache = undefined;
    this.cacheOrder = [];
  }

  /**
   * The deepest element under the point that is not the window itself. Blank
   * space inside a window always answers with the window root, which addresses
   * nothing a click could replay.
   */
  private contentHit(snapshot: Snapshot, point: Point): Located | undefined {
    const hit = this.hit(snapshot, point);
    return hit && hit.node !== snapshot.tree ? hit : undefined;
  }

  /**
   * Completes a target the helper already named with the path or index this
   * window needs to address it, using a tree that is already cached. It never
   * reads a tree: element evidence alone is a usable target.
   */
  private completeFromCache(
    binding: WindowBinding, event: Extract<CaptureEvent, { kind: 'click' }>, target: ElementLocator,
  ): ElementLocator | undefined {
    const snapshot = this.reusableTree(binding, event);
    if (!snapshot) return undefined;
    const names = elementNames(snapshot.tree);
    const candidates = flatten(snapshot.tree).filter(entry =>
      entry.node.role === target.role && (names.get(entry.node) ?? '') === (target.name ?? ''));
    if (!candidates.length) return undefined;
    const chosen = candidates.length === 1
      ? candidates[0]
      : candidates.find(entry => contains(entry.node.bounds, event.point));
    if (!chosen) return undefined;
    return toLocator(snapshot, chosen);
  }

  /**
   * Drops a reused tree that was read before the click moved focus inside this
   * window: the text that follows has no focus evidence, and the old tree would
   * name the control the caret just left.
   */
  private dropTreeIfFocusMoved(binding: WindowBinding, snapshot: Snapshot, target: ElementLocator) {
    if (this.showsFocused(snapshot, target)) return;
    this.dropTree(binding);
  }

  private showsFocused(snapshot: Snapshot, target: ElementLocator) {
    const names = elementNames(snapshot.tree);
    return flatten(snapshot.tree).some(entry =>
      entry.node.states.includes('focused') && entry.node.role === target.role &&
      (names.get(entry.node) ?? '') === (target.name ?? ''));
  }

  /**
   * The helper's own reason for a stale capture, kept as a recording
   * diagnostic. It explains the gap and never downgrades it: without the
   * stream there is no proof that the interruption lost nothing.
   */
  private noteGapReason(event: Extract<CaptureEvent, { kind: 'gap' }>) {
    if (event.gapCode !== 'STALE_CAPTURE') return;
    if (event.detail === 'tap_interrupted') {
      this.warn('STALE_CAPTURE_TAP_INTERRUPTED',
        'The system disabled the event tap during recording; the capture gap stays because input in that interval could not be observed');
    } else if (event.detail === 'event_lag') {
      this.warn('STALE_CAPTURE_EVENT_LAG',
        'The helper fell behind the event stream; the capture gap stays because a late event cannot be tied to the focus it was typed into');
    } else if (event.detail === 'text_unverifiable') {
      this.warn('STALE_CAPTURE_TEXT_UNVERIFIABLE',
        'The focused control could not be read, so the keystrokes were not recorded: text whose control cannot be proven non-secure never leaves the helper, and the gap stays');
    }
  }

  /**
   * A gap stands for a piece of the recording no step can replay. A scope gap
   * before the first step names no window the flow could stand at, so it is
   * startup noise like any other unprovable opening event; every other gap is
   * evidence of lost input and is kept. A checkpoint gap is always kept.
   */
  private pushGap(code: CaptureGapCode, { evidence = false, at = this.eventAt, origin }: {
    evidence?: boolean; at?: number; origin?: GapOrigin;
  } = {}) {
    this.endBursts();
    if (!evidence && code === 'CAPTURE_SCOPE_UNVERIFIED' && !this.steps.length) {
      this.startupDropped += 1;
      return;
    }
    const before = this.steps.length;
    this.push({ kind: 'gap', code }, at);
    // A gap the step limit dropped has no id to point at; naming one anyway
    // would send the reader to a step the flow does not contain.
    if (code === 'CAPTURE_SCOPE_UNVERIFIED' && this.steps.length > before) {
      this.noteGapOrigin(this.steps[this.steps.length - 1].id, origin);
    }
  }

  /**
   * `CAPTURE_SCOPE_UNVERIFIED` is raised by many handlers and the step alone
   * cannot say which one, so a flow that blocks replay on it cannot be
   * diagnosed after the fact. The capture report carries one line per such gap:
   * the step id it actually got, the handler, the event's own window evidence,
   * its decision and generation. That is enough to tell a click that lost its
   * window from an unattributable hover, and it extends no flow schema and
   * stores no screen content.
   *
   * `origin` names the event that actually caused the gap when it is not the
   * event being consumed — a held press settled later by a focus, a hover or a
   * boundary. The gap then also keeps the press's own time (`pushGap`'s `at`),
   * so the report never blames the event that merely triggered the settlement.
   *
   * Read it from the record outcome's `warnings` (`code: CAPTURE_GAP_ORIGIN`):
   * `cuekeeper record --json` prints it, and the workbench keeps it in the
   * `api/record/stop` response (20 warnings, 500 characters each). A successful
   * import then replaces the page message with "timeline imported" and reloads,
   * so the line is read from that response, not from the page alert.
   */
  private noteGapOrigin(id: string, origin?: GapOrigin) {
    const event = this.consuming;
    const owner = event?.owner;
    const line = [
      id,
      `from=${origin?.handler ?? this.gapHandler}`,
      `app=${origin?.app ?? owner?.app ?? '-'}`,
      `window=${origin?.window ?? owner?.windowNumber ?? '-'}`,
      `gen=${origin?.generation ?? event?.focusGeneration ?? '-'}`,
      `decision=${origin?.decision ?? (event && 'decision' in event ? event.decision ?? '-' : '-')}`,
    ].join(' ');
    if (this.gapOrigins.length < gapOriginLines) this.gapOrigins.push(line);
    else this.gapOriginsOmitted += 1;
    const lines = [...this.gapOrigins];
    if (this.gapOriginsOmitted) lines.push(`+${this.gapOriginsOmitted} more`);
    this.notes.set('CAPTURE_GAP_ORIGIN', lines.join('; ').slice(0, gapOriginChars));
  }

  /**
   * Whether this focus is the one the held press caused. Only the first focus
   * after the press (the next generation) can be it: a later focus on the same
   * window means the user left and came back — across another app, or across a
   * capture boundary — and proves nothing about the press. A press into the
   * window the flow already stood in can never be an activation press.
   */
  private provesHeldActivation(pending: HeldClick, event: Extract<CaptureEvent, { kind: 'focus' }>) {
    return pending.activation && event.focusGeneration === pending.generation + 1;
  }

  /** A press the window activation swallowed is not a step. */
  private dropHeldClick() {
    if (!this.pendingGapClick) return;
    this.pendingGapClick = undefined;
    this.warn('CLICK_ONLY_ACTIVATED_WINDOW',
      'A click landed on a window that was not focused yet; it only brought the window forward and was not recorded as a click');
  }

  /**
   * Records the held unprovable click, at the time the click happened. Its
   * window is known even when its control is not, so the click becomes a step
   * there — named from the tree that was on screen, or kept at its point — and
   * never a gap: a gap blocks every replay of the flow over one press the
   * recording already placed on the screen.
   */
  private flushPendingGap() {
    const pending = this.pendingGapClick;
    if (!pending) return;
    this.pendingGapClick = undefined;
    if (!this.steps.length) {
      // Before the first step it names no window the flow could stand at.
      this.startupDropped += 1;
      return;
    }
    if (pending.button === 'right') {
      // Replay addresses a right click through the control the previous left
      // click selected (run-v2 keeps `lastClickTarget`), so writing an unproven
      // one as a plain click would press something else. It stays blocking
      // evidence: the flow can be completed by editing it, never replayed blind.
      this.warn('RIGHT_CLICK_UNPROVEN',
        `A right click on ${pending.where} at ${pending.point[0]},${pending.point[1]} could not be proven to target an element; it blocks the flow instead of becoming a left click`);
      // The gap is the press's, not the settling event's: it keeps the press's
      // own time and evidence, so a focus, a hover or a boundary that merely
      // triggered this settlement is never named as what lost the input.
      this.pushGap('CAPTURE_SCOPE_UNVERIFIED', {
        at: pending.at,
        origin: {
          handler: 'click',
          app: pending.binding.app,
          window: pending.binding.windowNumber,
          generation: pending.generation,
          decision: 'gap',
        },
      });
      return;
    }
    // The trees already read are all this click can be named from; the click
    // itself happened before any of them, and reading again now would describe
    // the screen the following event changed.
    const settled = this.settledLookup(pending.binding, {
      point: pending.point, seen: pending.seen,
    } as Extract<CaptureEvent, { kind: 'click' }>, { cache: false });
    this.ensureScope(pending.binding);
    if (settled.nothing) {
      this.warn('CLICK_UNPROVEN',
        `A click on ${pending.where} at ${pending.point[0]},${pending.point[1]} could not be proven to target an element and held nothing clickable, so it was not recorded`);
      return;
    }
    const target: ClickTarget = settled.target ?? { kind: 'point', point: pending.point };
    if (!settled.target) {
      this.warn('CLICK_UNPROVEN',
        `A click on ${pending.where} at ${pending.point[0]},${pending.point[1]} could not be proven to target an element; it is kept at its screen point and must be edited into an element before replay`);
    }
    const scope = this.windowScope(pending.binding);
    this.push({ kind: 'click', scope, target }, pending.at);
    if (target.kind === 'point') {
      this.pointClickWarning.set(this.steps.length - 1, new Set(['CLICK_UNPROVEN']));
    }
    const step = this.steps[this.steps.length - 1];
    if (step?.kind === 'click') {
      this.lastClick = {
        at: pending.at, point: pending.point, index: this.steps.length - 1,
        scope: scopeKey(scope), locator: locatorKey(target), button: 'left',
      };
    }
  }

  private push(step: StepDraft, at = this.eventAt) {
    if (this.steps.length >= this.stepLimit) {
      this.truncated = true;
      return;
    }
    this.steps.push({
      id: `s${this.steps.length + 1}`,
      atMs: this.stepTime(at),
      ...step,
    } as unknown as StepV2);
  }

  /**
   * A step's time is milliseconds from the recording's first step, so the
   * timeline reads from zero no matter how long the helper took to prove the
   * first window. It never runs backwards: a burst that settles late keeps the
   * time of the event it belongs to.
   */
  private stepTime(at: number) {
    const first = this.firstStepAt ??= at;
    // The step's own wall clock, so the flow can say when the recording began
    // even though its step times are the recording's active clock.
    this.firstStepWall ??= this.eventSeen - (this.eventAt - at);
    const atMs = Math.max(this.lastStepAt, Math.round(at - first));
    this.lastStepAt = atMs;
    return atMs;
  }

  /**
   * The finished flow is schema-validated. Semantic validation is skipped when a
   * gap remains, because a gap is exactly what `parseFlowV2` refuses: the file
   * still has to reach the workbench so the gap can be resolved there.
   */
  finish(): FlowV2 {
    this.ended = true;
    this.droppedText = undefined;
    // No focus ever proved the last held click was an activation.
    this.flushPendingGap();
    if (this.pendingDockGap) {
      // No focus ever named the app the Dock click started, so it started none.
      this.pendingDockGap = undefined;
      this.endBursts();
      this.warn('DOCK_CLICK_UNPROVEN',
        'A Dock click at the end of the recording was not recorded because no application changed focus');
    }
    if (this.pendingText) {
      // A buffered burst whose read never returned cannot be placed; dropping it
      // is better than a flow that silently loses every later step's order.
      this.pendingText = undefined;
      this.warn('UNTARGETED_TEXT',
        'A fallback tree read for buffered text did not finish before the recording ended; those characters were dropped');
    }
    this.endBursts();
    if (this.secureOpen) this.closeSecure();
    // The session is over: no window tree outlives it.
    this.dropTrees();
    if (this.startupDropped) {
      this.warn('CAPTURE_STARTUP',
        `${this.startupDropped} event(s) before the first recorded step had no replayable target and were dropped as startup noise`);
    }
    if (!this.steps.length) throw new Fault('EMPTY_RECORDING', 'No supported actions were captured');
    if (this.truncated) this.warn('STEP_LIMIT', `The flow retains the first ${this.stepLimit} steps`);
    const id = randomUUID();
    // The flow carries when the recording actually began and how long it was
    // paused, so a net timeline can be read back as a wall-clock stretch. Both
    // are optional: a flow recorded before these fields stays valid.
    const startedAt = this.firstStepWall === undefined
      ? undefined : new Date(this.firstStepWall).toISOString();
    const flow: FlowV2 = {
      version: 2,
      id: flowIdPattern.test(id) ? `global-${id.slice(0, 8)}` : 'global-recording',
      name: `${this.apps.size} 个 App / ${this.bindings.size} 个窗口的全局录制`,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(this.pausedMs > 0 ? { pausedMs: this.pausedMs } : {}),
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
  /**
   * Install/download observation while recording. `true` (the default) watches
   * the user's Downloads and application directories; `false` disables it; an
   * object overrides the directories, quiet window or read-only seams.
   */
  lifecycle?: boolean | LifecycleWatchOptions;
  /**
   * Called once, with the epoch-ms moment the helper began capturing. That is
   * the helper's own `readyAt`; when an older helper omits it, the moment its
   * ready line arrived is used instead. A supervisor dates the recording from
   * here, never from process start-up.
   */
  onReady?: (readyAt: number) => void;
}

export interface GlobalCaptureResult {
  flow: FlowV2;
  warnings: CaptureWarning[];
  partial: boolean;
  failure?: Fault;
  /**
   * The text behind each `type` step, keyed by parameter name. It is returned
   * separately from the flow so the CLI can write the sidecar: the flow, its
   * hash and its revisions never contain the value.
   */
  inputValues: Record<string, InputValueEntry>;
  /** Explicit lifecycle facts, for `lifecycle.json` next to the flow. */
  lifecycle: LifecycleEvent[];
  /** How many window trees the recording read; reused trees are not counted. */
  snapshotReads: number;
  /** Warnings that still describe a click kept at its screen point. */
  clickWarnings: string[];
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
 * Paused time from the helper's closing summary. A malformed number is a
 * protocol error, not something to guess around: the flow's step times are
 * already net of it.
 */
function sessionPausedMs(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Fault('CAPTURE_PROTOCOL', 'Capture helper reported an invalid paused time');
  }
  return value;
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
    (window, budgetMs) => {
      const budget = Math.max(1, Math.round(budgetMs ?? snapshotTimeoutMs));
      // The driver process gets a bounded margin over the observation budget, so
      // a fallback read (and its one retry) stays inside one short window instead
      // of the driver's own generous startup allowance.
      return desktop.snapshotWindow(`w-${window.windowNumber}`, window.windowTitle, budget, {
        forceElectronA11y: true,
        commandTimeoutMs: budget + snapshotCommandMarginMs,
      });
    },
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

  let ready = false;
  let failure: Fault | undefined;
  /** Paused time the helper reports when the session ends; zero if it never does. */
  let pausedMs = 0;
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
            'Capture helper did not confirm global mode. Rebuild it with npm run build:recorder', true);
        }
        if (options.indicator && !indicatorConfirmed(data.indicator)) {
          throw new Fault('INDICATOR_UNCONFIRMED',
            'Capture helper did not confirm the requested indicator state. Rebuild it with npm run build:recorder', true);
        }
        ready = true;
        clearTimeout(startupTimeout);
        sessionTimeout = setTimeout(() => child.kill('SIGKILL'), (options.seconds + 5) * 1000);
        // The helper dates `ready` itself; without that field the arrival of
        // the line is the closest observable moment. Neither is a sleep guess.
        const readyAt = typeof data.readyAt === 'number' && Number.isSafeInteger(data.readyAt) &&
          data.readyAt > 0 ? data.readyAt : Date.now();
        options.onReady?.(readyAt);
        await startWatcher();
        process.stderr.write(
          `Recording globally for up to ${options.seconds} seconds. Ctrl+Option+P pauses or resumes. ` +
          'Ctrl+Option+X stops and saves.\n');
        continue;
      }
      if (!ready) throw new Fault('CAPTURE_PROTOCOL', 'Input arrived before the helper was ready');
      if (data.kind === 'stopped') {
        pausedMs = sessionPausedMs(data.pausedMs);
        continue;
      }
      if (data.kind === 'warning') {
        const code = captureCode(data.code);
        // A warning that carries the helper's own bounded reason says what it
        // was about (`TAP_INTERRUPTED: timeout: previous callback 640 ms in
        // pointer`); one without keeps the message it always had.
        const detail = typeof data.detail === 'string' && /^[ -~]{1,240}$/.test(data.detail)
          ? `${code}: ${data.detail}`
          : `Some input may have been skipped: ${code}`;
        recording.warn(code, detail);
        continue;
      }
      if (data.kind === 'boundary') {
        recording.noteBoundary();
        continue;
      }
      // The helper announces a pickup so v1 can read the tree the gesture starts
      // from. v2 reads that tree when the drop arrives, so the announcement only
      // closes the current burst and is never an event of its own.
      if (data.kind === 'drag_start') {
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
    if (!ready) throw new Fault('CAPTURE_DEPENDENCY', 'Capture helper unavailable. Build it with npm run build:recorder', true);
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
  recording.notePausedMs(pausedMs);
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
    inputValues: recording.recordedInputValues(),
    snapshotReads: recording.snapshotReadCount,
    clickWarnings: recording.clickWarnings,
  };
}
