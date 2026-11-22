import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyElectronAccessibility, ElectronAccessibilityGuard,
} from '../dist/electron-accessibility.js';

// Chromium/Electron only builds a renderer's AX tree when accessibility is on.
// These fixtures freeze the three observable states: the app's own placeholder,
// a live editor control, and a page that proves neither (Welcome/Settings).

const vsCode = 'com.microsoft.VSCode';
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const bounds = { x: 0, y: 0, width: 1200, height: 800 };

function electronWindow(children) {
  return {
    windowId: 'w-31',
    tree: { role: 'window', name: 'main', ref: '@w31:e1', bounds, states: [], secure: false, children },
  };
}

const placeholderWindow = () => electronWindow([{
  role: 'group', name: 'The editor is not accessible at this time. To enable screen reader optimized mode, use Shift+Alt+F1',
  ref: '@w31:e2', bounds: { x: 0, y: 80, width: 1200, height: 720 }, states: [], secure: false, children: [],
}]);
const editorWindow = () => electronWindow([{
  role: 'textfield', name: 'Editor', ref: '@w31:e2',
  bounds: { x: 100, y: 120, width: 800, height: 600 }, states: ['focused'], secure: false, children: [],
}]);
const welcomeWindow = () => electronWindow([{
  role: 'button', name: 'Open Folder', ref: '@w31:e2',
  bounds: { x: 100, y: 120, width: 160, height: 32 }, states: [], secure: false, children: [],
}]);

const finderWindow = {
  windowId: 'w-11',
  tree: {
    role: 'window', name: 'Downloads', ref: '@w11:e1', bounds, states: [], secure: false, children: [{
      role: 'textfield', name: 'Search', ref: '@w11:e2',
      bounds: { x: 100, y: 100, width: 200, height: 24 }, states: ['focused'], secure: false, children: [],
    }],
  },
};

const finderClick = {
  kind: 'click', t: 100, seen: 1_700_000_000_000, point: [150, 110],
  focusGeneration: 1, secure: false, decision: 'record',
  owner: {
    app: 'com.apple.finder', pid: 100, processInstance: 1_700_000_000_000,
    windowNumber: 11, windowTitle: 'Downloads', role: 'AXTextField', pressable: true,
  },
};

function electronEvent(kind, t, app = vsCode, extra = {}) {
  return {
    kind, t, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
    ...(kind === 'click' ? { point: [200, 200], decision: 'record' } : {}),
    owner: {
      app, pid: 200, processInstance: 1_700_000_000_000,
      windowNumber: 31, windowTitle: 'main',
    },
    ...extra,
  };
}

test('a window states its accessibility three ways and nothing is guessed', () => {
  assert.equal(classifyElectronAccessibility(placeholderWindow()), 'disabled');
  assert.equal(classifyElectronAccessibility(editorWindow()), 'enabled');
  assert.equal(classifyElectronAccessibility(welcomeWindow()), 'unverified');
  // A window of static text proves nothing either way.
  assert.equal(classifyElectronAccessibility(electronWindow([{
    role: 'statictext', name: 'Settings', ref: '@w31:e2',
    bounds: { x: 0, y: 0, width: 200, height: 24 }, states: [], secure: false, children: [],
  }])), 'unverified');
});

test('an Electron app/window is probed once and other apps are never read', async () => {
  let reads = 0;
  const guard = new ElectronAccessibilityGuard({
    read: async () => { reads += 1; return placeholderWindow(); },
    knownApps: [vsCode],
  });
  assert.equal(await guard.inspect({ app: 'com.apple.TextEdit', pid: 1, windowNumber: 2 }), undefined);
  assert.equal(reads, 0, 'a non-Electron app costs no accessibility read');

  const first = await guard.inspect({ app: vsCode, pid: 200, windowNumber: 31 });
  const second = await guard.inspect({ app: vsCode, pid: 200, windowNumber: 31 });
  assert.equal(first, 'disabled');
  assert.equal(second, 'disabled');
  assert.equal(reads, 1, 'the same window is classified once');

  await guard.inspect({ app: vsCode, pid: 200, windowNumber: 32 });
  assert.equal(reads, 2, 'a second window of the app is its own probe');
});

