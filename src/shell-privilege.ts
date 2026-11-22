import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShellFault, shellPath } from './shell.js';

export const privilegeRoot = '/Library/CueKeeper/privileged';
export const privilegeRegistryName = 'registry.json';
export const privilegeTaskLimitMs = 30_000;
const recordLimit = 64 * 1024;
const cleanupGraceMs = 1000;

export interface PrivilegeRequest {
  taskId: string;
  path: string;
}

export interface PrivilegeExecution {
  started: boolean;
  state: 'finished' | 'terminated' | 'failed';
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  startFailed?: boolean;
  cleanup?: 'complete' | 'unknown';
}

/** How a root step proves it may run: a password dialog or a sudoers policy. */
export type RootMode = 'prompt' | 'sudoers';

export interface RootPreflight {
  program: string;
  args: string[];
  cwd: string;
  mode: RootMode;
}

export interface RootRequest extends RootPreflight {
  timeoutMs: number;
  /** Private directory that holds the askpass helper and its outcome files. */
  directory: string;
}

/**
 * The authentication verdict of a root step. `provided` means the dialog
 * returned a password; the command result is reported separately.
 */
export type RootAuthentication =
  'provided' | 'rejected' | 'cancelled' | 'timeout' | 'unavailable' | 'refused';

export interface RootExecution {
  started: boolean;
  state: 'finished' | 'terminated' | 'failed';
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  startFailed?: boolean;
  cleanup?: 'complete' | 'unknown';
  authentication?: RootAuthentication;
  /** Human-readable explanation for `unavailable` and `refused`. */
  reason?: string;
}

/**
 * Injected seam for the fixed admin tasks and for root steps. The default
 * runner never runs sudo until HAOC-76 machine verification passes; offline
 * tests supply a mock.
 */
export interface PrivilegeRunner {
  preflight(taskPath: string): Promise<{ taskId: string }>;
  run(request: PrivilegeRequest, signal: AbortSignal): Promise<PrivilegeExecution>;
  /** Static checks before a root step resolves. */
  preflightRoot?(request: RootPreflight): Promise<void>;
  /** Runs caller argv as root through the password dialog or a sudoers policy. */
  runRoot?(request: RootRequest, signal: AbortSignal): Promise<RootExecution>;
}

export interface PrivilegeRegistry {
  lookup(taskPath: string): Promise<{ taskId: string }>;
}

export function sudoInvocation(taskPath: string) {
  return {
    program: '/usr/bin/sudo',
    args: ['-n', '-k', '-u', 'root', '--', taskPath],
    cwd: '/',
    env: { PATH: shellPath, LANG: 'C' },
  };
}

function taskIdFromPath(taskPath: string, root: string) {
  const prefix = [root, privilegeRoot].map(base => `${base}/`).find(base => taskPath.startsWith(base));
  const name = prefix ? taskPath.slice(prefix.length) : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task path is not registered');
  }
  return name;
}

async function assertRegularOwnedFile(path: string, ownerUid: number, what: string) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', `${what} is not installed`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', `${what} is not a regular file`);
  }
  if (info.uid !== ownerUid) {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', `${what} is not owned by root`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', `${what} is writable by group or others`);
  }
  return info;
}

async function assertNoSymlinkComponents(path: string, root: string) {
  let current = root;
  await assertRoot(root);
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'The privileged task is not installed');
    }
    if (info.isSymbolicLink()) {
      throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task path contains a symbolic link');
    }
  }
}

async function assertRoot(root: string) {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task directory is not a real directory');
    }
  } catch (error) {
    if (error instanceof ShellFault) throw error;
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task directory is not installed');
  }
}

/**
 * Reads the administrator-owned registry. Paths, ownership and symlinks are
 * checked here; sudoers authorization itself is only proven at execution time.
 */
