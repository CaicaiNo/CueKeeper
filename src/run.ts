import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateAssertion, resolveAssertion } from './assertion.js';
import type { AssertionObservation } from './assertion.js';
import { AppIdentitySession, IdentityFault, unsafePoint } from './app-identity.js';
import { defaultEnsureTimeoutMs } from './contracts.js';
import type { AssertCheck, Check, Ensure, Entry, Flow, Report, ScreenshotActual, Setup, Target } from './contracts.js';
import { DesktopFault, isMissingWindow } from './desktop.js';
import type { Desktop } from './desktop.js';
import { hashFlow, plan } from './flow.js';
import { Fault, contains, resolve } from './locator.js';
import type { Located, Snapshot } from './locator.js';

type AssertionRecord = {
  expected: AssertCheck['expect'];
  actual?: boolean | string | ScreenshotActual;
  screenshots?: { baseline: string; actual: string };
};
type Outcome = Pick<Entry, 'status' | 'message' | 'code' | 'delivery'> & { assertion?: AssertionRecord };
type SetupOutcome = Outcome & Pick<Extract<Entry, { kind: 'setup' }>, 'repair'>;

function locateCheck(snapshot: Snapshot, check: Check): Located | undefined {
  try {
    return resolve(snapshot, check.target);
  } catch (error) {
    if (error instanceof Fault && error.code === 'NOT_FOUND' && check.expect.property === 'exists') {
      return undefined;
    }
    throw error;
  }
}

async function evaluate(desktop: Desktop, current: Snapshot, check: Check, timeoutMs?: number) {
  const found = locateCheck(current, check);
  if (check.expect.property === 'exists') return Boolean(found) === check.expect.equals;
  if (!found || found.node.secure) throw new Fault('PROPERTY_UNAVAILABLE', 'Property unavailable for this control');
  const actual = await desktop.property(found.node, check.expect.property, timeoutMs);
  if (actual === undefined) throw new Fault('PROPERTY_UNAVAILABLE', 'Property could not be read');
  return actual === check.expect.equals;
}

function errorOutcome(error: unknown, status: 'failed' | 'blocked'): Outcome {
  return {
    status,
    code: error instanceof Fault ? error.code : 'ACTION_FAILED',
    message: error instanceof Error ? error.message : 'Unknown error',
    ...(error instanceof DesktopFault ? { delivery: error.delivery } : {}),
  };
}

async function saveAssertionEvidence(directory: string, stepId: string, observation: AssertionObservation) {
  const folder = join(directory, ...stepId.split('/'));
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, 'assertion-baseline.png'), observation.evidence!.baseline);
    await writeFile(join(folder, 'assertion-actual.png'), observation.evidence!.actual);
    return {
      screenshots: {
        baseline: `assets/${stepId}/assertion-baseline.png`,
        actual: `assets/${stepId}/assertion-actual.png`,
      },
    };
  } catch {
    return { message: '截图证据未能写入报告目录' };
  }
}

