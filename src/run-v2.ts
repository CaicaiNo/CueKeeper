import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import type { IdentityDeps } from './app-identity.js';
import { evaluateAssertion } from './assertion.js';
import type { AssertionObservation } from './assertion.js';
import type { AssertCheck, ElementLocator } from './contracts.js';
import { defaultCheckpointTimeoutMs, defaultFileQuietMs, defaultWaitTimeoutMs } from './contracts-v2.js';
import type {
  AppWaitCheck, DeliveryV2, FileExistsCheck, FileScope, FileWaitCheck, FlowV2, ProcessRunningCheck,
  ProcessScope, ReportV2, ReportV2Entry, Scope, StepV2, WindowScope, WindowWaitCheck,
} from './contracts-v2.js';
import type { Delivery } from './contracts.js';
import { DesktopFault } from './desktop.js';
import type { ClickOptions, Desktop, DragEndpoint, WindowInfo } from './desktop.js';
import { parseFlowV2 } from './flow-v2.js';
import { InstallState } from './install-state.js';
import type { InstallStateDeps } from './install-state.js';
import { Fault, contains, flatten, resolve, toLocator } from './locator.js';
import type { Located, Node, Point, Snapshot } from './locator.js';
import { CheckpointFault, runHandOff } from './manual-checkpoint.js';
import type { CheckpointChannel, CheckpointMetadata } from './manual-checkpoint.js';
import { ReportV2Session } from './report-v2.js';
import type { AppIdentityRecord, StepResult } from './report-v2.js';
import { RunLease, ScopeResolver } from './scope.js';
import type { WindowBinding } from './scope.js';
import { SystemChecks } from './system-check.js';
import type { SystemCheckDeps } from './system-check.js';
import { assertWaitCheckSupported, waitFor } from './wait.js';
import type { WaitObservation } from './wait.js';

// Cross-app replay. Every step first resolves its scope to one window of one
// running process, then prepares that window, confirms the run still owns the
// foreground, dispatches, verifies delivery and moves on. A focus the run did
// not create, a restarted process or an uncertain delivery stops the run at that
// step instead of retrying or rebinding.

export interface FlowV2RunOptions {
  desktop: Desktop;
  signal: AbortSignal;
  /** Runtime values for `input` parameters, keyed by parameter name. */
  inputs?: Readonly<Record<string, string>>;
  /** Injected identity probe/filesystem seam; production uses the native helper. */
  identityDeps?: IdentityDeps;
  /** Override identity sessions, e.g. for tests. */
  identityFor?: (app: string) => AppIdentitySession;
  /** Foreground run lease; production state lives under ~/.cuekeeper. */
  lease?: RunLease;
  leaseDirectory?: string;
  runId?: string;
  launchTimeoutMs?: number;
  /** Directory holding `baselines/<sha256>.png` next to the flow file. */
  baselineDir?: string;
  /** Install/download/process evidence seam; production reads the local disk. */
  installState?: InstallState;
  installDeps?: InstallStateDeps;
  /** File/process state probes; production reads stat(2) and /bin/ps. */
  systemChecks?: SystemChecks;
  systemCheckDeps?: SystemCheckDeps;
  /** Streaming progress: one call per completed step. */
  onEntry?: (entry: import('./contracts-v2.js').ReportV2Entry) => void;
  /** Operator hand-off channel; a checkpoint without one blocks the run. */
  checkpoints?: CheckpointChannel;
  /** System secure input probe; a hand-off cannot prove recovery without it. */
  secureInputActive?: () => Promise<boolean>;
  /** Read-only visibility of supported macOS system dialogs. */
  systemDialogVisible?: () => Promise<boolean>;
}

type StepOutcome = Omit<StepResult, 'status'> & { status?: 'passed' | 'failed' };

/** The steps whose first event after a window switch waits for a ready target. */
type ReadinessGatedStep = Extract<StepV2, { kind: 'click' | 'type' | 'key' }>;

const blockingCodes = new Set([
  'APP_PATH_INVALID', 'APP_AMBIGUOUS', 'APP_NOT_FOUND', 'APP_UNVERIFIED',
  'AMBIGUOUS_TARGET', 'WINDOW_NOT_FOUND', 'WINDOW_CHANGED', 'FOCUS_INTERRUPTED',
  'IDENTITY_DEPENDENCY', 'RUN_BUSY', 'RUN_LEASE_FAILED', 'INPUT_MISSING',
  'SURFACE_UNSUPPORTED', 'MANUAL_CHECKPOINT_REQUIRED', 'MANUAL_CHECKPOINT_CANCELLED',
  'MANUAL_CHECKPOINT_TIMEOUT', 'SECURE_INPUT', 'SYSTEM_DIALOG_VISIBLE', 'WAIT_UNSUPPORTED',
  'UNSAFE_POINT', 'UNSAFE_TARGET', 'DELIVERY_UNCERTAIN', 'LAUNCH_TIMEOUT',
  'COMMAND_TIMEOUT', 'TIMEOUT', 'DESKTOP_DEPENDENCY', 'UNSUPPORTED_PLATFORM',
  'DOWNLOAD_PATH_INVALID', 'DOWNLOAD_NOT_FOUND', 'DOWNLOAD_INCOMPLETE',
  'DOWNLOAD_AMBIGUOUS', 'PROCESS_MISMATCH',
]);

// Steps that deliver input to the desktop. Before each one the run re-reads the
// system secure input flag: an unplanned password prompt stops the step.
const inputKinds = new Set<StepV2['kind']>([
  'click', 'type', 'key', 'scroll', 'drag', 'hover', 'paste',
]);

const transientWaitCodes = new Set(['NOT_FOUND', 'WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'INCOMPLETE_TREE']);

// Paste needs a control that accepts typed text; a non-editable first responder
// would swallow Cmd+V without an error.
const pasteEditable = new Set(['textfield', 'textbox', 'textarea', 'searchfield', 'combobox']);

function toFault(error: unknown): Fault {
  if (error instanceof Fault) return error;
  return new Fault('ACTION_FAILED', error instanceof Error ? error.message : 'Unknown error');
}

function deliveryOf(error: unknown): { delivery?: DeliveryV2 } {
  return error instanceof DesktopFault && error.delivery ? { delivery: error.delivery } : {};
}

/** A recorded element and, when one exists, the node that can press it. */
interface Actionable {
  /** The node the recorded locator resolved to. */
  node: Node;
  /** The nearest node in its chain that the driver can press. */
  press?: Node;
}

/** A control's identity in an operator-facing fault message. */
function describeControl(node: Node): string {
  const label = (node.name ?? node.value ?? node.text ?? '').trim() || node.identifier;
  return label ? `${node.role} "${label.slice(0, 80)}"` : node.role;
}

function actionable(snapshot: Snapshot, locator: ElementLocator): Actionable {
  let found: Located;
  try {
    found = resolve(snapshot, locator);
  } catch (error) {
    // Finder's list view names a file in the value of a textfield, while the
    // recording may address it as a row. A single name/value match is the same
    // element; anything ambiguous keeps the original NOT_FOUND.
    if (!(error instanceof Fault) || error.code !== 'NOT_FOUND' ||
        locator.identifier !== undefined || !locator.name) throw error;
    let candidates = flatten(snapshot.tree)
      .filter(({ node }) => node.name === locator.name || node.value === locator.name || node.text === locator.name);
    if (candidates.length > 1) {
      // The file name appears on the row label and on the editable text field;
      // the one that accepts input is the actionable candidate.
      const editableCandidates = candidates.filter(({ node }) => (node.actions ?? []).includes('SetValue'));
      if (editableCandidates.length === 1) {
        candidates = editableCandidates;
      } else {
        const actionableCandidates = candidates.filter(({ node }) =>
          node.ref && (node.actions ?? []).some(action => /^(click|press|rightclick)$/i.test(action)));
        if (actionableCandidates.length === 1) candidates = actionableCandidates;
      }
    }
    if (candidates.length !== 1) {
      const detail = candidates.map(({ node }) =>
        `${node.role}:${node.value ?? node.name ?? ''}[${(node.actions ?? []).join('|')}]`).join(', ');
      throw new Fault('NOT_FOUND',
        `Locator ${locator.role}:${locator.name} matched ${candidates.length} candidates fallback (${detail})`);
    }
    found = candidates[0];
  }
  const chain = chainTo(snapshot.tree, found.node) ?? [found.node];
  // A secure control is never pressed, nor is the container around it: a click
  // on a password field's frame is as unplanned as one on the field.
  if (found.node.secure) {
    throw new Fault('UNSAFE_TARGET', `${describeControl(found.node)} is a secure control`);
  }
  const clickable = (node: Node) => node.ref && !node.secure &&
    (node.actions ?? []).some(action => /^(click|press|axpress)$/i.test(action));
  // Finder's sidebar switches folders when the row is pressed; pressing the
  // cell inside it only selects the item. Prefer the row-level container, then
  // any clickable ancestor, then a bare ref for older drivers.
  const rowLevel = /^(treeitem|row|listitem|outlinerow|outlineitem)$/;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (rowLevel.test(chain[i].role) && clickable(chain[i])) return { node: found.node, press: chain[i] };
  }
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (clickable(chain[i])) return { node: found.node, press: chain[i] };
  }
  // An older driver reports no actions but does give a reference. The window,
  // application and page roots are not controls, though: pressing one is not
  // the click the flow recorded, so the walk stops below them.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (/^(window|application|webarea)$/.test(chain[i].role)) break;
    if (chain[i].ref && !chain[i].secure) return { node: found.node, press: chain[i] };
  }
  // Nothing in the chain carries an action reference. The element is still
  // exactly the recorded one, so a click can fall back to its own centre
  // instead of pressing a neighbouring control; a step that needs a reference
  // of its own reports which control was missing one.
  return { node: found.node };
}

/** The reference a step that can only press requires, or a fault naming why. */
function pressRef(target: Actionable, what: string): string {
  if (!target.press?.ref) {
    throw new Fault('UNSAFE_TARGET',
      `${describeControl(target.node)} has no action reference to ${what}; edit the step and pick the target again`);
  }
  return target.press.ref;
}

/**
 * The centre of a control that cannot be pressed. The click is physical, so the
 * point must be inside the bound window: this is the same containment the
 * coordinate path enforces, and the driver re-reads the window before delivery.
 */
function centreOf(node: Node, snapshot: Snapshot): Point {
  const bounds = node.bounds;
  if (!bounds) {
    throw new Fault('UNSAFE_TARGET',
      `${describeControl(node)} has no action reference and no bounds to click; ` +
      'edit the step and pick the target from the window again');
  }
  const point: Point = [
    Math.round(bounds.x + bounds.width / 2),
    Math.round(bounds.y + bounds.height / 2),
  ];
  if (!contains(snapshot.tree.bounds, point)) {
    throw new Fault('UNSAFE_POINT',
      `${describeControl(node)} sits outside the bound window; edit the step and pick the target again`);
  }
  return point;
}

