import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessScope } from './contracts-v2.js';
import { Fault } from './locator.js';

// System state checks: is one absolute path a regular file, and is one
// executable running. Both are observations of the machine, never of a window:
// nothing here launches, focuses, clicks or types, and neither probe needs the
// accessibility helper or an app identity.
//
// Process identity never trusts `ps comm` (which is argv[0], a value the
// process chooses) or `ps args` (which joins arguments into text). `ps` is read
// only for kernel-provided pid/uid/state; the executable path comes from
// `proc_pidpath` in the native helper, and the helper compares expected
// arguments itself against a bounded KERN_PROCARGS2 read, so raw argv never
// crosses back into Node and two arguments containing a space can never
// collapse into one.

export const psArgs = ['-axww', '-o', 'pid=', '-o', 'uid=', '-o', 'state='] as const;
export const psTimeoutMs = 3000;
export const maxPsBytes = 4 * 1024 * 1024;
export const processProbeTimeoutMs = 10_000;
export const maxProcessProbeBytes = 4 * 1024 * 1024;
/** Bounded fan-out: one helper call per same-name candidate. */
export const maxArgCandidates = 64;
export const maxListedProcesses = 8192;

/** One row of `ps -o pid= -o uid= -o state=`: kernel values only, no comm. */
export interface PidRow {
  pid: number;
  uid: number;
  state: string;
}

/** One live process the system reports. */
export interface ProcessIdentity {
  pid: number;
  /** Effective UID of the process. */
  uid: number;
  /**
   * Path from `proc_pidpath`, never the process-chosen argv[0]. Absent when the
   * system cannot name the executable (a deleted image, a protected process):
   * the PID is still alive and may be the one the flow names, so it stays an
   * unproven candidate instead of disappearing.
   */
  executable?: string;
  /**
   * Kernel short executable name (`pbi_name`), never the process's argv[0].
   * It outlives an unlinked image and lets an unmatched check exclude a live
   * PID that cannot be the one the flow names. Absent when the kernel does not
   * expose a name, which keeps that PID possible.
   */
  nameHint?: string;
  /** Generation marker; absent when the system will not prove identity. */
  startedAt?: string;
  /** False for a zombie: a corpse is not a running process. */
  live: boolean;
}

/**
 * `matched`: one live candidate proved the expected argv run. `unmatched`: the
 * argv was read in full and does not contain it. `unknown`: the candidate could
 * not be read (permission, init/protected process, PID reuse) — a reverse check
 * must never treat this as absent.
 */
export type ArgMatch = 'matched' | 'unmatched' | 'unknown';

export interface ArgCandidate {
  pid: number;
  executable: string;
  startedAt: string;
}

/** Read-only runtime facts. The macOS helper is one implementation. */
export interface ProcessProbe {
  /** Every live process; an unnameable executable stays as an unproven entry. */
  identities(): Promise<ProcessIdentity[]>;
  /** Compares `args` with argv[1...], entirely inside the probe. */
  matchArgs(candidate: ArgCandidate, args: string[]): Promise<ArgMatch>;
}

export interface SystemCheckDeps {
  /** Read-only metadata; follows symlinks exactly like stat(2). */
  stat?(path: string): Promise<{ isFile(): boolean }>;
  /** Tests replace it and never start a process. */
  probe?: ProcessProbe;
}

function helperPath() {
  return process.env.CUEKEEPER_APP_IDENTITY ?? fileURLToPath(new URL('./cuekeeper-identity', import.meta.url));
}

/**
 * One request to the read-only native helper: fixed argv, one bounded JSON
 * request on stdin, bounded stdout and a hard timeout. A missing helper is a
 * dependency failure; every other problem is an unknown observation.
 */
