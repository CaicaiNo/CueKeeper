import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
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

/**
 * Injected seam for the fixed admin tasks. The default runner never runs sudo
 * until HAOC-76 machine verification passes; offline tests supply a mock.
 */
export interface PrivilegeRunner {
  preflight(taskPath: string): Promise<{ taskId: string }>;
  run(request: PrivilegeRequest, signal: AbortSignal): Promise<PrivilegeExecution>;
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
