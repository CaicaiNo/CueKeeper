import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Flow, ShellEntry, ShellOutput, ShellResult, ShellStep } from './contracts.js';
import { Fault } from './locator.js';
import type { PrivilegeRunner, RootMode } from './shell-privilege.js';

/** Fixed search path for every user-mode step. No login shell, no shell rc files. */
export const shellPath = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Per-stream text retention limit. */
export const shellStreamLimit = 16 * 1024;
/** Whole-run retention limit across every shell stream. */
export const shellReportLimit = 1024 * 1024;
const shellInputLimit = 64 * 1024;
const cleanupGraceMs = 1000;

export class ShellFault extends Fault {}

/**
 * Structural view of a shell step. The union in the generated schema has no
 * shared object type for fields that only some variants allow, so readers use
 * this optional view and the planner validates the combination again.
 */
export type ShellInput = ShellStep & {
  readonly argv?: string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | { secretEnv: string }>;
  readonly timeoutMs?: number;
  readonly privilegeMode?: 'prompt' | 'sudoers' | 'keychain';
};

export type ShellPrivilege = 'user' | 'sudo' | 'root';

export interface ShellBudget {
  remaining: number;
}

export function shellBudget(): ShellBudget {
  return { remaining: shellReportLimit };
}

export interface ShellOutcome {
  status: 'passed' | 'failed' | 'blocked' | 'resolved' | 'skipped';
  code?: string;
  message?: string;
  shell: ShellResult;
}

export interface ShellPlan {
  id: string;
  mode: 'argv' | 'shell';
  privilege: ShellPrivilege;
  privilegeMode?: RootMode;
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  expectedExitCode: number;
  secretValues: string[];
  taskId?: string;
}

export interface ShellDescription {
  id: string;
  mode: 'argv' | 'shell';
  privilege: ShellPrivilege;
  privilegeMode?: RootMode;
  program: string;
  args: string[];
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
  expectedExitCode: number;
}

export interface ShellGate {
  code: 'SHELL_NOT_ALLOWED' | 'SHELL_PRIVILEGE_REQUIRED';
  stepId: string;
  message?: string;
}

export function shellMode(step: ShellInput): 'argv' | 'shell' {
  return step.shell === true ? 'shell' : 'argv';
}

export function shellPrivilege(step: ShellInput): ShellPrivilege {
  return step.privilege === 'sudo' ? 'sudo' : step.privilege === 'root' ? 'root' : 'user';
}

/** Root steps default to the interactive password dialog. */
export function shellPrivilegeMode(step: ShellInput): RootMode {
  return step.privilegeMode === 'sudoers' ? 'sudoers'
    : step.privilegeMode === 'keychain' ? 'keychain' : 'prompt';
}

/**
 * `--non-interactive` upgrades a prompt-mode root step to the login keychain.
 * An explicit `sudoers` or `keychain` choice in the flow is never overridden.
 */
export function effectiveRootMode(
  step: ShellInput, options: { nonInteractive?: boolean } = {},
): RootMode {
  const mode = shellPrivilegeMode(step);
  return mode === 'prompt' && options.nonInteractive ? 'keychain' : mode;
}

/** The `shell` report fields that do not depend on how execution ended. */
export function shellContext(step: ShellInput, options: { nonInteractive?: boolean } = {}) {
  const privilege = shellPrivilege(step);
  return {
    mode: shellMode(step), privilege,
    ...(privilege === 'root' ? { privilegeMode: effectiveRootMode(step, options) } : {}),
  };
}

/** Shell steps reachable from the expanded plan. */
export function reachableShells(planned: { id: string; action: { kind: string } }[]) {
  return planned.filter((step): step is { id: string; action: ShellInput } => step.action.kind === 'shell');
}

/** Includes shell steps in behavior definitions the flow never calls. */
export function definedShells(flow: Flow): ShellInput[] {
  return (flow.behaviors ?? []).flatMap(behavior =>
    behavior.steps.filter((step): step is ShellInput => step.kind === 'shell'));
}

export function flowHasShellDefinitions(flow: Flow) {
  return flow.steps.some(step => step.kind === 'shell') || definedShells(flow).length > 0;
}

export function summarizeShellUsage(flow: Flow, planned: { id: string; action: { kind: string } }[]) {
  const reachable = reachableShells(planned).map(step => step.action);
  const defined = definedShells(flow);
  return {
    reachable: reachable.length,
    definitions: defined.length,
    privileged: [...reachable, ...defined].filter(step => shellPrivilege(step) !== 'user').length,
  };
}