export function createFileRegistry(options: { root?: string; ownerUid?: number } = {}): PrivilegeRegistry {
  const root = options.root ?? privilegeRoot;
  const ownerUid = options.ownerUid ?? 0;
  return {
    async lookup(taskPath: string) {
      const taskId = taskIdFromPath(taskPath, root);
      // Tests may point the registry at a private root; the registered path is
      // always the deployed absolute path.
      const installed = join(root, taskId);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(root, privilegeRegistryName), 'utf8'));
      } catch {
        throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'The privileged task registry is missing');
      }
      const registry = raw as { version?: unknown; tasks?: unknown };
      if (registry?.version !== 1 || typeof registry.tasks !== 'object' || registry.tasks === null ||
          Array.isArray(registry.tasks)) {
        throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'The privileged task registry is invalid');
      }
      const entry = (registry.tasks as Record<string, unknown>)[taskId];
      if (typeof entry !== 'object' || entry === null) {
        throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task is not registered');
      }
      const registered = (entry as Record<string, unknown>).path;
      if (registered !== taskPath) {
        throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged task path does not match its registration');
      }
      await assertNoSymlinkComponents(installed, root);
      await assertRegularOwnedFile(join(root, privilegeRegistryName), ownerUid, 'The privileged task registry');
      const info = await assertRegularOwnedFile(installed, ownerUid, 'The privileged task');
      if ((info.mode & 0o100) === 0) {
        throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'The privileged task is not executable by its owner');
      }
      return { taskId };
    },
  };
}

/**
 * Parses the bounded stdout protocol of a fixed task: exactly one start record
 * followed by one finish record. Any extra or malformed line fails closed.
 */
export function interpretPrivilegeOutput(stdout: string, taskId: string) {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const parsed: { started: boolean; exitCode?: number; state?: string; error?: string } = { started: false };
  for (const [index, line] of lines.entries()) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return { started: parsed.started, error: 'Malformed privileged task record' };
    }
    if (typeof record !== 'object' || record === null) {
      return { started: parsed.started, error: 'Malformed privileged task record' };
    }
    const value = record as Record<string, unknown>;
    if (value.task !== taskId) return { started: parsed.started, error: 'Privileged task record is for another task' };
    if (index === 0) {
      if (value.record !== 'start' || parsed.started) {
        return { started: false, error: 'Expected the privileged task start record' };
      }
      parsed.started = true;
      continue;
    }
    if (index === 1) {
      if (value.record !== 'finish') return { started: true, error: 'Expected the privileged task finish record' };
      const state = value.state;
      if (state !== 'finished' && state !== 'failed' && state !== 'terminated') {
        return { started: true, error: 'The privileged task finish record is invalid' };
      }
      parsed.state = state;
      if (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode) &&
          value.exitCode >= 0 && value.exitCode <= 255) {
        parsed.exitCode = value.exitCode;
      } else if (state === 'finished') {
        return { started: true, error: 'The privileged task finish record has no exit code' };
      }
      continue;
    }
    return { started: true, error: 'Unexpected privileged task record' };
  }
  if (!parsed.started) return { started: false, error: 'The privileged task did not start' };
  if (parsed.state === undefined) return { started: true, error: 'The privileged task did not finish' };
  return parsed;
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

