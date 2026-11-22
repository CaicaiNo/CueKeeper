import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppIdentitySession } from '../dist/app-identity.js';
import { reportV2Check } from '../dist/contracts-v2.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { InstallState } from '../dist/install-state.js';
import { Fault, parseSnapshot } from '../dist/locator.js';
import { runFlowV2 } from '../dist/run-v2.js';

// Acceptance sequence for HAOC-115, driven end to end with no GUI: a browser
// download finishes, the Installer appears, the install completes, the app
// appears, an uninstaller runs and the app disappears. Every wait is observed
// through the same read-only seams production uses.

const browser = 'com.apple.Safari';
const installer = 'com.apple.installer';
const uninstaller = 'com.example.Uninstaller';
const target = 'com.example.CuekeeperTest';
const browserPath = '/Applications/Safari.app';
const installerPath = '/Applications/Install CuekeeperTest.app';
const uninstallerPath = '/Applications/Uninstaller.app';
const targetPath = '/Applications/CuekeeperTest.app';
const appPaths = {
  [browser]: browserPath,
  [installer]: installerPath,
  [uninstaller]: uninstallerPath,
  [target]: targetPath,
};

const browserScope = { kind: 'window', app: browser, windowKey: 'downloads', windowTitle: 'Downloads' };
const installerScope = { kind: 'window', app: installer, windowKey: 'installer', windowTitle: 'Install CuekeeperTest' };
const uninstallerScope = { kind: 'window', app: uninstaller, windowKey: 'uninstaller', windowTitle: 'Uninstall CuekeeperTest' };

function envelope(windowId, title, children = []) {
  return {
    complete: true,
    window: { id: windowId, title },
    tree: {
      role: 'window', name: title, bounds: { x: 10, y: 10, width: 800, height: 600 },
      children,
    },
  };
}

function button(name, ref, states = ['enabled']) {
  return {
    role: 'button', name, ref_id: ref, bounds: { x: 40, y: 500, width: 120, height: 32 }, states,
  };
}

/**
 * One world for the whole scenario. Waits advance it by observing, exactly like
 * a real system would: the download completes after two reads, the Installer
 * starts after two process reads, the install lands after two bundle reads and
 * removal lands after two more.
 */