test('a failed accessibility read is retried instead of becoming a verdict', async () => {
  let attempt = 0;
  const guard = new ElectronAccessibilityGuard({
    read: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('snapshot unavailable');
      return editorWindow();
    },
    knownApps: [vsCode],
  });
  assert.equal(await guard.inspect({ app: vsCode, pid: 200, windowNumber: 31 }), undefined);
  assert.equal(await guard.inspect({ app: vsCode, pid: 200, windowNumber: 31 }), 'enabled');
});

/**
 * Runs the real CLI against stub helper and desktop executables. The helper
 * emits its ready line and events; the desktop serves the fixture trees. No
 * GUI, accessibility API or capture tap is involved.
 */
function cliFixture(t, {
  mode, snapshots, events, cliArgs, electronApps,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-electron-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    recursive: true,
    filter: source => !source.endsWith('/cuekeeper-capture') && !source.endsWith('/cuekeeper-ime'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');

  const convert = node => ({
    role: node.role,
    ...(node.name === undefined ? {} : { name: node.name }),
    ...(node.ref === undefined ? {} : { ref_id: node.ref }),
    ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
    states: node.states ?? [],
    secure: node.secure ?? false,
    children: (node.children ?? []).map(convert),
  });
  const trees = Object.fromEntries(Object.entries(snapshots).map(([number, snapshot]) => [number, {
    id: snapshot.windowId,
    title: snapshot.tree.name,
    tree: convert(snapshot.tree),
  }]));

  const desktop = join(dir, 'desktop');
  writeFileSync(desktop, `#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
const windows = ${JSON.stringify(trees)};
if (command === 'version') {
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: { version: '1.3.1' } }));
  process.exit(0);
}
if (command === 'list-windows') {
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: Object.values(windows).map(window => ({ id: window.id, title: window.title })) }));
  process.exit(0);
}
if (command === 'snapshot') {
  const index = args.indexOf('--window-id');
  const id = index < 0 ? '' : args[index + 1];
  const entry = Object.entries(windows).find(([, window]) => window.id === id);
  if (!entry) {
    console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'WINDOW_NOT_FOUND' } }));
    process.exit(1);
  }
  const [, window] = entry;
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: {
    complete: true, truncated: false, window: { id: window.id, title: window.title }, tree: window.tree,
  } }));
  process.exit(0);
}
console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'UNSUPPORTED' } }));
process.exit(1);
`, { mode: 0o700 });

  const capture = join(dir, 'cuekeeper-capture');
  const captureLog = join(dir, 'capture-args.log');
  writeFileSync(captureLog, '');
  const ready = mode === 'global'
    ? { kind: 'ready', global: true, hotkeysFiltered: true, indicator: false }
    : { kind: 'ready', hotkeysFiltered: true, indicator: false };
  writeFileSync(capture, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(captureLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
const seen = Date.now();
const messages = [${JSON.stringify(ready)}, ...${JSON.stringify(events)}];
console.log(messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n'));
process.exitCode = 0;
`, { mode: 0o700 });

  const output = join(dir, 'recorded.flow.json');
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record', ...cliArgs, '--out', output, '--json'], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: desktop,
      CUEKEEPER_RECORDER: capture,
      // Keep host installs out of the probe unless the test names the app.
      CUEKEEPER_ELECTRON_APPS: electronApps ?? '',
      CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      CUEKEEPER_IME_DIR: join(dir, 'ime-root'),
    },
    encoding: 'utf8', timeout: 20_000,
  });
  const response = JSON.parse(result.stdout);
  return {
    code: result.status,
    response,
    stderr: result.stderr,
    written: existsSync(output) ? readFileSync(output, 'utf8') : undefined,
    captureArgs: readFileSync(captureLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

function globalArgs(extra = []) {
  return ['--global', '--countdown', '0', '--no-indicator', '--max-seconds', '2', ...extra];
}

test('global recording stops at an inaccessible Electron editor and keeps the prefix', {
  skip: process.platform !== 'darwin',
}, t => {
  const run = cliFixture(t, {
    mode: 'global',
    cliArgs: globalArgs(),
    electronApps: vsCode,
    snapshots: { 11: finderWindow, 31: placeholderWindow() },
    events: [finderClick, electronEvent('focus', 200)],
  });
  assert.equal(run.code, 1, run.stderr + JSON.stringify(run.response));
  assert.equal(run.response.ok, false);
  assert.equal(run.response.error.code, 'ELECTRON_ACCESSIBILITY_REQUIRED');
  assert.equal(run.response.data.partial, true);
  assert.match(run.stderr, /VS Code 的无障碍编辑器没有开启，录制已停止/);
  assert.match(run.stderr, /--force-renderer-accessibility/);
  assert.ok(run.written, 'the captured prefix must be saved');
  // The click before the editor survives; the inaccessible window adds no step.
  assert.deepEqual(JSON.parse(run.written).steps.map(step => step.kind), ['click']);
});

test('global recording continues into an Electron editor that exposes its controls', {
  skip: process.platform !== 'darwin',
}, t => {
  const run = cliFixture(t, {
    mode: 'global',
    cliArgs: globalArgs(),
    electronApps: vsCode,
    snapshots: { 11: finderWindow, 31: editorWindow() },
    events: [finderClick, electronEvent('focus', 200), electronEvent('text', 300, vsCode, { chars: 'Zq' })],
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  assert.deepEqual(JSON.parse(run.written).steps.map(step => step.kind), ['click', 'activate_app', 'type']);
  assert.equal(run.response.data.warnings, undefined);
});

test('global recording only treats a named Electron app as Electron', {
  skip: process.platform !== 'darwin',
}, t => {
  const plain = 'com.example.plain';
  const run = cliFixture(t, {
    mode: 'global',
    cliArgs: globalArgs(),
    // No Electron override: the app has no Electron framework and no placeholder
    // check is run on it, so the same tree is recorded as an ordinary click.
    snapshots: { 31: placeholderWindow() },
    events: [electronEvent('click', 100, plain)],
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  assert.deepEqual(JSON.parse(run.written).steps.map(step => step.kind), ['click']);
});

test('a Welcome page is unverified and the recording continues with a warning', {
  skip: process.platform !== 'darwin',
}, t => {
  const run = cliFixture(t, {
    mode: 'global',
    cliArgs: globalArgs(),
    electronApps: vsCode,
    snapshots: { 31: welcomeWindow() },
    events: [electronEvent('click', 100)],
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  assert.deepEqual(JSON.parse(run.written).steps.map(step => step.kind), ['click']);
  assert.deepEqual(run.response.data.warnings.map(warning => warning.code), ['ELECTRON_ACCESSIBILITY_UNVERIFIED']);
});

test('single-window recording refuses an inaccessible Electron target before the helper starts', {
  skip: process.platform !== 'darwin',
}, t => {
  const run = cliFixture(t, {
    mode: 'window',
    cliArgs: ['--app', vsCode, '--window', 'main', '--seconds', '1', '--no-indicator'],
    electronApps: vsCode,
    snapshots: { 31: placeholderWindow() },
    events: [],
  });
  assert.equal(run.code, 2, run.stderr + JSON.stringify(run.response));
  assert.equal(run.response.error.code, 'ELECTRON_ACCESSIBILITY_REQUIRED');
  assert.match(run.stderr, /VS Code 的无障碍编辑器没有开启，录制已停止/);
  assert.equal(run.written, undefined);
  // Only the read-only permission probe ran; the capture session never started.
  assert.deepEqual(run.captureArgs, [['--permissions']]);
});

test('single-window recording starts the helper when the editor is accessible', {
  skip: process.platform !== 'darwin',
}, t => {
  const run = cliFixture(t, {
    mode: 'window',
    cliArgs: ['--app', vsCode, '--window', 'main', '--seconds', '1', '--no-indicator'],
    electronApps: vsCode,
    snapshots: { 31: editorWindow() },
    events: [{ kind: 'click', t: 100, point: [200, 200] }],
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  assert.deepEqual(run.captureArgs.at(-1), [vsCode, '31', '1', '--no-indicator']);
  assert.deepEqual(JSON.parse(run.written).steps.map(step => step.kind), ['click']);
  assert.equal(run.response.data.warnings, undefined);
});
