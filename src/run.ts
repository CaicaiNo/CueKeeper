import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateAssertion, resolveAssertion } from './assertion.js';
import type { AssertionObservation } from './assertion.js';
import { defaultEnsureTimeoutMs } from './contracts.js';
import type {
  AssertCheck, Check, Delivery, Ensure, Entry, Flow, Report, ScreenshotActual, Setup, Target,
} from './contracts.js';
import { DesktopFault, isMissingWindow } from './desktop.js';
import type { Desktop } from './desktop.js';
import { hashFlow, plan } from './flow.js';
import type { PlannedStep } from './flow.js';
import { Fault, contains, resolve } from './locator.js';
import type { Located, Snapshot } from './locator.js';
import {
  ShellFault, hasShellSecrets, planShellStep, previewShell, privateShellDirectory,
  removeShellDirectory, reachableShells, runShell, shellBudget, shellEntry, shellGate,
  shellContext, shellPrivilege,
} from './shell.js';
import type { ShellBudget, ShellGate, ShellInput, ShellOutcome } from './shell.js';
import type { PrivilegeRunner } from './shell-privilege.js';

type AssertionRecord = {
  expected: AssertCheck['expect'];
  actual?: boolean | string | ScreenshotActual;
  screenshots?: { baseline: string; actual: string };
};
type Outcome = {
  status: Entry['status']; message?: string; code?: string; delivery?: Delivery;
  assertion?: AssertionRecord;
};
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

export interface ShellRunOptions {
  allowShell: boolean;
  allowSudo: boolean;
  /** Human-in-the-loop consent for password-dialog root steps. */
  interactive?: boolean;
  /** Input flow or test file directory; shell steps resolve cwd from here. */
  baseDir: string;
  captureOutput?: boolean;
  hostEnv?: NodeJS.ProcessEnv;
  privilege?: PrivilegeRunner;
  /** Receives the resolved command of every root step right before it runs. */
  announceRoot?: (step: { id: string; program: string; args: string[]; cwd: string; mode: string }) => void;
}

/**
 * The gate report is produced before any desktop adapter or shell process is
 * created, so a missing permission never has side effects.
 */
export function blockedShellReport(flow: Flow, planned: PlannedStep[], gate: ShellGate): Report {
  const reason = gate.message ?? (gate.code === 'SHELL_NOT_ALLOWED'
    ? 'Shell steps require --allow-shell'
    : 'Privileged shell steps require --allow-sudo');
  return {
    version: 1,
    flowId: flow.id,
    flowSha256: hashFlow(flow),
    startedAt: new Date().toISOString(),
    mode: 'replay',
    status: 'blocked',
    entries: planned.map(({ id, action }) => {
      const shell = action as ShellInput;
      const shellResult = action.kind === 'shell'
        ? { shell: { ...shellContext(shell), execution: 'not-run' as const } }
        : {};
      if (id !== gate.stepId) {
        return {
          id, kind: action.kind, status: 'skipped', atMs: 0, durationMs: 0,
          message: 'Not run: a shell permission is missing', ...shellResult,
        } as Entry;
      }
      return shellEntry(id, {
        status: 'blocked', code: gate.code, message: reason,
        shell: { ...shellContext(shell), execution: 'not-run' },
      }, 0, 0);
    }),
  };
}

