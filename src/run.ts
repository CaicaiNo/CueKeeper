import { setTimeout as sleep } from 'node:timers/promises';
import { defaultEnsureTimeoutMs } from './contracts.js';
import type { Check, Ensure, Entry, Flow, Report, Setup, Target } from './contracts.js';
import { DesktopFault, isMissingWindow } from './desktop.js';
import type { Desktop } from './desktop.js';
import { hashFlow, plan } from './flow.js';
import { Fault, contains, resolve } from './locator.js';
import type { Located, Snapshot } from './locator.js';

type Outcome = Pick<Entry, 'status' | 'message' | 'code' | 'delivery'>;
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

export async function runFlow(
  flow: Flow, desktop: Desktop, options: { dryRun: boolean; signal: AbortSignal; secretTexts?: ReadonlyMap<string, string> },
): Promise<Report> {
  const planned = plan(flow);
  const { dryRun, signal } = options;
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
  function bindWindow(target: Target) {
    let windowId: string | undefined;
    let selectedWindowId: string | undefined;
    return {
      get id() { return windowId; },
      async read(timeoutMs?: number, exactWindow = false, repairedWindowId?: string) {
        const selected = selectedWindowId ?? (exactWindow ? windowId ?? repairedWindowId : undefined);
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
    let outcome: SetupOutcome;
    try {
      outcome = await work();
    } catch (error) {
      if (signal.aborted || (error instanceof Fault && error.dependency)) throw error;
      outcome = errorOutcome(error, failure);
    }
    signal.throwIfAborted();
    const { repair, ...result } = outcome;
    const entry = { id, atMs, durationMs: elapsed() - atMs, ...result };
    report.entries.push(kind === 'setup' && repair ? { ...entry, kind, repair } : { ...entry, kind });
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
      const repairedWindowId = await desktop.ensure(action, timeoutMs, window.id);
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
        const window = ensure?.kind === 'window_ready' &&
          (ensure.app !== flow.target.app || ensure.window !== flow.target.window)
          ? bindWindow({ app: ensure.app, window: ensure.window }) : replayWindow;
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
    }
    return true;
  }

  const globalReady = await checkConditions(flow.setup, 'global');
  let halted = !globalReady;
  if (halted) report.status = 'blocked';
  for (const { id, action } of planned) {
    if (halted) {
      await log(id, action.kind, async () =>
        ({ status: globalReady ? 'skipped' : 'blocked', message: 'Stopped by an earlier result' }));
      continue;
    }
    if (!await checkConditions(action.setup, id)) {
      await log(id, action.kind, async () =>
        ({ status: 'blocked', code: 'LOCAL_SETUP', message: 'Local precondition blocked this action' }));
      report.status = 'blocked';
      continue;
    }

    const status = await log(id, action.kind, async () => {
      if (action.kind === 'assert' || action.kind === 'wait') {
        if (dryRun) {
          locateCheck(await snapshot(), action.check);
          return { status: 'resolved' };
        }
        if (action.kind === 'assert') {
          if (!await evaluate(desktop, await snapshot(), action.check)) {
            throw new Fault('ASSERTION_FALSE', `Expected ${action.check.expect.property} did not match`);
          }
        } else {
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
        }
        return { status: 'passed' };
      }

      const current = await snapshot();
      if (action.kind === 'key') {
        if (dryRun) return { status: 'resolved', message: 'Window resolved for shortcut' };
        return { status: 'passed', delivery: await desktop.press(
          [...(action.modifiers ?? []), action.key].join('+'), current,
        ) };
      }
      if (action.target.kind === 'point') {
        if (!contains(current.tree.bounds, action.target.point)) {
          throw new Fault('UNSAFE_POINT', 'Coordinate is outside the selected window');
        }
        if (dryRun) return { status: 'resolved', message: 'Coordinate is within the selected window' };
        return { status: 'passed', delivery: await desktop.clickPoint(current, flow.target, action.target.point) };
      }

      const { node } = resolve(current, action.target);
      if (!node.ref || node.secure) throw new Fault('UNSAFE_TARGET', 'Control is secure or has no action reference');
      if (dryRun) return { status: 'resolved', message: `Resolved ${node.role}` };
      const delivery = action.kind === 'click' ? await desktop.click(node.ref) : await desktop.type(node.ref, options.secretTexts?.get(id) ?? action.text);
      return { status: 'passed', delivery };
    });
    if (status === 'failed') {
      report.status = 'failed';
      halted = true;
    }
  }
  return report;
}
