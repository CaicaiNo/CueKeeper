import { setTimeout as sleep } from 'node:timers/promises';
import type { Check, Entry, Flow, Report, Setup } from './contracts.js';
import { DesktopFault } from './desktop.js';
import type { Desktop } from './desktop.js';
import { hashFlow, plan } from './flow.js';
import { Fault, contains, resolve } from './locator.js';
import type { Located, Snapshot } from './locator.js';

type Outcome = Pick<Entry, 'status' | 'message' | 'code' | 'delivery'>;

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

async function evaluate(desktop: Desktop, current: Snapshot, check: Check) {
  const found = locateCheck(current, check);
  if (check.expect.property === 'exists') return Boolean(found) === check.expect.equals;
  if (!found || found.node.secure) throw new Fault('PROPERTY_UNAVAILABLE', 'Property unavailable for this control');
  const actual = await desktop.property(found.node, check.expect.property);
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
  let windowId: string | undefined;
  let drySnapshot: Promise<Snapshot> | undefined;
  async function readSnapshot(timeoutMs?: number) {
    const current = await desktop.snapshot(flow.target, timeoutMs);
    if (windowId !== undefined && current.windowId !== windowId) {
      throw new Fault('WINDOW_CHANGED', 'The original target window changed during the run');
    }
    windowId = current.windowId;
    return current;
  }
  const snapshot = (timeoutMs?: number) => dryRun ? (drySnapshot ??= readSnapshot()) : readSnapshot(timeoutMs);

  async function log(
    id: string, kind: Entry['kind'], work: () => Promise<Outcome>, failure: 'failed' | 'blocked' = 'failed',
  ) {
    signal.throwIfAborted();
    const atMs = elapsed();
    let outcome: Outcome;
    try {
      outcome = await work();
    } catch (error) {
      if (signal.aborted || (error instanceof Fault && error.dependency)) throw error;
      outcome = errorOutcome(error, failure);
    }
    signal.throwIfAborted();
    report.entries.push({ id, kind, atMs, durationMs: elapsed() - atMs, ...outcome });
    return outcome.status;
  }

  async function checkConditions(conditions: Setup[] = [], scope: string) {
    for (const condition of conditions) {
      const state = await log(`${scope}/setup/${condition.id}`, 'setup', async () => {
        if (condition.state !== 'confirmed') {
          return { status: 'skipped', message: `Setup state is ${condition.state}` };
        }
        const current = await snapshot();
        if (dryRun) {
          locateCheck(current, condition.check);
          return { status: 'resolved' };
        }
        if (!await evaluate(desktop, current, condition.check)) {
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