export function hasShellSecrets(step: ShellInput) {
  return Object.values(step.env ?? {}).some(value => typeof value === 'object');
}

/** Gate checked before the desktop adapter is initialized. */
export function shellGate(
  flow: Flow, planned: { id: string; action: { kind: string } }[],
  options: { allowShell: boolean; allowSudo: boolean; interactive?: boolean; nonInteractive?: boolean },
): ShellGate | undefined {
  const steps = reachableShells(planned);
  if (steps.length && !options.allowShell) {
    return { code: 'SHELL_NOT_ALLOWED', stepId: steps[0].id };
  }
  for (const step of steps) {
    const privilege = shellPrivilege(step.action);
    if (privilege !== 'user' && !options.allowSudo) {
      return {
        code: 'SHELL_PRIVILEGE_REQUIRED', stepId: step.id,
        message: 'Privileged shell steps require --allow-sudo',
      };
    }
    const mode = effectiveRootMode(step.action, { nonInteractive: options.nonInteractive });
    if (privilege === 'root' && mode === 'prompt' && !options.interactive) {
      // Never fall back to the non-interactive form: a root step either shows
      // the password dialog on purpose or it does not run at all.
      return {
        code: 'SHELL_PRIVILEGE_REQUIRED', stepId: step.id,
        message: 'Interactive root steps require --interactive or --non-interactive',
      };
    }
  }
  return undefined;
}

function textBytes(values: string[]) {
  return values.reduce((total, value) => total + Buffer.byteLength(value), 0);
}

function baseEnvironment(tempDir: string, hostEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const info = userInfo();
  return {
    HOME: hostEnv.HOME ?? info.homedir,
    USER: info.username,
    LOGNAME: info.username,
    TMPDIR: tempDir,
    LANG: 'C',
    PATH: shellPath,
  };
}

export function describeShellStep(
  step: ShellInput, context: { baseDir: string; nonInteractive?: boolean },
): ShellDescription {
  const mode = shellMode(step);
  const privilege = shellPrivilege(step);
  const cwd = privilege === 'sudo' ? '/' : resolve(context.baseDir, step.cwd ?? '.');
  const program = privilege === 'sudo' ? step.argv![0] : mode === 'shell' ? '/bin/sh' : step.argv![0];
  const args = privilege === 'sudo' ? [] : mode === 'shell' ? ['-c', step.command!] : step.argv!.slice(1);
  return {
    id: step.id, mode, privilege, program, args, cwd,
    ...(privilege === 'root'
      ? { privilegeMode: effectiveRootMode(step, { nonInteractive: context.nonInteractive }) }
      : {}),
    envKeys: Object.keys(step.env ?? {}).sort(),
    timeoutMs: step.timeoutMs ?? 30_000,
    expectedExitCode: step.expectedExitCode ?? 0,
  };
}

/**
 * Resolves a live shell step into an executable plan. Everything is validated
 * before the process starts so a bad cwd or missing secret never spawns.
 */