/**
 * A semantic AX press that fails right after its window was raised is usually
 * racing the app's own re-render: the tree answered, but the control did not
 * accept a press yet. One re-read after this pause gives the app a chance to
 * settle without turning a failure into a retry loop.
 */
const clickRetryDelayMs = 300;

/**
 * A hover settles for at least this long even when the recording saw the
 * pointer leave sooner: an app that opens a tooltip or a submenu needs the
 * pointer to rest, and a next step that reads that state would otherwise race.
 */
const hoverDwellFloorMs = 400;

/**
 * A window that was just raised answers the accessibility read before it
 * accepts input: an Electron page in particular exposes a control's reference
 * while its press still fails. The first input after a switch therefore reads
 * the target twice, this far apart, and only delivers once both reads name the
 * same enabled control in the same place.
 */
const readinessProbeIntervalMs = 200;

/**
 * The bound on that proof. It is short on purpose: an app that cannot expose an
 * enabled, stable control for this long is not still loading, and the run says
 * so instead of pressing into a half-drawn page.
 */
const readinessProofTimeoutMs = 1500;

/** Steps whose first event after a window switch waits for a ready target. */
const readinessGated = new Set<StepV2['kind']>(['click', 'type', 'key']);

/** A read the proof cannot use because the window was not there yet. */
const readinessTransientCodes = new Set([...transientWaitCodes, 'WINDOW_CHANGED']);

/**
 * True when a step leaves a window the run raised in front of the next step.
 * A wait and a hover take no focus, so their declared hand-off is not one.
 */
function switchesWindow(step: StepV2): boolean {
  if (step.kind === 'activate_app' || step.kind === 'focus_window') return true;
  if (step.kind === 'wait' || step.kind === 'hover') return false;
  return (step as { focusAfter?: Scope }).focusAfter !== undefined;
}

/** What must hold still for two reads to prove the same control. */
function readinessSignature(node: Node): string {
  const bounds = node.bounds;
  return `${node.role}|${node.name ?? ''}|${node.identifier ?? ''}|` +
    (bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'no-bounds');
}

/** The same proof for a step that names no control: the bound window itself. */
function windowReadinessSignature(snapshot: Snapshot): string {
  const bounds = snapshot.tree.bounds;
  return `${snapshot.windowId}|` +
    (bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : 'no-bounds');
}

/** One read of the bound window, reduced to what the proof compares. */
interface ReadinessRead {
  /** Empty when this read proves nothing yet; two equal non-empty values pass. */
  signature?: string;
  /** Why this read did not prove the target, for the timeout message. */
  problem: string;
  /** The step's own refusal applies (secure or unpressable target); it reports it. */
  refuse?: boolean;
}

/**
 * What a type step's characters are typed into, decided once and shared by the
 * readiness proof and the dispatch, so the field that is proved is the field
 * that is typed into.
 */
type TypeDispatch =
  /** `type <ref> --stdin`, optionally after clicking the field for focus. */
  | { via: 'reference'; node: Node; clickFirst: boolean }
  /** Click the rename field, then type into the first responder it becomes. */
  | { via: 'rename-field'; node: Node }
  /** Finder's inline rename editor: click the row's name column, then type. */
  | { via: 'inline-rename' }
  /** The focused cell/row hosts the editor: type into the first responder. */
  | { via: 'focused-host'; node: Node }
  /** More than one control claims the characters; dispatch does not guess. */
  | { via: 'ambiguous'; reason: string }
  /** The step's own dispatch refuses this target. */
  | { via: 'refused'; reason: string };

/** A locator's identity in a readiness fault message. */
function describeLocator(locator: ElementLocator): string {
  const name = (locator.name ?? '').trim();
  if (name) return `${locator.role ?? 'element'} "${name.slice(0, 80)}"`;
  return locator.identifier
    ? `${locator.role ?? 'element'} [${locator.identifier}]`
    : (locator.role ?? 'the target');
}

/** What a gated step acts on, for a readiness fault message. */
function describeTarget(step: ReadinessGatedStep): string {
  if (step.kind === 'key') return 'the bound window';
  if (step.kind === 'click' && step.target.kind === 'point') return 'the bound window';
  return describeLocator(step.target as ElementLocator);
}

/**
 * The screen point a hover rests on. A recorded point wins when it still lands
 * inside the resolved control — or when the control has no bounds to compare
 * against, which is exactly the anonymous-container case the point exists for.
 * A point outside that control falls back to its centre; a point outside the
 * bound window is refused, because moving the pointer to another window would
 * be a different action, not a hover of this step.
 */
function hoverPoint(node: Node, recorded: Point | undefined, snapshot: Snapshot): Point {
  if (recorded) {
    if (!contains(snapshot.tree.bounds, recorded)) {
      throw new Fault('UNSAFE_POINT',
        `The recorded hover point ${recorded.join(',')} is outside the bound window; ` +
        'the window moved or resized since the recording — edit the step and pick the target again');
    }
    if (!node.bounds || contains(node.bounds, recorded)) return recorded;
  }
  if (!node.bounds) {
    throw new Fault('HOVER_UNRESOLVED', `${describeControl(node)} has no bounds to move to`);
  }
  const centre: Point = [
    Math.round(node.bounds.x + node.bounds.width / 2),
    Math.round(node.bounds.y + node.bounds.height / 2),
  ];
  if (!contains(snapshot.tree.bounds, centre)) {
    throw new Fault('UNSAFE_POINT', `${describeControl(node)} sits outside the bound window`);
  }
  return centre;
}

/** The item a right click on a container really targets. */
function rightClickTarget(snapshot: Snapshot, button: string | undefined, locator: ElementLocator): ElementLocator {
  if (button !== 'right') return locator;
  const containers = new Set(['outline', 'list', 'table', 'tree', 'group', 'scrollarea']);
  if (!containers.has(locator.role ?? '')) return locator;
  const selected = flatten(snapshot.tree).filter(({ node }) => node.ref && node.states.includes('selected'));
  // The file name in Finder's list view is a textfield that accepts RightClick;
  // the row around it may only accept Click.
  const rightClickable = selected.filter(({ node }) => (node.actions ?? []).includes('RightClick'));
  if (rightClickable.length === 1) {
    const locator = toLocator(snapshot, rightClickable[0]);
    if (!locator.name) locator.name = rightClickable[0].node.value ?? '';
    return locator;
  }
  const item = selected.filter(({ node }) =>
    /^(row|cell|treeitem|listitem|outlinerow|outlineitem|textfield)$/.test(node.role));
  if (item.length !== 1) return locator;
  return toLocator(snapshot, item[0]);
}

/**
 * A point inside the file-name column of a row. Finder's inline rename editor
 * replaces the name textfield without exposing a new AX node, so replay keeps
 * this point to click into the editor and give it keyboard focus.
 */
function rowNamePoint(node: Node): Point | undefined {
  if (!/^(treeitem|row|listitem|outlinerow|outlineitem)$/.test(node.role)) return undefined;
  const cell = node.children.find(child => child.role === 'cell');
  const label = cell?.children.find(child => /^(textfield|statictext)$/.test(child.role))
    ?? cell?.children.find(child => child.role === 'image');
  const bounds = label?.bounds ?? cell?.bounds;
  if (!bounds || bounds.width < 2 || bounds.height < 2) return undefined;
  return [
    bounds.x + Math.min(bounds.width / 2, 24),
    bounds.y + bounds.height / 2,
  ];
}

/** Root-to-node chain in the window tree, or undefined when the node is absent. */
function chainTo(tree: Node, target: Node): Node[] | undefined {
  if (tree === target) return [tree];
  for (const child of tree.children) {
    const chain = chainTo(child, target);
    if (chain) return [tree, ...chain];
  }
  return undefined;
}

/**
 * A click target without a name or an identifier proves nothing: the recording
 * saw an element it could not address, so any same-role element in the window
 * would satisfy it. Refusing here is what keeps an unnamed AXTextField from
 * being clicked silently. An identifier is an identity of its own — Chromium's
 * AXDOMIdentifier and Cocoa's AXIdentifier address controls that carry no name.
 */
function addressable(locator: ElementLocator): ElementLocator {
  if (locator.name === '' && !locator.identifier) {
    throw new Fault('AMBIGUOUS',
      'A recorded element target has no name or identifier; edit the step into a named element before replay');
  }
  return locator;
}

/**
 * The test a window must pass to be the one a step was recorded in. A window
 * holds the step when it contains the recorded point, or when its tree
 * addresses the recorded element exactly once. A test returns undefined when
 * the tree cannot rule the window in or out.
 */
function windowTest(step: StepV2): ((snapshot: Snapshot) => boolean | undefined) | undefined {
  const points: Point[] = [];
  const locators: ElementLocator[] = [];
  if (step.kind === 'click') {
    if (step.target.kind === 'point') points.push(step.target.point);
    else locators.push(step.target);
  } else if (step.kind === 'hover' || step.kind === 'scroll' || step.kind === 'type' || step.kind === 'paste') {
    locators.push(step.target);
  } else if (step.kind === 'drag') {
    locators.push(step.from, step.to);
  }
  if (!points.length && !locators.length) return undefined;
  return snapshot => {
    if (points.length && !snapshot.tree.bounds) return undefined;
    if (!points.every(point => contains(snapshot.tree.bounds, point))) return false;
    try {
      for (const locator of locators) resolve(snapshot, addressable(locator));
      return true;
    } catch (error) {
      return error instanceof Fault && error.code === 'NOT_FOUND' ? false : undefined;
    }
  };
}

function dragEndpoint(snapshot: Snapshot, locator: ElementLocator): DragEndpoint {
  const { node } = resolve(snapshot, locator);
  if (!node.ref) throw new Fault('UNSAFE_TARGET', 'Drag endpoint has no action reference');
  if (node.secure) throw new Fault('UNSAFE_TARGET', 'Drag endpoint is secure');
  return { ref: node.ref };
}

/** Wheel intent a semantic scroll posts, from either scroll shape. */
function scrollIntent(step: Extract<StepV2, { kind: 'scroll' }>): {
  direction: 'up' | 'down' | 'left' | 'right'; amount: number;
} {
  if ('direction' in step) return { direction: step.direction, amount: step.amount };
  const { deltaX, deltaY } = step;
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX) && deltaY !== 0;
  const magnitude = Math.abs(vertical ? deltaY : deltaX);
  return {
    direction: vertical ? (deltaY > 0 ? 'up' : 'down') : (deltaX > 0 ? 'right' : 'left'),
    amount: Math.max(1, Math.min(1000, Math.round(magnitude))),
  };
}