export function createSudoPrivilegeRunner(options: {
  registry?: PrivilegeRegistry;
  spawn?: typeof nodeSpawn;
  deadlineMs?: number;
} = {}): PrivilegeRunner {
  const registry = options.registry ?? createFileRegistry();
  const launch = options.spawn ?? nodeSpawn;
  const deadlineMs = options.deadlineMs ?? privilegeTaskLimitMs;

  return {
    preflight: taskPath => registry.lookup(taskPath),
    async run(request, signal) {
      if (signal.aborted) {
        return { started: false, state: 'terminated', cancelled: true, cleanup: 'complete' };
      }
      const invocation = sudoInvocation(request.path);
      return await new Promise<PrivilegeExecution>(resolvePromise => {
        let child;
        try {
          child = launch(invocation.program, invocation.args, {
            cwd: invocation.cwd, env: invocation.env, detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          return resolvePromise({ started: false, state: 'failed', startFailed: true });
        }
        const pid = child.pid;
        let stdout = '';
        let bytes = 0;
        let timedOut = false;
        let cancelled = false;
        let settled = false;
        let forceTimer: NodeJS.Timeout | undefined;
        let deadline: NodeJS.Timeout | undefined;
        const cleanup = () => {
          if (deadline) clearTimeout(deadline);
          if (forceTimer) clearTimeout(forceTimer);
          signal.removeEventListener('abort', onAbort);
        };
        const terminate = (reason: 'timeout' | 'cancel') => {
          if (settled) return;
          if (reason === 'timeout') timedOut = true;
          else cancelled = true;
          if (pid) {
            killGroup(pid, 'SIGTERM');
            forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
            forceTimer.unref?.();
          }
        };
        const onAbort = () => terminate('cancel');
        child.stdout?.on('data', (chunk: Buffer) => {
          if (bytes >= recordLimit) return;
          const room = recordLimit - bytes;
          const slice = chunk.subarray(0, room);
          bytes += slice.length;
          stdout += slice.toString('utf8');
        });
        // Privileged stderr never reaches the report.
        child.stderr?.on('data', () => undefined);
        let spawnError = false;
        child.once('error', () => { spawnError = true; });
        child.once('exit', () => {
          if (!timedOut && !cancelled && pid && groupAlive(pid)) {
            killGroup(pid, 'SIGTERM');
            forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
            forceTimer.unref?.();
          }
        });
        deadline = setTimeout(() => terminate('timeout'), deadlineMs);
        deadline.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
        child.once('close', () => {
          void (async () => {
            if (settled) return;
            settled = true;
            cleanup();
            let cleaned: 'complete' | 'unknown' = 'complete';
            if (pid && groupAlive(pid)) {
              const until = performance.now() + cleanupGraceMs + 500;
              while (groupAlive(pid) && performance.now() < until) await sleep(20);
              if (groupAlive(pid)) {
                killGroup(pid, 'SIGKILL');
                await sleep(50);
              }
              cleaned = groupAlive(pid) ? 'unknown' : 'complete';
            }
            const parsed = interpretPrivilegeOutput(stdout, request.taskId);
            if (cancelled) {
              return resolvePromise({
                started: true, state: 'terminated', cancelled: true, cleanup: cleaned,
              });
            }
            if (timedOut) {
              return resolvePromise({
                started: true, state: 'terminated', timedOut: true, cleanup: cleaned,
              });
            }
            if (!parsed.started) {
              return resolvePromise({ started: false, state: 'failed', ...(spawnError ? { startFailed: true } : {}) });
            }
            if (parsed.error !== undefined || parsed.state === undefined) {
              return resolvePromise({ started: true, state: 'failed', cleanup: cleaned });
            }
            return resolvePromise({
              started: true,
              state: parsed.state === 'finished' ? 'finished' : 'terminated',
              ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
              cleanup: cleaned,
            });
          })();
        });
      });
    },
  };
}

/**
 * Until HAOC-76 passes, the CLI never invokes sudo: privileged steps are
 * blocked at preflight with the same code used for a missing registration.
 */
export const disabledPrivilegeRunner: PrivilegeRunner = {
  async preflight() {
    throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'Privileged tasks are disabled until machine verification');
  },
  async run() {
    return { started: false, state: 'failed' };
  },
};

function shQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The native password dialog. `hidden answer` keeps the characters off screen,
 * `giving up after` bounds an unattended dialog, and the -128 branch reports a
 * Cancel click instead of relying on osascript's exit status.
 */
function askpassDialog(seconds: number) {
  return `try
set d to display dialog "CueKeeper 需要管理员密码，以便将一个 Shell 步骤作为 root 运行。" with title "CueKeeper 管理员授权" default answer "" with hidden answer buttons {"取消", "继续"} default button "继续" giving up after ${seconds}
if gave up of d then
return "timeout"
end if
return "ok:" & (text returned of d)
on error number -128
return "cancelled"
end try`;
}

/**
 * SUDO_ASKPASS helper. sudo reads the password from this program's stdout, so
 * the password only ever travels through a pipe. The helper records the
 * outcome (never the password) in its status file: sudo may re-ask after a
 * rejected password, and the `retry` line lets the parent tell "wrong
 * password" from "the command exited non-zero".
 */
function askpassSource(statusPath: string, promptCommand: string) {
  return `#!/bin/sh
umask 077
status=${shQuote(statusPath)}
if [ -e "$status" ]; then
  printf 'retry\\n' >> "$status"
  exit 1
fi
out=$(${promptCommand} 2>/dev/null)
case "$out" in
  ok:*)
    printf 'provided\\n' > "$status"
    printf '%s\\n' "\${out#ok:}"
    exit 0
    ;;
  cancelled) printf 'cancelled\\n' > "$status"; exit 1 ;;
  timeout) printf 'timeout\\n' > "$status"; exit 1 ;;
  *) printf 'unavailable\\n' > "$status"; exit 1 ;;
esac
`;
}

function sudoEnvironment(askpass?: string) {
  return {
    PATH: shellPath,
    LANG: 'C',
    ...(askpass ? { SUDO_ASKPASS: askpass, SUDO_ASKPASS_REQUIRE: 'force' } : {}),
  };
}

function readPromptStatus(path: string) {
  return readFile(path, 'utf8')
    .then(text => text.split('\n').map(line => line.trim()).filter(Boolean))
    .catch(() => [] as string[]);
}

async function writeAskpass(path: string, statusPath: string, promptCommand: string) {
  await writeFile(path, askpassSource(statusPath, promptCommand), { mode: 0o700 });
  await chmod(path, 0o700);
}

async function assertExecutable(path: string, message: string) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new ShellFault('SHELL_PRIVILEGE_UNAVAILABLE', message);
  }
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new ShellFault('SHELL_PRIVILEGE_UNAVAILABLE', message);
}