function lifecycleWorld(options = {}) {
  const state = {
    calls: [],
    focused: undefined,
    downloadReads: 0,
    enabledReads: 0,
    installerReads: 0,
    uninstallerReads: 0,
    installReads: 0,
    removalReads: 0,
    installCompleted: false,
    installerRunning: false,
    uninstallerRunning: false,
    targetInstalled: false,
    targetRemoved: false,
    targetProcessRunning: options.targetProcessRunning ?? true,
    neverInstalled: options.neverInstalled === true,
    receipts: [],
  };

  const processes = () => {
    const map = new Map();
    map.set(501, { pid: 501, startedAt: '501.1', bundleId: browser, bundlePath: browserPath });
    if (state.installerRunning) map.set(900, { pid: 900, startedAt: '900.1', bundleId: installer, bundlePath: installerPath });
    if (state.uninstallerRunning) map.set(950, { pid: 950, startedAt: '950.1', bundleId: uninstaller, bundlePath: uninstallerPath });
    if (state.targetProcessRunning) map.set(700, { pid: 700, startedAt: '700.1', bundleId: target, bundlePath: targetPath });
    return map;
  };

  const windows = () => {
    const list = [{
      id: 'w-11', app: browser, pid: 501, title: 'Downloads', data: envelope('w-11', 'Downloads', [{
        role: 'statictext', name: 'Download status', bounds: { x: 20, y: 40, width: 300, height: 20 },
        text: state.downloadReads >= 2 ? 'Download complete' : 'Downloading…',
      }]),
    }];
    if (state.installerRunning) {
      list.push({
        id: 'w-31', app: installer, pid: 900, title: 'Install CuekeeperTest',
        data: envelope('w-31', 'Install CuekeeperTest', [
          button('Continue', '@w31:e9', state.enabledReads >= 2 ? ['enabled'] : ['disabled']),
        ]),
      });
    }
    if (state.uninstallerRunning) {
      list.push({
        id: 'w-41', app: uninstaller, pid: 950, title: 'Uninstall CuekeeperTest',
        data: envelope('w-41', 'Uninstall CuekeeperTest', [button('Uninstall', '@w41:e9')]),
      });
    }
    return list;
  };

  const byId = id => windows().find(window => window.id === id);

  const desktop = {
    async snapshotWindow(windowId) {
      state.calls.push(['snapshotWindow', windowId]);
      const window = byId(windowId);
      if (!window) throw new Fault('WINDOW_NOT_FOUND', 'window is gone');
      if (windowId === 'w-11') state.downloadReads += 1;
      if (windowId === 'w-31') state.enabledReads += 1;
      return parseSnapshot(window.data, { app: '', window: window.title });
    },
    async listAllWindows() {
      state.calls.push(['listAllWindows']);
      return windows().map(window => ({
        id: window.id, title: window.title, processInstance: window.pid,
        isFocused: window.id === state.focused,
      }));
    },
    async focusedWindow() {
      return state.focused === undefined ? undefined : windows()
        .map(window => ({ id: window.id, title: window.title }))
        .find(window => window.id === state.focused);
    },
    async listWindows(app) {
      return windows().filter(window => window.app === app).map(window => ({ id: window.id, title: window.title }));
    },
    async focusWindow(windowId) {
      state.calls.push(['focusWindow', windowId, { installed: state.installCompleted }]);
      if (!byId(windowId)) throw new Fault('WINDOW_NOT_FOUND', 'window is gone');
      state.focused = windowId;
    },
    async click(ref) {
      state.calls.push(['click', ref, { installed: state.installCompleted }]);
      return 'delivered_verified';
    },
    async snapshot() { throw new Fault('UNSUPPORTED', 'cross-app replay reads windows by ID'); },
    async property(node, property) {
      if (property === 'visible') return true;
      return node[property] ?? node.value ?? node.name ?? '';
    },
    async ensure() { throw new Fault('UNSUPPORTED', 'no repair'); },
    async listApps() { return []; },
    async readClipboard() { return { type: 'empty' }; },
    async writeClipboard() { throw new Fault('UNSUPPORTED', 'no clipboard'); },
    async screenshotWindow() { throw new Fault('UNSUPPORTED', 'no screenshots'); },
    async screenshot() { throw new Fault('UNSUPPORTED', 'no screenshots'); },
    async press() { throw new Fault('UNSUPPORTED', 'no keys'); },
    async type() { throw new Fault('UNSUPPORTED', 'no typing'); },
    async scroll() { throw new Fault('UNSUPPORTED', 'no scroll'); },
    async drag() { throw new Fault('UNSUPPORTED', 'no drag'); },
    async hoverAt() { throw new Fault('UNSUPPORTED', 'no hover'); },
    async clickPoint() { throw new Fault('UNSUPPORTED', 'no points'); },
    async scrollPoint() { throw new Fault('UNSUPPORTED', 'no points'); },
    async focus() { throw new Fault('UNSUPPORTED', 'no element focus'); },
  };

  const probe = {
    async available() { return true; },
    async describe(pid) { return processes().get(pid); },
    async instances(bundleId) {
      state.calls.push(['instances', bundleId]);
      if (bundleId === installer) {
        state.installerReads += 1;
        if (state.installerReads >= 2) state.installerRunning = true;
      }
      if (bundleId === uninstaller) {
        state.uninstallerReads += 1;
        if (state.uninstallerReads >= 2) state.uninstallerRunning = true;
      }
      return [...processes().values()].filter(instance => instance.bundleId === bundleId);
    },
    async windows() {
      return windows().map(window => ({
        number: Number(window.id.slice(2)), ownerPid: window.pid, title: window.title,
      }));
    },
    async validate() { return undefined; },
    async open() { throw new Fault('UNSUPPORTED', 'waits never launch'); },
  };

  const install = new InstallState({
    async stat(path) {
      if (path === targetPath) {
        state.calls.push(['installStat', state.installCompleted]);
        if (state.neverInstalled) return undefined;
        if (state.uninstallerRunning) {
          state.removalReads += 1;
          if (state.removalReads >= 3) state.targetInstalled = false;
        } else {
          state.installReads += 1;
          if (state.installReads >= 2) {
            state.targetInstalled = true;
            state.installCompleted = true;
          }
        }
        return state.targetInstalled
          ? { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 }
          : undefined;
      }
      return undefined;
    },
    async readdir() { return undefined; },
    async bundleId(path) {
      if (path !== targetPath) return undefined;
      return state.targetInstalled ? target : undefined;
    },
    async receipts() { return state.receipts; },
    async process() { throw new Error('install evidence must not read processes'); },
  });

  const sessions = new Map();
  const pathToBundle = Object.fromEntries(Object.entries(appPaths).map(([app, path]) => [path, app]));
  const identityFor = app => {
    let session = sessions.get(app);
    if (!session) {
      session = new AppIdentitySession({ app, window: '', appPath: appPaths[app] }, {
        platform: 'darwin',
        probe,
        realpath: async path => path,
        stat: async () => ({ isDirectory: () => true }),
        readBundleId: async path => pathToBundle[path],
        sleep: async ms => new Promise(resolve => setTimeout(resolve, ms)),
      });
      sessions.set(app, session);
    }
    return session;
  };

  return { state, desktop, probe, install, identityFor };
}

