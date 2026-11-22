import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import type { IdentityDeps } from './app-identity.js';
import { evaluateAssertion } from './assertion.js';
import type { AssertionObservation } from './assertion.js';
import type { AssertCheck, ElementLocator } from './contracts.js';
import { defaultCheckpointTimeoutMs, defaultWaitTimeoutMs } from './contracts-v2.js';
import type {
  AppWaitCheck, DeliveryV2, FlowV2, ReportV2, ReportV2Entry, Scope, StepV2,
  WindowScope, WindowWaitCheck,
} from './contracts-v2.js';
import { DesktopFault } from './desktop.js';
import type { Desktop, DragEndpoint } from './desktop.js';
import { parseFlowV2 } from './flow-v2.js';
import { Fault, contains, resolve } from './locator.js';
import type { Node, Point, Snapshot } from './locator.js';
import { CheckpointFault, runHandOff } from './manual-checkpoint.js';
import type { CheckpointChannel, CheckpointMetadata } from './manual-checkpoint.js';
import { ReportV2Session } from './report-v2.js';
import type { AppIdentityRecord, StepResult } from './report-v2.js';
import { RunLease, ScopeResolver } from './scope.js';
import type { WindowBinding } from './scope.js';

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
  /** Operator hand-off channel; a checkpoint without one blocks the run. */
  checkpoints?: CheckpointChannel;
  /** System secure input probe; a hand-off cannot prove recovery without it. */
  secureInputActive?: () => Promise<boolean>;
}

type StepOutcome = Omit<StepResult, 'status'> & { status?: 'passed' | 'failed' };