interface SupervisedResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  startFailed: boolean;
  cleanup?: 'complete' | 'unknown';
}

/**
 * Runs one sudo front-end in its own session with bounded cleanup. Output is
 * discarded: a privileged command's stdout never reaches the report, and the
 * askpass channel must stay a single pipe into sudo.
 */
async function runSupervised(
  launch: typeof nodeSpawn, program: string, args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<SupervisedResult> {
  if (options.signal.aborted) {
    return { code: null, signal: null, timedOut: false, cancelled: true, startFailed: false, cleanup: 'complete' };
  }
  return await new Promise<SupervisedResult>(resolvePromise => {
    let child;
    try {
      child = launch(program, args, {
        cwd: options.cwd, env: options.env, detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return resolvePromise({
        code: null, signal: null, timedOut: false, cancelled: false, startFailed: true,
      });
    }
    const pid = child.pid;
    let timedOut = false;
    let cancelled = false;
    let spawnError = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const terminate = (reason: 'timeout' | 'cancel') => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      if (pid) {
        killGroup(pid, 'SIGTERM');
        forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
        forceTimer.unref?.();
      }
    };
    const onAbort = () => terminate('cancel');
    if (options.timeoutMs > 0) {
      deadline = setTimeout(() => terminate('timeout'), options.timeoutMs);
      deadline.unref?.();
    }
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', () => { spawnError = true; });
    child.once('exit', () => {
      if (!timedOut && !cancelled && pid && groupAlive(pid)) {
        killGroup(pid, 'SIGTERM');
        forceTimer = setTimeout(() => { if (pid) killGroup(pid, 'SIGKILL'); }, cleanupGraceMs);
        forceTimer.unref?.();
      }
    });
    child.once('close', (code, signal) => {
      void (async () => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (forceTimer) clearTimeout(forceTimer);
        options.signal.removeEventListener('abort', onAbort);
        let cleaned: 'complete' | 'unknown' = 'complete';
        if (pid && groupAlive(pid)) {
          const until = performance.now() + cleanupGraceMs + 500;
          while (groupAlive(pid) && performance.now() < until) await sleep(20);
          if (groupAlive(pid)) {
            killGroup(pid, 'SIGKILL');
            await sleep(50);
          }
          cleaned = groupAlive(pid) ? 'unknown' : 'complete';
        }
        resolvePromise({
          code, signal, timedOut, cancelled, startFailed: spawnError, cleanup: cleaned,
        });
      })();
    });
  });
}

function commandExecution(result: SupervisedResult): RootExecution {
  if (result.startFailed) return { started: false, state: 'failed', startFailed: true };
  if (result.cancelled) {
    return { started: true, state: 'terminated', cancelled: true, cleanup: result.cleanup };
  }
  if (result.timedOut) {
    return { started: true, state: 'terminated', timedOut: true, cleanup: result.cleanup };
  }
  if (result.code === null) return { started: true, state: 'failed', cleanup: result.cleanup };
  return { started: true, state: 'finished', exitCode: result.code, cleanup: result.cleanup };
}

function authenticationFailure(
  verdict: RootAuthentication, extra: Partial<RootExecution> = {},
): RootExecution {
  return { started: false, state: 'failed', authentication: verdict, ...extra };
}

export interface RootRunnerOptions {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  sudoPath?: string;
  osascriptPath?: string;
  /** Program that answers the prompt. Tests inject a fake; defaults to osascript. */
  prompt?: string;
  /** How long the password dialog waits before it reports a timeout. */
  promptTimeoutMs?: number;
  /** Hard cap on the non-prompting `sudo -n -l` policy probe. */
  probeTimeoutMs?: number;
  /** Unattended sudoers execution stays off until HAOC-76 verifies it. */
  allowSudoers?: boolean;
}

/**
 * Root steps use either one interactive password dialog per step (sudo -A with
 * our askpass helper) or a pre-installed sudoers policy (`sudo -n`). Fixed
 * administrator tasks stay disabled on the same runner.
 */
export function createRootPrivilegeRunner(options: RootRunnerOptions = {}): PrivilegeRunner {
  const launch = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const sudoPath = options.sudoPath ?? '/usr/bin/sudo';
  const osascriptPath = options.osascriptPath ?? '/usr/bin/osascript';
  const promptTimeoutMs = options.promptTimeoutMs ?? 60_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
  const allowSudoers = options.allowSudoers ?? false;
  const promptCommand = options.prompt
    ? shQuote(options.prompt)
    : `${shQuote(osascriptPath)} -e ${shQuote(askpassDialog(Math.ceil(promptTimeoutMs / 1000)))}`;

  return {
    preflight: disabledPrivilegeRunner.preflight,
    run: disabledPrivilegeRunner.run,
    async preflightRoot(request) {
      if (request.mode === 'sudoers') {
        if (!allowSudoers) {
          throw new ShellFault(
            'SHELL_PRIVILEGE_REQUIRED',
            'Non-interactive root steps stay disabled until machine verification (HAOC-76)',
          );
        }
        await assertExecutable(sudoPath, 'The system sudo binary is missing');
        const probe = await runSupervised(launch, sudoPath,
          ['-n', '-l', '--', request.program, ...request.args],
          { cwd: request.cwd, env: sudoEnvironment(), timeoutMs: 10_000, signal: new AbortController().signal });
        if (probe.startFailed) throw new ShellFault('SHELL_PRIVILEGE_UNAVAILABLE', 'The system sudo binary could not be started');
        if (probe.timedOut || probe.cancelled) {
          throw new ShellFault('SHELL_PRIVILEGE_REQUIRED', 'The sudoers policy check did not finish');
        }
        if (probe.code !== 0) {
          throw new ShellFault(
            'SHELL_PRIVILEGE_REQUIRED',
            'The sudoers policy does not authorize this command without a password',
          );
        }
        return;
      }
      if (platform !== 'darwin') {
        throw new ShellFault('SHELL_PRIVILEGE_UNAVAILABLE', 'The administrator password dialog is only available on macOS');
      }
      await assertExecutable(sudoPath, 'The system sudo binary is missing');
      await assertExecutable(
        options.prompt ?? osascriptPath, 'The administrator password dialog helper is missing',
      );
    },
    async runRoot(request, signal) {
      if (signal.aborted) {
        return { started: false, state: 'terminated', cancelled: true, cleanup: 'complete' };
      }
      if (request.mode === 'sudoers') {
        const result = await runSupervised(launch, sudoPath,
          ['-n', '-k', '-u', 'root', '--', request.program, ...request.args],
          { cwd: request.cwd, env: sudoEnvironment(), timeoutMs: request.timeoutMs, signal });
        return commandExecution(result);
      }
      const nonce = randomUUID();
      const askpass = join(request.directory, `askpass-${nonce}.sh`);
      const status = join(request.directory, `askpass-${nonce}.status`);
      try {
        await writeAskpass(askpass, status, promptCommand);
      } catch {
        return { started: false, state: 'failed', startFailed: true };
      }

      // One sudo invocation per root step. `-k` drops any cached ticket so the
      // dialog belongs to this step, and sudo reuses the credential it just
      // obtained to run the command. A separate `sudo -A -k -v` probe prompted
      // twice on macOS: without a TTY the ticket validated by `-v` does not
      // cover the following sudo run (HAOC-100).
      // The deadline carries one full dialog window on top of the command
      // budget, so typing the password never eats into the command's time.
      // The dialog also bounds itself at promptTimeoutMs.
      const run = await runSupervised(launch, sudoPath,
        ['-A', '-k', '-u', 'root', '--', request.program, ...request.args],
        {
          cwd: request.cwd, env: sudoEnvironment(askpass),
          timeoutMs: request.timeoutMs + promptTimeoutMs, signal,
        });
      if (run.startFailed) return { started: false, state: 'failed', startFailed: true };
      if (run.cancelled) {
        return { started: true, state: 'terminated', cancelled: true, cleanup: run.cleanup };
      }
      const lines = await readPromptStatus(status);
      if (lines.includes('cancelled')) return authenticationFailure('cancelled');
      if (lines.includes('timeout')) return authenticationFailure('timeout');
      if (lines.includes('unavailable')) return authenticationFailure('unavailable');
      if (run.timedOut) {
        return { started: true, state: 'terminated', timedOut: true, cleanup: run.cleanup };
      }
      // The helper answers once and refuses every later sudo attempt, so a
      // `retry` line means sudo rejected the password and never ran the
      // command; otherwise the exit code is the command's own.
      if (lines.includes('retry') && run.code !== 0) return authenticationFailure('rejected');
      if (lines.includes('provided') || lines.includes('retry')) return commandExecution(run);
      if (run.code === 0) return commandExecution(run);
      // sudo never asked: a NOPASSWD rule let the command run, or the account
      // may not use sudo at all. A non-prompting policy check tells the two
      // apart without opening a second dialog.
      const policy = await runSupervised(launch, sudoPath,
        ['-n', '-l', '--', request.program, ...request.args],
        { cwd: request.cwd, env: sudoEnvironment(), timeoutMs: probeTimeoutMs, signal });
      if (policy.code === 0) return commandExecution(run);
      return authenticationFailure('refused');
    },
  };
}