/** A wait's scope and condition for the timeout message; never a captured value. */
function waitDescription(step: Extract<StepV2, { kind: 'wait' }>): string {
  const check = step.check as { kind: string; equals?: boolean; expect?: { property?: string } };
  if (step.scope.kind === 'file') {
    const name = 'name' in step.scope ? step.scope.name : `*${step.scope.suffix}`;
    return `file ${name}; ${check.kind}`;
  }
  const condition = check.kind === 'element' || check.kind === 'window'
    ? (check.expect?.property ?? 'condition')
    : `${check.kind} = ${String(check.equals)}`;
  const scope = step.scope.kind === 'app'
    ? `app ${step.scope.app}`
    : `window ${step.scope.app}/${step.scope.windowKey}`;
  return `${scope}; ${condition}`;
}

function assertionOutcome(observation: AssertionObservation): StepOutcome {
  if (observation.passed) {
    return observation.message === undefined ? {} : { message: observation.message };
  }
  return {
    status: 'failed',
    code: observation.code ?? 'ASSERTION_FALSE',
    message: observation.message ?? 'Assertion did not match',
  };
}

/** Every app a flow names, in flow order. */
function flowApps(flow: FlowV2): string[] {
  const apps = new Set<string>();
  const add = (scope: Scope | undefined) => {
    if (!scope) return;
    if (scope.kind === 'window' || scope.kind === 'app') apps.add(scope.app);
    else if (scope.kind === 'surface' &&
        (scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu')) apps.add(scope.app);
    // A file or process scope names no app: it observes the machine only.
  };
  for (const step of flow.steps) {
    if (step.kind === 'gap') continue;
    add(step.scope);
    add((step as { focusAfter?: Scope }).focusAfter);
    if (step.kind === 'manual_checkpoint') add(step.resume.scope);
  }
  for (const intent of flow.intents ?? []) {
    for (const effect of intent.observableEffects) add(effect.scope);
  }
  return [...apps];
}

/** The recorded title a first window bind searches for, per app. */
function recordedTitles(flow: FlowV2): Map<string, string> {
  const titles = new Map<string, string>();
  for (const step of flow.steps) {
    if (step.kind === 'gap' || step.scope.kind !== 'window') continue;
    if (!titles.has(step.scope.app)) titles.set(step.scope.app, step.scope.windowTitle);
  }
  return titles;
}

class StepRunner {
  constructor(private readonly ctx: {
    desktop: Desktop;
    resolver: ScopeResolver;
    signal: AbortSignal;
    inputs: Readonly<Record<string, string>>;
    install: InstallState;
    system: SystemChecks;
    appPaths: Readonly<Record<string, string>>;
    baselineDir?: string;
    checkpoints?: CheckpointChannel;
    secureInputActive?: () => Promise<boolean>;
    systemDialogVisible?: () => Promise<boolean>;
    /** True when a checkpoint in the flow makes secure-state proof mandatory. */
    requireSecureState: boolean;
  }) {}

  private get desktop() { return this.ctx.desktop; }
  private get resolver() { return this.ctx.resolver; }
  private get signal() { return this.ctx.signal; }

  /** The element the last left click landed on, for a container's context menu. */
  private lastClickTarget?: ElementLocator;
  /** Where that click landed, so a rename field can be found in place. */
  private lastClickPoint?: Point;
  /** True after a Rename menu item opened Finder's inline editor. */
  private inlineRename = false;
  /** A point in the clicked row's name column, for focusing the inline editor. */
  private lastRowNamePoint?: Point;
  /** True after this run raised a window; the next input proves its target first. */
  private pendingWindowSwitch = false;

  /** Per-step file stability memory: size, mtime and when they last changed. */
  private readonly fileStability = new Map<string, { size: number; mtimeMs: number; since: number }>();

  async run(step: StepV2): Promise<StepOutcome> {
    this.signal.throwIfAborted();
    if (step.kind === 'drag' && (step.path?.length ?? 0) > 0) {
      // P2 has no raw coordinates: a recorded pointer path cannot be proven to
      // belong to the bound window, so the step stops instead of replaying it.
      throw new Fault('UNSAFE_POINT', 'P2 replay does not accept recorded pointer paths');
    }
    // A password prompt the flow did not declare is an unknown secure interface.
    if (inputKinds.has(step.kind)) {
      await this.guardSecureInput();
      if (await this.ctx.systemDialogVisible?.()) {
        throw new Fault('SYSTEM_DIALOG_VISIBLE', 'A macOS system dialog is already visible before automatic input');
      }
    }
    // A context-menu item is pressed through the menu's own surface, whose
    // open-and-retry path already outlasts a repaint; it consumes the switch
    // without the readiness proof (which reads a window, not a menu).
    if (step.kind === 'click' && step.target.kind === 'element' && step.target.role === 'menuitem') {
      this.pendingWindowSwitch = false;
    }
    const outcome = await this.dispatch(step);
    if (switchesWindow(step)) this.pendingWindowSwitch = true;
    return { ...outcome, ...await this.handOff(step) };
  }

  /**
   * The readiness proof for the first input after a window switch. It resolves
   * the bound window, brings it forward and reads it twice, readinessProbeIntervalMs
   * apart, and hands back the window and the exact snapshot the step will
   * dispatch from. Each read proves the target the step itself will act on, with
   * the step's own selection rules: the same enabled control in the same place,
   * on the same window of the same process instance. Only a read-only resolve is
   * used — preparing a window is the step's own business — and one monotonic
   * deadline ends window selection, focus, identity checks and snapshot reads,
   * including a driver call that never answers: a result that lands after it is
   * refused instead of used, and nothing is dispatched.
   */
  private async awaitReadyWindow(step: ReadinessGatedStep): Promise<{ binding: WindowBinding; snapshot: Snapshot }> {
    // The same same-title disambiguation the step itself will use: the gate must
    // not turn a window the flow can prove into an ambiguity, and a window that
    // does not hold the target yet is "not ready", not ambiguous.
    const pick = (candidates: WindowInfo[]) => this.pickSameTitled(candidates, step, { prove: true });
    const deadline = performance.now() + readinessProofTimeoutMs;
    const remaining = () => deadline - performance.now();
    // One signal for the whole proof. It is cancelled at the deadline so a read
    // that finishes late cannot start the focus command it was waiting for.
    const cancel = new AbortController();
    const cutoff = setTimeout(() => cancel.abort(
      new Fault('TARGET_NOT_READY', 'The readiness deadline passed before the window could be focused')),
      readinessProofTimeoutMs);
    const fail = (problem: string, reads: number): Fault => new Fault('TARGET_NOT_READY',
      `${describeTarget(step)} was not ready ${readinessProofTimeoutMs} ms after the window was brought forward: ` +
      `${problem} (${reads} read${reads === 1 ? '' : 's'}); no input was delivered`);
    let previous: string | undefined;
    let problem = 'the window has not been read yet';
    let reads = 0;
    // The window is resolved and brought forward once; every later read reuses
    // that binding and only the read itself re-proves the owner. A read that
    // says the window moved, closed or was recreated resolves it again.
    let binding: WindowBinding | undefined;
    try {
      for (;;) {
        this.signal.throwIfAborted();
        let snapshot: Snapshot | undefined;
        let read: ReadinessRead | undefined;
        try {
          if (binding === undefined) {
            binding = await this.withinDeadline(
              this.resolver.resolveWindow(step.scope, pick, { repair: false }), deadline, () => fail(problem, reads));
            await this.withinDeadline(
              this.resolver.confirmForeground(binding, cancel.signal), deadline, () => fail(problem, reads));
          }
          snapshot = await this.withinDeadline(
            this.resolver.snapshot(binding!), deadline, () => fail(problem, reads));
          reads += 1;
          read = this.readinessOf(snapshot, binding!, step);
        } catch (error) {
          const fault = toFault(error);
          // The cancellation that ended the proof says nothing about the target;
          // the last read's own state is the message the operator needs.
          if (fault.code === 'TARGET_NOT_READY' && cancel.signal.aborted) throw fail(problem, reads);
          if (!readinessTransientCodes.has(fault.code)) throw error;
          problem = `${fault.code}: ${fault.message}`;
          binding = undefined;
        }
        // A read or a selection that outlived the deadline is not evidence.
        if (remaining() <= 0) throw fail(read?.problem ?? problem, reads);
        if (read?.refuse) return { binding: binding!, snapshot: snapshot! };
        if (read?.signature !== undefined && read.signature === previous) {
          // The windows were read over a moment in which the operator can take
          // the foreground away. Dispatch only happens while the run still
          // owns it; a switch since the first read stops the step with zero
          // input, and the check itself stays inside the proof's budget.
          await this.withinDeadline(
            this.resolver.confirmForeground(binding!, cancel.signal), deadline, () => fail(problem, reads));
          return { binding: binding!, snapshot: snapshot! };
        }
        previous = read?.signature;
        if (read !== undefined) problem = read.problem;
        await sleep(Math.max(0, Math.min(readinessProbeIntervalMs, remaining())), undefined, { signal: this.signal });
      }
    } finally {
      clearTimeout(cutoff);
      // Whatever ended the proof, a read that lands afterwards must not start
      // the focus command it was waiting for.
      if (!cancel.signal.aborted) {
        cancel.abort(new Fault('TARGET_NOT_READY', 'The readiness proof ended before the window could be focused'));
      }
    }
  }

  /**
   * Runs one desktop operation under the readiness deadline. A driver call that
   * never answers cannot be cancelled, but nothing waits for it past the
   * deadline and its late result is dropped, so it can neither be acted on nor
   * turn into input.
   */
  private async withinDeadline<T>(work: Promise<T>, deadline: number, fail: () => Fault): Promise<T> {
    // A late result or rejection belongs to this call, not to the process.
    void work.catch(() => undefined);
    const left = deadline - performance.now();
    if (left <= 0) throw fail();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(fail()), Math.max(1, left));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * What one read says about the target, using the step's own dispatch rules:
   * the right click's selected row, or the control a type step would type into.
   * A secure or unpressable target is the step's own refusal; a target that is
   * missing, moving or disabled is not ready yet.
   */
  private readinessOf(snapshot: Snapshot, binding: WindowBinding, step: ReadinessGatedStep): ReadinessRead {
    const window = `${binding.windowId}|${binding.pid}|${binding.processInstance ?? ''}`;
    const settledWindow = (): ReadinessRead => snapshot.tree.bounds === undefined
      ? { problem: 'the window has no bounds to prove it has settled' }
      : {
        signature: `${window}|${windowReadinessSignature(snapshot)}`,
        problem: 'the window bounds were still changing between reads',
      };
    if (step.kind === 'key' || (step.kind === 'click' && step.target.kind === 'point')) return settledWindow();
    if (step.kind === 'type') {
      let plan: TypeDispatch;
      try {
        plan = this.typeDispatch(snapshot, step);
      } catch (error) {
        const fault = toFault(error);
        if (fault.code === 'NOT_FOUND' || fault.code === 'AMBIGUOUS') {
          return { problem: `${describeTarget(step)} is still not provable (${fault.code})` };
        }
        if (fault.code === 'UNSAFE_TARGET') return { problem: fault.message, refuse: true };
        throw error;
      }
      if (plan.via === 'refused') return { problem: plan.reason, refuse: true };
      // A target that still names two controls is not proved yet; the next read
      // may settle it, and one that never does ends as a readiness fault.
      if (plan.via === 'ambiguous') return { problem: plan.reason };
      // The inline rename editor is not an addressable control; the window it
      // appears in is what can be proved. The focused host is a real node and
      // is proved like any other target (a secure one is refused).
      if (plan.via === 'inline-rename') return settledWindow();
      return this.proveNode(window, plan.node);
    }
    let resolved: Actionable;
    try {
      resolved = this.clickTargetOf(step, snapshot).resolved;
    } catch (error) {
      const fault = toFault(error);
      if (fault.code === 'UNSAFE_TARGET') return { problem: fault.message, refuse: true };
      if (fault.code === 'NOT_FOUND' || fault.code === 'AMBIGUOUS') {
        return { problem: `${describeTarget(step)} is still not provable (${fault.code})` };
      }
      throw error;
    }
    if (resolved.press && resolved.press !== resolved.node) {
      const press = this.proveNode(window, resolved.press);
      if (press.signature === undefined) return press;
      const node = this.proveNode(window, resolved.node);
      if (node.signature === undefined) return node;
      return { signature: `${node.signature}|${press.signature}`, problem: node.problem };
    }
    return this.proveNode(window, resolved.node);
  }

  /** One control's part of the readiness signature, with the window it lives in. */
  private proveNode(window: string, node: Node): ReadinessRead {
    if (node.secure) return { problem: `${describeControl(node)} is a secure control`, refuse: true };
    if (node.states.includes('disabled')) return { problem: `${describeControl(node)} is still disabled` };
    return {
      signature: `${window}|${readinessSignature(node)}`,
      problem: `${describeControl(node)} was still changing between reads`,
    };
  }

  /**
   * The control a click step presses, chosen exactly as its own dispatch chooses
   * it: a container right click targets the row selected inside it, and the
   * previous click names it when the tree does not.
   */
  private clickTargetOf(
    step: Extract<StepV2, { kind: 'click' }>,
    snapshot: Snapshot,
  ): { locator: ElementLocator; resolved: Actionable } {
    const target = step.target as ElementLocator;
    const locator = step.button === 'right' && target.identifier === undefined
      ? (this.lastClickTarget ?? rightClickTarget(snapshot, step.button, target))
      : target;
    return { locator, resolved: actionable(snapshot, addressable(locator)) };
  }

  /**
   * The control a type step's characters land in, decided exactly as the step
   * dispatches them. One decision, read by both the proof and the dispatch.
   */
  private typeDispatch(snapshot: Snapshot, step: Extract<StepV2, { kind: 'type' }>): TypeDispatch {
    const locator = step.target as ElementLocator;
    // An identifier is an explicit identity: address that control directly.
    // The heuristics below find an unnamed inline rename editor that the tree
    // cannot address; they must never redirect a recorded identifier's text
    // into whichever editable control happens to be focused.
    if (locator.identifier !== undefined) {
      const { node } = resolve(snapshot, locator);
      if (!node.ref || node.secure) {
        return { via: 'refused', reason: 'Type target is secure or has no action reference' };
      }
      return { via: 'reference', node, clickFirst: false };
    }
    // Finder's inline rename editor is not in the accessibility tree. The
    // Rename menu item opened it, but a semantic menu press leaves keyboard
    // focus on the list. Clicking the name column makes the field editor the
    // first responder; Cmd+A then replaces the whole name, so a recorded
    // full file name is not appended to the old base name.
    if (this.inlineRename && !locator.name) return { via: 'inline-rename' };
    // A recorded rename field has no name of its own: the editor appears in
    // place and several textfields may exist. The focused editable control is
    // the one that received the characters, and it has to be the only one: two
    // controls claiming focus cannot say which one the characters belong to.
    const focusedFields = locator.name ? [] : flatten(snapshot.tree).filter(({ node }) =>
      node.ref && node.states.includes('focused') &&
      /^(textfield|textbox|textarea|searchfield|combobox)$/.test(node.role));
    if (focusedFields.length > 1) {
      const names = focusedFields.map(({ node }) => describeControl(node)).join(', ');
      return { via: 'ambiguous', reason: `${focusedFields.length} editable controls reported focus (${names})` };
    }
    const focused = focusedFields[0];
    // A rename editor opens exactly where the file was clicked. When AX does
    // not flag the focused field, the editable control nearest that point is
    // the one the recorded characters landed in.
    // The rename editor is the text field of the file that was clicked: its
    // value still holds the old file name. That is stronger evidence than a
    // distance guess.
    const clickName = this.lastClickTarget?.name;
    const byNameMatches = focused || locator.name || !clickName ? [] : flatten(snapshot.tree).filter(({ node }) =>
      /^(textfield|textbox|textarea|searchfield|combobox)$/.test(node.role) &&
      (node.value === clickName || node.name === clickName));
    if (byNameMatches.length > 1) {
      return {
        via: 'ambiguous',
        reason: `${byNameMatches.length} editable controls carry the clicked name "${clickName}"`,
      };
    }
    const byName = byNameMatches[0];
    /** The closest candidate, or a tie when two sit at the same distance. */
    const closest = (candidates: { entry: Located; distance: number }[]): Located | 'tied' | undefined => {
      if (!candidates.length) return undefined;
      if (candidates.length > 1 && candidates[1].distance - candidates[0].distance < 0.5) return 'tied';
      return candidates[0].entry;
    };
    const nearPick = focused || byName || locator.name || !this.lastClickPoint ? undefined : closest(
      flatten(snapshot.tree).filter(({ node }) =>
        node.ref && /^(textfield|textbox|textarea|searchfield|combobox)$/.test(node.role) && node.bounds)
        .map(entry => {
          const b = entry.node.bounds!;
          const dx = b.x + b.width / 2 - this.lastClickPoint![0];
          const dy = b.y + b.height / 2 - this.lastClickPoint![1];
          return { entry, distance: Math.hypot(dx, dy) };
        })
        .filter(candidate => candidate.distance <= 120)
        .sort((a, b) => a.distance - b.distance));
    if (nearPick === 'tied') {
      return { via: 'ambiguous', reason: 'two editable controls sat equally close to the last click' };
    }
    const near = nearPick;
    // Finder's rename editor is not exposed as an editable element: AX shows
    // only the focused cell. A focused editable control elsewhere in the
    // window means the recorded characters belong there instead.
    const hosts = focused || locator.name ? [] : flatten(snapshot.tree).filter(({ node }) =>
      node.ref && node.states.includes('focused') && /^(cell|row|treeitem)$/.test(node.role));
    if (hosts.length > 1) {
      return { via: 'ambiguous', reason: `${hosts.length} rows or cells reported focus` };
    }
    const host = hosts[0];
    // The editor is usually a nameless textfield where the file name was.
    // Click it first: it has no AX focus of its own.
    const renamePick = !this.lastClickPoint || locator.name ? undefined : closest(
      flatten(snapshot.tree)
        .filter(({ node }) => node.role === 'textfield' && node.ref && node.bounds)
        .map(entry => {
          const b = entry.node.bounds!;
          const dx = b.x + b.width / 2 - this.lastClickPoint![0];
          const dy = b.y + b.height / 2 - this.lastClickPoint![1];
          return { entry, distance: Math.hypot(dx, dy) };
        })
        .filter(candidate => candidate.distance <= 120)
        .sort((a, b) => a.distance - b.distance));
    if (renamePick === 'tied') {
      return { via: 'ambiguous', reason: 'two rename fields sat equally close to the last click' };
    }
    if (renamePick) {
      return renamePick.node.secure
        ? { via: 'refused', reason: `${describeControl(renamePick.node)} is a secure control; the run does not type into it` }
        : { via: 'rename-field', node: renamePick.node };
    }
    if (host) {
      return host.node.secure
        ? { via: 'refused', reason: `${describeControl(host.node)} is a secure control; the run does not type into it` }
        : { via: 'focused-host', node: host.node };
    }
    const direct = focused ?? byName ?? near;
    if (direct) {
      return direct.node.secure
        ? { via: 'refused', reason: `${describeControl(direct.node)} is a secure control; the run does not type into it` }
        : { via: 'reference', node: direct.node, clickFirst: Boolean(byName || near) };
    }
    const resolved = actionable(snapshot, addressable(locator));
    if (!resolved.press) {
      return {
        via: 'refused',
        reason: `${describeControl(resolved.node)} has no action reference to type into; ` +
          'edit the step and pick the target again',
      };
    }
    if (resolved.press.secure) {
      return { via: 'refused', reason: `${describeControl(resolved.press)} is a secure control; the run does not type into it` };
    }
    return { via: 'reference', node: resolved.press, clickFirst: false };
  }

  /**
   * The readiness wait can span a password prompt or a system dialog, so the
   * gate that ran before it is re-checked before the first event is posted.
   */
  private async recheckInputGates(): Promise<void> {
    await this.guardSecureInput();
    if (await this.ctx.systemDialogVisible?.()) {
      throw new Fault('SYSTEM_DIALOG_VISIBLE',
        'A macOS system dialog appeared while the window was becoming ready; the run stops instead of typing into it');
    }
  }

  /**
   * Reads the system secure input flag before automatic input. When the flow has
   * no checkpoint, a helper that cannot report the flag keeps the older
   * unprotected behaviour instead of blocking every existing flow.
   */
  private async guardSecureInput() {
    const probe = this.ctx.secureInputActive;
    if (!probe) {
      if (this.ctx.requireSecureState) throw this.missingSecureProbe();
      return;
    }
    let secure: boolean;
    try {
      secure = await probe();
    } catch (error) {
      if (this.ctx.requireSecureState) throw toFault(error);
      return;
    }
    if (secure) {
      throw new Fault('SECURE_INPUT',
        'macOS secure input is active; the run stops instead of typing into an unplanned password prompt');
    }
  }

  private missingSecureProbe() {
    return new Fault('MANUAL_CHECKPOINT_REQUIRED',
      'A flow with manual checkpoints needs the secure input probe; rebuild the capture helper with npm run build:recorder', true);
  }

  /**
   * Clicks an item in the open context menu. A menu is an app-level surface:
   * it never appears in the window tree, so the window replay path cannot see
   * it. The menu is read through its own surface and the item pressed by ref.
   */
  private async menuStep(step: Extract<StepV2, { kind: 'click' }>): Promise<StepOutcome> {
    const target = step.target as ElementLocator;
    const readMenu = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          return await this.desktop.snapshotSurface('menu');
        } catch {
          await sleep(100);
        }
      }
      return undefined;
    };
    const findItem = (menu: Snapshot) => flatten(menu.tree).filter(({ node }) =>
      node.role === 'menuitem' && !node.states.includes('disabled') &&
      (node.name === target.name || node.value === target.name));

    let menu = await readMenu();
    if (!menu) throw new Fault('ELEMENT_NOT_FOUND', 'The context menu did not open');
    let items = findItem(menu);
    if (items.length !== 1) {
      throw new Fault('NOT_FOUND',
        `Menu item "${target.name ?? ''}" matched ${items.length}; the context menu may not be open`);
    }

    let delivery;
    try {
      delivery = await this.desktop.clickSemantic(items[0].node.ref!);
    } catch {
      // The menu can close between the snapshot and the press. Reopen it at the
      // recorded click point and try once more before falling back to a
      // physical click on the item's centre.
      if (this.lastClickPoint) {
        await this.desktop.clickScreen(this.lastClickPoint, { button: 'right' }).catch(() => undefined);
        await sleep(500);
        const reopened = await readMenu();
        if (reopened) {
          menu = reopened;
          items = findItem(reopened);
          if (items.length === 1) {
            try {
              delivery = await this.desktop.clickSemantic(items[0].node.ref!);
            } catch {
              // fall through to the physical click below
            }
          }
        }
      }
    }
    if (delivery === undefined) {
      const bounds = items[0]?.node.bounds;
      if (!bounds) throw new Fault('UNSAFE_TARGET', 'Menu item has no bounds to click');
      delivery = await this.desktop.clickScreen(
        [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
        { button: step.button === 'right' ? 'right' : 'left' },
      );
    }
    // A rename item turns the file name into an inline editor that the window
    // tree does not expose. The next type step must use the keyboard focus the
    // menu just set, not click a neighbouring file name.
    if (/重新命名|重命名|rename/i.test(target.name ?? '')) this.inlineRename = true;
    // The rename editor appears after the menu closes; give Finder a moment
    // before the next step reads the window.
    await sleep(300);
    return delivery === undefined ? {} : { delivery };
  }

  private async dispatch(step: StepV2): Promise<StepOutcome> {
    switch (step.kind) {
      case 'launch_app':
        await this.resolver.launch(step.scope.app);
        return {};
      case 'activate_app':
        await this.resolver.requireRunning(step.scope.app);
        return {};
      case 'focus_window':
        try {
          await this.resolver.focusAfter(step.scope);
        } catch (error) {
          // A recorded window title can disappear because the app retitled it
          // (Chrome follows the tab) or the panel closed. Navigating to the
          // app is what the step meant; blocking the run costs every later step.
          const recoverable = error instanceof Fault &&
            ['WINDOW_NOT_FOUND', 'WINDOW_CHANGED', 'AMBIGUOUS_TARGET'].includes(error.code);
          if (!recoverable) throw error;
          await this.resolver.activateApp(step.scope.app);
          return { message: `window "${step.scope.windowTitle}" was gone; activated ${step.scope.app} instead` };
        }
        return {};
      case 'click':
        if (step.target.kind === 'element' && step.target.role === 'menuitem') {
          return this.menuStep(step);
        }
        // Any other click ends an inline rename editor: it either commits the
        // name or moves focus, so later typing must not use the stale focus.
        this.inlineRename = false;
        return this.windowStep(step.scope, async (binding, snapshot) => {
          // A recorded point is the fallback for a click whose window tree could
          // not name the element. It stays replayable as physical input; an
          // out-of-window point is refused instead of clicked somewhere else.
          if (step.target.kind === 'point') {
            const point = step.target.point as Point;
            if (!contains(snapshot!.tree.bounds, point)) {
              throw new Fault('UNSAFE_POINT',
                'A recorded click point is outside the bound window; edit the step to an element target');
            }
            const delivery = await this.desktop.clickPoint(snapshot!, this.targetOf(binding), point, {
              ...(step.count === undefined ? {} : { count: step.count as 1 | 2 | 3 }),
              ...(step.button === undefined ? {} : { button: step.button }),
            });
            return delivery === undefined ? {} : { delivery };
          }
          // A right click on a list container means "the item selected inside
          // it". Finder records a context-menu click on the outline, but the
          // menu belongs to the selected file row. The click that selected the
          // file is stronger evidence than the AX "selected" state, which the
          // list view does not always expose.
          const { locator, resolved } = this.clickTargetOf(step, snapshot!);
          const node = resolved.press ?? resolved.node;
          const options = {
            ...(step.count === undefined ? {} : { count: step.count as 1 | 2 | 3 }),
            ...(step.button === undefined ? {} : { button: step.button }),
          };
          let delivery;
          let message: string | undefined;
          if (!resolved.press) {
            // The recorded control carries no AX action and no container above
            // it does either — a common shape in an Electron page, where only
            // the nodes the driver can press get a reference. The element itself
            // is still resolved by name or identifier, so clicking its own
            // centre is the same control, not a guess: it goes through the
            // coordinate path, which proves the window and the point first.
            const point = centreOf(resolved.node, snapshot!);
            delivery = await this.desktop.clickPoint(snapshot!, this.targetOf(binding), point, options);
            message = `${describeControl(resolved.node)} has no AX action; clicked its centre instead`;
          } else if (step.button === 'right') {
            try {
              delivery = await this.desktop.click(resolved.press.ref!, options);
            } catch (error) {
              // Some AX elements advertise RightClick but reject the semantic
              // action (Finder's list view). Fall back to a physical click at the
              // element's centre, which is what the user's own right click does.
              if (!node.bounds) throw error;
              const point: Point = [
                node.bounds.x + node.bounds.width / 2,
                node.bounds.y + node.bounds.height / 2,
              ];
              delivery = await this.desktop.clickPoint(snapshot!, this.targetOf(binding), point, { button: 'right' });
            }
          } else if ((step.count ?? 1) === 1) {
            // A single left click gets one re-read/retry and, if the press still
            // fails, a physical click at the same control's centre. Multi-click
            // commands are physical input of their own; retrying one could send
            // a second double/triple click, so they keep the plain failure.
            const recovered = await this.clickWithRecovery(binding, resolved, locator, options);
            delivery = recovered.delivery;
            message = recovered.message;
          } else {
            delivery = await this.desktop.click(resolved.press.ref!, options);
          }
          if (step.button !== 'right') {
            this.lastClickTarget = locator;
            if (node.bounds) {
              this.lastClickPoint = [node.bounds.x + node.bounds.width / 2, node.bounds.y + node.bounds.height / 2];
            }
            const namePoint = rowNamePoint(node);
            if (namePoint) this.lastRowNamePoint = namePoint;
          }
          const outcome = delivery === undefined ? {} : { delivery };
          return message === undefined ? outcome : { ...outcome, message };
        }, step);
      case 'type':
        return this.typeStep(step);
      case 'key':
        return this.windowStep(step.scope, async (_binding, snapshot) => {
          const combo = [...(step.modifiers ?? []), step.key].join('+');
          try {
            const delivery = await this.desktop.press(combo, snapshot!);
            return delivery === undefined ? {} : { delivery };
          } finally {
            if (step.key === 'return' || step.key === 'escape') this.inlineRename = false;
          }
        }, step);
      case 'scroll':
        return this.windowStep(step.scope, async (_binding, snapshot) => {
          const press = pressRef(actionable(snapshot!, step.target as ElementLocator), 'scroll');
          const delivery = await this.desktop.scroll(press, scrollIntent(step));
          return delivery === undefined ? {} : { delivery };
        }, step);
      case 'drag':
        return this.windowStep(step.scope, async (binding, snapshot) => {
          const delivery = await this.desktop.drag(
            snapshot!, this.targetOf(binding),
            dragEndpoint(snapshot!, step.from as ElementLocator),
            dragEndpoint(snapshot!, step.to as ElementLocator),
            { durationMs: step.durationMs, ...(step.button ? { button: step.button } : {}) },
          );
          return delivery === undefined ? {} : { delivery };
        }, step);
      case 'hover':
        return this.readOnlyWindowStep(step.scope, async (binding, snapshot) => {
          const { node } = resolve(snapshot, step.target as ElementLocator);
          if (node.secure) throw new Fault('UNSAFE_TARGET', 'Hover target is secure');
          const point = hoverPoint(node, step.point, snapshot);
          const delivery = await this.desktop.hoverAt(
            snapshot, this.targetOf(binding), point, { readOnly: true, travel: true },
          );
          // A tooltip or submenu closes the moment the pointer leaves, so the
          // dwell is what the next step sees. A recording's own dwell can be
          // shorter than the time an app needs to settle its hover state, so
          // the step waits at least the floor. The pointer is not moved away
          // afterwards: the open tooltip is state the flow may rely on.
          await sleep(Math.max(step.durationMs, hoverDwellFloorMs), undefined, { signal: this.signal });
          return delivery === undefined ? {} : { delivery };
        }, step);
      case 'paste':
        return this.pasteStep(step);
      case 'wait':
        return this.waitStep(step);
      case 'assert':
        return this.assertStep(step);
      case 'open_system_surface':
      case 'surface_press':
        throw new Fault('SURFACE_UNSUPPORTED',
          'Dock, menu bar and Spotlight surfaces arrive with HAOC-116; this run does not guess their positions');
      case 'manual_checkpoint':
        return this.checkpointStep(step);
      case 'gap':
        return {};
    }
  }

  private targetOf(binding: WindowBinding) {
    return { app: binding.app, window: binding.observedTitle };
  }

  /**
   * One recovery pass for a semantic click that returned ACTION_FAILED. A
   * freshly raised Electron window can answer the accessibility read while the
   * control still rejects AXPress; the press is retried once against a re-read
   * snapshot, and only when the recorded control still resolves uniquely. If it
   * still fails, the same control is clicked physically at its centre through
   * the ordinary coordinate gate. Never more than one retry and one fallback.
   *
   * A control that can no longer be proved in the window is not clicked at its
   * old bounds: stale coordinates may belong to a different control by now.
   */
  private async clickWithRecovery(
    binding: WindowBinding,
    resolved: Actionable,
    locator: ElementLocator,
    options: ClickOptions,
  ): Promise<{ delivery?: Delivery; message?: string }> {
    try {
      return { delivery: await this.desktop.click(resolved.press!.ref!, options) };
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== 'ACTION_FAILED') throw error;
    }
    await sleep(clickRetryDelayMs, undefined, { signal: this.signal });
    const fresh = await this.resolver.snapshot(binding);
    let again: Actionable;
    try {
      again = actionable(fresh, addressable(locator));
    } catch (error) {
      // The re-read could not prove the recorded control any more. Falling back
      // to the first snapshot's bounds would click whatever now sits there.
      if (!(error instanceof Fault) ||
          !['NOT_FOUND', 'AMBIGUOUS', 'UNSAFE_TARGET'].includes(error.code)) throw error;
      throw this.clickFailure(resolved.node, 1, 0,
        `the control could not be resolved again after re-reading the window (${error.code})`);
    }
    let semantic = 1;
    if (again.press?.ref) {
      semantic = 2;
      try {
        const delivery = await this.desktop.click(again.press.ref, options);
        return {
          delivery,
          message: `${describeControl(again.node)}: the first AX press returned ACTION_FAILED; ` +
            'retried once against a re-read snapshot and it succeeded',
        };
      } catch (error) {
        if (!(error instanceof Fault) || error.code !== 'ACTION_FAILED') throw error;
      }
    }
    let point: Point;
    if (!again.node.bounds) {
      throw this.clickFailure(again.node, semantic, 0, 'the control has no bounds to click at its centre');
    }
    try {
      point = centreOf(again.node, fresh);
    } catch (error) {
      throw this.clickFailure(again.node, semantic, 0, error instanceof Fault
        ? `${error.code}: ${error.message}` : String(error));
    }
    try {
      const delivery = await this.desktop.clickPoint(fresh, this.targetOf(binding), point, options);
      return {
        delivery,
        message: `${describeControl(again.node)}: the AX press kept returning ACTION_FAILED; ` +
          `CLICK_POINT_FALLBACK clicked its centre (${point.join(',')}) as physical input`,
      };
    } catch (error) {
      throw this.clickFailure(again.node, semantic, 1, error instanceof Fault
        ? `${error.code}: ${error.message}` : String(error));
    }
  }

  /** A click that exhausted its bounded attempts, naming the control and them. */
  private clickFailure(node: Node, semantic: number, physical: number, detail: string): Fault {
    const attempts = `${semantic} semantic click attempt${semantic === 1 ? '' : 's'} and ` +
      `${physical} physical centre click${physical === 1 ? '' : 's'}`;
    return new Fault('ACTION_FAILED', `${describeControl(node)} failed after ${attempts} (${detail})`);
  }

  /** Resolves and, for input steps, brings the scope window forward first. */
  private async windowStep(
    scope: WindowScope,
    work: (binding: WindowBinding, snapshot: Snapshot | undefined) => Promise<StepOutcome>,
    step?: StepV2,
  ): Promise<StepOutcome> {
    // A click that changes the window's content (Finder following a sidebar
    // folder) can answer the next step from a tree read a moment too early.
    // A NOT_FOUND from the target resolver is retried against a fresh tree;
    // the fault is raised before any input is delivered, so a retry cannot
    // double-click.
    let lastError: unknown;
    // Only the first input after a window switch pays the readiness proof, and
    // only on its first attempt: a NOT_FOUND retry is already acting on a
    // proven window.
    const gate = step !== undefined && readinessGated.has(step.kind) && this.pendingWindowSwitch;
    if (gate) this.pendingWindowSwitch = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let binding: WindowBinding;
      let snapshot: Snapshot;
      if (gate && attempt === 0) {
        // The proof hands back the very snapshot the step dispatches from, so
        // the target it accepted is the target that is pressed.
        ({ binding, snapshot } = await this.awaitReadyWindow(step as ReadinessGatedStep));
        await this.recheckInputGates();
      } else {
        binding = await this.resolver.resolveWindow(
          scope,
          step ? candidates => this.pickSameTitled(candidates, step) : undefined,
        );
        await this.resolver.confirmForeground(binding);
        snapshot = await this.resolver.snapshot(binding);
      }
      try {
        const outcome = await work(binding, snapshot);
        const notes: string[] = [];
        if (binding.rebound) {
          binding.rebound = false;
          notes.push('window rebound after the recorded window was recreated');
        }
        if (binding.sharedTitle) {
          const which = binding.sharedTitle === 'target' ? 'the one that held its target' : 'the focused one';
          notes.push(`more than one window was titled "${scope.windowTitle}", so the step ran in ${which}`);
        }
        if (!notes.length) return outcome;
        const note = notes.join('; ');
        return { ...outcome, message: outcome.message ? `${outcome.message}; ${note}` : note };
      } catch (error) {
        const retryable = error instanceof Fault && error.code === 'NOT_FOUND';
        if (!retryable || attempt === 3) throw error;
        lastError = error;
        await sleep(200);
      }
    }
    throw lastError;
  }

  /**
   * Resolves a window and proves the run may act in it without moving focus.
   * Hover is the one read-only input: it must not raise its window, click a
   * Finder sidebar item to reopen one, or take a declared hand-off. The binding
   * itself is the same evidence a focusable step uses, and the foreground is
   * checked by reading it, never by taking it.
   */
  private async readOnlyWindowStep(
    scope: WindowScope,
    work: (binding: WindowBinding, snapshot: Snapshot) => Promise<StepOutcome>,
    step: StepV2,
  ): Promise<StepOutcome> {
    // A hover can land while its window is still repainting (a tooltip that
    // appears late, a list that virtualises). The focusable path retries a
    // missing target against a fresh tree, and a read-only step keeps the same
    // patience without ever taking a side effect: every attempt binds, proves
    // the foreground and reads the tree again, and the pointer is only moved by
    // the attempt whose target resolved.
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const binding = await this.resolver.resolveWindow(
        scope,
        candidates => this.pickSameTitled(candidates, step),
        { repair: false },
      );
      await this.resolver.requireForeground(binding);
      const snapshot = await this.resolver.snapshot(binding);
      try {
        const outcome = await work(binding, snapshot);
        const notes: string[] = [];
        if (binding.rebound) {
          binding.rebound = false;
          notes.push('window rebound after the recorded window was recreated');
        }
        if (binding.sharedTitle) {
          const which = binding.sharedTitle === 'target' ? 'the one that held its target' : 'the focused one';
          notes.push(`more than one window was titled "${scope.windowTitle}", so the step ran in ${which}`);
        }
        if (!notes.length) return outcome;
        const note = notes.join('; ');
        return { ...outcome, message: outcome.message ? `${outcome.message}; ${note}` : note };
      } catch (error) {
        const retryable = error instanceof Fault && error.code === 'NOT_FOUND';
        if (!retryable || attempt === 3) throw error;
        lastError = error;
        await sleep(200);
      }
    }
    throw lastError;
  }

  /** A declared focusAfter scope, or the launched app's own front window. */
  private async handOff(step: StepV2): Promise<StepOutcome> {
    // A wait observes only. It never moves focus, even if the file declares a
    // focusAfter, because a wait that changes the desktop is not a wait.
    if (step.kind === 'wait') return {};
    // Hover is read-only for the same reason: raising another window after a
    // hover would close the tooltip it just opened, and a hover must never take
    // focus in the first place.
    if (step.kind === 'hover') return {};
    const declared = (step as { focusAfter?: ReportV2Entry['focusAfter'] }).focusAfter;
    if (declared?.kind === 'window') {
      try {
        await this.resolver.focusAfter(declared);
        return { focusAfter: declared };
      } catch (error) {
        // Bringing an app forward does not need one specific window, just as
        // `open -a` does not. A click that still cannot tell two same-titled
        // windows apart keeps failing; only the hand-off is relaxed. An
        // activate/launch step means exactly "open the app": the recorded window
        // may have been closed since, and opening the app again is the step.
        const opensApp = step.kind === 'activate_app' || step.kind === 'launch_app';
        const tolerable = error instanceof Fault && (
          ['AMBIGUOUS_TARGET', 'TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code) ||
          (opensApp && ['WINDOW_NOT_FOUND', 'WINDOW_CHANGED'].includes(error.code)));
        if (!tolerable || !(error instanceof Fault)) throw error;
        await this.resolver.activateApp(declared.app);
        return {
          focusAfter: { kind: 'app', app: declared.app },
          message: error.code === 'WINDOW_NOT_FOUND' || error.code === 'WINDOW_CHANGED' ?
            `window "${declared.windowTitle}" was gone; opened ${declared.app} instead` :
          error.code === 'AMBIGUOUS_TARGET' ?
            `more than one window is titled "${declared.windowTitle}"; brought ${declared.app} forward instead` :
            `could not focus "${declared.windowTitle}" in time; brought ${declared.app} forward instead`,
        };
      }
    }
    if (declared?.kind === 'app') {
      await this.resolver.activateApp(declared.app);
      return { focusAfter: declared };
    }
    if (step.kind === 'activate_app') {
      await this.resolver.activateApp(step.scope.app);
    } else if (step.kind === 'launch_app') {
      // A launch stays in the background unless the step declares where focus
      // should land; the next input step focuses its own window.
      await this.resolver.absorbAppForeground(step.scope.app);
    }
    return {};
  }

  /**
   * Settles which of several same-titled windows a step belongs to. A step is
   * placed in the one window its own tree evidence proves: exactly one window
   * holds the recorded target, or several hold it and the operator's focused
   * window is the only one of them. Anything less is insufficient evidence and
   * stays ambiguous — a guess here would type into the wrong document.
   */
  private async pickSameTitled(
    candidates: WindowInfo[],
    step: StepV2,
    { prove = false }: { prove?: boolean } = {},
  ): Promise<{ window: WindowInfo; reason: 'target' | 'focused' } | undefined> {
    const test = windowTest(step);
    if (!test) {
      // The step names nothing the tree can be asked about, so the operator's
      // own front window is the only evidence there is.
      const focused = candidates.filter(window => window.isFocused === true);
      return focused.length === 1 ? { window: focused[0], reason: 'focused' } : undefined;
    }
    const holders: WindowInfo[] = [];
    for (const candidate of candidates) {
      let snapshot: Snapshot;
      try {
        snapshot = await this.desktop.snapshotWindow(candidate.id);
      } catch (error) {
        // A tree that cannot be read right now leaves the window in contention.
        // A caller under its own deadline retries a transient read; anything
        // else is the driver's own failure and keeps its code.
        if (!prove) return undefined;
        const fault = toFault(error);
        if (!readinessTransientCodes.has(fault.code)) throw error;
        throw fault;
      }
      const result = test(snapshot);
      // An ambiguous element keeps this window in contention.
      if (result === undefined) return undefined;
      if (result) holders.push(candidate);
    }
    if (holders.length === 0) {
      // No candidate holds the target yet. A caller under its own deadline
      // treats that as "not ready" and reads the windows again; a plain step
      // keeps the ambiguity it would otherwise report.
      if (!prove) return undefined;
      throw new Fault('WINDOW_NOT_FOUND',
        `None of the ${candidates.length} windows titled "${candidates[0]?.title ?? ''}" ` +
        'holds the recorded target yet');
    }
    if (holders.length === 1) return { window: holders[0], reason: 'target' };
    // Several windows hold the target — the same folder open twice looks the
    // same in both — so the operator's own window decides between them.
    const focused = holders.filter(window => window.isFocused === true);
    if (focused.length === 1) return { window: focused[0], reason: 'focused' };
    // Genuinely ambiguous: more than one window holds the target and none is
    // the operator's. Retrying cannot settle this, so it stays a refusal.
    return undefined;
  }

  /**
   * Waits for the operator and read-only evidence that the flow can resume.
   */
  private async checkpointStep(
    step: Extract<StepV2, { kind: 'manual_checkpoint' }>,
  ): Promise<StepOutcome> {
    const channel = this.ctx.checkpoints;
    const probe = this.ctx.secureInputActive;
    if (!channel || !probe) {
      throw new Fault('MANUAL_CHECKPOINT_REQUIRED',
        'A manual checkpoint needs an operator confirmation channel and the secure input probe; ' +
        'run it from an interactive terminal with the rebuilt capture helper', true);
    }
    // Proving the trigger window is still the bound window stops a hand-off that
    // would hand the operator an interface the flow no longer owns.
    await this.resolver.resolveWindow(step.scope);
    const request = {
      stepId: step.id,
      triggerStepId: step.triggerStepId,
      scope: step.scope,
      timeoutMs: step.timeoutMs ?? defaultCheckpointTimeoutMs,
      reason: step.reason,
    };
    const checkpoint: CheckpointMetadata = await runHandOff({
      request,
      channel,
      signal: this.signal,
      timeoutMs: request.timeoutMs,
      probe: {
        secureInput: probe,
        ...(this.ctx.systemDialogVisible ? { systemDialogVisible: this.ctx.systemDialogVisible } : {}),
        resume: () => this.resumeHolds(step),
      },
    });
    // The operator just used the desktop; the next step brings its own window
    // forward instead of treating that interaction as an unexpected focus steal.
    this.resolver.acceptHandoff();
    return { checkpoint };
  }

  /** The checkpoint's read-only resume condition, evaluated without input. */
  private async resumeHolds(
    step: Extract<StepV2, { kind: 'manual_checkpoint' }>,
  ): Promise<boolean> {
    const check = step.resume.check as WindowWaitCheck;
    let current: WindowBinding;
    try {
      current = await this.resolver.resolveWindow(step.resume.scope);
    } catch (error) {
      if (error instanceof Fault &&
          ['WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'WINDOW_CHANGED'].includes(error.code)) {
        return check.kind === 'window_exists' && check.equals === false;
      }
      throw error;
    }
    if (check.kind === 'window_exists') return check.equals === true;
    const snapshot = await this.resolver.snapshot(current);
    if (check.kind === 'element_enabled') {
      const found = resolve(snapshot, check.target as ElementLocator);
      if (found.node.secure) return false;
      const enabled = !found.node.states.includes('disabled');
      return enabled === check.equals;
    }
    const assertion = check.kind === 'window'
      ? { target: { kind: 'window' as const }, expect: check.expect }
      : { target: check.target, expect: check.expect };
    const observation = await evaluateAssertion(assertion as AssertCheck, {
      desktop: this.desktop,
      snapshot: async () => snapshot,
      windowsFor: async () => [{ id: current.windowId, title: current.observedTitle }],
    });
    return observation.passed;
  }

  private async typeStep(step: Extract<StepV2, { kind: 'type' }>): Promise<StepOutcome> {
    const literal = 'text' in step;
    const input = literal ? undefined : step.input;
    const text = literal ? step.text : this.ctx.inputs[step.input];
    if (text === undefined) {
      throw new Fault('INPUT_MISSING', `Input parameter ${String(input)} has no value for this run`);
    }
    const outcome: StepOutcome = {
      textMode: literal ? 'literal' : 'input',
      ...(input === undefined ? {} : { input }),
    };
    return this.windowStep(step.scope, async (_binding, snapshot) => {
      const plan = this.typeDispatch(snapshot!, step);
      switch (plan.via) {
        case 'refused':
          throw new Fault('UNSAFE_TARGET', plan.reason);
        case 'ambiguous':
          throw new Fault('AMBIGUOUS', plan.reason);
        case 'inline-rename':
          // The rename editor is the first responder; clicking the row's name
          // column makes it so, and Cmd+A replaces the whole name.
          if (this.lastRowNamePoint) {
            await this.desktop.clickScreen(this.lastRowNamePoint).catch(() => undefined);
            await sleep(150);
          }
          await this.desktop.typeFocused(text, step.scope.app, { selectAll: true });
          this.inlineRename = false;
          await sleep(250);
          return outcome;
        case 'focused-host':
          await this.desktop.typeFocused(text, step.scope.app);
          await sleep(250);
          return outcome;
        case 'rename-field':
          // The editor has no AX focus of its own: click it first.
          await this.desktop.click(plan.node.ref!).catch(() => undefined);
          await sleep(150);
          await this.desktop.typeFocused(text, step.scope.app);
          await sleep(250);
          return outcome;
        case 'reference': {
          // A rename field that AX does not flag as focused still needs a click
          // to take keyboard focus before the characters are typed into it.
          if (plan.clickFirst) await this.desktop.click(plan.node.ref!).catch(() => undefined);
          const delivery = await this.desktop.type(plan.node.ref!, text);
          return delivery === undefined ? outcome : { ...outcome, delivery };
        }
      }
    }, step);
  }

  private async pasteStep(step: Extract<StepV2, { kind: 'paste' }>): Promise<StepOutcome> {
    const input = step.source.kind === 'input' ? step.source.input : undefined;
    const text = input === undefined ? undefined : this.ctx.inputs[input];
    if (input !== undefined && text === undefined) {
      throw new Fault('INPUT_MISSING', `Input parameter ${input} has no value for this run`);
    }
    return this.windowStep(step.scope, async (_binding, snapshot) => {
      const { node } = resolve(snapshot!, step.target as ElementLocator);
      if (!node.ref || node.secure) throw new Fault('UNSAFE_TARGET', 'Paste target is secure or has no action reference');
      if (!pasteEditable.has(node.role)) {
        throw new Fault('UNSAFE_TARGET', 'Paste target is not an editable control');
      }
      // Focus the recorded control before the shortcut: Cmd+V goes wherever the
      // app's first responder is at that moment. A copy step already put the
      // text on the clipboard; only a named input is written here.
      await this.desktop.focus(node.ref);
      if (text !== undefined) await this.desktop.writeClipboard(text);
      const delivery = await this.desktop.press('meta+v', snapshot!);
      return {
        ...(delivery === undefined ? {} : { delivery }),
        ...(input === undefined ? {} : { input }),
      };
    }, step);
  }

  private async waitStep(step: Extract<StepV2, { kind: 'wait' }>): Promise<StepOutcome> {
    const timeoutMs = step.timeoutMs ?? defaultWaitTimeoutMs;
    // A wait only observes: resolveWindow, ownedWindows, snapshots and install
    // evidence are reads, so no launch, focus, click or clipboard write happens
    // until the condition matches.
    await waitFor({
      describe: () => `${step.id} (${waitDescription(step)})`,
      observe: () => this.observeWait(step),
    }, {
      timeoutMs,
      signal: this.signal,
      transient: error => error instanceof Fault && transientWaitCodes.has(error.code),
    });
    return {};
  }

  private async observeWait(step: Extract<StepV2, { kind: 'wait' }>): Promise<WaitObservation> {
    assertWaitCheckSupported(step.check.kind);
    if (step.scope.kind === 'file') {
      return this.fileWait(step.scope, step.check as FileWaitCheck, step.id);
    }
    if (step.scope.kind === 'app') {
      const check = step.check as AppWaitCheck;
      if (check.kind === 'app_installed') {
        const app = step.scope.app;
        const evidence = await this.ctx.install.appInstalled(app, {
          ...(this.ctx.appPaths[app] === undefined ? {} : { path: this.ctx.appPaths[app] }),
        });
        return {
          matched: evidence.installed === check.equals,
          detail: `app_installed=${evidence.installed} evidence=${evidence.evidence.join(',') || 'none'}`,
        };
      }
      const running = await this.resolver.appRunning(step.scope.app);
      return { matched: running === check.equals, detail: `app_running=${running}` };
    }
    const scope = step.scope as WindowScope;
    const check = step.check as WindowWaitCheck;
    let binding: WindowBinding;
    try {
      binding = await this.resolver.resolveWindow(scope);
    } catch (error) {
      // A window that is not open yet (or no longer open) only answers
      // `window_exists`; any other condition keeps waiting for it to appear.
      if (error instanceof Fault &&
          ['WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'WINDOW_CHANGED', 'AMBIGUOUS_TARGET'].includes(error.code)) {
        const exists = false;
        if (check.kind === 'window_exists') return { matched: exists === check.equals, detail: 'window_exists=false' };
        return { matched: false, detail: `${check.kind} waiting for the window (${error.code})` };
      }
      throw error;
    }
    if (check.kind === 'window_exists') {
      return { matched: check.equals === true, detail: 'window_exists=true' };
    }
    if (check.kind === 'element_enabled') {
      const { node } = resolve(await this.resolver.snapshot(binding), check.target as ElementLocator);
      // AX omits AXEnabled when it is true, so only an explicit disabled marker
      // proves a control is not enabled.
      const enabled = node.states.includes('enabled') ? true : !node.states.includes('disabled');
      return { matched: enabled === check.equals, detail: `element_enabled=${enabled}` };
    }
    const assertion = check.kind === 'window'
      ? { target: { kind: 'window' as const }, expect: check.expect }
      : { target: check.target, expect: check.expect };
    const observation = await evaluateAssertion(assertion as AssertCheck, {
      desktop: this.desktop,
      snapshot: () => this.resolver.snapshot(binding),
      windowsFor: async () => [{ id: binding.windowId, title: binding.observedTitle }],
    });
    return {
      matched: observation.passed,
      detail: observation.passed ? undefined : (observation.message ?? 'condition did not match'),
    };
  }

  /**
   * A file wait reads the download directory only. A file that is still
   * partial, absent or recently written keeps the wait polling; an unreadable
   * directory or two matching files stop it, because neither proves completion.
   */
  private async fileWait(scope: FileScope, check: FileWaitCheck, stepId: string): Promise<WaitObservation> {
    const evidence = await this.ctx.install.fileEvidence({
      directory: scope.directory,
      ...('name' in scope ? { name: scope.name } : { suffix: scope.suffix }),
    });
    const name = evidence.name ?? ('name' in scope ? scope.name : `*${scope.suffix}`);
    if (check.kind === 'file_exists') {
      const detail = evidence.present
        ? `file_exists=true (${name})`
        : `file_exists=false${evidence.incomplete ? ' (still writing)' : ''}`;
      return { matched: evidence.present === check.equals, detail };
    }
    // `file_stable` needs two reads: the size and mtime must stay unchanged for
    // the whole quiet window, so a single instantaneous read never matches.
    const quietMs = check.quietMs ?? defaultFileQuietMs;
    const previous = this.fileStability.get(stepId);
    if (!evidence.present || evidence.size === undefined || evidence.mtimeMs === undefined) {
      this.fileStability.delete(stepId);
      return {
        matched: false,
        detail: `file_stable=false ${evidence.incomplete ? `${name} is still writing` : 'absent'}`,
      };
    }
    const now = performance.now();
    if (!previous || previous.size !== evidence.size || previous.mtimeMs !== evidence.mtimeMs) {
      this.fileStability.set(stepId, { size: evidence.size, mtimeMs: evidence.mtimeMs, since: now });
      return {
        matched: false,
        detail: `file_stable=false ${name} size=${evidence.size} still changing`,
      };
    }
    const unchangedForMs = Math.round(now - previous.since);
    const stable = unchangedForMs >= quietMs;
    return {
      matched: stable,
      detail: `file_stable=${stable} ${name} size=${evidence.size} ` +
        `unchangedForMs=${unchangedForMs} quietMs=${quietMs}`,
    };
  }

  private async assertStep(step: Extract<StepV2, { kind: 'assert' }>): Promise<StepOutcome> {
    // A system state check reads the machine only. It never resolves a window,
    // probes an app identity, takes focus or raises a permission.
    if (step.scope.kind === 'file' && 'path' in step.scope) {
      const path = step.scope.path;
      return this.systemAssert(
        step.check as FileExistsCheck,
        () => this.ctx.system.fileExists(path),
        actual => `File ${path} ${actual ? 'exists' : 'does not exist'}`,
      );
    }
    if (step.scope.kind === 'process') {
      const scope = step.scope as ProcessScope;
      const check = step.check as ProcessRunningCheck;
      const label = 'name' in scope ? `Process ${scope.name}` : `Process at ${scope.path}`;
      // An argument check compares a run of argv, so an unmatched process is
      // still running; say which fact failed without repeating the arguments.
      const describesArgs = 'args' in check && (check.args?.length ?? 0) > 0;
      return this.systemAssert(
        check,
        () => this.ctx.system.processRunning(scope, 'args' in check ? check.args : undefined),
        actual => describesArgs
          ? `${label} ${actual ? 'runs' : 'does not run'} with the expected arguments`
          : `${label} is ${actual ? 'running' : 'not running'}`,
      );
    }
    if (step.scope.kind === 'app') {
      // A missing app is an empty window inventory, so `exists: false` can still
      // pass; `evaluateAssertion` reads the inventory through `windowsFor`.
      const identity = this.resolver.identity(step.scope.app);
      const observation = await evaluateAssertion(step.check as AssertCheck, {
        desktop: this.desktop,
        snapshot: async () => {
          throw new Fault('DESKTOP_DEPENDENCY', 'An app-scoped assertion reads the window inventory', true);
        },
        windowsFor: () => identity.ownedWindows(this.desktop),
      });
      return assertionOutcome(observation);
    }
    const binding = await this.resolver.resolveWindow(step.scope);
    const identity = this.resolver.identity(step.scope.app);
    const observation = await evaluateAssertion(step.check as AssertCheck, {
      desktop: this.desktop,
      snapshot: () => this.resolver.snapshot(binding),
      windowsFor: async () => [{ id: binding.windowId, title: binding.observedTitle }],
      screenshotWindow: (_app, windowId) => identity.screenshotWindow(this.desktop, windowId),
      ...(this.ctx.baselineDir === undefined ? {} : { baselineDir: this.ctx.baselineDir }),
    });
    return assertionOutcome(observation);
  }

  /**
   * Compares one observed system value with the declared expectation. A probe
   * error is an unknown value: the step fails with `actual: null` whatever the
   * expectation was, so a reverse check can never pass by accident.
   */
  private async systemAssert(
    check: FileExistsCheck | ProcessRunningCheck,
    observe: () => Promise<boolean>,
    describe: (actual: boolean) => string,
  ): Promise<StepOutcome> {
    const stateCheck = { kind: check.kind, expected: check.equals, actual: null as boolean | null };
    let actual: boolean;
    try {
      actual = await observe();
    } catch (error) {
      const fault = toFault(error);
      return { status: 'failed', code: fault.code, message: fault.message, stateCheck };
    }
    stateCheck.actual = actual;
    if (actual === check.equals) return { stateCheck };
    return {
      status: 'failed',
      code: 'ASSERTION_FALSE',
      message: `${describe(actual)}; expected ${check.kind}=${check.equals}`,
      stateCheck,
    };
  }
}

/**
 * Live cross-app replay of one v2 flow. Scope resolution, foreground ownership
 * and delivery verification are per step; the run stops at the first step that
 * cannot be proven and never retries an uncertain input.
 */
export async function runFlowV2(input: FlowV2, options: FlowV2RunOptions): Promise<ReportV2> {
  const flow = parseFlowV2(input);
  const report = new ReportV2Session(flow, options.onEntry);
  const apps = flowApps(flow);
  const titles = recordedTitles(flow);
  const identities = new Map<string, AppIdentitySession>();
  /** Apps whose pinned path was absent; each is proven at its first real use. */
  const deferred = new Set<string>();

  function identityFor(app: string): AppIdentitySession {
    let identity = identities.get(app);
    if (!identity) {
      identity = options.identityFor?.(app) ?? new AppIdentitySession(
        {
          app,
          window: titles.get(app) ?? '',
          ...(flow.appPaths?.[app] === undefined ? {} : { appPath: flow.appPaths[app] }),
        },
        options.identityDeps,
      );
      identities.set(app, identity);
    }
    return identity;
  }

  function identityRecords(options: {
    blocked?: AppIdentityRecord; includeUnreached: boolean;
  }): AppIdentityRecord[] {
    return apps.flatMap(app => {
      if (options.blocked?.app === app) return [options.blocked];
      const identity = identities.get(app);
      if (identity?.verified) return [{ app, mode: identity.mode, status: 'verified' }];
      // A deferred pin was never accepted: a run that only waited for the
      // install never proved this app's path, so it is not reported verified.
      if (deferred.has(app)) {
        return [{
          app, mode: identity?.mode ?? 'bundle_path', status: 'blocked',
          code: 'APP_UNVERIFIED', reason: 'preflight_deferred',
        }];
      }
      // A passed run omits an app it never had to bind (e.g. only asserted as
      // absent); a stopped run lists it so the operator sees what was skipped.
      if (!options.includeUnreached) return [];
      return [{
        app,
        mode: identity?.mode ?? (flow.appPaths?.[app] === undefined ? 'legacy_bundle_id' : 'bundle_path'),
        status: 'blocked',
        code: 'APP_UNVERIFIED',
        reason: 'not_reached',
      }];
    });
  }

  function blockedReport(fault: Fault, blocked?: AppIdentityRecord): ReportV2 {
    report.blockAll(fault.code, fault.message);
    report.setIdentities(identityRecords({ ...(blocked ? { blocked } : {}), includeUnreached: true }));
    return report.finish('blocked');
  }

  const expectsSystemDialog = flow.steps.some(step => step.kind === 'manual_checkpoint' && step.reason === 'system_dialog');
  const systemDialogVisible = expectsSystemDialog ? options.systemDialogVisible : undefined;
  if (expectsSystemDialog && (!systemDialogVisible || !options.checkpoints || !options.secureInputActive)) {
    return blockedReport(new Fault('MANUAL_CHECKPOINT_REQUIRED',
      'A system dialog checkpoint needs an operator channel and native dialog and secure-state probes', true));
  }

  // Path pinning and the identity helper are checked before any desktop call,
  // report artifact or lease file exists. A missing pinned path is deferred to
  // the app's first real use: the same flow may install it first. An existing
  // path that holds another bundle still stops here.
  for (const app of apps) {
    try {
      const outcome = await identityFor(app).preflight({ allowMissingPath: true });
      if (outcome === 'missing') deferred.add(app);
    } catch (error) {
      const fault = toFault(error);
      return blockedReport(fault,
        error instanceof IdentityFault ? error.identity() : undefined);
    }
  }
  for (const app of apps) {
    if (!await identityFor(app).probe.available()) {
      return blockedReport(new Fault('IDENTITY_DEPENDENCY',
        'Cross-app replay needs the app identity helper; build it with npm run build:recorder', true));
    }
  }

  const lease = options.lease ?? new RunLease({
    runId: options.runId ?? randomUUID(),
    ...(options.leaseDirectory === undefined ? {} : { directory: options.leaseDirectory }),
  });
  try {
    await lease.acquire();
  } catch (error) {
    return blockedReport(toFault(error));
  }

  const resolver = new ScopeResolver({
    desktop: options.desktop,
    signal: options.signal,
    identityFor,
    ...(options.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.launchTimeoutMs }),
  });
  const runner = new StepRunner({
    desktop: options.desktop,
    resolver,
    signal: options.signal,
    inputs: options.inputs ?? {},
    install: options.installState ?? new InstallState(options.installDeps),
    system: options.systemChecks ?? new SystemChecks(options.systemCheckDeps),
    appPaths: flow.appPaths ?? {},
    ...(options.baselineDir === undefined ? {} : { baselineDir: options.baselineDir }),
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
    ...(options.secureInputActive === undefined ? {} : { secureInputActive: options.secureInputActive }),
    ...(systemDialogVisible === undefined ? {} : { systemDialogVisible }),
    requireSecureState: flow.steps.some(step => step.kind === 'manual_checkpoint'),
  });

  let status: ReportV2['status'] = 'passed';
  let stopped = false;
  let identityBlock: AppIdentityRecord | undefined;
  try {
    for (const step of flow.steps) {
      if (stopped) {
        report.skip(step);
        continue;
      }
      options.signal.throwIfAborted();
      const atMs = report.elapsed();
      try {
        await lease.refresh();
        const outcome = await runner.run(step);
        const stepStatus = outcome.status ?? 'passed';
        report.record(step, { ...outcome, status: stepStatus }, atMs);
        if (stepStatus === 'failed') {
          status = 'failed';
          stopped = true;
        }
      } catch (error) {
        if (options.signal.aborted) throw error;
        const fault = toFault(error);
        const blocking = fault.dependency || blockingCodes.has(fault.code);
        report.record(step, {
          status: blocking ? 'blocked' : 'failed',
          code: fault.code,
          message: fault.message,
          ...(error instanceof CheckpointFault ? { checkpoint: error.checkpoint } : {}),
          ...deliveryOf(error),
        }, atMs);
        status = blocking ? 'blocked' : 'failed';
        stopped = true;
        if (error instanceof IdentityFault) identityBlock = error.identity(step.id);
      }
    }
  } finally {
    await lease.release();
  }
  if (identityBlock) {
    report.setIdentities(identityRecords({ blocked: identityBlock, includeUnreached: true }));
  } else {
    report.setIdentities(identityRecords({ includeUnreached: status !== 'passed' }));
  }
  return report.finish(status);
}
