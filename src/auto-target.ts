import { captureTargetCheck } from './contracts.js';
import type { Target } from './contracts.js';
import type { Desktop, WindowInfo } from './desktop.js';
import { Fault } from './locator.js';

/** Same bundle-ID shape the record command accepts on its command line. */
const bundleIdPattern = /^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i;

/**
 * The window a one-key recording should target.
 *
 * The driver marks a window focused only when its app is frontmost and the
 * window joins to that app's `AXFocusedWindow`, so at most one window is
 * focused. A window without a title cannot be named as a flow target, so it
 * is ignored.
 */
export function focusedWindow(windows: WindowInfo[]): WindowInfo | undefined {
  return windows.find(window => window.isFocused === true && window.title.length > 0);
}

/**
 * Resolve the front window into a flow target after the countdown.
 *
 * With `app` the driver's app-filtered inventory is used and the bundle ID is
 * the user's. Without it the window's owner PID is joined to the app inventory:
 * a window with no owning bundle ID stays `APP_NOT_FOUND` instead of being
 * guessed from the title or the app name.
 */
export async function detectTarget(
  desktop: Desktop, options: { app?: string; timeoutMs?: number } = {},
): Promise<Target> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const windows = options.app
    ? await desktop.listWindows(options.app, timeoutMs)
    : await desktop.listAllWindows(timeoutMs);
  const window = focusedWindow(windows);
  if (!window) {
    throw new Fault('WINDOW_NOT_FOUND', options.app
      ? `应用 ${options.app} 没有处于前台的窗口。请先切换到要录制的窗口再重试。`
      : '没有找到前台窗口。请先打开要录制的 App 窗口，再运行 cuekeeper record。');
  }

  let app = options.app;
  if (!app) {
    if (window.pid === undefined) {
      throw new Fault('APP_NOT_FOUND', '无法确认前台窗口所属的应用进程，请先切换到要录制的 App 窗口。');
    }
    const running = await desktop.listApps(timeoutMs);
    const owner = running.find(item => item.pid === window.pid);
    app = owner?.bundleId;
    if (!app) {
      throw new Fault('APP_NOT_FOUND',
        '无法确认前台窗口所属应用的 bundle ID，请先切换到要录制的 App 窗口。');
    }
  }
  if (!bundleIdPattern.test(app)) {
    throw new Fault('APP_NOT_FOUND', `前台窗口所属应用没有可用的 bundle ID（${app}）`);
  }
  const target: Target = { app, window: window.title };
  if (!captureTargetCheck.Check(target)) {
    throw new Fault('WINDOW_NOT_FOUND', '前台窗口的标题无法作为录制目标');
  }
  return target;
}

/**
 * Give the user the few seconds they need to bring the target app forward.
 * Ticks go to the progress stream so `--json` keeps a clean stdout.
 */
export async function countdown(
  seconds: number,
  write: (line: string) => void,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
) {
  if (seconds === 0) {
    write('立即读取当前前台窗口。');
    return;
  }
  write(`${seconds} 秒后开始录制，请切换到要录制的 App 窗口。`);
  for (let left = seconds; left > 0; left--) {
    signal.throwIfAborted();
    write(`${left}…`);
    await sleep(1000);
  }
  signal.throwIfAborted();
}
