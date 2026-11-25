import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ProcessScope } from './contracts-v2.js';
import { Fault } from './locator.js';

// System state checks: is one absolute path a regular file, and is one
// executable running. Both are observations of the machine, never of a window:
// nothing here launches, focuses, clicks or types, and neither probe needs the
// accessibility helper or an app identity. The process probe runs a fixed
// `/bin/ps` argv with no shell and never passes a flow value as an argument.

/** The fixed argv the process probe uses. User input is never appended to it. */
export const psArgs = ['-axww', '-o', 'pid=', '-o', 'state=', '-o', 'comm='] as const;
export const psTimeoutMs = 3000;
export const maxPsBytes = 1024 * 1024;

/** One row of `ps -o pid= -o state= -o comm=`. `comm` may contain spaces. */
export interface ProcessEntry {
  pid: number;
  state: string;
  comm: string;
}

export interface SystemCheckDeps {
  /** Read-only metadata; follows symlinks exactly like stat(2). */
  stat?(path: string): Promise<{ isFile(): boolean }>;
  /** Returns `/bin/ps` stdout; tests replace it and never start a process. */
  ps?(): Promise<string>;
}

/**
 * Parses the bounded `ps` output. A line that does not fit the three columns is
 * a probe failure, not an empty process table: a negative check must never pass
 * because the output was unreadable.
 */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe returned output that could not be parsed');
    }
    entries.push({ pid: Number(match[1]), state: match[2], comm: match[3] });
  }
  return entries;
}

/** Zombies are corpses, not running processes; their state starts with `Z`. */
export function isLiveProcess(entry: ProcessEntry): boolean {
  return !/^Z/.test(entry.state);
}

/**
 * True when any live process matches. A name is the basename of the visible
 * executable (so a path with spaces stays one comparison); a path is compared
 * verbatim, with no symlink equivalence, because the flow named that path.
 */
export function processMatches(entries: ProcessEntry[], scope: ProcessScope): boolean {
  return entries.some(entry => {
    if (!isLiveProcess(entry)) return false;
    return 'name' in scope ? basename(entry.comm) === scope.name : entry.comm === scope.path;
  });
}

/** Runs the fixed probe. Failure, timeout or overlong output is an unknown. */
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

/**
 * The two system observations. `fileExists` keeps the `stat` semantics the
 * contract promises: a regular file or a symlink to one exists, a directory or
 * any other non-regular file does not, a missing path does not, and every other
 * error stays unknown instead of answering false.
 */
export class SystemChecks {
  private readonly statFile: (path: string) => Promise<{ isFile(): boolean }>;
  private readonly probe: () => Promise<string>;

  constructor(deps: SystemCheckDeps = {}) {
    this.statFile = deps.stat ?? (path => stat(path));
    this.probe = deps.ps ?? runPs;
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

  async processRunning(scope: ProcessScope): Promise<boolean> {
    const output = await this.probe();
    return processMatches(parseProcessTable(output), scope);
  }
}