export async function runFlow(
  flow: Flow, desktop: Desktop, options: {
    dryRun: boolean; signal: AbortSignal; secretTexts?: ReadonlyMap<string, string>;
    /** Directory holding `baselines/<sha256>.png` next to the flow file. */
    baselineDir?: string;
    /** Directory receiving assertion evidence, one subdirectory per step. */
    evidenceDir?: string;
    /** True when the run resolves against a saved snapshot instead of the desktop. */
    offline?: boolean;
    /** The app path stored in the snapshot envelope, when one exists. */
    fixtureAppPath?: string;
    /** Injected identity probe/filesystem seam; production uses the native helper. */
    identity?: AppIdentitySession;
  },
): Promise<Report> {
  const planned = plan(flow);
  const { dryRun, signal } = options;
  const offline = options.offline === true;
  const report: Report = {
    version: 1,
    flowId: flow.id,
    flowSha256: hashFlow(flow),
    startedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'replay',
    status: 'passed',
    entries: [],
  };
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const identity = options.identity ?? new AppIdentitySession(flow.target);
  let identityBlock: { fault: IdentityFault; entryId?: string } | undefined;
  /**
   * A blocked start lists every planned action as blocked without inventing
   * setup entries, and keeps the report timeline in flow order.
   */
  function blockBeforeStart(fault: IdentityFault) {
    report.status = 'blocked';
    report.appIdentity = fault.identity();
    for (const { id, action } of planned) {
      report.entries.push({
        id, kind: action.kind, status: 'blocked', atMs: 0, durationMs: 0,
        code: fault.code, message: fault.message,
      });
    }
    return report;
  }

  try {
    await identity.preflight({ offline });
    if (offline && flow.target.appPath && options.fixtureAppPath &&
        flow.target.appPath !== options.fixtureAppPath) {
      throw new IdentityFault('APP_AMBIGUOUS', 'fixture_path_mismatch',
        '快照来自另一个应用路径，请重新采集快照或恢复与快照匹配的目标。',
        flow.target.app, identity.mode);
    }
    if (!offline) await identity.bindInstances(desktop);
  } catch (error) {
    if (error instanceof IdentityFault) return blockBeforeStart(error);
    throw error;
  }
  if (offline) report.appIdentity = identity.offlineIdentity();

  // Only a path-fixed target switches to window-only driver calls; a legacy
  // flow keeps its existing app-scoped route.
  const pathBound = !offline && identity.mode === 'bundle_path';

  function bindWindow(target: Target) {
    let windowId: string | undefined;
    let selectedWindowId: string | undefined;
    const bound = pathBound && target.app === flow.target.app;
    return {
      get id() { return windowId; },
      async read(timeoutMs?: number, exactWindow = false, repairedWindowId?: string) {
        const selected = selectedWindowId ?? (exactWindow ? windowId ?? repairedWindowId : undefined);
        if (bound) {
          // After the first read the bound window ID is reused, so a later
          // action never re-selects a window by title.
          const preferred = selectedWindowId ?? windowId ?? (exactWindow ? repairedWindowId : undefined);
          const current = await identity.readWindow(desktop, target, {
            timeoutMs, ...(preferred === undefined ? {} : { preferredWindowId: preferred }),
          });
          const expectedId = windowId ?? selected;
          if (expectedId !== undefined && current.windowId !== expectedId) {
            throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
          }
          windowId = current.windowId;
          if (exactWindow) selectedWindowId = current.windowId;
          return current;
        }
        const current = await desktop.snapshot(target, timeoutMs, selected, exactWindow);
        const expectedId = windowId ?? selected;
        if (expectedId !== undefined && current.windowId !== expectedId) {
          throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
        }
        windowId = current.windowId;
        if (exactWindow) selectedWindowId = current.windowId;
        return current;
      },
    };
  }
  const replayWindow = bindWindow(flow.target);
  let drySnapshot: Promise<Snapshot> | undefined;
  const snapshot = (timeoutMs?: number) => dryRun ? (drySnapshot ??= replayWindow.read()) : replayWindow.read(timeoutMs);

  async function log(
    id: string, kind: Entry['kind'], work: () => Promise<SetupOutcome>, failure: 'failed' | 'blocked' = 'failed',
  ) {
    signal.throwIfAborted();
    const atMs = elapsed();
    const previousBlock = identityBlock;
    let outcome: SetupOutcome;
    try {
      outcome = await work();
    } catch (error) {
      if (signal.aborted || (error instanceof Fault && error.dependency)) throw error;
      if (error instanceof IdentityFault) identityBlock = { fault: error, entryId: id };
      outcome = errorOutcome(error, error instanceof IdentityFault ? 'blocked' : failure);
    }
    // A repair can record the identity failure itself while keeping repair
    // details; the entry that triggered it names the stop.
    if (identityBlock && identityBlock !== previousBlock && identityBlock.entryId === undefined) {
      identityBlock.entryId = id;
    }
    signal.throwIfAborted();
    const { repair, ...result } = outcome;
    const entry = { id, atMs, durationMs: elapsed() - atMs, ...result };
    report.entries.push((kind === 'setup' && repair ? { ...entry, kind, repair } : { ...entry, kind }) as Entry);
    return outcome.status;
  }

  async function evaluateSetup(current: Snapshot, check: Check, deadline?: number) {
    try {
      const budget = deadline === undefined ? undefined : Math.ceil(deadline - performance.now());
      if (budget !== undefined && budget <= 0) throw new Fault('COMMAND_TIMEOUT', 'The setup repair deadline expired');
      return await evaluate(desktop, current, check, budget);
    } catch (error) {
      if (error instanceof Fault && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  async function ensureThenCheck(check: Check, action: Ensure, window: ReturnType<typeof bindWindow>): Promise<SetupOutcome> {
    try {
      if (await evaluateSetup(await window.read(undefined, true), check)) return { status: 'passed' };
    } catch (error) {
      if (signal.aborted || !isMissingWindow(error)) throw error;
    }
    const repair = { attempted: true, kind: action.kind };
    const timeoutMs = action.timeout_ms ?? defaultEnsureTimeoutMs;
    const deadline = performance.now() + timeoutMs;
    try {
      signal.throwIfAborted();
      const repairedWindowId = await identity.ensure(desktop, action, timeoutMs, window.id);
      let current: Snapshot;
      for (;;) {
        signal.throwIfAborted();
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Fault('WINDOW_NOT_FOUND', 'The target window was not ready before the repair deadline');
        try {
          current = await window.read(remaining, true, repairedWindowId);
          break;
        } catch (error) {
          if (signal.aborted || !isMissingWindow(error) || action.kind === 'window_ready' ||
              deadline - performance.now() <= 100) throw error;
        }
        await sleep(100, undefined, { signal });
      }
      if (await evaluateSetup(current, check, deadline)) {
        return { status: 'passed', repair: { ...repair, result: 'passed' }, message: 'Confirmed precondition matched after repair' };
      }
      return {
        status: 'blocked', code: 'PRECONDITION_FALSE', message: 'Confirmed precondition still did not match after repair',
        repair: { ...repair, result: 'failed' },
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Fault && error.dependency)) throw error;
      const outcome = errorOutcome(error, 'blocked');
      // Keep the repair record while surfacing the identity stop at the top.
      if (error instanceof IdentityFault) identityBlock = { fault: error };
      return { ...outcome, code: 'ENSURE_FAILED', repair: { ...repair, result: 'failed', code: outcome.code } };
    }
  }

  async function checkConditions(conditions: Setup[] = [], scope: string) {
    for (const condition of conditions) {
      const state = await log(`${scope}/setup/${condition.id}`, 'setup', async () => {
        if (condition.state !== 'confirmed') {
          return { status: 'skipped', message: `Setup state is ${condition.state}` };
        }
        const { ensure } = condition;
        // A window-root check names the window it validates; bind that window so
        // an inferred app/window suggestion for a secondary app reads its own tree.
        const locator = condition.check.target;
        const bound = ensure?.kind === 'window_ready'
          ? { app: ensure.app, window: ensure.window }
          : locator.role === 'window' && locator.name
            ? { app: ensure?.app ?? flow.target.app, window: locator.name }
            : undefined;
        const window = bound && (bound.app !== flow.target.app || bound.window !== flow.target.window)
          ? bindWindow(bound) : replayWindow;
        if (dryRun) {
          const current = await (window === replayWindow ? snapshot() : window.read(undefined, true));
          locateCheck(current, condition.check);
          return { status: 'resolved' };
        }
        if (ensure) return ensureThenCheck(condition.check, ensure, window);
        if (!await evaluate(desktop, await snapshot(), condition.check)) {
          throw new Fault('PRECONDITION_FALSE', 'Confirmed precondition did not match');
        }
        return { status: 'passed' };
      }, 'blocked');
      if (state === 'blocked') return false;
      if (identityBlock) return false;
    }
    return true;
  }

  const globalReady = await checkConditions(flow.setup, 'global');
  let halted = !globalReady;
  let stopped = identityBlock ? 'identity' : undefined;
  if (halted) report.status = 'blocked';
  for (const { id, action } of planned) {
    if (stopped === 'identity') {
      await log(id, action.kind, async () =>
        ({ status: 'skipped', message: 'Stopped by an earlier result' }));
      continue;
    }
    if (halted) {
      await log(id, action.kind, async () =>
        ({ status: globalReady ? 'skipped' : 'blocked', message: 'Stopped by an earlier result' }));
      continue;
    }
    if (!await checkConditions(action.setup, id)) {
      if (identityBlock) {
        await log(id, action.kind, async () =>
          ({ status: 'skipped', message: 'Stopped by an earlier result' }));
        report.status = 'blocked';
        stopped = 'identity';
        continue;
      }
      await log(id, action.kind, async () =>
        ({ status: 'blocked', code: 'LOCAL_SETUP', message: 'Local precondition blocked this action' }));
      report.status = 'blocked';
      continue;
    }

    const status = await log(id, action.kind, async () => {
      if (action.kind === 'assert') {
        const context = {
          desktop,
          snapshot: () => snapshot(),
          baselineDir: options.baselineDir,
          secretTexts: options.secretTexts,
          windowsFor: (app: string) => app === flow.target.app
            ? identity.windowsFor(desktop, flow.target)
            : desktop.listWindows(app),
          ...(pathBound ? {
            screenshotWindow: (targetApp: string, windowId: string) => targetApp === flow.target.app
              ? identity.screenshotWindow(desktop, windowId)
              : desktop.screenshot(targetApp, windowId),
          } : {}),
        };
        if (dryRun) {
          await resolveAssertion(action.check, context);
          return { status: 'resolved' };
        }
        let observation: AssertionObservation;
        try {
          observation = await evaluateAssertion(action.check, context);
        } catch (error) {
          if (signal.aborted || (error instanceof Fault && error.dependency)) throw error;
          const outcome = errorOutcome(error, 'failed');
          return { ...outcome, assertion: { expected: action.check.expect } };
        }
        const saved = observation.evidence && options.evidenceDir
          ? await saveAssertionEvidence(options.evidenceDir, id, observation)
          : undefined;
        const screenshots = saved && 'screenshots' in saved ? saved.screenshots : undefined;
        const assertion: AssertionRecord = {
          expected: action.check.expect,
          ...(observation.actual !== undefined ? { actual: observation.actual } : {}),
          ...(screenshots ? { screenshots } : {}),
        };
        let message = observation.message;
        if (saved && 'message' in saved) message = [message, saved.message].filter(Boolean).join('；') || saved.message;
        if (observation.passed) return { status: 'passed', ...(message ? { message } : {}), assertion };
        return {
          status: 'failed',
          code: observation.code ?? 'ASSERTION_FALSE',
          message: message ?? `Expected ${action.check.expect.property} did not match`,
          assertion,
        };
      }
      if (action.kind === 'wait') {
        if (dryRun) {
          locateCheck(await snapshot(), action.check);
          return { status: 'resolved' };
        }
        const deadline = performance.now() + action.timeoutMs;
        for (;;) {
          const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
          try {
            if (await evaluate(desktop, await snapshot(Math.min(3000, remaining)), action.check)) break;
          } catch (error) {
            if (!(error instanceof Fault && ['NOT_FOUND', 'INCOMPLETE_TREE'].includes(error.code))) throw error;
          }
          if (performance.now() >= deadline) throw new Fault('WAIT_TIMEOUT', 'Wait condition did not match');
          await sleep(Math.min(100, Math.max(0, deadline - performance.now())), undefined, { signal });
        }
        return { status: 'passed' };
      }

      const current = await snapshot();
      if (action.kind === 'key') {
        if (dryRun) return { status: 'resolved', message: 'Window resolved for shortcut' };
        if (pathBound) await identity.verifyWindowId(current.windowId, flow.target.window);
        return { status: 'passed', delivery: await desktop.press(
          [...(action.modifiers ?? []), action.key].join('+'), current,
        ) };
      }
      if (action.target.kind === 'point') {
        // A path-fixed flow cannot prove which copy receives a global
        // coordinate, so it stops instead of clicking the foreground window.
        if (pathBound) throw unsafePoint(flow.target.app, identity.mode);
        if (!contains(current.tree.bounds, action.target.point)) {
          throw new Fault('UNSAFE_POINT', 'Coordinate is outside the selected window');
        }
        if (dryRun) return { status: 'resolved', message: 'Coordinate is within the selected window' };
        return { status: 'passed', delivery: await desktop.clickPoint(current, flow.target, action.target.point) };
      }

      const { node } = resolve(current, action.target);
      if (!node.ref || node.secure) throw new Fault('UNSAFE_TARGET', 'Control is secure or has no action reference');
      if (dryRun) return { status: 'resolved', message: `Resolved ${node.role}` };
      if (pathBound) await identity.verifyWindowId(current.windowId, flow.target.window);
      const delivery = action.kind === 'click' ? await desktop.click(node.ref) : await desktop.type(node.ref, options.secretTexts?.get(id) ?? action.text);
      return { status: 'passed', delivery };
    });
    if (identityBlock) {
      report.status = 'blocked';
      stopped = 'identity';
      continue;
    }
    if (status === 'failed') {
      report.status = 'failed';
      halted = true;
    }
  }
  if (identityBlock) {
    report.status = 'blocked';
    report.appIdentity = identityBlock.fault.identity(identityBlock.entryId);
  } else if (!offline && identity.verified) {
    report.appIdentity = identity.verifiedIdentity();
  }
  return report;
}