function runHelper(command: string, request?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const executable = helperPath();
    const child = spawn(executable, [command], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const finish = (error: Fault | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Fault('SYSTEM_CHECK_FAILED',
        `The process probe timed out after ${processProbeTimeoutMs} ms`));
    }, processProbeTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxProcessProbeBytes) {
        child.kill('SIGKILL');
        finish(new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned too much output'));
      }
    });
    child.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(code === 'ENOENT' || code === 'EACCES'
        ? new Fault('SYSTEM_CHECK_FAILED',
          'The process probe helper is unavailable; build it with npm run build:recorder')
        : new Fault('SYSTEM_CHECK_FAILED', `The process probe failed: ${code ?? 'unknown error'}`));
    });
    // A probe that exits before reading its request closes the pipe under the
    // write. EPIPE must become an unknown observation, not an uncaught error
    // that ends the CLI before any report is written.
    child.stdin.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      child.kill('SIGKILL');
      finish(new Fault('SYSTEM_CHECK_FAILED',
        `The process probe closed its request pipe (${code ?? 'write error'})`));
    });
    child.on('close', () => {
      if (settled) return;
      let envelope: unknown;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        finish(new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned no JSON envelope'));
        return;
      }
      const record = envelope as { ok?: unknown; data?: unknown; error?: unknown };
      if (record?.ok === true) {
        finish(undefined, record.data);
        return;
      }
      const fault = (record?.error ?? {}) as { code?: unknown; message?: unknown };
      finish(new Fault(
        typeof fault.code === 'string' && /^[A-Z_]+$/.test(fault.code) ? fault.code : 'SYSTEM_CHECK_FAILED',
        typeof fault.message === 'string' ? fault.message : 'The process probe failed',
      ));
    });
    try {
      if (request === undefined) child.stdin.end();
      else child.stdin.end(JSON.stringify(request));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      child.kill('SIGKILL');
      finish(new Fault('SYSTEM_CHECK_FAILED',
        `The process probe could not receive its request (${code ?? 'write error'})`));
    }
  });
}

/**
 * The fixed `ps` call: kernel-provided pid, effective uid and state. `comm` and
 * `args` are deliberately absent, so no process-chosen string decides identity.
 */
export function parsePidTable(output: string): PidRow[] {
  const rows: PidRow[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // macOS prints a negative uid for a few kernel-owned processes, so the
    // column is signed; a strict \d+ turned every check into "unparsable".
    const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) {
      throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned output that could not be parsed');
    }
    rows.push({ pid: Number(match[1]), uid: Number(match[2]), state: match[3] });
    if (rows.length > maxListedProcesses) {
      throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned too many processes');
    }
  }
  return rows;
}

/** Zombies are corpses, not running processes; their state starts with `Z`. */
export function isLiveState(state: string): boolean {
  return !/^Z/.test(state);
}