export async function planShellStep(
  step: ShellInput,
  context: {
    baseDir: string; hostEnv: NodeJS.ProcessEnv; tempDir: string; privilege?: PrivilegeRunner;
    /** `--non-interactive`: prompt-mode root steps resolve to the keychain. */
    nonInteractive?: boolean;
  },
): Promise<ShellPlan> {
  const mode = shellMode(step);
  const privilege = shellPrivilege(step);
  const timeoutMs = step.timeoutMs ?? 30_000;
  const expectedExitCode = step.expectedExitCode ?? 0;
  const cwd = resolve(context.baseDir, step.cwd ?? '.');
  const secretValues: string[] = [];

  if (mode === 'argv' && !step.argv![0]) {
    throw new ShellFault('SHELL_START_FAILED', 'The shell program name is empty');
  }

  if (privilege === 'sudo') {
    const path = step.argv![0];
    if (!context.privilege) {
      throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged tasks are disabled on this host');
    }
    const { taskId } = await context.privilege.preflight(path);
    return {
      id: step.id, mode: 'argv', privilege, program: path, args: [],
      cwd: '/', env: {}, timeoutMs: 30_000, expectedExitCode, secretValues, taskId,
    };
  }

  if (privilege === 'root') {
    const runner = context.privilege;
    if (!runner?.preflightRoot) {
      throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Root steps are disabled on this host');
    }
    if (mode !== 'argv') {
      throw new ShellFault('SHELL_START_FAILED', 'Root steps must use an explicit argv');
    }
    let rootCwdInfo;
    try {
      rootCwdInfo = await stat(cwd);
    } catch {
      throw new ShellFault('SHELL_START_FAILED', 'The shell working directory does not exist');
    }
    if (!rootCwdInfo.isDirectory()) {
      throw new ShellFault('SHELL_START_FAILED', 'The shell working directory is not a directory');
    }
    const program = step.argv![0];
    const args = step.argv!.slice(1);
    if (textBytes([program, ...args]) > shellInputLimit) {
      throw new ShellFault('SHELL_START_FAILED', 'Shell arguments exceed 64 KiB');
    }
    const privilegeMode = effectiveRootMode(step, { nonInteractive: context.nonInteractive });
    await runner.preflightRoot({ program, args, cwd, mode: privilegeMode });
    return {
      id: step.id, mode: 'argv', privilege, privilegeMode, program, args, cwd,
      env: {}, timeoutMs, expectedExitCode, secretValues,
    };
  }

  let cwdInfo;
  try {
    cwdInfo = await stat(cwd);
  } catch {
    throw new ShellFault('SHELL_START_FAILED', 'The shell working directory does not exist');
  }
  if (!cwdInfo.isDirectory()) {
    throw new ShellFault('SHELL_START_FAILED', 'The shell working directory is not a directory');
  }

  const env = baseEnvironment(context.tempDir, context.hostEnv);
  for (const [key, value] of Object.entries(step.env ?? {})) {
    if (typeof value === 'string') {
      env[key] = value;
      continue;
    }
    const secret = context.hostEnv[value.secretEnv];
    if (!secret) {
      throw new ShellFault('SHELL_START_FAILED', `Missing environment variable ${value.secretEnv}`);
    }
    if (secret.length > 4000) {
      throw new ShellFault('SHELL_START_FAILED', `Environment variable ${value.secretEnv} is too long`);
    }
    env[key] = secret;
    secretValues.push(secret);
  }

  const argv: string[] = step.argv ?? [];
  const program: string = mode === 'shell' ? '/bin/sh' : argv[0];
  const args: string[] = mode === 'shell' ? ['-c', step.command ?? ''] : argv.slice(1);
  const envBytes = Object.entries(env).flatMap(([key, value]) => value === undefined ? [key] : [key, value]);
  if (textBytes([program, ...args, ...envBytes]) > shellInputLimit) {
    throw new ShellFault('SHELL_START_FAILED', 'Shell arguments and environment exceed 64 KiB');
  }
  return {
    id: step.id, mode, privilege, program, args, cwd, env,
    timeoutMs, expectedExitCode, secretValues,
  };
}

export async function privateShellDirectory() {
  return mkdtemp(join(tmpdir(), 'cuekeeper-shell-'));
}

export async function removeShellDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

export function previewShell(step: ShellInput, options: { nonInteractive?: boolean } = {}): ShellOutcome {
  return { status: 'resolved', shell: { ...shellContext(step, options), execution: 'preview' } };
}

class StreamCapture {
  private chunks: Buffer[] = [];
  private kept = 0;
  bytes = 0;
  truncated = false;

  push(chunk: Buffer) {
    this.bytes += chunk.length;
    const room = shellStreamLimit - this.kept;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) this.truncated = true;
    const slice = chunk.subarray(0, Math.min(chunk.length, room));
    this.chunks.push(Buffer.from(slice));
    this.kept += slice.length;
  }

  data() {
    return Buffer.concat(this.chunks);
  }
}

/** Drops at most three bytes of a cut multi-byte sequence. */
function decodeCaptured(data: Buffer, truncated: boolean): string | undefined {
  let bytes = data;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      if (!truncated || bytes.length === 0) return undefined;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
  }
  return undefined;
}

const ansiPattern = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitizeShellText(text: string) {
  return text.replace(ansiPattern, '').replace(/\r\n?/g, '\n').replace(controlPattern, '');
}

function limitedText(text: string, remaining: number) {
  if (Buffer.byteLength(text) <= remaining) return text;
  let end = Math.min(text.length, remaining);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > remaining) end--;
  return text.slice(0, end);
}

