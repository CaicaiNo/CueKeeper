import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import type { IdentityDeps } from './app-identity.js';
import { evaluateAssertion } from './assertion.js';
import type { AssertionObservation } from './assertion.js';
import type { AssertCheck, ElementLocator } from './contracts.js';
import { defaultCheckpointTimeoutMs, defaultFileQuietMs, defaultWaitTimeoutMs } from './contracts-v2.js';
import type {
  AppWaitCheck, DeliveryV2, FileScope, FileWaitCheck, FlowV2, ReportV2, ReportV2Entry, Scope, StepV2,
  WindowScope, WindowWaitCheck,
} from './contracts-v2.js';
import { DesktopFault } from './desktop.js';
import type { Desktop, DragEndpoint } from './desktop.js';
import { finderRenameSteps } from './finder-rename.js';
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
  /** Replay Finder's recorded context menu literally instead of using Return. */
  finderRenameMenu?: boolean;
  renameCommitTimeoutMs?: number;
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

function actionable(snapshot: Snapshot, locator: ElementLocator): { node: Node } {
  let found: Located;
  try {
    found = resolve(snapshot, locator);
  } catch (error) {
    // Finder's list view names a file in the value of a textfield, while the
    // recording may address it as a row. A single name/value match is the same
    // element; anything ambiguous keeps the original NOT_FOUND.
    if (!(error instanceof Fault) || error.code !== 'NOT_FOUND' || !locator.name) throw error;
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
  const clickable = (node: Node) => node.ref && !node.secure &&
    (node.actions ?? []).some(action => /^(click|press|axpress)$/i.test(action));
  // Finder's sidebar switches folders when the row is pressed; pressing the
  // cell inside it only selects the item. Prefer the row-level container, then
  // any clickable ancestor, then a bare ref for older drivers.
  const rowLevel = /^(treeitem|row|listitem|outlinerow|outlineitem)$/;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (rowLevel.test(chain[i].role) && clickable(chain[i])) return { node: chain[i] };
  }
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (clickable(chain[i])) return { node: chain[i] };
  }
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (chain[i].ref && !chain[i].secure) return { node: chain[i] };
  }
  throw new Fault('UNSAFE_TARGET', 'Control has no action reference');
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
 * A click target without a name proves nothing: the recording saw an element it
 * could not address, so any same-role element in the window would satisfy it.
 * Refusing here is what keeps an unnamed AXTextField from being clicked
 * silently; the step must be edited into a named element first.
 */
