import { mkdir, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Fault } from './locator.js';

/**
 * The durable root the workbench uses for per-run desktop state. It lives
 * under the user's home because the value inherited in `TMPDIR` can disappear
 * while the process is still running: a workbench started from a finished
 * task's shell keeps pointing at that task's deleted temp directory, and macOS
 * reaps stale `/var/folders/.../T` entries on its own. Every recording then
 * failed in `mkdtemp` with a bare `ENOENT`.
 */
export const workdirEnv = 'CUEKEEPER_WORKDIR';

/** Last resort when the preferred root cannot be used. */
const fallbackRoot = '/tmp';

export function workdirRoot(env: NodeJS.ProcessEnv = process.env) {
  const override = env[workdirEnv]?.trim();
  return override ? resolve(override) : join(homedir(), '.cuekeeper', 'tmp');
}

/**
 * Where one run's directory goes. An explicit root wins — the workbench sets
 * one for its recorder child — and otherwise a run uses the system temp
 * directory, which is what a CLI run started from a normal shell always used.
 */
export function desktopWorkdirRoot(env: NodeJS.ProcessEnv = process.env) {
  const override = env[workdirEnv]?.trim();
  return override ? resolve(override) : tmpdir();
}

export interface DesktopWorkdir {
  /** A fresh directory for one run. The caller removes it when the run ends. */
  directory: string;
  /** The root the directory was created under. */
  root: string;
  /** True when the preferred root was unusable and the system directory was used. */
  fallback: boolean;
}

function reason(error: unknown) {
  const fault = error as NodeJS.ErrnoException | undefined;
  return fault?.code ? `${fault.code}: ${fault.message}` : String(error);
}

/**
 * Prepare the durable root before it is needed. Returns the reason it could
 * not be prepared, or undefined on success: start-up reports the problem while
 * the run itself still falls back.
 */
export async function prepareWorkdir(root = workdirRoot()) {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return undefined;
  } catch (error) {
    return reason(error);
  }
}

/**
 * One run's private directory. The durable root is created if it is missing; a
 * system temp directory is not, because an inherited `TMPDIR` that no longer
 * exists must fall back instead of being resurrected. Only when both fail does
 * the caller get an actionable fault instead of a bare `ENOENT`.
 */
export async function createDesktopWorkdir(
  root = desktopWorkdirRoot(), fallback = fallbackRoot,
): Promise<DesktopWorkdir> {
  // The durable root is ours to create; a temp dir handed to us is not.
  const durable = resolve(root) === resolve(workdirRoot());
  const candidates = root === fallback
    ? [{ path: root, create: false }]
    : [{ path: root, create: durable }, { path: fallback, create: false }];
  const attempts: { root: string; reason: string }[] = [];
  for (const candidate of candidates) {
    try {
      if (candidate.create) await mkdir(candidate.path, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(candidate.path, 'cuekeeper-'));
      return { directory, root: candidate.path, fallback: candidate.path !== root };
    } catch (error) {
      attempts.push({ root: candidate.path, reason: reason(error) });
    }
  }
  throw new Fault('WORKDIR_UNAVAILABLE',
    '无法为录制或回放准备临时工作目录，任务没有开始。' +
    `已尝试：${attempts.map(item => `${item.root}（${item.reason}）`).join('；')}。` +
    `请确认该目录存在且可写，或用 ${workdirEnv} 指定一个可写目录后重试。`, true);
}