function outputFor(capture: StreamCapture, canCapture: boolean, budget: ShellBudget, warning: { set: boolean }) {
  const bytes = capture.bytes;
  const truncated = capture.truncated;
  if (truncated) warning.set = true;
  if (!canCapture) return { kind: 'omitted', bytes, truncated } as ShellOutput;
  const data = capture.data();
  const text = decodeCaptured(data, truncated);
  if (text === undefined) return { kind: 'binary', bytes, truncated } as ShellOutput;
  let final = sanitizeShellText(text);
  let cut = truncated;
  if (budget.remaining <= 0) {
    warning.set = true;
    return { kind: 'omitted', bytes, truncated: true } as ShellOutput;
  }
  if (Buffer.byteLength(final) > budget.remaining) {
    final = limitedText(final, budget.remaining);
    cut = true;
    warning.set = true;
  }
  budget.remaining -= Buffer.byteLength(final);
  return { kind: 'text', bytes, truncated: cut, text: final } as ShellOutput;
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    /* The group already left. */
  }
}

export interface ShellRunContext {
  signal: AbortSignal;
  budget: ShellBudget;
  canCapture: boolean;
  privilege?: PrivilegeRunner;
  /** Private directory for privilege helpers; required by root steps. */
  directory?: string;
}

/**
 * Runs one user-mode step in its own POSIX session. Timeout and cancellation
 * signal the whole group, escalate to SIGKILL after one second, then wait for
 * the pipes to drain before reporting the outcome.
 */
export async function runShell(plan: ShellPlan, context: ShellRunContext): Promise<ShellOutcome> {
  if (plan.privilege === 'sudo') return runPrivileged(plan, context);
  if (plan.privilege === 'root') return runRootStep(plan, context);
  if (context.signal.aborted) {
    return {
      status: 'failed', code: 'SHELL_CANCELLED',
      message: 'The shell step was cancelled before it started',
      shell: { mode: plan.mode, privilege: 'user', execution: 'terminated', cleanup: 'complete' },
    };
  }
  return await new Promise<ShellOutcome>(resolvePromise => {
    let child;
    try {
      child = spawn(plan.program, plan.args, {
        cwd: plan.cwd, env: plan.env, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return resolvePromise(startFailed(plan));
    }
    const pid = child.pid;
    const stdout = new StreamCapture();
    const stderr = new StreamCapture();
    const warning = { set: false };
    let termination: 'SHELL_TIMEOUT' | 'SHELL_CANCELLED' | undefined;
    let spawnError: Error | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = async () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      context.signal.removeEventListener('abort', onAbort);
    };
    const terminate = (reason: 'SHELL_TIMEOUT' | 'SHELL_CANCELLED') => {
      if (termination || settled) return;
      termination = reason;
      if (pid) {
        killGroup(pid, 'SIGTERM');
        forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
        forceTimer.unref?.();
      }
    };
    const onAbort = () => terminate('SHELL_CANCELLED');

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', error => { spawnError = error; });
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      // The direct child is gone; reclaim anything it left in its group so the
      // pipes close and the plan can move on.
      if (!termination && pid && groupAlive(pid)) {
        killGroup(pid, 'SIGTERM');
        forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
        forceTimer.unref?.();
      }
    });
    if (plan.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate('SHELL_TIMEOUT'), plan.timeoutMs);
      timeoutTimer.unref?.();
    }
    context.signal.addEventListener('abort', onAbort, { once: true });

    const finish = async () => {
      if (settled) return;
      settled = true;
      await cleanup();
      if (spawnError) return resolvePromise(startFailed(plan));
      let cleaned: 'complete' | 'unknown' = 'complete';
      if (pid && groupAlive(pid)) {
        // Wait for the group to leave after SIGTERM; escalate if it ignores it.
        const deadline = performance.now() + cleanupGraceMs + 500;
        while (groupAlive(pid) && performance.now() < deadline) await sleep(20);
        if (groupAlive(pid)) {
          killGroup(pid, 'SIGKILL');
          await sleep(50);
        }
        cleaned = groupAlive(pid) ? 'unknown' : 'complete';
      }
      const stdoutResult = outputFor(stdout, context.canCapture, context.budget, warning);
      const stderrResult = outputFor(stderr, context.canCapture, context.budget, warning);
      const shell: ShellResult = {
        mode: plan.mode, privilege: 'user',
        ...(termination ? { execution: 'terminated' as const, cleanup: cleaned } :
          { execution: 'finished' as const, ...(exit?.code !== null && exit?.code !== undefined
            ? { exitCode: exit.code } : {}) }),
        ...(exit?.signal && !termination ? { signal: exit.signal } : {}),
        stdout: stdoutResult, stderr: stderrResult,
        ...(warning.set ? { warnings: ['SHELL_OUTPUT_TRUNCATED'] as ['SHELL_OUTPUT_TRUNCATED'] } : {}),
      };
      if (termination === 'SHELL_TIMEOUT') {
        return resolvePromise({
          status: 'failed', code: 'SHELL_TIMEOUT',
          message: `The shell step exceeded ${plan.timeoutMs} ms`, shell,
        });
      }
      if (termination === 'SHELL_CANCELLED') {
        return resolvePromise({
          status: 'failed', code: 'SHELL_CANCELLED', message: 'The shell step was cancelled', shell,
        });
      }
      if (exit?.code === plan.expectedExitCode) return resolvePromise({ status: 'passed', shell });
      if (exit?.code !== undefined && exit?.code !== null) {
        return resolvePromise({
          status: 'failed', code: 'SHELL_EXIT',
          message: `The shell step exited with ${exit.code} instead of ${plan.expectedExitCode}`, shell,
        });
      }
      return resolvePromise({
        status: 'failed', code: 'SHELL_EXIT', message: 'The shell step was terminated by a signal', shell,
      });
    };
    child.once('close', () => { void finish(); });
  });
}

