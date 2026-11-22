import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nativeIdentityProbe } from './app-identity.js';
import { describeApps } from './apps.js';
import { flatten } from './locator.js';
import type { Snapshot } from './locator.js';

const run = promisify(execFile);

// Chromium keeps a renderer's accessibility tree closed until the app enables
// it. Clicking such a window during a recording would otherwise produce a thin
// tree, a click on the window chrome, and a flow that cannot replay inside the
// editor. The preflight here only reads the target window and stops the
// recording when the app says its editor is not accessible.

export type ElectronAccessibility = 'enabled' | 'disabled' | 'unverified';

export const electronAccessibilityCode = 'ELECTRON_ACCESSIBILITY_REQUIRED';
export const electronAccessibilityUnverifiedCode = 'ELECTRON_ACCESSIBILITY_UNVERIFIED';

/** The exact hint the CLI and the workbench show when a recording is stopped. */
export function electronAccessibilityHint(app?: string) {
  const vsCode = app === undefined || app === 'com.microsoft.VSCode' || app === 'com.microsoft.VSCodeInsiders';
  if (!vsCode) {
    return [
      `「${app}」的无障碍编辑器没有开启，录制已停止。`,
      '请用 --force-renderer-accessibility 重启该应用，或在其设置里开启屏幕阅读器/无障碍模式，然后重新录制。',
    ].join('\n');
  }
  return [
    'VS Code 的无障碍编辑器没有开启，录制已停止。',
    '请用 --force-renderer-accessibility 重启 VS Code：',
    '  open -na "Visual Studio Code" --args --force-renderer-accessibility',
    '或在命令面板执行 Toggle Screen Reader Accessibility Mode，然后重新录制。',
  ].join('\n');
}

const editableRoles = new Set(['textfield', 'textarea', 'textbox', 'combobox', 'searchfield']);
// VS Code/Chromium name the AX placeholder that replaces an inaccessible
// editor. It is the only node that proves accessibility is off: a Welcome page
// has neither an editor nor a placeholder and stays unverified.
const inaccessibleEditor = /editor is not accessible/i;

/**
 * Reads the accessibility state out of one already-captured window tree.
 *
 * The capture snapshot exposes AX roles and refs but not the action list
 * (`TypeText`/`SetValue`), so an editable control carrying an AX ref is the
 * proof that Chromium exposed its web content. The placeholder wins over any
 * incidental text field: with accessibility off the app still draws chrome
 * widgets, but the editor itself is the placeholder.
 */
export function classifyElectronAccessibility(snapshot: Snapshot): ElectronAccessibility {
  const nodes = flatten(snapshot.tree).map(entry => entry.node);
  if (nodes.some(node => typeof node.name === 'string' && inaccessibleEditor.test(node.name))) return 'disabled';
  if (nodes.some(node => editableRoles.has(node.role) && node.ref)) return 'enabled';
  return 'unverified';
}