/** Runs the fixed process table call. Failure, timeout or overlong output is an unknown. */
export function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', [...psArgs], {
      encoding: 'utf8', timeout: psTimeoutMs, maxBuffer: maxPsBytes, env: { LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) {
        const reason = error.killed
          ? `timed out after ${psTimeoutMs} ms`
          : (error as NodeJS.ErrnoException).code ?? error.message;
        reject(new Fault('SYSTEM_CHECK_FAILED', `The process probe failed: ${reason}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** The real macOS helper, shared with the app-identity probe. */
export function nativeProcessProbe(): ProcessProbe {
  return {
    async identities() {
      const rows = parsePidTable(await runPs());
      const data = await runHelper('process-identities', { pids: rows.map(row => row.pid) });
      const record = data as { processes?: unknown };
      if (!Array.isArray(record?.processes)) {
        throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned no process table');
      }
      const observed = new Map<number, {
        executable?: string; nameHint?: string; startedAt?: string;
      }>();
      for (const entry of record.processes) {
        if (entry === null || typeof entry !== 'object') continue;
        const { pid, executable, name, startedAt } = entry as Record<string, unknown>;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue;
        const path = typeof executable === 'string' && executable.startsWith('/') ? executable : undefined;
        const hint = typeof name === 'string' && name ? name : undefined;
        const marker = typeof startedAt === 'string' && startedAt ? startedAt : undefined;
        observed.set(pid, {
          ...(path === undefined ? {} : { executable: path }),
          ...(hint === undefined ? {} : { nameHint: hint }),
          ...(marker === undefined ? {} : { startedAt: marker }),
        });
      }
      return rows.flatMap(row => {
        const seen = observed.get(row.pid);
        // No entry means the helper found the PID gone. An entry without a path
        // is a live process it could not name: keep it as an unproven candidate
        // instead of turning a possible match into a false "not running".
        if (seen === undefined) return [];
        return [{
          pid: row.pid, uid: row.uid, live: isLiveState(row.state),
          ...(seen.executable === undefined ? {} : { executable: seen.executable }),
          ...(seen.nameHint === undefined ? {} : { nameHint: seen.nameHint }),
          ...(seen.startedAt === undefined ? {} : { startedAt: seen.startedAt }),
        }];
      });
    },
    async matchArgs(candidate, args) {
      const data = await runHelper('process-argv', {
        pid: candidate.pid, executable: candidate.executable,
        startedAt: candidate.startedAt, args,
      });
      const status = (data as { status?: unknown } | null)?.status;
      if (status === 'matched' || status === 'unmatched' || status === 'unknown') return status;
      throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned an unknown argument status');
    },
  };
}

/**
 * A kernel short name is at most 31 bytes; a longer basename is truncated.
 * Only a truncated hint is compared as a prefix, and an absent hint stays
 * possible because the kernel gave no clue to exclude it.
 */
export function nameHintCouldMatch(hint: string | undefined, name: string): boolean {
  if (hint === undefined) return true;
  if (hint === name) return true;
  return Buffer.byteLength(hint, 'utf8') >= 31 && name.startsWith(hint);
}

/**
 * The two system observations. `fileExists` keeps the `stat` semantics the
 * contract promises: a regular file or a symlink to one exists, a directory or
 * any other non-regular file does not, a missing path does not, and every other
 * error stays unknown instead of answering false.
 */
export class SystemChecks {
  private readonly statFile: (path: string) => Promise<{ isFile(): boolean }>;
  private readonly probe: ProcessProbe;

  constructor(deps: SystemCheckDeps = {}) {
    this.statFile = deps.stat ?? (path => stat(path));
    this.probe = deps.probe ?? nativeProcessProbe();
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      return (await this.statFile(path)).isFile();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw new Fault('SYSTEM_CHECK_FAILED',
        `File ${path} could not be inspected (${code ?? 'unknown error'})`);
    }
  }

  /**
   * A path check matches the executable path verbatim. A name check matches the
   * executable's basename, case-sensitively. With `args`, only same-UID
   * candidates are read, one proven match is enough, and an unreadable
   * candidate that leaves every other candidate unmatched is an unknown.
   *
   * A live process whose executable path the system cannot name is not
   * automatically absent: when no reliable kernel name excludes it, it stays a
   * possible match and the answer is unknown. A different `pbi_name` excludes
   * an unrelated process, so one unreadable image never blocks every check.
   */
  async processRunning(scope: ProcessScope, expectedArgs?: readonly string[]): Promise<boolean> {
    const identities = (await this.probe.identities()).filter(identity => identity.live);
    const named = identities.filter(
      (identity): identity is ProcessIdentity & { executable: string } => identity.executable !== undefined);
    // A PID the system cannot name is only "possible" when a reliable kernel
    // clue still could be the target: its `pbi_name`, the basename the flow
    // asks for. An unrelated process with a different kernel name is excluded
    // instead of turning every unmatched check into an unknown.
    const possible = (name: string) => identities.filter(identity =>
      identity.executable === undefined && nameHintCouldMatch(identity.nameHint, name));
    const unknownPath = (count: number) => new Fault('SYSTEM_CHECK_FAILED',
      `${count} live process(es) may match but have no readable executable path`);
    if ('path' in scope) {
      if (named.some(identity => identity.executable === scope.path)) return true;
      const candidates = possible(basename(scope.path));
      if (candidates.length) throw unknownPath(candidates.length);
      return false;
    }
    const sameName = named.filter(identity => basename(identity.executable) === scope.name);
    const args = expectedArgs;
    if (args === undefined || args.length === 0) {
      if (sameName.length) return true;
      const candidates = possible(scope.name);
      if (candidates.length) throw unknownPath(candidates.length);
      return false;
    }
    const uid = process.geteuid?.();
    if (uid === undefined) {
      throw new Fault('SYSTEM_CHECK_FAILED', 'The effective user id is unavailable on this platform');
    }
    const candidates = sameName.filter(identity => identity.uid === uid);
    // The same UID's unnameable processes could be the target too, but only
    // when their kernel name could still be this name.
    const unresolved = possible(scope.name).filter(identity => identity.uid === uid).length;
    if (!candidates.length && !unresolved) return false;
    if (candidates.length + unresolved > maxArgCandidates) {
      throw new Fault('SYSTEM_CHECK_FAILED',
        `More than ${maxArgCandidates} same-name candidates; the argument check stays bounded`);
    }
    let unreadable = false;
    for (const candidate of candidates) {
      // Without a generation marker the system cannot prove this is still the
      // same process, so the candidate's arguments stay unknown.
      if (candidate.startedAt === undefined) {
        unreadable = true;
        continue;
      }
      const result = await this.probe.matchArgs({
        pid: candidate.pid, executable: candidate.executable, startedAt: candidate.startedAt,
      }, [...args]);
      if (result === 'matched') return true;
      if (result === 'unknown') unreadable = true;
    }
    if (unreadable || unresolved) {
      throw new Fault('SYSTEM_CHECK_FAILED',
        'The arguments of a matching process could not be read');
    }
    return false;
  }
}