function startFailed(plan: ShellPlan, _error?: Error): ShellOutcome {
  return {
    status: 'failed', code: 'SHELL_START_FAILED',
    message: 'The shell step could not be started',
    shell: {
      mode: plan.mode, privilege: plan.privilege, execution: 'not-run',
    },
  };
}

async function runPrivileged(plan: ShellPlan, context: ShellRunContext): Promise<ShellOutcome> {
  const runner = context.privilege;
  if (!runner || !plan.taskId) {
    return {
      status: 'blocked', code: 'SHELL_PRIVILEGE_REQUIRED',
      message: 'Privileged tasks are disabled on this host',
      shell: { mode: 'argv', privilege: 'sudo', execution: 'not-run' },
    };
  }
  let result;
  try {
    result = await runner.run({ taskId: plan.taskId, path: plan.program }, context.signal);
  } catch (error) {
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The privileged task could not be started',
      shell: { mode: 'argv', privilege: 'sudo', execution: 'unknown', cleanup: 'unknown' },
    };
  }
  if (result.startFailed) {
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The privileged task could not be started',
      shell: { mode: 'argv', privilege: 'sudo', execution: 'not-run' },
    };
  }
  if (!result.started) {
    return {
      status: 'blocked', code: 'SHELL_PRIVILEGE_REQUIRED',
      message: 'The privileged task was refused before it started',
      shell: { mode: 'argv', privilege: 'sudo', execution: 'not-run' },
    };
  }
  if (result.cancelled) {
    return {
      status: 'failed', code: 'SHELL_CANCELLED', message: 'The privileged task was cancelled',
      shell: {
        mode: 'argv', privilege: 'sudo', execution: 'terminated',
        cleanup: result.cleanup ?? 'unknown',
      },
    };
  }
  if (result.timedOut) {
    return {
      status: 'failed', code: 'SHELL_TIMEOUT', message: 'The privileged task exceeded its 30 second limit',
      shell: {
        mode: 'argv', privilege: 'sudo', execution: 'terminated',
        cleanup: result.cleanup ?? 'unknown',
      },
    };
  }
  if (result.state !== 'finished' || result.exitCode === undefined) {
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The privileged task did not report a result',
      shell: {
        mode: 'argv', privilege: 'sudo', execution: 'unknown',
        cleanup: result.cleanup ?? 'unknown',
      },
    };
  }
  const shell: ShellResult = {
    mode: 'argv', privilege: 'sudo', execution: 'finished',
    exitCode: result.exitCode,
    ...(result.cleanup ? { cleanup: result.cleanup } : {}),
  };
  if (result.exitCode === plan.expectedExitCode) return { status: 'passed', shell };
  return {
    status: 'failed', code: 'SHELL_EXIT',
    message: `The privileged task exited with ${result.exitCode} instead of ${plan.expectedExitCode}`,
    shell,
  };
}

/**
 * Root steps report metadata only: the command's own output is never captured,
 * and authentication outcomes block the step instead of degrading to a
 * non-interactive attempt.
 */