function addressable(locator: ElementLocator): ElementLocator {
  if (locator.name === '') {
    throw new Fault('AMBIGUOUS',
      'A recorded element target has no name; edit the step into a named element before replay');
  }
  return locator;
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
    // A file scope names no app: its wait observes the filesystem only.
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
    renameActions: ReturnType<typeof finderRenameSteps>;
    desktop: Desktop;
    resolver: ScopeResolver;
    signal: AbortSignal;
    inputs: Readonly<Record<string, string>>;
    install: InstallState;
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
    const rename = this.ctx.renameActions.get(step.id);
    if (rename) return rename();
    const outcome = await this.dispatch(step);
    return { ...outcome, ...await this.handOff(step) };
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
    await this.desktop.waitMenu(step.scope.app, true);
    const menu = await this.desktop.snapshotSurface('menu', 2000, step.scope.app);
    const items = flatten(menu.tree).filter(({ node }) =>
      node.role === 'menuitem' && !node.states.includes('disabled') &&
      (node.name === target.name || node.value === target.name));
    if (items.length !== 1 || !items[0].node.ref) throw new Fault('NOT_FOUND', 'Expected one enabled menu item');
    const delivery = await this.desktop.clickSemantic(items[0].node.ref);
    return { delivery };
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
          const locator = step.button === 'right'
            ? (this.lastClickTarget ?? rightClickTarget(snapshot!, step.button, step.target as ElementLocator))
            : (step.target as ElementLocator);
          const { node } = actionable(snapshot!, addressable(locator));
          let delivery;
          try {
            delivery = await this.desktop.click(node.ref!, {
              ...(step.count === undefined ? {} : { count: step.count as 1 | 2 | 3 }),
              ...(step.button === undefined ? {} : { button: step.button }),
            });
          } catch (error) {
            // Some AX elements advertise RightClick but reject the semantic
            // action (Finder's list view). Fall back to a physical click at the
            // element's centre, which is what the user's own right click does.
            if (step.button !== 'right' || !node.bounds) throw error;
            const point: Point = [
              node.bounds.x + node.bounds.width / 2,
              node.bounds.y + node.bounds.height / 2,
            ];
            delivery = await this.desktop.clickPoint(snapshot!, this.targetOf(binding), point, { button: 'right' });
          }
          if (step.button !== 'right') this.lastClickTarget = locator;
          return delivery === undefined ? {} : { delivery };
        });
      case 'type':
        return this.typeStep(step);
      case 'key':
        return this.windowStep(step.scope, async (_binding, snapshot) => {
          const combo = [...(step.modifiers ?? []), step.key].join('+');
          const delivery = await this.desktop.press(combo, snapshot!);
          return delivery === undefined ? {} : { delivery };
        });
      case 'scroll':
        return this.windowStep(step.scope, async (_binding, snapshot) => {
          const { node } = actionable(snapshot!, step.target as ElementLocator);
          const delivery = await this.desktop.scroll(node.ref!, scrollIntent(step));
          return delivery === undefined ? {} : { delivery };
        });
      case 'drag':
        return this.windowStep(step.scope, async (binding, snapshot) => {
          const delivery = await this.desktop.drag(
            snapshot!, this.targetOf(binding),
            dragEndpoint(snapshot!, step.from as ElementLocator),
            dragEndpoint(snapshot!, step.to as ElementLocator),
            { durationMs: step.durationMs, ...(step.button ? { button: step.button } : {}) },
          );
          return delivery === undefined ? {} : { delivery };
        });
      case 'hover':
        return this.windowStep(step.scope, async (binding, snapshot) => {
          const { node } = resolve(snapshot!, step.target as ElementLocator);
          if (node.secure) throw new Fault('UNSAFE_TARGET', 'Hover target is secure');
          if (!node.bounds) throw new Fault('HOVER_UNRESOLVED', 'Hover target has no bounds to move to');
          const point: Point = [
            Math.round(node.bounds.x + node.bounds.width / 2),
            Math.round(node.bounds.y + node.bounds.height / 2),
          ];
          if (!contains(snapshot!.tree.bounds, point)) {
            throw new Fault('UNSAFE_POINT', 'Hover target is outside the bound window');
          }
          const delivery = await this.desktop.hoverAt(snapshot!, this.targetOf(binding), point);
          if (step.durationMs > 0) await sleep(step.durationMs, undefined, { signal: this.signal });
          return delivery === undefined ? {} : { delivery };
        });
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

  /** Resolves and, for input steps, brings the scope window forward first. */
  private async windowStep(
    scope: WindowScope,
    work: (binding: WindowBinding, snapshot: Snapshot | undefined) => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    // A click that changes the window's content (Finder following a sidebar
    // folder) can answer the next step from a tree read a moment too early.
    // A NOT_FOUND from the target resolver is retried against a fresh tree;
    // the fault is raised before any input is delivered, so a retry cannot
    // double-click.
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const binding = await this.resolver.resolveWindow(scope);
      await this.resolver.confirmForeground(binding);
      const snapshot = await this.resolver.snapshot(binding);
      try {
        const outcome = await work(binding, snapshot);
        if (!binding.rebound) return outcome;
        binding.rebound = false;
        const note = 'window rebound after the recorded window was recreated';
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
    const declared = (step as { focusAfter?: ReportV2Entry['focusAfter'] }).focusAfter;
    if (declared?.kind === 'window') {
      await this.resolver.focusAfter(declared);
      return { focusAfter: declared };
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
    const locator = step.target as ElementLocator;
    if (step.scope.app === 'com.apple.finder' && !locator.name && /^(textfield|textbox)$/.test(locator.role)) {
      throw new Fault('RENAME_EDITOR_UNPROVEN', 'An unnamed Finder editor requires a verified rename sequence');
    }
    return this.windowStep(step.scope, async (_binding, snapshot) => {
      const focused = locator.name ? undefined : flatten(snapshot!.tree).filter(({ node }) =>
        node.ref && !node.secure && node.states.includes('focused') && pasteEditable.has(node.role));
      const node = focused?.length === 1 ? focused[0].node : actionable(snapshot!, addressable(locator)).node;
      const delivery = await this.desktop.type(node.ref!, text);
      return {
        ...(delivery === undefined ? {} : { delivery }),
        textMode: literal ? 'literal' : 'input',
        ...(input === undefined ? {} : { input }),
      };
    });
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
    });
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
    renameActions: finderRenameSteps(flow.steps, options.desktop, resolver, options.inputs ?? {}, options.signal,
      options.finderRenameMenu ?? process.env.CUEKEEPER_FINDER_RENAME_MENU === '1', options.renameCommitTimeoutMs),
    desktop: options.desktop,
    resolver,
    signal: options.signal,
    inputs: options.inputs ?? {},
    install: options.installState ?? new InstallState(options.installDeps),
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