function lifecycleFlow() {
  return parseFlowV2({
    version: 2,
    id: 'install-lifecycle',
    name: 'Download, install and uninstall',
    appPaths,
    steps: [
      {
        id: 'wait-download', kind: 'wait', scope: browserScope, timeoutMs: 5000,
        check: {
          kind: 'element',
          target: { kind: 'element', role: 'statictext', name: 'Download status' },
          expect: { property: 'text', contains: 'Download complete' },
        },
      },
      {
        id: 'wait-installer', kind: 'wait', scope: { kind: 'app', app: installer }, timeoutMs: 5000,
        check: { kind: 'app_running', equals: true },
      },
      {
        id: 'wait-installer-window', kind: 'wait', scope: installerScope, timeoutMs: 5000,
        check: { kind: 'window_exists', equals: true },
      },
      {
        id: 'wait-installed', kind: 'wait', scope: { kind: 'app', app: target }, timeoutMs: 5000,
        check: { kind: 'app_installed', equals: true },
      },
      { id: 'confirm-install', kind: 'click', scope: installerScope, target: { kind: 'element', role: 'button', name: 'Continue' } },
      {
        id: 'wait-uninstaller', kind: 'wait', scope: { kind: 'app', app: uninstaller }, timeoutMs: 5000,
        check: { kind: 'app_running', equals: true },
      },
      {
        id: 'wait-uninstaller-window', kind: 'wait', scope: uninstallerScope, timeoutMs: 5000,
        check: { kind: 'window_exists', equals: true },
      },
      {
        id: 'wait-removed', kind: 'wait', scope: { kind: 'app', app: target }, timeoutMs: 5000,
        check: { kind: 'app_installed', equals: false },
      },
    ],
  });
}

function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-wait-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = lifecycleWorld(options);
  const controller = new AbortController();
  const run = (flow, overrides = {}) => runFlowV2(flow, {
    desktop: world.desktop,
    signal: overrides.signal ?? controller.signal,
    identityFor: world.identityFor,
    leaseDirectory: dir,
    installState: world.install,
  });
  return { dir, world, controller, run };
}

const callsOf = (world, name) => world.state.calls.filter(call => call[0] === name);
const entry = (report, id) => report.entries.find(item => item.id === id);

test('a download, install and uninstall advance on conditions with no click before the install', async t => {
  const { world, run, dir } = harness(t);

  const report = await run(lifecycleFlow());

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.ok(reportV2Check.Check(report));
  assert.deepEqual(report.entries.map(item => item.status), [
    'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed',
  ]);

  // Every wait kept its declared scope and reported its own span.
  for (const step of lifecycleFlow().steps) {
    if (step.kind !== 'gap') assert.deepEqual(entry(report, step.id).scope, step.scope);
  }

  // A wait issues no launch, focus, click or clipboard write. Before the click
  // step, every driver call is a read.
  const clickIndex = world.state.calls.findIndex(call => call[0] === 'click');
  assert.ok(clickIndex > 0);
  const writesBeforeClick = world.state.calls.slice(0, clickIndex)
    .filter(call => ['open', 'click', 'press', 'type', 'writeClipboard'].includes(call[0]));
  assert.deepEqual(writesBeforeClick, []);
  // The only focus is that click step's own preparation, right before it.
  const focusIndex = world.state.calls.findIndex(call => call[0] === 'focusWindow');
  assert.ok(focusIndex > 0 && focusIndex < clickIndex);

  // The click ran only after the install was proven by the app bundle.
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w31:e9', { installed: true }]]);
  // The only focus is the input step's own window preparation, after install.
  assert.deepEqual(callsOf(world, 'focusWindow'), [['focusWindow', 'w-31', { installed: true }]]);
  assert.deepEqual(callsOf(world, 'open'), []);

  // The waits were real: each observation seam was read at least twice.
  assert.ok(world.state.downloadReads >= 2);
  assert.ok(world.state.installerReads >= 2);
  assert.ok(world.state.installReads >= 2);
  assert.ok(world.state.uninstallerReads >= 2);
  assert.ok(world.state.removalReads >= 3);

  // The scopes resolved are the declared ones, never a launch.
  assert.equal(entry(report, 'wait-removed').status, 'passed');
  // The lease is released after the run; a leftover would block the next run.
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});