/** A macOS Electron app keeps its runtime in this framework directory. */
export async function isElectronBundlePath(path: string) {
  try {
    await access(join(path, 'Contents', 'Frameworks', 'Electron Framework.framework'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bundle IDs that are treated as Electron without reading the bundle. The
 * environment entry is an override for copies the system metadata misses (and
 * the seam tests use); the default is empty.
 */
export function configuredElectronApps() {
  return (process.env.CUEKEEPER_ELECTRON_APPS ?? '')
    .split(',').map(entry => entry.trim()).filter(Boolean);
}

/** The `.app` a running executable belongs to, from the system process list. */
async function runningBundlePath(pid: number) {
  try {
    const { stdout } = await run('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 1000, maxBuffer: 64 * 1024 });
    const executable = stdout.split('\n')[0]?.trim();
    // `ps -o comm=` reports the full executable path on macOS; the bundle is
    // the first `.app` segment that contains it.
    const bundle = executable?.match(/^(.*?\.app)(?:\/|$)/)?.[1];
    return bundle && bundle.startsWith('/') ? bundle : undefined;
  } catch {
    return undefined;
  }
}

/** The paths of the copies of one app that are running, or installed. */
export async function electronCandidatePaths(app: string, pid?: number) {
  const paths: string[] = [];
  // The running copy is the one whose window is being read, and the process
  // list answers without a helper, a Spotlight query or a 4s budget.
  if (pid) {
    const running = await runningBundlePath(pid);
    if (running) paths.push(running);
  }
  if (!paths.length) {
    const probe = nativeIdentityProbe();
    try {
      if (await probe.available()) {
        if (pid) {
          const instance = await probe.describe(pid);
          if (instance?.bundlePath) paths.push(instance.bundlePath);
        } else {
          for (const instance of await probe.instances(app)) {
            if (instance.bundlePath) paths.push(instance.bundlePath);
          }
        }
      }
    } catch {
      // The identity helper is optional for this read-only check.
    }
  }
  if (!paths.length) {
    try {
      paths.push(...(await describeApps([app]))[app]?.paths ?? []);
    } catch {
      // Spotlight metadata is optional as well.
    }
  }
  return [...new Set(paths)];
}

export interface ElectronWindow {
  app?: string;
  pid?: number;
  windowNumber?: number;
  windowTitle?: string;
}

export type ElectronSnapshotReader = (window: ElectronWindow) => Promise<Snapshot>;
export type ElectronBundleResolver = (app: string, pid?: number) => Promise<string[]>;

export interface ElectronAccessibilityGuardOptions {
  /** Reads one target window; a failed read keeps the current recording. */
  read: ElectronSnapshotReader;
  /** Bundle paths to inspect; defaults to running and installed copies. */
  bundles?: ElectronBundleResolver;
  /** Extra bundle IDs treated as Electron without reading the bundle. */
  knownApps?: Iterable<string>;
}

/**
 * Probes Electron targets at most once per app and window. A verdict is cached
 * so a burst of clicks costs one accessibility read, never one per event. A
 * failed read is not a verdict: the next event may still classify the window.
 */
export class ElectronAccessibilityGuard {
  private readonly read: ElectronSnapshotReader;
  private readonly bundles: ElectronBundleResolver;
  private readonly known: Set<string>;
  private readonly apps = new Map<string, Promise<boolean>>();
  private readonly verdicts = new Map<string, Promise<ElectronAccessibility | undefined>>();

  constructor(options: ElectronAccessibilityGuardOptions) {
    this.read = options.read;
    this.bundles = options.bundles ?? electronCandidatePaths;
    this.known = new Set([...configuredElectronApps(), ...(options.knownApps ?? [])]);
  }

  /** Whether this app is Electron; non-Electron apps cost no snapshot. */
  isElectron(app: string, pid?: number): Promise<boolean> {
    if (!app) return Promise.resolve(false);
    if (this.known.has(app)) return Promise.resolve(true);
    const cached = this.apps.get(app);
    if (cached) return cached;
    const pending = (async () => {
      try {
        for (const path of await this.bundles(app, pid)) {
          if (await isElectronBundlePath(path)) return true;
        }
      } catch {
        // A failed lookup skips the check instead of stopping the recording.
      }
      return false;
    })();
    this.apps.set(app, pending);
    return pending;
  }

  /**
   * `undefined` means "not an Electron app" (or an unreadable window): the
   * caller records normally. `disabled` is the only verdict that stops capture.
   */
  async inspect(window: ElectronWindow, cacheKey?: string): Promise<ElectronAccessibility | undefined> {
    const app = window.app;
    if (!app) return undefined;
    if (!(await this.isElectron(app, window.pid))) return undefined;
    const key = `${app}:${cacheKey ?? `${window.pid ?? 0}:${window.windowNumber ?? 0}`}`;
    const cached = this.verdicts.get(key);
    if (cached) return cached;
    const pending = (async () => {
      try {
        return classifyElectronAccessibility(await this.read(window));
      } catch {
        return undefined;
      }
    })();
    this.verdicts.set(key, pending);
    const verdict = await pending;
    if (verdict === undefined) this.verdicts.delete(key);
    return verdict;
  }
}