const blockingCodes = new Set([
  'APP_PATH_INVALID', 'APP_AMBIGUOUS', 'APP_NOT_FOUND', 'APP_UNVERIFIED',
  'AMBIGUOUS_TARGET', 'WINDOW_NOT_FOUND', 'WINDOW_CHANGED', 'FOCUS_INTERRUPTED',
  'IDENTITY_DEPENDENCY', 'RUN_BUSY', 'RUN_LEASE_FAILED', 'INPUT_MISSING',
  'SURFACE_UNSUPPORTED', 'MANUAL_CHECKPOINT_REQUIRED', 'MANUAL_CHECKPOINT_CANCELLED',
  'MANUAL_CHECKPOINT_TIMEOUT', 'SECURE_INPUT', 'WAIT_UNSUPPORTED',
  'UNSAFE_POINT', 'UNSAFE_TARGET', 'DELIVERY_UNCERTAIN', 'LAUNCH_TIMEOUT',
  'COMMAND_TIMEOUT', 'TIMEOUT', 'DESKTOP_DEPENDENCY', 'UNSUPPORTED_PLATFORM',
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
  const found = resolve(snapshot, locator);
  if (!found.node.ref) throw new Fault('UNSAFE_TARGET', 'Control has no action reference');
  if (found.node.secure) throw new Fault('UNSAFE_TARGET', 'Control is secure and cannot be automated');
  return found;
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
    else if (scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu') apps.add(scope.app);
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
    baselineDir?: string;
    checkpoints?: CheckpointChannel;
    secureInputActive?: () => Promise<boolean>;
    /** True when a checkpoint in the flow makes secure-state proof mandatory. */
    requireSecureState: boolean;
  }) {}

  private get desktop() { return this.ctx.desktop; }
  private get resolver() { return this.ctx.resolver; }
  private get signal() { return this.ctx.signal; }

  async run(step: StepV2): Promise<StepOutcome> {
    this.signal.throwIfAborted();
    if (step.kind === 'drag' && (step.path?.length ?? 0) > 0) {
      // P2 has no raw coordinates: a recorded pointer path cannot be proven to
      // belong to the bound window, so the step stops instead of replaying it.
      throw new Fault('UNSAFE_POINT', 'P2 replay does not accept recorded pointer paths');
    }
    // A password prompt the flow did not declare is an unknown secure interface.
    if (inputKinds.has(step.kind)) await this.guardSecureInput();
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
      'A flow with manual checkpoints needs the secure input probe; rebuild the capture helper with pnpm build:recorder', true);
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
        await this.resolver.focusAfter(step.scope);
        return {};
      case 'click':
        return this.windowStep(step.scope, async (_binding, snapshot) => {
          const { node } = actionable(snapshot!, step.target as ElementLocator);
          const delivery = await this.desktop.click(node.ref!, {
            ...(step.count === undefined ? {} : { count: step.count as 1 | 2 | 3 }),
            ...(step.button === undefined ? {} : { button: step.button }),
          });
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
    const binding = await this.resolver.resolveWindow(scope);
    await this.resolver.confirmForeground(binding);
    const snapshot = await this.resolver.snapshot(binding);
    return work(binding, snapshot);
  }

  /** A declared focusAfter scope, or the launched app's own front window. */
  private async handOff(step: StepV2): Promise<StepOutcome> {
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
   * Blocks at a secure input checkpoint until the operator confirms the hand-off
   * in the real interface and both the secure state and resume condition are
   * proven. The checkpoint never receives, stores or reports a password.
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
    };
    const checkpoint: CheckpointMetadata = await runHandOff({
      request,
      channel,
      signal: this.signal,
      timeoutMs: request.timeoutMs,
      probe: {
        secureInput: probe,
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
    return this.windowStep(step.scope, async (_binding, snapshot) => {
      const { node } = actionable(snapshot!, step.target as ElementLocator);
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
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      this.signal.throwIfAborted();
      let matched = false;
      try {
        matched = await this.observeWait(step);
      } catch (error) {
        if (!(error instanceof Fault) || !transientWaitCodes.has(error.code)) throw error;
      }
      if (matched) return {};
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Fault('WAIT_TIMEOUT', `Wait ${step.id} did not match before its ${timeoutMs} ms deadline`);
      }
      await sleep(Math.min(100, remaining), undefined, { signal: this.signal });
    }
  }

  private async observeWait(step: Extract<StepV2, { kind: 'wait' }>): Promise<boolean> {
    if (step.scope.kind === 'app') {
      const check = step.check as AppWaitCheck;
      if (check.kind === 'app_installed') {
        throw new Fault('WAIT_UNSUPPORTED', 'app_installed waits arrive with HAOC-115');
      }
      let running = true;
      try {
        await this.resolver.requireRunning(step.scope.app);
      } catch (error) {
        if (error instanceof Fault && error.code === 'APP_NOT_FOUND') running = false;
        else throw error;
      }
      return running === check.equals;
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
          ['WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'WINDOW_CHANGED'].includes(error.code)) {
        if (check.kind === 'window_exists') return check.equals === false;
      }
      throw error;
    }
    if (check.kind === 'window_exists') return check.equals === true;
    if (check.kind === 'element_enabled') {
      throw new Fault('WAIT_UNSUPPORTED', 'element_enabled waits arrive with HAOC-115');
    }
    const assertion = check.kind === 'window'
      ? { target: { kind: 'window' as const }, expect: check.expect }
      : { target: check.target, expect: check.expect };
    const observation = await evaluateAssertion(assertion as AssertCheck, {
      desktop: this.desktop,
      snapshot: () => this.resolver.snapshot(binding),
      windowsFor: async () => [{ id: binding.windowId, title: binding.observedTitle }],
    });
    return observation.passed;
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
  const report = new ReportV2Session(flow);
  const apps = flowApps(flow);
  const titles = recordedTitles(flow);
  const identities = new Map<string, AppIdentitySession>();

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

  // Path pinning and the identity helper are checked before any desktop call,
  // report artifact or lease file exists.
  for (const app of apps) {
    try {
      await identityFor(app).preflight();
    } catch (error) {
      const fault = toFault(error);
      return blockedReport(fault,
        error instanceof IdentityFault ? error.identity() : undefined);
    }
  }
  for (const app of apps) {
    if (!await identityFor(app).probe.available()) {
      return blockedReport(new Fault('IDENTITY_DEPENDENCY',
        'Cross-app replay needs the app identity helper; build it with pnpm build:recorder', true));
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
    ...(options.baselineDir === undefined ? {} : { baselineDir: options.baselineDir }),
    ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
    ...(options.secureInputActive === undefined ? {} : { secureInputActive: options.secureInputActive }),
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