export async function runFlow(
  flow: Flow, desktop: Desktop | undefined, options: {
    dryRun: boolean; signal: AbortSignal; secretTexts?: ReadonlyMap<string, string>;
    /** Directory holding `baselines/<sha256>.png` next to the flow file. */
    baselineDir?: string;
    /** Directory receiving assertion evidence, one subdirectory per step. */
    evidenceDir?: string;
    /** Enables shell steps. Omit for flows that contain none. */
    shell?: ShellRunOptions;
  },
): Promise<Report> {
  const planned = plan(flow);
  const { dryRun, signal } = options;
  const shellSteps = reachableShells(planned);
  const gate = dryRun || !shellSteps.length ? undefined : shellGate(flow, planned, {
    allowShell: options.shell?.allowShell ?? false,
    allowSudo: options.shell?.allowSudo ?? false,
    interactive: options.shell?.interactive ?? false,
  });
  if (gate) return blockedShellReport(flow, planned, gate);
  function requireDesktop(): Desktop {
    if (!desktop) throw new Fault('DESKTOP_DEPENDENCY', 'This flow needs the desktop adapter', true);
    return desktop;
  }
  const shellBudgetState: ShellBudget = shellBudget();
  const canCapture = Boolean(options.shell?.captureOutput) && !(options.secretTexts?.size) &&
    !shellSteps.some(step => hasShellSecrets(step.action)) &&
    !shellSteps.some(step => shellPrivilege(step.action) !== 'user');
  let shellTemp: string | undefined;
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
        const current = await requireDesktop().snapshot(target, timeoutMs, selected, exactWindow);
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
    report.entries.push((kind === 'setup' && repair ? { ...entry, kind, repair } : { ...entry, kind }) as Entry);
    return outcome.status;
  }

  async function evaluateSetup(current: Snapshot, check: Check, deadline?: number) {
    try {
      const budget = deadline === undefined ? undefined : Math.ceil(deadline - performance.now());
      if (budget !== undefined && budget <= 0) throw new Fault('COMMAND_TIMEOUT', 'The setup repair deadline expired');
      return await evaluate(requireDesktop(), current, check, budget);
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
      const repairedWindowId = await requireDesktop().ensure(action, timeoutMs, window.id);
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
        if (!await evaluate(requireDesktop(), await snapshot(), condition.check)) {
          throw new Fault('PRECONDITION_FALSE', 'Confirmed precondition did not match');
        }
        return { status: 'passed' };
      }, 'blocked');
      if (state === 'blocked') return false;
    }
    return true;
  }

  async function runShellStep(id: string, step: ShellInput) {
    const atMs = elapsed();
    let outcome: ShellOutcome;
    if (dryRun) {
      outcome = previewShell(step);
    } else {
      try {
        if (!shellTemp) shellTemp = await privateShellDirectory();
        const plan = await planShellStep(step, {
          baseDir: options.shell?.baseDir ?? process.cwd(),
          hostEnv: options.shell?.hostEnv ?? process.env,
          tempDir: shellTemp,
          privilege: options.shell?.privilege,
        });
        if (plan.privilege === 'root' && options.shell?.announceRoot) {
          // Show the exact program, arguments and directory before the dialog.
          options.shell.announceRoot({
            id, program: plan.program, args: plan.args, cwd: plan.cwd,
            mode: plan.privilegeMode ?? 'prompt',
          });
        }
        outcome = await runShell(plan, {
          signal, budget: shellBudgetState, canCapture, privilege: options.shell?.privilege,
          directory: shellTemp,
        });
      } catch (error) {
        if (!(error instanceof ShellFault)) throw error;
        const privilegeCode = error.code.startsWith('SHELL_PRIVILEGE_');
        outcome = {
          status: privilegeCode ? 'blocked' : 'failed',
          code: error.code,
          message: error.message,
          shell: { ...shellContext(step), execution: 'not-run' },
        };
      }
    }
    report.entries.push(shellEntry(id, outcome, atMs, elapsed() - atMs));
    if (outcome.status === 'blocked') {
      report.status = 'blocked';
      return true;
    }
    if (outcome.status === 'failed') {
      report.status = 'failed';
      return true;
    }
    return false;
  }

  const globalReady = await checkConditions(flow.setup, 'global');
  let halted = !globalReady;
  if (halted) report.status = 'blocked';
  try {
    for (const { id, action } of planned) {
      if (halted) {
        const status = globalReady ? 'skipped' : 'blocked';
        report.entries.push(action.kind === 'shell'
          ? shellEntry(id, {
            status,
            message: 'Stopped by an earlier result',
            shell: { ...shellContext(action), execution: 'not-run' },
          }, elapsed(), 0)
          : {
            id, kind: action.kind, status, atMs: elapsed(), durationMs: 0,
            message: 'Stopped by an earlier result',
          } as Entry);
        continue;
      }
      if (!await checkConditions(action.setup, id)) {
        if (action.kind === 'shell') {
          report.entries.push(shellEntry(id, {
            status: 'blocked', code: 'LOCAL_SETUP', message: 'Local precondition blocked this action',
            shell: { ...shellContext(action), execution: 'not-run' },
          }, elapsed(), 0));
        } else {
          await log(id, action.kind, async () =>
            ({ status: 'blocked', code: 'LOCAL_SETUP', message: 'Local precondition blocked this action' }));
        }
        report.status = 'blocked';
        continue;
      }
      if (action.kind === 'shell') {
        halted = await runShellStep(id, action);
        continue;
      }

      const status = await log(id, action.kind, async () => {
        if (action.kind === 'assert') {
          const context = {
            desktop: requireDesktop(),
            snapshot: () => snapshot(),
            baselineDir: options.baselineDir,
            secretTexts: options.secretTexts,
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
              if (await evaluate(requireDesktop(), await snapshot(Math.min(3000, remaining)), action.check)) break;
            } catch (error) {
              if (!(error instanceof Fault && ['NOT_FOUND', 'INCOMPLETE_TREE'].includes(error.code))) throw error;
            }
            if (performance.now() >= deadline) throw new Fault('WAIT_TIMEOUT', 'Wait condition did not match');
            await sleep(Math.min(100, Math.max(0, deadline - performance.now())), undefined, { signal });
          }
          return { status: 'passed' };
        }

        const current = await snapshot();
        const client = requireDesktop();
        if (action.kind === 'key') {
          if (dryRun) return { status: 'resolved', message: 'Window resolved for shortcut' };
          return { status: 'passed', delivery: await client.press(
            [...(action.modifiers ?? []), action.key].join('+'), current,
          ) };
        }
        if (action.target.kind === 'point') {
          if (!contains(current.tree.bounds, action.target.point)) {
            throw new Fault('UNSAFE_POINT', 'Coordinate is outside the selected window');
          }
          if (dryRun) return { status: 'resolved', message: 'Coordinate is within the selected window' };
          return { status: 'passed', delivery: await client.clickPoint(current, flow.target, action.target.point) };
        }

        const { node } = resolve(current, action.target);
        if (!node.ref || node.secure) throw new Fault('UNSAFE_TARGET', 'Control is secure or has no action reference');
        if (dryRun) return { status: 'resolved', message: `Resolved ${node.role}` };
        const delivery = action.kind === 'click' ? await client.click(node.ref) : await client.type(node.ref, options.secretTexts?.get(id) ?? action.text);
        return { status: 'passed', delivery };
      });
      if (status === 'failed') {
        report.status = 'failed';
        halted = true;
      }
    }
  } finally {
    if (shellTemp) await removeShellDirectory(shellTemp);
  }
  return report;
}