test('a timeout keeps the scope and never clicks on an unproven install', async t => {
  // The app is running, but no receipt and no bundle at the pinned path proves
  // an install: a process is not evidence.
  const { world, run } = harness(t, { targetProcessRunning: true, neverInstalled: true });
  const flow = parseFlowV2({
    version: 2,
    id: 'install-timeout',
    name: 'Install timeout',
    appPaths: { [installer]: installerPath, [target]: targetPath },
    steps: [
      {
        id: 'wait-installed', kind: 'wait', scope: { kind: 'app', app: target }, timeoutMs: 1000,
        check: { kind: 'app_installed', equals: true },
      },
      { id: 'confirm-install', kind: 'click', scope: installerScope, target: { kind: 'element', role: 'button', name: 'Continue' } },
    ],
  });
  const report = await run(flow);

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'wait-installed').status, 'failed');
  assert.equal(entry(report, 'wait-installed').code, 'WAIT_TIMEOUT');
  assert.match(entry(report, 'wait-installed').message, /evidence=none/);
  assert.deepEqual(entry(report, 'wait-installed').scope, { kind: 'app', app: target });
  assert.equal(entry(report, 'confirm-install').status, 'skipped');
  assert.deepEqual(callsOf(world, 'click'), []);
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  // The target process was running the whole time and was never consulted as
  // install evidence.
  assert.deepEqual(callsOf(world, 'installStat').map(call => call[1]).slice(-1), [false]);
});

test('element_enabled waits for a control to become usable without focusing its window', async t => {
  const { world, run } = harness(t);
  world.state.installerRunning = true;
  world.state.installerReads = 2;
  const flow = parseFlowV2({
    version: 2,
    id: 'wait-enabled',
    name: 'Wait enabled',
    appPaths: { [installer]: installerPath },
    steps: [{
      id: 'wait-enabled', kind: 'wait', scope: installerScope, timeoutMs: 5000,
      check: { kind: 'element_enabled', target: { kind: 'element', role: 'button', name: 'Continue' }, equals: true },
    }],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.ok(world.state.enabledReads >= 2);
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('a wait never moves focus even when the file declares a focusAfter', async t => {
  const { world, run } = harness(t);
  const flow = parseFlowV2({
    version: 2,
    id: 'wait-no-focus',
    name: 'Wait does not focus',
    appPaths: { [browser]: browserPath },
    steps: [{
      id: 'wait-download', kind: 'wait', scope: browserScope, focusAfter: browserScope, timeoutMs: 5000,
      check: { kind: 'window_exists', equals: true },
    }],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.equal(entry(report, 'wait-download').focusAfter, undefined);
});

test('cancelling a wait stops the run with WAIT_CANCELLED and releases the lease', async t => {
  const { world, run, controller, dir } = harness(t);
  const flow = parseFlowV2({
    version: 2,
    id: 'cancel-wait',
    name: 'Cancel wait',
    appPaths: { [installer]: installerPath },
    steps: [{
      id: 'wait-installer', kind: 'wait', scope: { kind: 'app', app: installer }, timeoutMs: 10_000,
      check: { kind: 'app_running', equals: true },
    }],
  });
  setTimeout(() => controller.abort(new Error('Interrupted')), 40);

  await assert.rejects(run(flow), error => {
    assert.equal(error.code, 'WAIT_CANCELLED');
    assert.match(error.message, /Interrupted/);
    return true;
  });
  assert.deepEqual(callsOf(world, 'click'), []);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});