async function runRootStep(plan: ShellPlan, context: ShellRunContext): Promise<ShellOutcome> {
  const base = {
    mode: 'argv' as const, privilege: 'root' as const,
    privilegeMode: plan.privilegeMode ?? 'prompt' as const,
  };
  if (context.signal.aborted) {
    return {
      status: 'failed', code: 'SHELL_CANCELLED',
      message: 'The root step was cancelled before it started',
      shell: { ...base, execution: 'terminated', cleanup: 'complete' },
    };
  }
  const runner = context.privilege;
  if (!runner?.runRoot || !context.directory) {
    return {
      status: 'blocked', code: 'SHELL_PRIVILEGE_REQUIRED',
      message: 'Root steps are disabled on this host',
      shell: { ...base, execution: 'not-run' },
    };
  }
  let result;
  try {
    result = await runner.runRoot({
      program: plan.program, args: plan.args, cwd: plan.cwd,
      mode: plan.privilegeMode ?? 'prompt', timeoutMs: plan.timeoutMs,
      directory: context.directory,
    }, context.signal);
  } catch (error) {
    if (error instanceof ShellFault) {
      return {
        status: 'blocked', code: error.code, message: error.message,
        shell: { ...base, execution: 'not-run' },
      };
    }
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The root step could not be started',
      shell: { ...base, execution: 'unknown', cleanup: 'unknown' },
    };
  }
  if (result.startFailed) {
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The root step could not be started',
      shell: { ...base, execution: 'not-run' },
    };
  }
  if (result.cancelled) {
    return {
      status: 'failed', code: 'SHELL_CANCELLED', message: 'The root step was cancelled',
      shell: { ...base, execution: 'terminated', cleanup: result.cleanup ?? 'unknown' },
    };
  }
  if (result.timedOut) {
    return {
      status: 'failed', code: 'SHELL_TIMEOUT',
      message: `The root step exceeded ${plan.timeoutMs} ms`,
      shell: { ...base, execution: 'terminated', cleanup: result.cleanup ?? 'unknown' },
    };
  }
  switch (result.authentication) {
    case 'missing':
      return {
        status: 'blocked', code: 'SUDO_CREDENTIAL_MISSING',
        message: 'No administrator credential is stored in the login keychain. Run `cuekeeper sudo set` first.',
        shell: { ...base, execution: 'not-run' },
      };
    case 'cancelled':
      return {
        status: 'blocked', code: 'SHELL_PRIVILEGE_CANCELLED',
        message: 'The administrator cancelled the password dialog',
        shell: { ...base, execution: 'not-run' },
      };
    case 'timeout':
      return {
        status: 'blocked', code: 'SHELL_PRIVILEGE_CANCELLED',
        message: 'The administrator password dialog timed out',
        shell: { ...base, execution: 'not-run' },
      };
    case 'unavailable':
      return {
        status: 'blocked', code: 'SHELL_PRIVILEGE_UNAVAILABLE',
        message: 'The password dialog could not be shown (no graphical session or permission denied)',
        shell: { ...base, execution: 'not-run' },
      };
    case 'refused':
      return {
        status: 'blocked', code: 'SHELL_PRIVILEGE_REQUIRED',
        message: 'This account may not run sudo',
        shell: { ...base, execution: 'not-run' },
      };
    case 'rejected':
      return {
        status: 'blocked', code: 'SHELL_PRIVILEGE_REQUIRED',
        message: 'The administrator password was rejected',
        shell: { ...base, execution: 'not-run' },
      };
    default:
      break;
  }
  if (result.state !== 'finished' || result.exitCode === undefined) {
    return {
      status: 'failed', code: 'SHELL_START_FAILED', message: 'The root step did not report a result',
      shell: { ...base, execution: 'unknown', cleanup: result.cleanup ?? 'unknown' },
    };
  }
  const shell: ShellResult = {
    ...base, execution: 'finished', exitCode: result.exitCode,
    ...(result.cleanup ? { cleanup: result.cleanup } : {}),
  };
  if (result.exitCode === plan.expectedExitCode) return { status: 'passed', shell };
  return {
    status: 'failed', code: 'SHELL_EXIT',
    message: `The root step exited with ${result.exitCode} instead of ${plan.expectedExitCode}`,
    shell,
  };
}

export function shellEntry(
  id: string, outcome: ShellOutcome, atMs: number, durationMs: number,
): ShellEntry {
  return {
    id, kind: 'shell', status: outcome.status, atMs, durationMs,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    shell: outcome.shell,
  };
}
