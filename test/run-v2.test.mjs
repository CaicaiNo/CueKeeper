import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppIdentitySession } from '../dist/app-identity.js';
import { reportV2Check } from '../dist/contracts-v2.js';
import { DesktopFault } from '../dist/desktop.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { Fault, parseSnapshot, parseSurface } from '../dist/locator.js';
import { runFlowV2 } from '../dist/run-v2.js';
import { RunLease } from '../dist/scope.js';

// Cross-app replay is driven here by a fake desktop driver plus a fake identity
// probe, so launch, focus and dispatch order are asserted without any GUI or
// macOS authorization. Nothing in this file starts a real application.

const safari = 'com.apple.Safari';
const textedit = 'com.apple.TextEdit';
const appPaths = {
  [safari]: '/Applications/Safari.app',
  [textedit]: '/Applications/TextEdit.app',
};

const browserScope = { kind: 'window', app: safari, windowKey: 'browser', windowTitle: 'Browser Window' };
const notesScope = { kind: 'window', app: textedit, windowKey: 'notes', windowTitle: 'QA Notes' };
const draftScope = { kind: 'window', app: textedit, windowKey: 'draft', windowTitle: 'QA Draft' };

const inputs = { address: 'https://example.test/pkg', note: 'draft text' };

/** A minimal driver snapshot envelope; each control has a window-unique ref. */
function envelope(windowId, title, fields) {
  return {
    complete: true,
    window: { id: windowId, title },
    tree: {
      role: 'window',
      name: title,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
      children: [
        {
          role: 'scrollarea',
          bounds: { x: 110, y: 120, width: 780, height: 480 },
          children: fields.map(([name, ref], index) => ({
            role: 'textfield',
            name,
            ref_id: ref,
            bounds: { x: 120, y: 150 + index * 60, width: 600, height: 40 },
            states: ['focused'],
          })),
        },
        {
          role: 'button',
          name: 'Continue',
          ref_id: `@${windowId.replace('-', '')}:e9`,
          bounds: { x: 120, y: 500, width: 120, height: 32 },
        },
      ],
    },
  };
}

function windowRecord({ id, app, pid, title, fields }) {
  return { id, app, pid, title, data: envelope(id, title, fields) };
}

const initialWindows = () => [
  windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Draft', fields: [['draft', '@w22:e1']] }),
  windowRecord({ id: 'w-99', app: 'com.apple.finder', pid: 700, title: 'Finder', fields: [] }),
];

/**
 * One fake desktop plus one fake identity probe sharing the same window and
 * process inventory. `calls` records the driver commands the resolver used.
 */
function fakeWorld(options = {}) {
  const state = {
    windows: options.windows ?? initialWindows(),
    apps: new Map(Object.entries(options.apps ?? {
      [textedit]: [{ pid: 601, startedAt: '601.1', bundleId: textedit, bundlePath: appPaths[textedit] }],
    })),
    focused: options.focused ?? 'w-21',
    calls: [],
    hooks: options.hooks ?? {},
    delivery: options.delivery ?? (() => 'delivered_verified'),
    menu: options.menu,
  };
  const byId = id => state.windows.find(window => window.id === id);
  const instanceOf = pid => [...state.apps.values()].flat().find(instance => instance.pid === pid);
  const inventoryOf = app => state.windows
    .filter(window => window.app === app)
    .map(window => ({ id: window.id, title: window.title, processInstance: window.pid }));

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  function delivered(command) {
    const forced = state.delivery(command);
    if (forced === 'delivery_uncertain') throw new DesktopFault('DELIVERY_UNCERTAIN', command, 'delivery_uncertain');
    if (forced === 'not_delivered') throw new DesktopFault('NOT_DELIVERED', command, 'not_delivered');
    return forced;
  }

  const desktop = {
    async snapshotWindow(windowId) {
      state.calls.push(['snapshotWindow', windowId]);
      const window = byId(windowId);
      if (!window) throw new Fault('WINDOW_NOT_FOUND', 'no such window');
      return parseSnapshot(window.data, { app: '', window: window.title });
    },
    async focusWindow(windowId) {
      state.calls.push(['focusWindow', windowId]);
      state.hooks.beforeFocus?.(state, windowId);
      if (!byId(windowId)) throw new Fault('WINDOW_NOT_FOUND', 'no such window');
      state.focused = windowId;
      state.hooks.afterFocus?.(state, windowId);
    },
    async focusedWindow() {
      const window = byId(state.focused);
      return window ? { id: window.id, title: window.title } : undefined;
    },
    async listAllWindows() {
      return state.windows.map(window => ({
        id: window.id, title: window.title, processInstance: window.pid,
        isFocused: window.id === state.focused,
      }));
    },
    async listWindows(app) { return inventoryOf(app); },
    async listApps() { return []; },
    async property(node, property) {
      if (property === 'visible') return true;
      return node[property] ?? node.value ?? node.name ?? '';
    },
    async click(ref) {
      state.calls.push(['click', ref]);
      const fail = state.hooks.click?.(state, ref);
      if (fail) throw fail;
      return delivered('click');
    },
    async clickPoint(_snapshot, _target, point, { count = 1 } = {}) {
      // The real driver refuses physical coordinate input without --headed,
      // before it posts any event.
      if (!options.headed) {
        throw new Fault('HEADED_REQUIRED', 'Physical coordinate input requires --headed');
      }
      state.calls.push(['clickPoint', point, count]);
      const fail = state.hooks.clickPoint?.(state, point, count);
      if (fail) throw fail;
      return delivered('click');
    },
    async type(ref, text) {
      state.calls.push(['type', ref, text]);
      state.hooks.beforeType?.(state);
      return delivered('type');
    },
    async typeFocused(text, app, options) {
      state.calls.push(['typeFocused', text, app, options]);
      return delivered('type');
    },
    async clickSemantic(ref) {
      state.calls.push(['clickSemantic', ref]);
      return delivered('click');
    },
    async snapshotSurface(surface) {
      state.calls.push(['snapshotSurface', surface]);
      if (!state.menu) throw new Fault('NO_SURFACE', 'no menu is open');
      return parseSurface(state.menu);
    },
    async clickScreen(point, clickOptions = {}) {
      if (!options.headed) throw new Fault('HEADED_REQUIRED', 'Physical coordinate input requires --headed');
      state.calls.push(['clickScreen', point, clickOptions.button ?? 'left']);
      return delivered('click');
    },
    async press(combo, snapshot) {
      state.calls.push(['press', combo, snapshot.windowId]);
      return delivered('press');
    },
    async scroll(ref, options) {
      state.calls.push(['scroll', ref, options.direction, options.amount]);
      return delivered('scroll');
    },
    async drag(_snapshot, _target, from, to, options) {
      state.calls.push(['drag', from.ref, to.ref, options.durationMs]);
      return delivered('drag');
    },
    async hoverAt(_snapshot, _target, point, options = {}) {
      state.calls.push(['hoverAt', point, options.travel === true, performance.now()]);
      return delivered('hover');
    },
    async hoverScreen(point, options = {}) {
      state.calls.push(['hoverScreen', point, options.travel === true, performance.now()]);
      return delivered('hoverScreen');
    },
    async listDisplays() {
      state.calls.push(['listDisplays']);
      return [
        { id: '1', isPrimary: true, bounds: { x: 0, y: 0, width: 1470, height: 956 } },
        { id: '3', isPrimary: false, bounds: { x: 0, y: -1440, width: 2560, height: 1440 } },
      ];
    },
    async focus(ref) {
      state.calls.push(['focus', ref]);
    },
    async writeClipboard(text) {
      state.calls.push(['writeClipboard', text]);
    },
    async readClipboard() { return { type: 'empty' }; },
    async screenshotWindow(windowId) {
      state.calls.push(['screenshotWindow', windowId]);
      return png;
    },
    async screenshot(app, windowId) {
      state.calls.push(['screenshot', app, windowId]);
      return png;
    },
    async snapshot() { throw new Fault('UNSUPPORTED', 'cross-app replay reads windows by ID'); },
    async ensure() { throw new Fault('UNSUPPORTED', 'cross-app replay does not repair'); },
  };

  const probe = {
    async available() { return true; },
    async describe(pid) { return instanceOf(pid); },
    async instances(bundleId) { return [...(state.apps.get(bundleId) ?? [])]; },
    async windows() {
      return state.windows.map(window => ({
        number: Number(window.id.slice(2)), ownerPid: window.pid, title: window.title,
      }));
    },
    async validate() { return undefined; },
    async open(path, activate) {
      state.calls.push(['open', path, activate]);
      state.hooks.afterOpen?.(state, path, activate);
      if (activate) {
        // NSWorkspace activation brings the copy's existing front window forward.
        const app = Object.keys(appPaths).find(bundle => appPaths[bundle] === path);
        const window = state.windows.find(candidate => candidate.app === app);
        if (window) state.focused = window.id;
      }
    },
  };

  return { state, desktop, probe };
}

function identityFactory(world, readBundleId = {}, options = {}) {
  const sessions = new Map();
  const pathToBundle = options.pathToBundle ??
    Object.fromEntries(Object.entries(appPaths).map(([app, path]) => [path, app]));
  const present = options.present ?? (() => true);
  return app => {
    let session = sessions.get(app);
    if (!session) {
      session = new AppIdentitySession(
        { app, window: '', appPath: options.appPath?.(app) ?? appPaths[app] },
        {
          platform: 'darwin',
          probe: world.probe,
          realpath: async path => path,
          stat: async path => ({ isDirectory: () => present(path) }),
          readBundleId: async path => readBundleId[path] ?? pathToBundle[path],
          sleep: async ms => new Promise(resolve => setTimeout(resolve, ms)),
        },
      );
      sessions.set(app, session);
    }
    return session;
  };
}

/** The acceptance flow: two apps, three windows, one ordered replay. */
function crossAppFlow() {
  return parseFlowV2({
    version: 2,
    id: 'cross-app-replay',
    name: 'Cross app replay',
    appPaths,
    inputs: ['address', 'note'],
    steps: [
      { id: 'launch-browser', kind: 'launch_app', scope: { kind: 'app', app: safari }, focusAfter: browserScope },
      {
        id: 'type-address', kind: 'type', scope: browserScope,
        target: { kind: 'element', role: 'textfield', name: 'address' }, input: 'address',
      },
      { id: 'copy-address', kind: 'key', scope: browserScope, key: 'c', modifiers: ['meta'] },
      { id: 'switch-notes', kind: 'activate_app', scope: { kind: 'app', app: textedit }, focusAfter: notesScope },
      {
        id: 'paste-address', kind: 'paste', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' },
        source: { kind: 'copy', stepId: 'copy-address' },
      },
      {
        id: 'type-draft', kind: 'type', scope: draftScope,
        target: { kind: 'element', role: 'textfield', name: 'draft' }, input: 'note',
      },
      {
        id: 'assert-draft', kind: 'assert', scope: draftScope,
        check: { target: { kind: 'window' }, expect: { property: 'exists', equals: true } },
      },
    ],
  });
}

function harness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-run-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const world = fakeWorld(options);
  const controller = new AbortController();
  const run = (flow = crossAppFlow(), overrides = {}) => runFlowV2(flow, {
    desktop: world.desktop,
    signal: overrides.signal ?? controller.signal,
    identityFor: identityFactory(world, overrides.readBundleId ?? options.readBundleId,
      overrides.identityOptions ?? options.identityOptions ?? {}),
    leaseDirectory: dir,
    inputs: overrides.inputs ?? inputs,
    ...(overrides.installState === undefined ? {} : { installState: overrides.installState }),
    ...((overrides.launchTimeoutMs ?? options.launchTimeoutMs) === undefined
      ? {} : { launchTimeoutMs: overrides.launchTimeoutMs ?? options.launchTimeoutMs }),
    ...(overrides.checkpoints === undefined ? {} : { checkpoints: overrides.checkpoints }),
    ...(overrides.secureInputActive === undefined ? {} : { secureInputActive: overrides.secureInputActive }),
    ...(overrides.systemDialogVisible === undefined ? {} : { systemDialogVisible: overrides.systemDialogVisible }),
    ...(overrides.systemCheckDeps === undefined ? {} : { systemCheckDeps: overrides.systemCheckDeps }),
  });
  return { dir, world, controller, run };
}
const callsOf = (world, name) => world.state.calls.filter(call => call[0] === name);
const entry = (report, id) => report.entries.find(item => item.id === id);

test('two apps and three windows replay in order; focus is handed over once per window', async t => {
  const { world, run } = harness(t, {
    hooks: {
      // Launching Safari opens its browser window without taking focus; the
      // declared focusAfter is what brings it forward.
      afterOpen(state, path) {
        assert.equal(path, appPaths[safari]);
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
    },
  });

  const report = await run();

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.ok(reportV2Check.Check(report));
  assert.deepEqual(report.entries.map(item => [item.id, item.status]), [
    ['launch-browser', 'passed'],
    ['type-address', 'passed'],
    ['copy-address', 'passed'],
    ['switch-notes', 'passed'],
    ['paste-address', 'passed'],
    ['type-draft', 'passed'],
    ['assert-draft', 'passed'],
  ]);
  // Every entry carries the step's declared scope; the hand-offs are explicit.
  for (const step of crossAppFlow().steps) {
    if (step.kind === 'gap') continue;
    assert.deepEqual(entry(report, step.id).scope, step.scope);
  }
  assert.deepEqual(entry(report, 'launch-browser').focusAfter, browserScope);
  assert.deepEqual(entry(report, 'switch-notes').focusAfter, notesScope);

  // Launch is idempotent and path-pinned: exactly one open of the selected copy.
  assert.deepEqual(callsOf(world, 'open'), [['open', appPaths[safari], false]]);
  // One focus per window transition; steps in the already-focused window pay none.
  assert.deepEqual(callsOf(world, 'focusWindow').map(call => call[1]), ['w-11', 'w-21', 'w-22']);
  // Dispatch lands on the scope window's own controls, in flow order.
  assert.deepEqual(callsOf(world, 'type').map(call => [call[1], call[2]]), [
    ['@w11:e1', inputs.address],
    ['@w22:e1', inputs.note],
  ]);
  assert.deepEqual(callsOf(world, 'press').map(call => call.slice(1)), [
    ['meta+c', 'w-11'],
    ['meta+v', 'w-21'],
  ]);
  assert.deepEqual(callsOf(world, 'focus').map(call => call[1]), ['@w21:e1']);
  // Reads only ever name a bound window ID.
  assert.ok(callsOf(world, 'snapshotWindow').every(call => ['w-11', 'w-21', 'w-22'].includes(call[1])));
  assert.deepEqual(report.appIdentities, [
    { app: safari, mode: 'bundle_path', status: 'verified' },
    { app: textedit, mode: 'bundle_path', status: 'verified' },
  ]);
});

test('a retitled, moved window keeps its key; a same-titled new window cannot take it', async t => {
  const { world, run } = harness(t, {
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
      afterFocus(state, windowId) {
        if (windowId !== 'w-11' || state.hooks.mutated) return;
        state.hooks.mutated = true;
        // The user retitles and moves the bound window, then a new window
        // appears carrying the recorded title.
        const bound = state.windows.find(window => window.id === 'w-11');
        bound.title = 'Renamed Window';
        bound.data = envelope('w-11', 'Renamed Window', [['address', '@w11:e1']]);
        const bounds = bound.data.tree.bounds;
        bounds.x += 240;
        bounds.y += 80;
        state.windows.push(windowRecord({
          id: 'w-12', app: safari, pid: 501, title: 'Browser Window', fields: [['imposter', '@w12:e1']],
        }));
      },
    },
  });

  const flow = parseFlowV2({
    version: 2,
    id: 'retitled-window',
    name: 'Retitled window',
    appPaths: { [safari]: appPaths[safari] },
    inputs: ['address'],
    steps: [
      { id: 'launch-browser', kind: 'launch_app', scope: { kind: 'app', app: safari }, focusAfter: browserScope },
      {
        id: 'type-address', kind: 'type', scope: browserScope,
        target: { kind: 'element', role: 'textfield', name: 'address' }, input: 'address',
      },
      {
        id: 'assert-title', kind: 'assert', scope: browserScope,
        check: { target: { kind: 'window' }, expect: { property: 'title', equals: 'Renamed Window' } },
      },
    ],
  });
  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  // The dispatch used the bound window's control, not the same-titled newcomer.
  assert.deepEqual(callsOf(world, 'type').map(call => [call[1], call[2]]), [['@w11:e1', inputs.address]]);
  assert.equal(callsOf(world, 'snapshotWindow').some(call => call[1] === 'w-12'), false);
  assert.deepEqual(callsOf(world, 'focusWindow').map(call => call[1]), ['w-11']);
});

test('two windows with the recorded title are told apart by what they hold', async t => {
  const windows = [
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
    windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['other', '@w23:e1']] }),
  ];
  const { world, run } = harness(t, { windows });
  const flow = parseFlowV2({
    version: 2,
    id: 'same-title',
    name: 'Same title',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      { id: 'switch-notes', kind: 'activate_app', scope: { kind: 'app', app: textedit }, focusAfter: notesScope },
      {
        id: 'type-note', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' }, text: 'hello',
      },
    ],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.equal(entry(report, 'switch-notes').status, 'passed');
  assert.deepEqual(entry(report, 'switch-notes').focusAfter, { kind: 'app', app: textedit });
  // The window that holds the recorded field is the one that took the input.
  assert.deepEqual(callsOf(world, 'type').map(call => [call[1], call[2]]), [['@w21:e1', 'hello']]);
  assert.equal(callsOf(world, 'focusWindow').some(call => call[1] === 'w-23'), false);
  // Both windows are read and compared, but the newcomer is never typed into.
  assert.equal(callsOf(world, 'snapshotWindow').some(call => call[1] === 'w-23'), true);
  assert.match(entry(report, 'type-note').message, /more than one window was titled "QA Notes", so the step ran in the one that held its target/);
});

test('a matching state check leaves element addressing in charge of an ambiguous window', async t => {
  // A machine fact and a window fact in one run: the file check proves the
  // export exists, and the type step must still pick the window that holds the
  // recorded field instead of the same-titled twin.
  const twin = windowRecord({
    id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['other', '@w23:e1']],
  });
  const { world, run } = harness(t, { windows: [...initialWindows(), twin] });
  const flow = parseFlowV2({
    version: 2, id: 'state-check-then-element', name: 'State check then element',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      {
        id: 'export-exists', kind: 'assert',
        scope: { kind: 'file', path: '/tmp/report.pdf' },
        check: { kind: 'file_exists', equals: true },
      },
      {
        id: 'type-note', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' }, text: 'hello',
      },
    ],
  });

  const report = await run(flow, { systemCheckDeps: { stat: async () => ({ isFile: () => true }) } });

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  // The state check reports the observed machine fact, never a bare pass.
  assert.deepEqual(entry(report, 'export-exists').stateCheck,
    { kind: 'file_exists', expected: true, actual: true });
  // Element addressing still decided which window ran the step, and only that
  // window received the input.
  assert.deepEqual(callsOf(world, 'type').map(call => [call[1], call[2]]), [['@w21:e1', 'hello']]);
  assert.equal(callsOf(world, 'focusWindow').some(call => call[1] === 'w-23'), false);
  assert.equal(callsOf(world, 'snapshotWindow').some(call => call[1] === 'w-23'), true);
  assert.match(entry(report, 'type-note').message, /the one that held its target/);
});

test('a state check that already matched is not skipped when element addressing fails', async t => {
  // Neither same-titled window addresses the recorded field, so the step cannot
  // prove its window and must not type into a guess. The file check that already
  // ran keeps its real observation; only the later step is skipped.
  const twin = windowRecord({
    id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['other', '@w23:e1']],
  });
  const { world, run } = harness(t, { windows: [...initialWindows(), twin] });
  const flow = parseFlowV2({
    version: 2, id: 'element-missing-after-check', name: 'Element missing after check',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      {
        id: 'export-exists', kind: 'assert',
        scope: { kind: 'file', path: '/tmp/report.pdf' },
        check: { kind: 'file_exists', equals: true },
      },
      {
        id: 'type-ghost', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'ghost' }, text: 'nope',
      },
      {
        id: 'second-check', kind: 'assert',
        scope: { kind: 'file', path: '/tmp/never-checked.pdf' },
        check: { kind: 'file_exists', equals: true },
      },
    ],
  });

  const report = await run(flow, { systemCheckDeps: { stat: async () => ({ isFile: () => true }) } });

  assert.equal(report.status, 'blocked', JSON.stringify(report.entries, null, 2));
  // The state check that ran keeps its observation and is not relabelled.
  assert.equal(entry(report, 'export-exists').status, 'passed');
  assert.deepEqual(entry(report, 'export-exists').stateCheck,
    { kind: 'file_exists', expected: true, actual: true });
  // The element step could not prove its window and sent no input.
  assert.equal(entry(report, 'type-ghost').status, 'blocked');
  assert.equal(entry(report, 'type-ghost').code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(callsOf(world, 'type'), []);
  assert.deepEqual(callsOf(world, 'press'), []);
  // The step after the failure is skipped without inventing a machine fact.
  assert.equal(entry(report, 'second-check').status, 'skipped');
  assert.equal(entry(report, 'second-check').stateCheck, undefined);
});

test('a restarted process stops the run instead of rebinding', async t => {
  const { world, run } = harness(t, {
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
      beforeType(state) {
        // Safari quits after the first input; a new copy is not this run's instance.
        state.apps.delete(safari);
      },
    },
  });

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'type-address').status, 'passed');
  assert.equal(entry(report, 'copy-address').status, 'blocked');
  assert.equal(entry(report, 'copy-address').code, 'APP_AMBIGUOUS');
  assert.equal(entry(report, 'switch-notes').status, 'skipped');
  assert.deepEqual(callsOf(world, 'open').length, 1, 'the run never launches a replacement copy');
  assert.deepEqual(callsOf(world, 'press'), []);
  assert.deepEqual(report.appIdentities, [
    { app: safari, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'instance_changed', entryId: 'copy-address' },
    { app: textedit, mode: 'bundle_path', status: 'blocked', code: 'APP_UNVERIFIED', reason: 'not_reached' },
  ]);
});

test('a recorded title that belongs to another copy blocks before any desktop call', async t => {
  const { dir, world, run } = harness(t, {
    readBundleId: { [appPaths[safari]]: 'com.apple.SafariBeta' },
  });

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.ok(report.entries.every(item => item.status === 'blocked' && item.code === 'APP_PATH_INVALID'));
  assert.deepEqual(report.appIdentities, [
    { app: safari, mode: 'bundle_path', status: 'blocked', code: 'APP_PATH_INVALID', reason: 'bundle_id_mismatch' },
    { app: textedit, mode: 'bundle_path', status: 'blocked', code: 'APP_UNVERIFIED', reason: 'not_reached' },
  ]);
  assert.deepEqual(world.state.calls, [], 'no launch, focus or snapshot before the identity is proven');
  assert.equal(existsSync(join(dir, 'run.lock')), false, 'no lease is taken for a blocked preflight');
});

test('a launch that never produces the pinned instance reports LAUNCH_TIMEOUT', async t => {
  const { world, run } = harness(t, { launchTimeoutMs: 250 });

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'launch-browser').status, 'blocked');
  assert.equal(entry(report, 'launch-browser').code, 'LAUNCH_TIMEOUT');
  assert.equal(entry(report, 'type-address').status, 'skipped');
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.deepEqual(callsOf(world, 'type'), []);
});

test('a user switch stops the original step without stealing focus back', async t => {
  const { world, run } = harness(t, {
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
      beforeType() {},
    },
  });
  // While the notes window is read for the paste step, the user switches to
  // Finder. The next step must notice before it moves focus or types.
  const pasteSnapshot = world.desktop.snapshotWindow.bind(world.desktop);
  let stolen = false;
  world.desktop.snapshotWindow = async windowId => {
    const snapshot = await pasteSnapshot(windowId);
    if (windowId === 'w-21' && !stolen) {
      stolen = true;
      world.state.focused = 'w-99';
    }
    return snapshot;
  };

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'paste-address').status, 'passed');
  assert.equal(entry(report, 'type-draft').status, 'blocked');
  assert.equal(entry(report, 'type-draft').code, 'FOCUS_INTERRUPTED');
  assert.equal(entry(report, 'assert-draft').status, 'skipped');
  assert.deepEqual(callsOf(world, 'focusWindow').map(call => call[1]), ['w-11', 'w-21'],
    'the run never focuses the draft window after the switch');
  assert.deepEqual(callsOf(world, 'type').map(call => call[1]), ['@w11:e1'],
    'the intercepted step dispatched nothing');
});

test('an uncertain delivery stops the run and is never retried', async t => {
  const { world, run } = harness(t, {
    delivery: command => (command === 'type' ? 'delivery_uncertain' : 'delivered_verified'),
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
    },
  });

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'type-address').status, 'blocked');
  assert.equal(entry(report, 'type-address').code, 'DELIVERY_UNCERTAIN');
  assert.equal(entry(report, 'type-address').delivery, 'delivery_uncertain');
  assert.equal(entry(report, 'copy-address').status, 'skipped');
  assert.equal(callsOf(world, 'type').length, 1, 'an uncertain input is not repeated');
  assert.deepEqual(callsOf(world, 'press'), []);
});

test('a failed assertion sends no later step', async t => {
  const { world, run } = harness(t, {
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
    },
  });
  const base = crossAppFlow();
  const steps = base.steps.slice(0, 3);
  steps.push({
    id: 'assert-title', kind: 'assert', scope: browserScope,
    check: { target: { kind: 'window' }, expect: { property: 'title', equals: 'Wrong Title' } },
  });
  steps.push({ id: 'copy-after', kind: 'key', scope: browserScope, key: 'c', modifiers: ['meta'] });
  const flow = parseFlowV2({ ...base, appPaths: { [safari]: appPaths[safari] }, steps });

  const report = await run(flow);

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'assert-title').status, 'failed');
  assert.equal(entry(report, 'assert-title').code, 'ASSERTION_FALSE');
  assert.equal(entry(report, 'copy-after').status, 'skipped');
  // Only the earlier copy step pressed a key; the post-assertion step did not.
  assert.deepEqual(callsOf(world, 'press').map(call => call[1]), ['meta+c']);
});

test('cancelling a live replay releases the foreground lease', async t => {
  const { dir, world, controller, run } = harness(t, {
    hooks: {
      afterOpen(state) {
        state.apps.set(safari, [{
          pid: 501, startedAt: '501.1', bundleId: safari, bundlePath: appPaths[safari],
        }]);
        state.windows.push(windowRecord({
          id: 'w-11', app: safari, pid: 501, title: 'Browser Window', fields: [['address', '@w11:e1']],
        }));
      },
    },
  });
  world.state.delivery = command => {
    if (command === 'type') controller.abort(new Error('Interrupted'));
    return 'delivered_verified';
  };

  await assert.rejects(run(), /Interrupted/);
  assert.equal(existsSync(join(dir, 'run.lock')), false, 'the lease file is removed on cancel');
  // The aborted run is not failed through the generic path: no later step ran.
  assert.deepEqual(callsOf(world, 'press'), []);
});

test('a run cannot take the foreground while another lease is live', async t => {
  const { dir, world, run } = harness(t);
  const holder = new RunLease({ runId: 'other-run', directory: dir });
  await holder.acquire();
  t.after(async () => holder.release());

  const report = await run();

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'launch-browser').code, 'RUN_BUSY');
  assert.ok(report.entries.every(item => item.status === 'blocked'));
  assert.deepEqual(world.state.calls, [], 'a busy lease never touches the desktop');
});

test('an app-scope focusAfter activates the app and the next step consumes it', async t => {
  // Finder owns the foreground; TextEdit is running in the background.
  const { world, run } = harness(t, { focused: 'w-99' });
  const flow = parseFlowV2({
    version: 2, id: 'activate-app', name: 'Activate app',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      {
        id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit },
        focusAfter: { kind: 'app', app: textedit },
      },
      {
        id: 'type-note', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' }, text: 'typed',
      },
    ],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(entry(report, 'activate').focusAfter, { kind: 'app', app: textedit });
  // Activation uses the helper's exact bundle URL and asks it to activate.
  assert.deepEqual(callsOf(world, 'open'), [['open', appPaths[textedit], true]]);
  // The declared hand-off is consumed: no extra window focus before typing.
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.deepEqual(callsOf(world, 'type').map(call => [call[1], call[2]]), [['@w21:e1', 'typed']]);
});

test('a window-scope focusAfter with a duplicate title still activates the app', async t => {
  // Two TextEdit windows share the recorded title, so no single window can be
  // proved. Activating the app is still well defined, exactly like `open -a`.
  const twin = windowRecord({
    id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes2', '@w23:e1']],
  });
  const { world, run } = harness(t, { focused: 'w-99', windows: [...initialWindows(), twin] });
  const flow = parseFlowV2({
    version: 2, id: 'activate-twin', name: 'Activate twin',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{
      id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit },
      focusAfter: { kind: 'window', app: textedit, windowKey: 'notes', windowTitle: 'QA Notes' },
    }],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(entry(report, 'activate').focusAfter, { kind: 'app', app: textedit });
  assert.match(entry(report, 'activate').message, /more than one window/);
  assert.deepEqual(callsOf(world, 'open'), [['open', appPaths[textedit], true]]);
});

test('a focus timeout still brings the app forward for activate_app', async t => {
  // `open -a`-style hand-off: the app is what matters, a slow focus command is
  // not a reason to stop the whole replay.
  const { world, run } = harness(t, {
    hooks: { beforeFocus: () => { throw new Fault('TIMEOUT', 'focus-window timed out'); } },
  });
  const flow = parseFlowV2({
    version: 2, id: 'focus-timeout', name: 'Focus timeout',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{
      id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit },
      focusAfter: { kind: 'window', app: textedit, windowKey: 'notes', windowTitle: 'QA Notes' },
    }],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(entry(report, 'activate').focusAfter, { kind: 'app', app: textedit });
  assert.match(entry(report, 'activate').message, /could not focus/);
  assert.deepEqual(callsOf(world, 'open'), [['open', appPaths[textedit], true]]);
});

test('an activate step opens the app when its recorded window is gone', async t => {
  // The window the flow was recorded in can be closed by replay time. An
  // activate step means "open the app", as `open -a` does, so the missing
  // window must not stop the replay.
  const { world, run } = harness(t, {
    windows: [
      windowRecord({ id: 'w-31', app: safari, pid: 510, title: 'Start Page', fields: [] }),
      windowRecord({ id: 'w-32', app: safari, pid: 510, title: 'Example', fields: [] }),
    ],
    apps: {
      [safari]: [{ pid: 510, startedAt: '510.1', bundleId: safari, bundlePath: appPaths[safari] }],
    },
    focused: 'w-31',
  });
  const flow = parseFlowV2({
    version: 2, id: 'window-gone', name: 'Window gone',
    appPaths: { [safari]: appPaths[safari] },
    steps: [{
      id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: safari },
      focusAfter: { kind: 'window', app: safari, windowKey: 'client', windowTitle: 'client' },
    }],
  });

  const report = await run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(entry(report, 'activate').focusAfter, { kind: 'app', app: safari });
  assert.match(entry(report, 'activate').message, /was gone/);
  assert.deepEqual(callsOf(world, 'open'), [['open', appPaths[safari], true]]);
});

test('an app-scoped window assertion can prove an app is not running', async t => {
  const absent = parseFlowV2({
    version: 2, id: 'app-absent', name: 'App absent',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{
      id: 'assert-absent', kind: 'assert', scope: { kind: 'app', app: textedit },
      check: { target: { kind: 'window' }, expect: { property: 'exists', equals: false } },
    }],
  });
  const idle = harness(t, { apps: {}, windows: [] });

  const report = await idle.run(absent);

  assert.equal(report.status, 'passed');
  assert.equal(entry(report, 'assert-absent').status, 'passed');
  // An app the run only had to observe as absent is not reported as a failed
  // identity, and nothing was launched, focused or read from the driver.
  assert.equal(report.appIdentities, undefined);
  assert.deepEqual(idle.world.state.calls, []);
});

test('P2 refuses raw coordinates, undeclared stages and missing input values', async t => {
  // A recorded pointer path inside a drag has no window-bound meaning.
  const drag = parseFlowV2({
    version: 2,
    id: 'drag-path',
    name: 'Drag path',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{
      id: 'drag-note', kind: 'drag', scope: notesScope,
      from: { kind: 'element', role: 'textfield', name: 'notes' },
      to: { kind: 'element', role: 'button', name: 'Continue' },
      durationMs: 30,
      path: [[200, 200], [260, 240]],
    }],
  });
  const dragRun = harness(t);
  const dragReport = await dragRun.run(drag);
  assert.equal(entry(dragReport, 'drag-note').code, 'UNSAFE_POINT');
  assert.deepEqual(dragRun.world.state.calls, [], 'no snapshot, focus or gesture for a raw path');

  // A system surface belongs to HAOC-116; replay does not guess its position.
  const surface = parseFlowV2({
    version: 2, id: 'open-dock', name: 'Open dock',
    steps: [{ id: 'open-dock', kind: 'open_system_surface', scope: { kind: 'surface', surface: 'dock' } }],
  });
  const surfaceReport = await harness(t).run(surface);
  assert.equal(entry(surfaceReport, 'open-dock').code, 'SURFACE_UNSUPPORTED');

  // An app that is not running is never launched by an activate step.
  const activate = parseFlowV2({
    version: 2, id: 'activate-only', name: 'Activate only',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{ id: 'switch-notes', kind: 'activate_app', scope: { kind: 'app', app: textedit } }],
  });
  const idle = harness(t, { apps: {} });
  const activateReport = await idle.run(activate);
  assert.equal(entry(activateReport, 'switch-notes').code, 'APP_NOT_FOUND');
  assert.deepEqual(callsOf(idle.world, 'open'), []);

  // A named input with no runtime value stops before the window is touched.
  const type = parseFlowV2({
    version: 2, id: 'missing-input', name: 'Missing input',
    appPaths: { [textedit]: appPaths[textedit] }, inputs: ['note'],
    steps: [{
      id: 'type-note', kind: 'type', scope: notesScope,
      target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
    }],
  });
  const missing = harness(t);
  const missingReport = await missing.run(type, { inputs: {} });
  assert.equal(entry(missingReport, 'type-note').code, 'INPUT_MISSING');
  assert.deepEqual(callsOf(missing.world, 'type'), []);
  assert.deepEqual(callsOf(missing.world, 'focusWindow'), []);
});

/** A window step, a secure input checkpoint, then a later window step. */
function checkpointFlow(timeoutMs = 120_000, reason = 'secure_input') {
  return parseFlowV2({
    version: 2,
    id: 'secure-install',
    name: 'Secure install',
    appPaths: { [textedit]: appPaths[textedit] },
    inputs: ['note'],
    steps: [
      { id: 'launch', kind: 'launch_app', scope: { kind: 'app', app: textedit }, focusAfter: notesScope },
      {
        id: 'install', kind: 'click', scope: notesScope,
        target: { kind: 'element', role: 'button', name: 'Continue' },
      },
      {
        id: 'auth', kind: 'manual_checkpoint', scope: notesScope, triggerStepId: 'install',
        reason,
        resume: { scope: notesScope, check: { kind: 'window_exists', equals: true } },
        timeoutMs,
      },
      {
        id: 'type-note', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
      },
    ],
  });
}

/** A channel and probe pair that models the operator finishing the auth dialog. */
function operator() {
  const state = { secure: false, announced: 0, confirmed: 0, cancelled: 0 };
  const channel = {
    async announce() { state.announced += 1; state.secure = true; },
    async confirm() { state.confirmed += 1; state.secure = false; return 'continue'; },
  };
  return { state, channel, secureInputActive: async () => state.secure };
}

test('a checkpoint pauses, the operator confirms, and later steps run', async t => {
  const world = harness(t);
  const person = operator();
  const report = await world.run(checkpointFlow(), {
    checkpoints: person.channel,
    secureInputActive: person.secureInputActive,
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(item => [item.id, item.status]), [
    ['launch', 'passed'], ['install', 'passed'], ['auth', 'passed'], ['type-note', 'passed'],
  ]);
  assert.deepEqual(entry(report, 'auth').checkpoint, {
    reason: 'secure_input', triggerStepId: 'install', timeoutMs: 120_000, confirmedBy: 'operator',
  });
  assert.equal(person.state.announced, 1);
  assert.equal(person.state.confirmed, 1);
  // The operator's work never becomes a recorded input: only the flow's own
  // parameter is typed after the hand-off.
  assert.deepEqual(callsOf(world.world, 'type'), [['type', '@w21:e1', 'draft text']]);
  assert.ok(reportV2Check.Check(report));
});

test('system dialog replay observes the trigger, waits for dismissal, then sends later input', async t => {
  const world = harness(t);
  let dismissed = false;
  const report = await world.run(checkpointFlow(120_000, 'system_dialog'), {
    checkpoints: {
      async announce(request) {
        assert.equal(request.reason, 'system_dialog');
      },
      async confirm() {
        assert.deepEqual(callsOf(world.world, 'click'), [['click', '@w21:e9']]);
        assert.deepEqual(callsOf(world.world, 'type'), []);
        dismissed = true;
        return 'continue';
      },
    },
    secureInputActive: async () => false,
    systemDialogVisible: async () => !dismissed && callsOf(world.world, 'click').length > 0,
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entry(report, 'auth').checkpoint, {
    reason: 'system_dialog', triggerStepId: 'install', timeoutMs: 120_000, confirmedBy: 'operator',
  });
  assert.deepEqual(callsOf(world.world, 'type'), [['type', '@w21:e1', 'draft text']]);
  assert.ok(reportV2Check.Check(report));
});

test('a pre-existing system dialog prevents the trigger from sending input', async t => {
  const world = harness(t);
  const report = await world.run(checkpointFlow(120_000, 'system_dialog'), {
    checkpoints: operator().channel,
    secureInputActive: async () => false,
    systemDialogVisible: async () => true,
  });
  assert.equal(entry(report, 'install').code, 'SYSTEM_DIALOG_VISIBLE');
  assert.equal(entry(report, 'auth').status, 'skipped');
  assert.deepEqual(callsOf(world.world, 'click'), []);
});

test('a cancelled checkpoint blocks and sends no later step', async t => {
  const world = harness(t);
  let secure = false;
  const report = await world.run(checkpointFlow(), {
    checkpoints: {
      async announce() { secure = true; },
      async confirm() { return 'cancel'; },
    },
    secureInputActive: async () => secure,
  });
  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'auth').status, 'blocked');
  assert.equal(entry(report, 'auth').code, 'MANUAL_CHECKPOINT_CANCELLED');
  assert.deepEqual(entry(report, 'auth').checkpoint, {
    reason: 'secure_input', triggerStepId: 'install', timeoutMs: 120_000,
  });
  assert.equal(entry(report, 'type-note').status, 'skipped');
  assert.deepEqual(callsOf(world.world, 'type'), []);
});

test('a checkpoint without an operator channel blocks before the hand-off', async t => {
  const world = harness(t);
  const report = await world.run(checkpointFlow(), { secureInputActive: async () => false });
  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'auth').code, 'MANUAL_CHECKPOINT_REQUIRED');
  assert.equal(entry(report, 'type-note').status, 'skipped');
});

test('an unplanned secure input stops an automatic step before it types', async t => {
  const world = harness(t);
  const flow = parseFlowV2({
    version: 2, id: 'secure-auto', name: 'Secure automatic step',
    appPaths: { [textedit]: appPaths[textedit] }, inputs: ['note'],
    steps: [{
      id: 'type-note', kind: 'type', scope: notesScope,
      target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
    }],
  });
  const report = await world.run(flow, { secureInputActive: async () => true });
  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'type-note').code, 'SECURE_INPUT');
  assert.deepEqual(callsOf(world.world, 'type'), []);
});

// A recorded click whose window tree could not name its element keeps only a
// point. It must stay a step that can be replayed as physical input.
const finderApp = 'com.apple.finder';
const finderPath = '/System/Library/CoreServices/Finder.app';
const finderScope = { kind: 'window', app: finderApp, windowKey: 'finder', windowTitle: 'Finder' };

function pointClickFlow(point = [200, 200]) {
  return parseFlowV2({
    version: 2,
    id: 'finder-point-click',
    name: 'Finder package click',
    appPaths: { [finderApp]: finderPath },
    steps: [{
      id: 'open-pkg', kind: 'click', scope: finderScope,
      target: { kind: 'point', point }, count: 2,
    }],
  });
}

function finderWorld(t, extra = {}) {
  return harness(t, {
    apps: { [finderApp]: [{ pid: 700, startedAt: '700.1', bundleId: finderApp, bundlePath: finderPath }] },
    focused: 'w-99',
    readBundleId: { [finderPath]: finderApp },
    ...extra,
  });
}

test('a recorded point click replays as physical input only when headed', async t => {
  const plain = finderWorld(t);
  const refused = await plain.run(pointClickFlow());
  assert.equal(entry(refused, 'open-pkg').status, 'failed');
  assert.equal(entry(refused, 'open-pkg').code, 'HEADED_REQUIRED');
  assert.deepEqual(callsOf(plain.world, 'clickPoint'), []);

  const headed = finderWorld(t, { headed: true });
  const report = await headed.run(pointClickFlow());
  assert.equal(report.status, 'passed');
  // The double click keeps its count and its recorded point.
  assert.deepEqual(callsOf(headed.world, 'clickPoint'), [['clickPoint', [200, 200], 2]]);
});

test('a recorded point outside the bound window is refused instead of clicked', async t => {
  const world = finderWorld(t, { headed: true });
  const report = await world.run(pointClickFlow([2000, 2000]));
  assert.equal(entry(report, 'open-pkg').status, 'blocked');
  assert.equal(entry(report, 'open-pkg').code, 'UNSAFE_POINT');
  assert.deepEqual(callsOf(world.world, 'clickPoint'), []);
});

const notesElement = { kind: 'element', role: 'textfield', name: 'notes' };

function hoverFlow(steps) {
  return parseFlowV2({
    version: 2, id: 'hover-replay', name: 'Hover replay', steps,
  });
}

function notesHover(id, extra = {}) {
  return { id, kind: 'hover', scope: notesScope, target: notesElement, durationMs: 0, ...extra };
}

/** No step of a read-only hover may raise, focus or press anything. */
const readOnlyCalls = world => [
  callsOf(world, 'focusWindow'), callsOf(world, 'click'), callsOf(world, 'clickPoint'),
  callsOf(world, 'clickScreen'), callsOf(world, 'clickSemantic'), callsOf(world, 'press'),
];

test('a hover rests on the recorded point, asks for a travel path and sends no input', async t => {
  const { world, run } = harness(t, { headed: true });
  // The pointer rested 60 px left of the field's centre when this was recorded;
  // the field's own centre is exactly what the old replay would have moved to.
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));

  const [, point, travel] = callsOf(world, 'hoverAt')[0];
  assert.deepEqual(point, [360, 170]);
  // The path itself is built by the driver adapter from the window it re-reads
  // at delivery time; the runner only asks for a travel hover.
  assert.equal(travel, true);
  // Read-only: no focus, no activation, no click of any kind.
  assert.deepEqual(readOnlyCalls(world), [[], [], [], [], [], []]);
});

test('a hover without a recorded point falls back to the control centre', async t => {
  const { world, run } = harness(t, { headed: true });
  const report = await run(hoverFlow([notesHover('hover-centre')]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const [, point, travel] = callsOf(world, 'hoverAt')[0];
  assert.deepEqual(point, [420, 170]);
  assert.equal(travel, true);
  assert.deepEqual(readOnlyCalls(world), [[], [], [], [], [], []]);
});

test('a hover does not raise its window when another window is in front', async t => {
  const { world, run } = harness(t, { headed: true, focused: 'w-22' });
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  assert.equal(entry(report, 'hover-notes').code, 'HOVER_NOT_FOREGROUND');
  assert.match(entry(report, 'hover-notes').message, /hover is read-only and does not bring a window forward/);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
  assert.deepEqual(readOnlyCalls(world), [[], [], [], [], [], []]);
});

test('a hover ignores a declared focusAfter instead of taking focus', async t => {
  const { world, run } = harness(t, { headed: true });
  const report = await run(hoverFlow([notesHover('hover-notes', {
    point: [360, 170], focusAfter: draftScope,
  })]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  // A hand-off after the hover would close the tooltip it just opened, and a
  // read-only step never moves focus in the first place.
  assert.equal('focusAfter' in entry(report, 'hover-notes'), false);
  assert.deepEqual(readOnlyCalls(world), [[], [], [], [], [], []]);
});

test('a hover keeps its recorded point when the container has no bounds', async t => {
  // A canvas-like group: addressable by name, but the driver gives it no frame.
  const { world, run } = harness(t, {
    headed: true,
    windows: [{
      id: 'w-21', app: textedit, pid: 601, title: 'QA Notes',
      data: {
        complete: true, window: { id: 'w-21', title: 'QA Notes' },
        tree: {
          role: 'window', name: 'QA Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
          children: [{ role: 'group', name: 'canvas', states: [] }],
        },
      },
    }],
  });
  const report = await run(hoverFlow([{
    id: 'hover-canvas', kind: 'hover', scope: notesScope,
    target: { kind: 'element', role: 'group', name: 'canvas' },
    durationMs: 0, point: [300, 260],
  }]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'hoverAt')[0][1], [300, 260]);
});

test('a hover target with no bounds and no recorded point is unresolved', async t => {
  const { world, run } = harness(t, {
    headed: true,
    windows: [{
      id: 'w-21', app: textedit, pid: 601, title: 'QA Notes',
      data: {
        complete: true, window: { id: 'w-21', title: 'QA Notes' },
        tree: {
          role: 'window', name: 'QA Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
          children: [{ role: 'group', name: 'canvas', states: [] }],
        },
      },
    }],
  });
  const report = await run(hoverFlow([{
    id: 'hover-canvas', kind: 'hover', scope: notesScope,
    target: { kind: 'element', role: 'group', name: 'canvas' }, durationMs: 0,
  }]));
  assert.equal(entry(report, 'hover-canvas').code, 'HOVER_UNRESOLVED');
  assert.match(entry(report, 'hover-canvas').message, /group "canvas" has no bounds to move to/);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
});

test('a recorded hover point outside the bound window stops before any move', async t => {
  const { world, run } = harness(t, { headed: true });
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [2000, 2000] })]));
  assert.equal(entry(report, 'hover-notes').code, 'UNSAFE_POINT');
  assert.match(entry(report, 'hover-notes').message, /recorded hover point 2000,2000 is outside the bound window/);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
});

test('a recorded point outside the control falls back to its centre, still inside the window', async t => {
  const { world, run } = harness(t, { headed: true });
  // Inside the window, but the field now sits elsewhere: the old point proves
  // nothing about this control, so the centre is the safe resting place.
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [150, 500] })]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'hoverAt')[0][1], [420, 170]);
});

test('a hover dwells at least 400 ms, and a longer recorded dwell is kept', async t => {
  const { world, run } = harness(t, { headed: true });
  const report = await run(hoverFlow([
    notesHover('hover-short', { point: [360, 170] }),
    notesHover('hover-long', { point: [360, 170], durationMs: 700 }),
    notesHover('hover-tail', { point: [360, 170] }),
  ]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));

  const [short, long, tail] = callsOf(world, 'hoverAt');
  // Each start is the previous step's resting moment, so the gap to the next
  // start is that step's dwell plus the next step's own preparation.
  assert.ok(long[3] - short[3] >= 400, `short hover dwelled ${long[3] - short[3]} ms`);
  assert.ok(tail[3] - long[3] >= 700, `long hover dwelled ${tail[3] - long[3]} ms`);
});

const screenHover = (extra = {}) => ({
  id: 'screen-hover', kind: 'hover', scope: { kind: 'screen' },
  point: [238, 397], durationMs: 0, ...extra,
});

test('a screen hover binds no window and only moves the pointer', async t => {
  const { world, run } = harness(t, { headed: true });
  const report = await run(hoverFlow([screenHover()]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const hover = entry(report, 'screen-hover');
  assert.equal(hover.deliveredVia, 'screen_point');
  assert.deepEqual(hover.scope, { kind: 'screen' });
  assert.match(hover.message, /recorded screen point \(238,397\)/);
  const moves = callsOf(world, 'hoverScreen');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].slice(0, 3), ['hoverScreen', [238, 397], true]);
  // Nothing about a window was read or moved: no binding, no snapshot, no
  // foreground proof, and no input of any kind.
  assert.deepEqual([
    callsOf(world, 'listWindows'), callsOf(world, 'snapshotWindow'), callsOf(world, 'snapshot'),
    ...readOnlyCalls(world), callsOf(world, 'hoverAt'),
  ], [[], [], [], [], [], [], [], [], [], []]);
});

test('an element hover whose window is gone degrades to its recorded point', async t => {
  const { world, run } = harness(t, {
    headed: true,
    windows: initialWindows().filter(window => window.app !== textedit),
  });
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const hover = entry(report, 'hover-notes');
  assert.equal(hover.deliveredVia, 'screen_point');
  assert.match(hover.message, /HOVER_SCREEN_FALLBACK \(WINDOW_NOT_FOUND/);
  assert.deepEqual(callsOf(world, 'hoverScreen').map(call => call[1]), [[360, 170]]);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
  assert.deepEqual(readOnlyCalls(world), [[], [], [], [], [], []]);
});

test('an element hover with no point keeps WINDOW_NOT_FOUND and moves nothing', async t => {
  const { world, run } = harness(t, {
    headed: true,
    windows: initialWindows().filter(window => window.app !== textedit),
  });
  const report = await run(hoverFlow([notesHover('hover-notes')]));
  assert.equal(entry(report, 'hover-notes').code, 'WINDOW_NOT_FOUND');
  assert.equal(entry(report, 'hover-notes').deliveredVia, undefined);
  assert.deepEqual(callsOf(world, 'hoverScreen'), []);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
});

test('two same-titled windows with no front one degrade to the point', async t => {
  const { world, run } = harness(t, {
    headed: true,
    focused: 'w-99',
    windows: [
      windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
      windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w23:e1']] }),
      windowRecord({ id: 'w-99', app: 'com.apple.finder', pid: 700, title: 'Finder', fields: [] }),
    ],
  });
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  const hover = entry(report, 'hover-notes');
  assert.equal(hover.deliveredVia, 'screen_point');
  assert.match(hover.message, /HOVER_SCREEN_FALLBACK \(AMBIGUOUS_TARGET/);
  assert.deepEqual(callsOf(world, 'hoverScreen').map(call => call[1]), [[360, 170]]);
});

test('a secure hover target refuses instead of falling back', async t => {
  const { world, run } = harness(t, {
    headed: true,
    windows: [{
      id: 'w-21', app: textedit, pid: 601, title: 'QA Notes',
      data: {
        complete: true, window: { id: 'w-21', title: 'QA Notes' },
        tree: {
          role: 'window', name: 'QA Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
          children: [{
            role: 'textfield', name: 'notes', ref_id: '@w21:e1',
            bounds: { x: 120, y: 150, width: 600, height: 40 }, states: ['secure'],
          }],
        },
      },
    }],
  });
  const report = await run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  const hover = entry(report, 'hover-notes');
  assert.equal(hover.code, 'UNSAFE_TARGET');
  assert.equal(hover.deliveredVia, undefined);
  assert.deepEqual(callsOf(world, 'hoverScreen'), []);
  assert.deepEqual(callsOf(world, 'hoverAt'), []);
});

test('a point outside the bound window and a lost foreground never fall back', async t => {
  const outside = await harness(t, { headed: true }).run(
    hoverFlow([notesHover('hover-notes', { point: [2000, 2000] })]));
  assert.equal(entry(outside, 'hover-notes').code, 'UNSAFE_POINT');
  assert.equal(entry(outside, 'hover-notes').deliveredVia, undefined);

  const background = harness(t, { headed: true, focused: 'w-22' });
  const report = await background.run(hoverFlow([notesHover('hover-notes', { point: [360, 170] })]));
  assert.equal(entry(report, 'hover-notes').code, 'HOVER_NOT_FOREGROUND');
  assert.equal(entry(report, 'hover-notes').deliveredVia, undefined);
  assert.deepEqual(callsOf(background.world, 'hoverScreen'), []);
});


/** One Finder-style window: an item label whose name sits in its value. */
function finderItemsWorld(t, items) {
  return finderWorld(t, {
    windows: [{
      id: 'w-99', app: finderApp, pid: 700, title: 'cuekeeper-demo',
      data: {
        complete: true,
        window: { id: 'w-99', title: 'cuekeeper-demo' },
        tree: {
          role: 'window', name: 'cuekeeper-demo', bounds: { x: 100, y: 100, width: 800, height: 600 },
          children: [{ role: 'outline', bounds: { x: 110, y: 130, width: 780, height: 500 }, children: items }],
        },
      },
    }],
  });
}

function fileClickFlow(target) {
  return parseFlowV2({
    version: 2, id: 'finder-file-click', name: 'Finder file click',
    appPaths: { [finderApp]: finderPath },
    steps: [{
      id: 'open-file', kind: 'click', count: 2,
      scope: { kind: 'window', app: finderApp, windowKey: 'finder', windowTitle: 'cuekeeper-demo' },
      target,
    }],
  });
}

test('an unnamed element target is refused instead of clicking a look-alike', async t => {
  const { world, run } = finderItemsWorld(t, [{
    role: 'textfield', ref_id: '@w99:e1', bounds: { x: 120, y: 150, width: 600, height: 40 }, states: [],
  }]);
  const report = await run(fileClickFlow({ kind: 'element', role: 'textfield', name: '' }));
  assert.equal(entry(report, 'open-file').status, 'failed');
  assert.equal(entry(report, 'open-file').code, 'AMBIGUOUS');
  // The single unnamed textfield is exactly what a silent click would have hit.
  assert.deepEqual(callsOf(world, 'click'), []);
});

function identifierClickFlow(target) {
  return parseFlowV2({
    version: 2, id: 'identifier-click', name: 'Identifier click',
    appPaths: { [finderApp]: finderPath },
    steps: [{
      id: 'click-control', kind: 'click',
      scope: { kind: 'window', app: finderApp, windowKey: 'finder', windowTitle: 'cuekeeper-demo' },
      target,
    }],
  });
}

test('a recorded identifier resolves a control whose label has changed', async t => {
  // Chromium reports AXDOMIdentifier for controls whose visible text is free to
  // change; the identifier is the identity that survives a copy edit.
  const { world, run } = finderItemsWorld(t, [{
    role: 'button', ref_id: '@w99:e1', name: '继续', native_id: { kind: 'ax_dom_identifier', value: 'continue-btn' },
    bounds: { x: 120, y: 150, width: 200, height: 40 }, states: [],
  }]);
  const report = await run(identifierClickFlow({
    kind: 'element', role: 'button', name: 'Continue', identifier: 'continue-btn',
  }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1']]);
});

test('an identifier that the page no longer carries falls back to the name', async t => {
  // An older build of the app has the same control without the DOM identifier.
  const { world, run } = finderItemsWorld(t, [{
    role: 'button', ref_id: '@w99:e1', name: 'Continue',
    bounds: { x: 120, y: 150, width: 200, height: 40 }, states: [],
  }]);
  const report = await run(identifierClickFlow({
    kind: 'element', role: 'button', name: 'Continue', identifier: 'continue-btn',
  }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1']]);
});

test('a renamed control without its identifier is not clicked blindly', async t => {
  const { world, run } = finderItemsWorld(t, [{
    role: 'button', ref_id: '@w99:e1', name: '继续',
    bounds: { x: 120, y: 150, width: 200, height: 40 }, states: [],
  }]);
  const report = await run(identifierClickFlow({
    kind: 'element', role: 'button', name: 'Continue', identifier: 'continue-btn',
  }));
  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'click-control').code, 'NOT_FOUND');
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('a control with an identifier but no name is a usable element target', async t => {
  const { world, run } = finderItemsWorld(t, [{
    role: 'image', ref_id: '@w99:e1', native_id: { kind: 'ax_dom_identifier', value: 'qr-code' },
    bounds: { x: 200, y: 200, width: 120, height: 120 }, states: [],
  }]);
  const report = await run(identifierClickFlow({ kind: 'element', role: 'image', name: '', identifier: 'qr-code' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1']]);
});

test('a file target named by an item label value is found and clicked', async t => {
  const { world, run } = finderItemsWorld(t, [{
    role: 'row', bounds: { x: 110, y: 140, width: 780, height: 24 }, children: [{
      role: 'statictext', value: 'manifest.json', ref_id: '@w99:e1',
      bounds: { x: 140, y: 142, width: 200, height: 20 }, states: [],
    }],
  }]);
  const report = await run(fileClickFlow({ kind: 'element', role: 'statictext', name: 'manifest.json' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1']]);
});

// --- HAOC-192: a click whose control carries no action reference --------------
// A window shaped like an Electron page: the driver gives a reference only to
// the nodes it can press, so a labelled container (and everything above it in
// the tree) carries none. The recorded target is still the control the user
// clicked, and replay must not fall through to a neighbouring control.

function electronTree(children) {
  return {
    role: 'window', name: 'cuekeeper-demo', bounds: { x: 100, y: 100, width: 800, height: 600 },
    children: [{ role: 'webarea', bounds: { x: 110, y: 120, width: 780, height: 480 }, children }],
  };
}

function electronWindow(id, children) {
  return {
    id, app: finderApp, pid: 700, title: 'cuekeeper-demo',
    data: { complete: true, window: { id, title: 'cuekeeper-demo' }, tree: electronTree(children) },
  };
}

function electronWorld(t, children, options = {}) {
  return finderWorld(t, { windows: [electronWindow('w-99', children)], ...options });
}

test('a control with no action reference is pressed through its actionable container', async t => {
  // The label is what the recording could name; the container is what the
  // driver can press, and it is the same control the user clicked.
  const { world, run } = electronWorld(t, [{
    role: 'button', ref_id: '@w99:e1', bounds: { x: 600, y: 200, width: 400, height: 60 },
    children: [{
      role: 'statictext', name: '接入地址', bounds: { x: 620, y: 215, width: 180, height: 20 }, states: [],
    }],
  }]);
  const report = await run(identifierClickFlow({ kind: 'element', role: 'statictext', name: '接入地址' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1']]);
  assert.deepEqual(callsOf(world, 'clickPoint'), []);
  assert.equal(entry(report, 'click-control').message, undefined);
});

test('a control with no reference anywhere is clicked at its own centre, headed only', async t => {
  const children = [{
    role: 'group', name: '接入地址', bounds: { x: 600, y: 200, width: 400, height: 200 }, states: [],
  }];
  const plain = electronWorld(t, children);
  const refused = await plain.run(identifierClickFlow({ kind: 'element', role: 'group', name: '接入地址' }));
  assert.deepEqual({
    code: entry(refused, 'click-control').code, click: callsOf(plain.world, 'click'),
    point: callsOf(plain.world, 'clickPoint'),
  }, { code: 'HEADED_REQUIRED', click: [], point: [] });

  const headed = electronWorld(t, children, { headed: true });
  const report = await headed.run(identifierClickFlow({ kind: 'element', role: 'group', name: '接入地址' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  // The centre of the recorded control, as physical input: the same element,
  // proven by name, never a same-role neighbour.
  assert.deepEqual(callsOf(headed.world, 'clickPoint'), [['clickPoint', [800, 300], 1]]);
  assert.deepEqual(callsOf(headed.world, 'click'), []);
  assert.match(entry(report, 'click-control').message ?? '', /has no AX action; clicked its centre instead/);
});

test('a control with neither a reference nor bounds names itself and sends nothing', async t => {
  const { world, run } = electronWorld(t, [{
    role: 'group', name: '接入地址', states: [],
  }]);
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '接入地址' }));
  const blocked = entry(report, 'click-control');
  assert.equal(blocked.code, 'UNSAFE_TARGET');
  assert.match(blocked.message, /group "接入地址" has no action reference and no bounds to click/);
  assert.match(blocked.message, /pick the target/);
  assert.deepEqual([callsOf(world, 'click'), callsOf(world, 'clickPoint'), callsOf(world, 'clickScreen')],
    [[], [], []]);
});

// --- HAOC-206: a semantic press that returns ACTION_FAILED --------------------
// A window that was just raised (an Electron page, for one) can answer the
// accessibility read while the control still rejects AXPress. The run re-reads
// the tree once and retries the press; when that also fails it clicks the same
// control's centre through the ordinary coordinate gate. One retry and one
// fallback, never a loop.

function actionFailed() {
  return new DesktopFault('ACTION_FAILED', 'click', undefined);
}

const settingsGroup = () => ({
  role: 'group', name: '设置', ref_id: '@w99:e1',
  bounds: { x: 600, y: 200, width: 400, height: 200 }, states: [],
});

test('a first ACTION_FAILED is retried once against a re-read snapshot', async t => {
  const pressedAt = [];
  const { world, run } = electronWorld(t, [settingsGroup()], {
    headed: true,
    hooks: {
      click(state, ref) {
        pressedAt.push(performance.now());
        // The page finished rendering between the two presses: same control,
        // new driver reference. Reusing the stale ref cannot pass this test.
        state.windows[0].data.tree.children[0].children[0].ref_id = '@w99:e2';
        return ref === '@w99:e1' ? actionFailed() : undefined;
      },
    },
  });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click').map(call => call[1]), ['@w99:e1', '@w99:e2']);
  assert.deepEqual(callsOf(world, 'clickPoint'), []);
  assert.ok(pressedAt[1] - pressedAt[0] >= 200,
    `the retry should wait for the app to settle; it fired after ${pressedAt[1] - pressedAt[0]}ms`);
  const entryAfter = entry(report, 'click-control');
  assert.equal(entryAfter.status, 'passed');
  assert.match(entryAfter.message ?? '',
    /the first AX press returned ACTION_FAILED; retried once against a re-read snapshot and it succeeded/);
});

test('a press that keeps failing falls back to the same control\'s centre', async t => {
  const { world, run } = electronWorld(t, [settingsGroup()], {
    headed: true,
    hooks: { click: () => actionFailed() },
  });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click').map(call => call[1]), ['@w99:e1', '@w99:e1']);
  assert.deepEqual(callsOf(world, 'clickPoint'), [['clickPoint', [800, 300], 1]]);
  const entryAfter = entry(report, 'click-control');
  assert.match(entryAfter.message ?? '', /CLICK_POINT_FALLBACK/);
  assert.match(entryAfter.message ?? '', /the AX press kept returning ACTION_FAILED/);
});

test('a failed press with no bounds reports ACTION_FAILED and sends no input', async t => {
  const { world, run } = electronWorld(t, [{
    role: 'group', name: '设置', ref_id: '@w99:e1', states: [],
  }], { hooks: { click: () => actionFailed() } });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  const failed = entry(report, 'click-control');
  assert.equal(report.status, 'failed');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'ACTION_FAILED');
  assert.match(failed.message, /group "设置" failed after 2 semantic click attempts and 0 physical centre clicks/);
  assert.match(failed.message, /the control has no bounds to click at its centre/);
  assert.equal(callsOf(world, 'click').length, 2);
  assert.deepEqual(callsOf(world, 'clickPoint'), []);
});

test('a failed physical fallback reports ACTION_FAILED with both attempts', async t => {
  const { world, run } = electronWorld(t, [settingsGroup()], {
    headed: true,
    hooks: {
      click: () => actionFailed(),
      clickPoint: () => new Fault('UNSAFE_POINT', 'The coordinate is outside the selected window'),
    },
  });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  const failed = entry(report, 'click-control');
  assert.equal(failed.code, 'ACTION_FAILED');
  assert.match(failed.message, /group "设置" failed after 2 semantic click attempts and 1 physical centre click/);
  assert.match(failed.message, /UNSAFE_POINT/);
  assert.equal(callsOf(world, 'click').length, 2);
  assert.equal(callsOf(world, 'clickPoint').length, 1);
});

test('a secure control is never retried or clicked physically', async t => {
  const { world, run } = electronWorld(t, [{
    ...settingsGroup(), states: ['secure'],
  }], {
    headed: true,
    hooks: { click: () => actionFailed() },
  });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  assert.equal(entry(report, 'click-control').code, 'UNSAFE_TARGET');
  assert.deepEqual([callsOf(world, 'click'), callsOf(world, 'clickPoint')], [[], []]);
});

test('a target that no longer resolves is not clicked at its old bounds', async t => {
  const { world, run } = electronWorld(t, [settingsGroup()], {
    headed: true,
    hooks: {
      click(state) {
        // The control was replaced while the press failed: its old centre now
        // belongs to something else, so neither a retry nor a fallback is safe.
        state.windows[0].data.tree.children[0].children[0].name = '接入设置';
        return actionFailed();
      },
    },
  });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'group', name: '设置' }));
  const failed = entry(report, 'click-control');
  assert.equal(failed.code, 'ACTION_FAILED');
  assert.match(failed.message, /could not be resolved again/);
  assert.equal(callsOf(world, 'click').length, 1);
  assert.deepEqual(callsOf(world, 'clickPoint'), []);
});

test('a same-titled twin that lacks the control is not clicked even when focused', async t => {
  // Both windows carry the recorded title. Only one addresses the recorded
  // control, so that one runs the step; the operator's focus is not evidence
  // strong enough to overrule the tree.
  const holder = electronWindow('w-96', [{
    role: 'group', name: '接入地址', bounds: { x: 600, y: 200, width: 400, height: 200 },
    children: [{ role: 'button', name: '继续', ref_id: '@w96:e1', bounds: { x: 620, y: 215, width: 120, height: 32 } }],
  }]);
  const twin = electronWindow('w-97', [{
    role: 'group', name: '接入地址', bounds: { x: 600, y: 200, width: 400, height: 200 },
    children: [{ role: 'button', name: '取消', ref_id: '@w97:e1', bounds: { x: 620, y: 215, width: 120, height: 32 } }],
  }]);
  const { world, run } = finderWorld(t, { windows: [holder, twin], focused: 'w-97' });
  const report = await run(identifierClickFlow({ kind: 'element', role: 'button', name: '继续' }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w96:e1']]);
  assert.match(entry(report, 'click-control').message ?? '', /held its target/);
});

// A folder opened twice leaves two windows under one title. The flow was
// recorded in one of them, and the step's own target is what tells them apart.
function gitWindow(id, item) {
  return {
    id, app: finderApp, pid: 700, title: 'git',
    data: {
      complete: true,
      window: { id, title: 'git' },
      tree: {
        role: 'window', name: 'git', bounds: { x: 100, y: 100, width: 800, height: 600 }, children: [{
          role: 'outline', bounds: { x: 110, y: 130, width: 780, height: 500 }, children: [{
            role: 'row', bounds: { x: 110, y: 140, width: 780, height: 24 }, children: [{
              role: 'statictext', value: item, ref_id: `@${id.replace('-', '')}:e1`,
              bounds: { x: 140, y: 142, width: 200, height: 20 }, states: [],
            }],
          }],
        }],
      },
    },
  };
}

function gitClickFlow(name) {
  return parseFlowV2({
    version: 2, id: 'finder-git-click', name: 'Finder git click',
    appPaths: { [finderApp]: finderPath },
    steps: [{
      id: 'click-control', kind: 'click',
      scope: { kind: 'window', app: finderApp, windowKey: 'git', windowTitle: 'git' },
      target: { kind: 'element', role: 'statictext', name },
    }],
  });
}

test('a same-titled window is chosen by the target it holds', async t => {
  const { world, run } = finderWorld(t, {
    windows: [gitWindow('w-98', 'README.md'), gitWindow('w-97', 'git')],
  });
  const report = await run(gitClickFlow('git'));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
});

test('a missing window names the windows the app does have', async t => {
  const { run } = finderWorld(t, {
    windows: [
      { id: 'w-98', app: finderApp, pid: 700, title: '下载', data: envelope('w-98', '下载', []) },
      { id: 'w-97', app: finderApp, pid: 700, title: '桌面', data: envelope('w-97', '桌面', []) },
    ],
  });
  const report = await run(gitClickFlow('git'));
  const blocked = entry(report, 'click-control');
  assert.equal(blocked.code, 'WINDOW_NOT_FOUND');
  assert.match(blocked.message, /No window titled "git" belongs to com.apple.finder \(its windows: "下载", "桌面"\)/);
});

test('a same-titled window that is focused wins over an older duplicate', async t => {
  const { world, run } = finderWorld(t, {
    windows: [gitWindow('w-98', 'git'), gitWindow('w-97', 'git')],
    focused: 'w-97',
  });
  const report = await run(gitClickFlow('git'));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w97:e1']]);
  assert.match(entry(report, 'click-control').message ?? '', /more than one window was titled "git".*the focused one/);
});
// --- Deferred path preflight (HAOC-119) ---------------------------------------
// A flow that installs the app before it uses it cannot fail before that
// install. The pin is still proven at the first real use, and an existing path
// that holds another bundle still stops before any desktop call.

const target = 'com.example.CuekeeperTest';
const targetPath = '/Applications/CuekeeperTest.app';
const targetScope = { kind: 'window', app: target, windowKey: 'target', windowTitle: 'CuekeeperTest' };

/** One fake install state that can flip the pinned path into existence. */
function installStateFake(state) {
  return {
    async appInstalled(app, options) {
      assert.equal(app, target);
      assert.equal(options.path, targetPath);
      state.reads += 1;
      if (state.reads >= 2) state.installed = true;
      return { installed: state.installed, evidence: state.installed ? ['bundle'] : [] };
    },
    async fileEvidence() { throw new Error('a file wait is not part of this flow'); },
  };
}

/** An install followed by the first real use of the installed app. */
function installThenUseFlow() {
  return parseFlowV2({
    version: 2, id: 'install-then-use', name: 'Install then use',
    appPaths: { [target]: targetPath },
    steps: [
      {
        id: 'wait-installed', kind: 'wait', scope: { kind: 'app', app: target }, timeoutMs: 5000,
        check: { kind: 'app_installed', equals: true },
      },
      { id: 'launch-target', kind: 'launch_app', scope: { kind: 'app', app: target }, focusAfter: targetScope },
      {
        id: 'click-open', kind: 'click', scope: targetScope,
        target: { kind: 'element', role: 'button', name: 'Continue' },
      },
    ],
  });
}

/** The afterOpen hook that installation and launch produce in the fake world. */
function opensTarget(state) {
  state.apps.set(target, [{ pid: 801, startedAt: '801.1', bundleId: target, bundlePath: targetPath }]);
  state.windows.push(windowRecord({
    id: 'w-51', app: target, pid: 801, title: 'CuekeeperTest', fields: [['name', '@w51:e1']],
  }));
  state.focused = 'w-51';
}

function targetIdentityOptions(state, bundleId = target) {
  return {
    appPath: () => targetPath,
    pathToBundle: { [targetPath]: bundleId },
    present: path => path !== targetPath || state.installed,
  };
}

test('a pinned path that does not exist yet is proven after the install, not before', async t => {
  const state = { reads: 0, installed: false };
  const world = harness(t, {
    hooks: { afterOpen: opensTarget },
    identityOptions: targetIdentityOptions(state),
  });

  const report = await world.run(installThenUseFlow(), {
    installState: installStateFake(state),
  });

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(report.entries.map(item => item.status), ['passed', 'passed', 'passed']);
  // The wait ran before the path existed; the launch is the first desktop call
  // and it opened the exact installed bundle.
  assert.deepEqual(callsOf(world.world, 'open'), [['open', targetPath, false]]);
  assert.deepEqual(callsOf(world.world, 'click'), [['click', '@w51:e9']]);
  // Only after the window was read is the app reported verified.
  assert.deepEqual(report.appIdentities, [{ app: target, mode: 'bundle_path', status: 'verified' }]);
});

test('a pinned path that never appears stops at its first use with APP_PATH_INVALID', async t => {
  const state = { reads: 0, installed: false };
  const world = harness(t, { identityOptions: targetIdentityOptions(state) });
  const flow = parseFlowV2({
    version: 2, id: 'never-installed', name: 'Never installed',
    appPaths: { [target]: targetPath },
    steps: [
      { id: 'launch-target', kind: 'launch_app', scope: { kind: 'app', app: target } },
      {
        id: 'click-open', kind: 'click', scope: targetScope,
        target: { kind: 'element', role: 'button', name: 'Continue' },
      },
    ],
  });

  const report = await world.run(flow);

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'launch-target').code, 'APP_PATH_INVALID');
  assert.equal(entry(report, 'click-open').status, 'skipped');
  // The failure names the step that needed the app and never binds another copy.
  assert.deepEqual(report.appIdentities, [{
    app: target, mode: 'bundle_path', status: 'blocked', code: 'APP_PATH_INVALID',
    reason: 'invalid_bundle_path', entryId: 'launch-target',
  }]);
  assert.deepEqual(world.world.state.calls, [], 'nothing is launched, focused or read');
});

test('an installed path holding another bundle still fails closed at first use', async t => {
  const state = { reads: 0, installed: false };
  const world = harness(t, {
    hooks: { afterOpen: opensTarget },
    // The install lands, but the pinned path now declares a different bundle.
    identityOptions: targetIdentityOptions(state, 'com.example.Other'),
  });

  const report = await world.run(installThenUseFlow(), { installState: installStateFake(state) });

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'wait-installed').status, 'passed');
  assert.equal(entry(report, 'launch-target').code, 'APP_PATH_INVALID');
  assert.deepEqual(report.appIdentities, [{
    app: target, mode: 'bundle_path', status: 'blocked', code: 'APP_PATH_INVALID',
    reason: 'bundle_id_mismatch', entryId: 'launch-target',
  }]);
  assert.deepEqual(callsOf(world.world, 'open'), [], 'another bundle is never opened');
  assert.deepEqual(callsOf(world.world, 'click'), []);
});

test('an app_installed wait reads evidence without touching the missing pin', async t => {
  const state = { reads: 0, installed: false };
  const world = harness(t, { identityOptions: targetIdentityOptions(state) });
  const flow = parseFlowV2({
    version: 2, id: 'install-evidence', name: 'Install evidence',
    appPaths: { [target]: targetPath },
    steps: [
      {
        id: 'wait-installed', kind: 'wait', scope: { kind: 'app', app: target }, timeoutMs: 5000,
        check: { kind: 'app_installed', equals: true },
      },
    ],
  });

  const report = await world.run(flow, { installState: installStateFake(state) });

  assert.equal(report.status, 'passed');
  assert.equal(state.reads >= 2, true);
  assert.deepEqual(world.world.state.calls, []);
  // A deferred pin that was never used is not reported verified.
  assert.deepEqual(report.appIdentities, [{
    app: target, mode: 'bundle_path', status: 'blocked', code: 'APP_UNVERIFIED',
    reason: 'preflight_deferred',
  }]);
});

test('a deferred app is verified only after its window is bound', async t => {
  const state = { reads: 0, installed: true };
  const world = harness(t, {
    hooks: { afterOpen: opensTarget },
    identityOptions: targetIdentityOptions(state),
  });
  const flow = parseFlowV2({
    version: 2, id: 'deferred-then-used', name: 'Deferred then used',
    appPaths: { [target]: targetPath },
    steps: [
      { id: 'launch-target', kind: 'launch_app', scope: { kind: 'app', app: target }, focusAfter: targetScope },
      {
        id: 'click-open', kind: 'click', scope: targetScope,
        target: { kind: 'element', role: 'button', name: 'Continue' },
      },
    ],
  });

  const report = await world.run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  assert.deepEqual(report.appIdentities, [{ app: target, mode: 'bundle_path', status: 'verified' }]);
  assert.deepEqual(callsOf(world.world, 'click'), [['click', '@w51:e9']]);
});

// --- Finder-style rename -------------------------------------------------------

/** A Finder list view: the file name is a textfield value inside the first cell. */
function renameWindow() {
  return {
    id: 'w-1', app: textedit, pid: 601, title: 'cuekeeper-demo',
    data: {
      complete: true,
      window: { id: 'w-1', title: 'cuekeeper-demo' },
      tree: {
        role: 'window', name: 'cuekeeper-demo', ref_id: '@w1:e1',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        children: [{
          role: 'outline', name: '列表视图', ref_id: '@w1:e2',
          bounds: { x: 110, y: 150, width: 700, height: 400 },
          children: [{
            role: 'treeitem', ref_id: '@w1:e3',
            bounds: { x: 110, y: 160, width: 700, height: 20 },
            available_actions: ['Click'],
            children: [
              {
                role: 'cell', ref_id: '@w1:e4', bounds: { x: 130, y: 160, width: 300, height: 20 },
                children: [
                  { role: 'image', ref_id: '@w1:e5', bounds: { x: 130, y: 162, width: 16, height: 16 } },
                  {
                    role: 'textfield', ref_id: '@w1:e6', value: 'manifest.json',
                    bounds: { x: 150, y: 160, width: 120, height: 20 },
                    available_actions: ['Click', 'SetValue'],
                  },
                ],
              },
              {
                role: 'cell', name: '今天 10:00', ref_id: '@w1:e7',
                bounds: { x: 500, y: 160, width: 120, height: 20 },
                children: [{
                  role: 'statictext', name: '今天 10:00', ref_id: '@w1:e8',
                  bounds: { x: 500, y: 160, width: 100, height: 20 },
                }],
              },
            ],
          }],
        }, {
          role: 'textfield', name: 'notes', ref_id: '@w1:e9',
          bounds: { x: 200, y: 500, width: 300, height: 24 },
          available_actions: ['Click', 'SetValue'], states: ['focused'],
        }],
      },
    },
  };
}

const renameScope = {
  kind: 'window', app: textedit, windowKey: 'demo', windowTitle: 'cuekeeper-demo',
};

test('a recorded rename replays through the menu and focuses the inline editor', async t => {
  const menu = {
    complete: true,
    tree: {
      role: 'menu', name: '列表视图',
      children: [{
        role: 'menuitem', name: '重新命名', ref_id: '@menu:e1',
        bounds: { x: 300, y: 300, width: 120, height: 22 },
        available_actions: ['Click'],
      }],
    },
  };
  const world = harness(t, {
    headed: true,
    windows: [renameWindow()],
    focused: 'w-1',
    menu,
    apps: {
      [textedit]: [{ pid: 601, startedAt: '601.1', bundleId: textedit, bundlePath: appPaths[textedit] }],
    },
  });
  const flow = parseFlowV2({
    version: 2, id: 'rename-replay', name: 'Rename replay',
    steps: [
      {
        id: 'click-file', kind: 'click', scope: renameScope,
        // Finder reports AXRow to the helper but treeitem in the snapshot.
        target: { kind: 'element', role: 'row', name: 'manifest.json' },
      },
      {
        id: 'open-menu', kind: 'click', scope: renameScope,
        target: { kind: 'element', role: 'outline', name: '列表视图' }, button: 'right',
      },
      {
        id: 'rename', kind: 'click', scope: renameScope,
        target: { kind: 'element', role: 'menuitem', name: '重新命名' },
      },
      {
        id: 'type-name', kind: 'type', scope: renameScope,
        target: { kind: 'element', role: 'textfield' }, text: 'manifest-e2e.json',
      },
      { id: 'commit', kind: 'key', scope: renameScope, key: 'return' },
      {
        id: 'type-normal', kind: 'type', scope: renameScope,
        target: { kind: 'element', role: 'textfield', name: 'notes' }, text: 'plain',
      },
    ],
  });

  const report = await world.run(flow);

  assert.equal(report.status, 'passed', JSON.stringify(report.entries, null, 2));
  // The row click and the right-click both address the treeitem through the
  // row-role family; the recorded role was `row`.
  assert.deepEqual(callsOf(world.world, 'click'),
    [['click', '@w1:e3'], ['click', '@w1:e3']]);
  assert.deepEqual(callsOf(world.world, 'clickSemantic'), [['clickSemantic', '@menu:e1']]);
  // The rename editor is focused at the name column, not at a neighbouring row.
  assert.deepEqual(callsOf(world.world, 'clickScreen'), [['clickScreen', [174, 170], 'left']]);
  assert.deepEqual(callsOf(world.world, 'typeFocused'),
    [['typeFocused', 'manifest-e2e.json', textedit, { selectAll: true }]]);
  assert.deepEqual(callsOf(world.world, 'press'), [['press', 'return', 'w-1']]);
  // Return ended rename mode: a named field afterwards types normally.
  assert.deepEqual(callsOf(world.world, 'type'), [['type', '@w1:e9', 'plain']]);
});

function reviewTypeFlow(target = { kind: 'element', role: 'textfield', name: 'notes' }) {
  return parseFlowV2({
    version: 2, id: 'review-type', name: 'Review type',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{ id: 'type-note', kind: 'type', scope: notesScope, target, text: 'review' }],
  });
}

for (const unreadable of [false, true]) {
  test(`HAOC-175 review: same-title window ${unreadable ? 'unreadable' : 'no unique focus'} sends zero input`, async t => {
    const twin = windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w23:e1']] });
    if (unreadable) twin.data.complete = false;
    const { world, run } = harness(t, { windows: [...initialWindows(), twin], focused: 'w-22' });
    const report = await run(reviewTypeFlow());
    assert.deepEqual({ sent: callsOf(world, 'type'), code: entry(report, 'type-note').code },
      { sent: [], code: 'AMBIGUOUS_TARGET' });
  });
}

test('HAOC-175 review: an absent identifier alone sends zero click input', async t => {
  const { world, run } = finderItemsWorld(t, [{
    role: 'image', ref_id: '@w99:e1',
    bounds: { x: 200, y: 200, width: 120, height: 120 }, states: [],
  }]);
  const report = await run(identifierClickFlow({ kind: 'element', role: 'image', name: '', identifier: 'missing-id' }));
  assert.deepEqual({ sent: callsOf(world, 'click'), code: entry(report, 'click-control').code },
    { sent: [], code: 'NOT_FOUND' });
});

test('HAOC-175 review: an existing indexed paste refuses the wrong remaining duplicate', async t => {
  const { world, run } = harness(t);
  const flow = parseFlowV2({
    version: 2, id: 'review-paste', name: 'Review paste',
    appPaths: { [textedit]: appPaths[textedit] },
    inputs: ['note'],
    steps: [{
      id: 'paste-note', kind: 'paste', scope: notesScope,
      target: { kind: 'element', role: 'textfield', name: 'notes', index: 1 },
      source: { kind: 'input', input: 'note' },
    }],
  });
  const report = await run(flow);
  assert.deepEqual({ sent: callsOf(world, 'press'), code: entry(report, 'paste-note').code },
    { sent: [], code: 'NOT_FOUND' });
});

test('HAOC-175 review: identifier-only type goes to the identified field', async t => {
  const windows = initialWindows();
  const fields = windows[0].data.tree.children[0].children;
  fields[0].name = '';
  fields.push({
    ...fields[0], ref_id: '@w21:e2', states: [],
    native_id: { kind: 'ax_dom_identifier', value: 'recorded-field' },
  });
  const { world, run } = harness(t, { windows });
  const report = await run(reviewTypeFlow({ kind: 'element', role: 'textfield', name: '', identifier: 'recorded-field' }));
  assert.deepEqual({ sent: callsOf(world, 'type'), status: entry(report, 'type-note').status },
    { sent: [['type', '@w21:e2', 'review']], status: 'passed' });
});

test('HAOC-175 review: an ambiguous element in a same-titled window prevents choosing its twin', async t => {
  const twin = windowRecord({
    id: 'w-23', app: textedit, pid: 601, title: 'QA Notes',
    fields: [['notes', '@w23:e1'], ['notes', '@w23:e2']],
  });
  const { world, run } = harness(t, { windows: [...initialWindows(), twin], focused: 'w-22' });
  const report = await run(reviewTypeFlow());
  assert.equal(entry(report, 'type-note').code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(callsOf(world, 'type'), []);
});

test('HAOC-175 review: a same-titled window with unknown bounds prevents point input', async t => {
  const twin = windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [] });
  delete twin.data.tree.bounds;
  const { world, run } = harness(t, { windows: [...initialWindows(), twin], headed: true });
  const flow = parseFlowV2({
    version: 2, id: 'review-point', name: 'Review point',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [{
      id: 'point', kind: 'click', scope: notesScope, target: { kind: 'point', point: [200, 200] },
    }],
  });
  const report = await run(flow);
  assert.equal(entry(report, 'point').code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(callsOf(world, 'clickPoint'), []);
});

test('HAOC-175 review: a name index cannot pick among repeated exact identifiers', async t => {
  const native_id = { kind: 'ax_dom_identifier', value: 'shared' };
  const { world, run } = finderItemsWorld(t, [
    { role: 'image', ref_id: '@w99:e1', native_id },
    { role: 'image', ref_id: '@w99:e2', native_id },
  ]);
  const report = await run(identifierClickFlow({
    kind: 'element', role: 'image', name: '', identifier: 'shared', index: 1,
  }));
  assert.equal(entry(report, 'click-control').code, 'AMBIGUOUS');
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('HAOC-175 review: typing with an identifier preserves the fallback name index', async t => {
  const { world, run } = harness(t);
  const report = await run(reviewTypeFlow({
    kind: 'element', role: 'textfield', name: 'notes', identifier: 'absent', index: 1,
  }));
  assert.equal(entry(report, 'type-note').code, 'NOT_FOUND');
  assert.deepEqual(callsOf(world, 'type'), []);
});

test('HAOC-175 review: a right click with an identifier ignores an earlier click on another element', async t => {
  const { world, run } = finderItemsWorld(t, [
    { role: 'button', name: 'Previous', ref_id: '@w99:e1' },
    {
      role: 'button', ref_id: '@w99:e2',
      native_id: { kind: 'ax_dom_identifier', value: 'right-clicked' },
    },
  ]);
  const flow = identifierClickFlow({ kind: 'element', role: 'button', name: '', identifier: 'right-clicked' });
  const [step] = flow.steps;
  const report = await run(parseFlowV2({
    ...flow,
    steps: [
      { id: 'previous', kind: 'click', scope: step.scope, target: { kind: 'element', role: 'button', name: 'Previous' } },
      { ...step, button: 'right' },
    ],
  }));
  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e1'], ['click', '@w99:e2']]);
});

// HAOC-207: the first input after a window switch proves its target is really
// there. Every case below raises the window with `activate_app` and then presses
// one control, so only that first press pays the wait.

/** A raised window, then one control pressed in it. */
function readinessFlow(step) {
  return parseFlowV2({
    version: 2,
    id: 'readiness',
    name: 'Readiness',
    appPaths: { [textedit]: appPaths[textedit] },
    inputs: ['note'],
    steps: [
      { id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit } },
      step,
    ],
  });
}

const pressContinue = {
  id: 'press', kind: 'click', scope: notesScope,
  target: { kind: 'element', role: 'button', name: 'Continue' },
};

/**
 * Rewrites the notes window each time a step reads it, so a test can model an
 * app that paints its controls a few hundred milliseconds after its window was
 * raised. `script(window, readIndex)` runs before the snapshot is returned.
 */
function paintOnRead(world, script) {
  const reads = new Map();
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async windowId => {
    const index = (reads.get(windowId) ?? 0) + 1;
    reads.set(windowId, index);
    const window = world.state.windows.find(candidate => candidate.id === windowId);
    if (window) script(window, index);
    return real(windowId);
  };
  return reads;
}

const notesWindowOf = world => world.state.windows.find(window => window.id === 'w-21');
const continueButtonOf = world => notesWindowOf(world).data.tree.children
  .find(child => child.role === 'button' && child.name === 'Continue');

test('HAOC-207: a target that appears after the window was raised is waited for and pressed once', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  const reads = paintOnRead(world, (window, index) => {
    const present = window.data.tree.children.includes(button);
    // The first read of the freshly raised window cannot see the control yet.
    if (index === 1 && present) {
      window.data.tree.children = window.data.tree.children.filter(child => child !== button);
    } else if (index > 1 && !present) {
      window.data.tree.children = [...window.data.tree.children, button];
    }
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']], 'exactly one press was delivered');
  assert.ok(reads.get('w-21') >= 3, `the gate read the window until the control settled (${reads.get('w-21')})`);
  assert.ok(entry(report, 'press').durationMs >= 150,
    `the press waited for the second agreeing read (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207: a control whose bounds move twice is pressed only after they hold still', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  const original = { ...button.bounds };
  const moves = [40, 80, 0];
  paintOnRead(world, (_window, index) => {
    const offset = moves[index - 1] ?? 0;
    button.bounds = { ...original, x: original.x + offset };
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']]);
  assert.ok(entry(report, 'press').durationMs >= 400,
    `two moving reads and one agreeing pair were waited for (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207: a disabled control is pressed only once it becomes enabled', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  paintOnRead(world, (_window, index) => {
    button.states = index <= 2 ? ['disabled'] : [];
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']]);
  assert.ok(entry(report, 'press').durationMs >= 350,
    `two disabled reads were waited out (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207: a control that never becomes enabled stops the step as TARGET_NOT_READY with zero input', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  paintOnRead(world, () => { button.states = ['disabled']; });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'press').message, /button "Continue" is still disabled/);
  assert.deepEqual(callsOf(world, 'click'), [], 'no press was ever sent');
  assert.ok(entry(report, 'press').durationMs >= 1400,
    `the wait was bounded, not endless (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207: a control that never stops moving stops the step as TARGET_NOT_READY with zero input', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  const original = { ...button.bounds };
  paintOnRead(world, (_window, index) => {
    button.bounds = { ...original, x: original.x + index * 7 };
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'press').message, /still changing between reads/);
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('HAOC-207: a step with no switch before it reads the tree once and does not wait', async t => {
  const { world, run } = harness(t);
  const reads = paintOnRead(world, () => {});

  const report = await run(parseFlowV2({
    version: 2, id: 'no-switch', name: 'No switch',
    appPaths: { [textedit]: appPaths[textedit] },
    steps: [pressContinue],
  }));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']]);
  assert.equal(reads.get('w-21'), 1, 'the step read the window once: no readiness proof ran');
  assert.ok(entry(report, 'press').durationMs < 100,
    `the step did not wait (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207: typing after a switch waits for its field, then types once', async t => {
  const { world, run } = harness(t);
  const fields = notesWindowOf(world).data.tree.children[0].children;
  const field = fields.find(node => node.name === 'notes');
  const reads = paintOnRead(world, (window, index) => {
    const scrollarea = window.data.tree.children[0];
    const present = scrollarea.children.includes(field);
    if (index === 1 && present) {
      scrollarea.children = scrollarea.children.filter(node => node !== field);
    } else if (index > 1 && !present) {
      scrollarea.children = [...scrollarea.children, field];
    }
  });

  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
  }));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'type'), [['type', '@w21:e1', 'draft text']]);
  assert.ok(reads.get('w-21') >= 3, 'the gate waited for the field to appear');
});

test('HAOC-207: a key after a switch waits for the window bounds to hold still', async t => {
  const { world, run } = harness(t);
  const window = notesWindowOf(world);
  const original = { ...window.data.tree.bounds };
  paintOnRead(world, (_window, index) => {
    window.data.tree.bounds = index === 1
      ? { ...original, width: original.width - 40 }
      : { ...original };
  });

  const report = await run(readinessFlow({ id: 'key', kind: 'key', scope: notesScope, key: 'a' }));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'press').map(call => call[1]), ['a']);
  assert.ok(entry(report, 'key').durationMs >= 150, 'the key waited for a stable window');
});

test('HAOC-207: a ready target whose press still fails goes to the click recovery, not the gate', async t => {
  const { world, run } = harness(t, {
    hooks: {
      click(state, ref) {
        if (state.calls.filter(call => call[0] === 'click').length === 1) {
          throw new DesktopFault('ACTION_FAILED', 'click', 'the control rejected AXPress');
        }
      },
    },
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click').map(call => call[1]), ['@w21:e9', '@w21:e9'],
    'the gate delivered nothing extra: the recovery retried the recorded control once');
  assert.match(entry(report, 'press').message, /retried once against a re-read snapshot/);
});

// HAOC-207 review (HAOC-209): the seven failure scenarios the reviewer
// reproduced against head 463a143, plus the evidence the proof must expose.

/** A Finder window with a tree the test spells out. */
function finderWindow(id, title, children) {
  return {
    id, app: finderApp, pid: 700, title,
    data: {
      complete: true,
      window: { id, title },
      tree: { role: 'window', name: title, bounds: { x: 100, y: 100, width: 800, height: 600 }, children },
    },
  };
}

/** A raised Finder window, then one step in a window with the recorded title. */
function finderReadinessFlow(step, windowTitle = 'cuekeeper-demo') {
  return parseFlowV2({
    version: 2,
    id: 'finder-readiness',
    name: 'Finder readiness',
    appPaths: { [finderApp]: finderPath },
    steps: [
      { id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: finderApp } },
      { ...step, scope: { kind: 'window', app: finderApp, windowKey: 'finder', windowTitle } },
    ],
  });
}

/** Records when the driver read a window, so a test can measure the proof's interval. */
function timeSnapshots(world, windowId) {
  const times = [];
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async id => {
    const snapshot = await real(id);
    if (id === windowId) times.push(performance.now());
    return snapshot;
  };
  return times;
}

const finderClick = {
  id: 'press', kind: 'click', count: 1,
  scope: notesScope,
  target: { kind: 'element', role: 'button', name: 'Continue' },
};

test('HAOC-207 review: two agreeing reads land 150–250 ms apart and the press uses the newest read', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  paintOnRead(world, (_window, index) => {
    // The window repaints the control under a new reference after the first read.
    if (index >= 2) button.ref_id = '@w21:e90';
  });
  const times = timeSnapshots(world, 'w-21');

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e90']],
    'the press used the reference of the snapshot the proof accepted');
  assert.ok(times.length >= 2, `the proof read the window at least twice (${times.length})`);
  const interval = times[1] - times[0];
  assert.ok(interval >= 150 && interval <= 300,
    `the agreeing reads were ${Math.round(interval)} ms apart, inside the 150–250 ms probe interval`);
});

test('HAOC-207 review: a snapshot that lands after the deadline is refused and never pressed', async t => {
  const { world, run } = harness(t);
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let reads = 0;
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-21') {
      reads += 1;
      if (reads === 2) await new Promise(resolve => setTimeout(resolve, 2050));
    }
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.deepEqual(callsOf(world, 'click'), [], 'a late read is not evidence and delivers nothing');
  assert.ok(entry(report, 'press').durationMs < 2600,
    `the step stopped at its deadline instead of using the late read (${entry(report, 'press').durationMs} ms)`);
});

test('HAOC-207 review: the proof never prepares a window — Finder sidebar clicks stay at zero', async t => {
  const { world, run } = finderWorld(t, {
    windows: [
      finderWindow('w-90', 'Documents', [{
        role: 'outline', bounds: { x: 110, y: 130, width: 200, height: 400 }, children: [{
          role: 'treeitem', name: 'cuekeeper-demo', ref_id: '@w90:e1',
          bounds: { x: 120, y: 150, width: 180, height: 22 }, states: [],
        }],
      }]),
      finderWindow('w-91', 'Downloads', []),
    ],
    focused: 'w-90',
  });

  const report = await run(finderReadinessFlow(finderClick));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.deepEqual(callsOf(world, 'click'), [], 'the readiness proof is read-only: no sidebar press');
});

test('HAOC-207 review: a read that turns disabled is re-evidenced instead of reused', async t => {
  const { world, run } = harness(t);
  const button = continueButtonOf(world);
  // The first read sees an enabled control; every later read sees it disabled.
  // The enabled read is stale, so the press must never be sent.
  paintOnRead(world, (_window, index) => {
    button.states = index === 1 ? [] : ['disabled'];
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'press').message, /is still disabled/);
  assert.deepEqual(callsOf(world, 'click'), [], 'the snapshot the press would use shows disabled, so nothing is sent');
});

test('HAOC-207 review: a target only the name/value fallback can prove still clicks after a switch', async t => {
  // Finder's list view names a file in the value of a textfield while the
  // recording addresses it as a row; dispatch resolves it through the fallback,
  // so the proof has to accept it too instead of reporting TARGET_NOT_READY.
  const { world, run } = finderWorld(t, {
    windows: [finderWindow('w-99', 'cuekeeper-demo', [{
      role: 'outline', bounds: { x: 110, y: 130, width: 780, height: 500 }, children: [{
        role: 'row', ref_id: '@w99:e1', bounds: { x: 110, y: 140, width: 780, height: 24 },
        children: [{
          role: 'textfield', value: 'manifest.json', ref_id: '@w99:e2',
          available_actions: ['Press'],
          bounds: { x: 140, y: 142, width: 200, height: 20 }, states: [],
        }],
      }],
    }])],
    focused: 'w-99',
  });

  const report = await run(finderReadinessFlow({
    id: 'open-file', kind: 'click',
    target: { kind: 'element', role: 'row', name: 'manifest.json' },
  }));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w99:e2']]);
});

test('HAOC-207 review: a step with no element target needs real window bounds before it types', async t => {
  const { world, run } = harness(t);
  const window = notesWindowOf(world);
  paintOnRead(world, () => { delete window.data.tree.bounds; });

  const report = await run(readinessFlow({ id: 'key', kind: 'key', scope: notesScope, key: 'a' }));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'key').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'key').message, /no bounds/);
  assert.deepEqual(callsOf(world, 'press'), [], 'a window without bounds proves nothing, so no key is posted');
});

test('HAOC-207 review: an unreadable same-title candidate is retried inside the budget, not called ambiguous', async t => {
  const { world, run } = harness(t, {
    windows: [
      windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
      windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] }),
    ],
    focused: 'w-21',
  });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let tries = 0;
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-22') {
      tries += 1;
      if (tries === 1) throw new Fault('INCOMPLETE_TREE', 'the accessibility tree was still being built');
    }
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']]);
  assert.ok(tries >= 2,
    `the unreadable candidate was read again instead of ending the step as ambiguous (${tries})`);
});

test('HAOC-207 review: secure input that starts during the wait stops the first key', async t => {
  const { world, run } = harness(t);
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let secure = false;
  let reads = 0;
  world.desktop.snapshotWindow = async id => {
    const snapshot = await real(id);
    if (id === 'w-21') {
      reads += 1;
      if (reads === 1) secure = true;
    }
    return snapshot;
  };

  const report = await run(
    readinessFlow({ id: 'key', kind: 'key', scope: notesScope, key: 'a' }),
    { secureInputActive: async () => secure },
  );

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'key').code, 'SECURE_INPUT');
  assert.deepEqual(callsOf(world, 'press'), [], 'the secure gate that ran before the wait is re-checked after it');
});

test('HAOC-207 review: a wait or hover keeps its declared focusAfter and still leaves the next press gated', async t => {
  const withWait = harness(t);
  const waitReport = await withWait.run(parseFlowV2({
    version: 2, id: 'wait-handoff', name: 'Wait hand-off', appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      { id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit } },
      {
        id: 'observe', kind: 'wait', scope: notesScope, focusAfter: draftScope,
        check: { kind: 'window_exists', equals: true }, timeoutMs: 5000,
      },
      pressContinue,
    ],
  }));
  assert.equal(waitReport.status, 'passed', JSON.stringify(waitReport.entries));
  assert.deepEqual(callsOf(withWait.world, 'focusWindow').map(call => call[1]), [],
    'a wait takes no focus, so its declared focusAfter is ignored');
  const waitReads = withWait.world.state.calls.filter(call => call[0] === 'snapshotWindow' && call[1] === 'w-21').length;
  assert.equal(waitReads, 2,
    'the wait did not consume the switch: the following press paid its two-read proof');

  const withHover = harness(t);
  const hoverReport = await withHover.run(parseFlowV2({
    version: 2, id: 'hover-handoff', name: 'Hover hand-off', appPaths: { [textedit]: appPaths[textedit] },
    steps: [
      { id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit } },
      {
        id: 'peek', kind: 'hover', scope: notesScope, focusAfter: draftScope,
        target: { kind: 'element', role: 'button', name: 'Continue' }, durationMs: 0,
      },
      pressContinue,
    ],
  }));
  assert.equal(hoverReport.status, 'passed', JSON.stringify(hoverReport.entries));
  assert.deepEqual(callsOf(withHover.world, 'focusWindow').map(call => call[1]), [],
    'a hover takes no focus, so its declared focusAfter is ignored');
  const hoverReads = withHover.world.state.calls.filter(call => call[0] === 'snapshotWindow' && call[1] === 'w-21').length;
  assert.equal(hoverReads, 3,
    'the hover read once and did not consume the switch: the press paid its two-read proof');
});

// HAOC-207 second review round (HAOC-209): deadline over a hung driver call,
// the targets the two dispatch paths really choose, window identity across a
// rebind, and same-titled selection that keeps missing, ambiguous and driver
// failures apart.

test('HAOC-207 review 2: a snapshot that never answers stops the step at its deadline', async t => {
  const { world, run } = harness(t);
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let reads = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-21') {
      reads += 1;
      if (reads === 2) await held;
    }
    return real(id);
  };

  const started = performance.now();
  const report = await run(readinessFlow(pressContinue));
  const elapsed = performance.now() - started;

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.ok(elapsed < 2700,
    `the deadline ended the wait while the read was still hanging (${Math.round(elapsed)} ms)`);
  assert.deepEqual(callsOf(world, 'click'), [], 'a hanging read proves nothing and delivers nothing');

  // The driver call is still in flight; releasing it later must not turn into input.
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(callsOf(world, 'click'), [], 'the late result of the released read is dropped');
});

test('HAOC-207 review 2: a right click proves the row its dispatch would press', async t => {
  const { world, run } = finderWorld(t, {
    windows: [finderWindow('w-99', 'cuekeeper-demo', [{
      role: 'outline', name: 'Files', bounds: { x: 110, y: 130, width: 780, height: 500 }, children: [{
        role: 'row', name: 'report.txt', ref_id: '@w99:e1', available_actions: ['RightClick'],
        states: ['selected', 'disabled'],
        bounds: { x: 120, y: 140, width: 400, height: 24 },
      }],
    }])],
    focused: 'w-99',
  });

  const report = await run(finderReadinessFlow({
    id: 'context', kind: 'click', button: 'right',
    target: { kind: 'element', role: 'outline', name: 'Files' },
  }));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'context').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'context').message, /row "report\.txt" is still disabled/);
  assert.deepEqual(callsOf(world, 'click'), [], 'the disabled row the right click would target is never pressed');
});

test('HAOC-207 review 2: a type step proves the field it would really type into', async t => {
  const { world, run } = harness(t, {
    windows: [{
      id: 'w-21', app: textedit, pid: 601, title: 'QA Notes',
      data: {
        complete: true,
        window: { id: 'w-21', title: 'QA Notes' },
        tree: {
          role: 'window', name: 'QA Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
          children: [{
            role: 'textfield', name: 'rename', ref_id: '@w21:e1', states: ['focused', 'disabled'],
            bounds: { x: 120, y: 150, width: 600, height: 40 },
          }],
        },
      },
    }],
    focused: 'w-21',
  });

  // An unnamed target is resolved by the text path's own focus heuristics; the
  // proof has to see the same field, disabled, and refuse to type into it.
  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: '' }, input: 'note',
  }));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'type').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'type').message, /is still disabled/);
  assert.deepEqual(callsOf(world, 'type'), []);
  assert.deepEqual(callsOf(world, 'typeFocused'), []);
});

test('HAOC-207 review 2: a window replaced mid-proof starts the two reads over', async t => {
  const { world, run } = harness(t);
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  const order = [];
  world.desktop.snapshotWindow = async id => {
    order.push(id);
    const snapshot = await real(id);
    if (id === 'w-21') {
      // The recorded window is replaced by a same-titled one between reads.
      world.state.windows = world.state.windows.filter(window => window.id !== 'w-21');
      if (!world.state.windows.some(window => window.id === 'w-23')) {
        world.state.windows.push(windowRecord({
          id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w23:e1']],
        }));
      }
      world.state.focused = 'w-23';
    }
    return snapshot;
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(order.slice(0, 3), ['w-21', 'w-23', 'w-23'],
    'the old window does not count toward the two agreeing reads of the new one');
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w23:e9']], 'the new window\'s control is pressed once');
});

test('HAOC-207 review 2: a same-titled window that holds the target only on the second round still clicks', async t => {
  const draft = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  // Only the window the flow was recorded in has the recorded control.
  draft.data.tree.children = draft.data.tree.children.filter(child => child.name !== 'Continue');
  const { world, run } = harness(t, {
    windows: [
      windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
      draft,
    ],
    focused: 'w-22',
  });
  const button = continueButtonOf(world);
  paintOnRead(world, (window, index) => {
    if (window.id !== 'w-21') return;
    const present = window.data.tree.children.includes(button);
    if (index === 1 && present) {
      window.data.tree.children = window.data.tree.children.filter(child => child !== button);
    } else if (index > 1 && !present) {
      window.data.tree.children = [...window.data.tree.children, button];
    }
  });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']],
    'neither window held the target on the first round; the second round proved one and pressed it once');
});

test('HAOC-207 review 2: a driver dependency failure while choosing keeps its own code', async t => {
  const { world, run } = harness(t, {
    windows: [
      windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
      windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] }),
    ],
    focused: 'w-21',
  });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let tries = 0;
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-22') {
      tries += 1;
      throw new DesktopFault('DESKTOP_DEPENDENCY', 'snapshot');
    }
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(entry(report, 'press').code, 'DESKTOP_DEPENDENCY',
    'a driver failure is not a readiness wait and must not be retried into TARGET_NOT_READY');
  assert.equal(tries, 1, 'the failing read was not retried');
  assert.deepEqual(callsOf(world, 'click'), []);
});

// HAOC-207 third review round (HAOC-209): a late read must not start a focus
// command, a control-level secure refusal must stop the dispatch, and the text
// target must be unique before any characters are sent.

/** A textedit window whose tree a test spells out. */
function notesWindowTree(children) {
  return {
    id: 'w-21', app: textedit, pid: 601, title: 'QA Notes',
    data: {
      complete: true,
      window: { id: 'w-21', title: 'QA Notes' },
      tree: { role: 'window', name: 'QA Notes', bounds: { x: 100, y: 100, width: 800, height: 600 }, children },
    },
  };
}


test('HAOC-207 review 3: a foreground read released after the deadline starts no focus command', async t => {
  const { world, run } = harness(t);
  const realFocused = world.desktop.focusedWindow.bind(world.desktop);
  let reads = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  world.desktop.focusedWindow = async () => {
    reads += 1;
    // The proof's own foreground observation hangs; the run has to end anyway.
    if (reads === 2) await held;
    return realFocused();
  };

  const started = performance.now();
  const report = await run(readinessFlow({
    id: 'press', kind: 'click', scope: draftScope,
    target: { kind: 'element', role: 'button', name: 'Continue' },
  }));
  const elapsed = performance.now() - started;

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.ok(elapsed < 2700, `the step ended at its deadline (${Math.round(elapsed)} ms)`);
  assert.deepEqual(callsOf(world, 'focusWindow'), [], 'nothing is focused while the proof is unfinished');

  // The observation the deadline gave up on lands now; it must not become a
  // focus command, and the foreground must not switch.
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(callsOf(world, 'focusWindow'), [], 'the late foreground read started no focus command');
  assert.equal(world.state.focused, 'w-21', 'the foreground never changed after the run ended');
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('HAOC-207 review 3: a secure focused field is refused before any characters are sent', async t => {
  const { world, run } = harness(t, {
    windows: [notesWindowTree([{
      role: 'textfield', name: 'password', ref_id: '@w21:e1', secure: true, states: ['focused'],
      bounds: { x: 120, y: 150, width: 600, height: 40 },
    }])],
    focused: 'w-21',
  });

  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: '' }, input: 'note',
  }));

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'type').code, 'UNSAFE_TARGET');
  assert.match(entry(report, 'type').message, /secure control/);
  assert.deepEqual(callsOf(world, 'type'), [], 'no characters reach a secure field');
  assert.deepEqual(callsOf(world, 'typeFocused'), [], 'no characters reach the first responder either');
  assert.deepEqual(callsOf(world, 'click'), [], 'the field is not clicked for focus first');
});

test('HAOC-207 review 3: a text target that is momentarily ambiguous is re-read and typed once', async t => {
  const twin = {
    role: 'textfield', name: 'notes', ref_id: '@w21:e2', states: [],
    bounds: { x: 120, y: 200, width: 600, height: 40 },
  };
  const { world, run } = harness(t, {
    windows: [notesWindowTree([
      {
        role: 'textfield', name: 'notes', ref_id: '@w21:e1', states: [],
        bounds: { x: 120, y: 150, width: 600, height: 40 },
      },
      twin,
    ])],
    focused: 'w-21',
  });
  paintOnRead(world, (window, index) => {
    // The twin is there for the first read and gone from the second on.
    if (index >= 2 && window.data.tree.children.includes(twin)) {
      window.data.tree.children = window.data.tree.children.filter(child => child !== twin);
    }
  });

  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
  }));

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'type'), [['type', '@w21:e1', 'draft text']],
    'the single remaining field is typed into exactly once');
});

test('HAOC-207 review 3: two controls that keep claiming focus are never typed into', async t => {
  const { world, run } = harness(t, {
    windows: [notesWindowTree([
      {
        role: 'textfield', ref_id: '@w21:e1', states: ['focused'],
        bounds: { x: 120, y: 150, width: 600, height: 40 },
      },
      {
        role: 'textfield', ref_id: '@w21:e2', states: ['focused'],
        bounds: { x: 120, y: 220, width: 600, height: 40 },
      },
    ])],
    focused: 'w-21',
  });

  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: '' }, input: 'note',
  }));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'type').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'type').message, /2 editable controls reported focus/);
  assert.deepEqual(callsOf(world, 'type'), []);
  assert.deepEqual(callsOf(world, 'typeFocused'), []);
});

// HAOC-207 fourth review round (HAOC-209): a foreground switch during the
// proof, a secure focused host, and rename-field candidates that cannot be told
// apart.

test('HAOC-207 review 4: the operator taking the foreground during the proof sends no input', async t => {
  const { world, run } = harness(t);
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let reads = 0;
  world.desktop.snapshotWindow = async id => {
    const snapshot = await real(id);
    if (id === 'w-21') {
      reads += 1;
      // Between the two reads the operator switches to the draft window.
      if (reads === 1) world.state.focused = 'w-22';
    }
    return snapshot;
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'press').code, 'FOCUS_INTERRUPTED');
  assert.deepEqual(callsOf(world, 'click'), [], 'the press is not delivered into a window the run lost');
  assert.deepEqual(callsOf(world, 'focusWindow'), [], 'the run does not take the foreground back');
});

test('HAOC-207 review 4: a secure focused host is refused before the text dispatch', async t => {
  const { world, run } = harness(t, {
    windows: [notesWindowTree([{
      role: 'row', name: 'report.txt', ref_id: '@w21:e1', secure: true, states: ['focused'],
      bounds: { x: 120, y: 150, width: 400, height: 24 },
    }])],
    focused: 'w-21',
  });

  const report = await run(readinessFlow({
    id: 'type', kind: 'type', scope: notesScope,
    target: { kind: 'element', role: 'textfield', name: '' }, input: 'note',
  }));

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'type').code, 'UNSAFE_TARGET');
  assert.match(entry(report, 'type').message, /secure control/);
  assert.deepEqual(callsOf(world, 'typeFocused'), [], 'no characters reach the secure host');
  assert.deepEqual(callsOf(world, 'type'), []);
  assert.deepEqual(callsOf(world, 'click'), [], 'the host is not clicked first either');
});

test('HAOC-207 review 4: two rename fields the same distance away are never typed into', async t => {
  const { world, run } = harness(t, {
    windows: [notesWindowTree([
      {
        role: 'textfield', ref_id: '@w21:e1', states: [],
        // 40 pt above the anchor's centre, which sits at (180, 516).
        bounds: { x: 120, y: 456, width: 120, height: 40 },
      },
      {
        role: 'textfield', ref_id: '@w21:e2', states: [],
        // 40 pt below it: the two are equally close and cannot be told apart.
        bounds: { x: 120, y: 536, width: 120, height: 40 },
      },
      {
        role: 'button', name: 'Continue', ref_id: '@w21:e9', states: [],
        bounds: { x: 120, y: 500, width: 120, height: 32 },
      },
    ])],
    focused: 'w-21',
  });

  const report = await run(parseFlowV2({
    version: 2, id: 'rename-tie', name: 'Rename tie',
    appPaths: { [textedit]: appPaths[textedit] },
    inputs: ['note'],
    steps: [
      // The click anchors the text step to a point between two equal fields.
      { id: 'anchor', kind: 'click', scope: notesScope, target: { kind: 'element', role: 'button', name: 'Continue' } },
      { id: 'activate', kind: 'activate_app', scope: { kind: 'app', app: textedit } },
      {
        id: 'type', kind: 'type', scope: notesScope,
        target: { kind: 'element', role: 'textfield', name: '' }, input: 'note',
      },
    ],
  }));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'type').code, 'TARGET_NOT_READY');
  assert.match(entry(report, 'type').message, /equally close/);
  assert.deepEqual(callsOf(world, 'click').map(call => call[1]), ['@w21:e9'], 'only the anchor was clicked');
  assert.deepEqual(callsOf(world, 'type'), [], 'neither field receives characters');
  assert.deepEqual(callsOf(world, 'typeFocused'), []);
});

// HAOC-219: two windows can carry one recorded title ("下载"), and the target
// may live in only one of them. Choosing between them reads both trees before
// any window is focused — work that is not the stability proof, which stays
// short — and a proof that runs out names every window it read and what each
// one lacked instead of reporting a bare "0 reads".

/** One window record, with the `Continue` control removed from its tree. */
function withoutContinue(window) {
  window.data.tree.children = window.data.tree.children.filter(child => child.name !== 'Continue');
  return window;
}

/** Makes the first read of each window slow, as a folder full of files answers. */
function slowFirstRead(world, delayMs) {
  const seen = new Set();
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async id => {
    if (!seen.has(id)) {
      seen.add(id);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return real(id);
  };
}

test('HAOC-219: a slow same-title choice still finds the window holding the target and presses once', async t => {
  // The operator's foreground is the twin; the recorded control is only in w-21.
  const holder = windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] });
  const twin = withoutContinue(
    windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] }),
  );
  // The app's first window is the twin, so activating it leaves the twin in
  // front — the window that does not hold the recorded control.
  const { world, run } = harness(t, { windows: [twin, holder], focused: 'w-22' });
  // Reading the two candidates and focusing the proved one together outlast the
  // 1500 ms stability proof; on its own that is not a reason to stop.
  slowFirstRead(world, 700);
  const realFocus = world.desktop.focusWindow.bind(world.desktop);
  world.desktop.focusWindow = async windowId => {
    await new Promise(resolve => setTimeout(resolve, 200));
    return realFocus(windowId);
  };

  const started = performance.now();
  const report = await run(readinessFlow(pressContinue));
  const elapsed = performance.now() - started;

  assert.equal(report.status, 'passed', JSON.stringify(report.entries));
  assert.deepEqual(callsOf(world, 'click'), [['click', '@w21:e9']],
    'one press, delivered to the window that held the target');
  assert.deepEqual(callsOf(world, 'focusWindow').map(call => call[1]), ['w-21'],
    'the proved window is the one brought forward, not the one that happened to be in front');
  assert.ok(callsOf(world, 'snapshotWindow').some(call => call[1] === 'w-22'),
    'the twin was read while choosing the window');
  assert.match(entry(report, 'press').message, /the one that held its target/);
  assert.ok(elapsed >= 1500,
    `choosing and focusing took longer than the old proof (${Math.round(elapsed)} ms), so the old deadline is the regression`);
});

test('HAOC-219: when no same-title window holds the target the error names each window and sends nothing', async t => {
  // Neither window holds the recorded control (a nosy sibling opened beside it).
  const first = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const twin = withoutContinue(
    windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] }),
  );
  const { world, run } = harness(t, { windows: [first, twin], focused: 'w-21' });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'TARGET_NOT_READY');
  assert.match(failed.message, /2 same-title windows read/);
  assert.match(failed.message, /w-21 "QA Notes" \(\d+ reads?\): no button "Continue"/);
  assert.match(failed.message, /w-22 "QA Notes" \(\d+ reads?\): no button "Continue"/);
  assert.match(failed.message, /0 reads of the bound window/);
  assert.doesNotMatch(failed.message, /the window has not been read yet/,
    'the proof says which windows it read instead of reporting that nothing was read');
  assert.deepEqual(callsOf(world, 'click'), [], 'no window is guessed: zero input');
  assert.deepEqual(callsOf(world, 'focusWindow'), [],
    'no window is brought forward for a target none of them holds');
});

test('HAOC-219: an unreadable same-title candidate is named in the diagnostic', async t => {
  const first = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const unreadable = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  const { world, run } = harness(t, { windows: [first, unreadable], focused: 'w-22' });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-22') throw new Fault('INCOMPLETE_TREE', 'the accessibility tree was still being built');
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'TARGET_NOT_READY');
  assert.match(failed.message, /w-22 "QA Notes" \(\d+ reads?\): read failed \(INCOMPLETE_TREE\)/,
    'the window that could not be read is reported with its own code');
  assert.match(failed.message, /w-21 "QA Notes" \(\d+ reads?\): no button "Continue"/);
  assert.deepEqual(callsOf(world, 'click'), [], 'an unreadable window is never guessed at');
});

test('HAOC-219: two same-title windows that both hold the target are refused, naming both', async t => {
  // One folder open twice: the target is in both, and the operator's front
  // window is a third same-titled window that has it in neither. Nothing tells
  // the two holders apart, so the gate must refuse instead of picking one.
  const front = withoutContinue(
    windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['scratch', '@w23:e1']] }),
  );
  const first = windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] });
  const second = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  // Activation raises the app's first window, which is the one without the target.
  const { world, run } = harness(t, { windows: [front, first, second], focused: 'w-23' });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'blocked', 'an ambiguity is a refusal of the run, not a failed delivery');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'AMBIGUOUS_TARGET');
  assert.match(failed.message, /3 same-title windows read/);
  assert.match(failed.message, /w-21 "QA Notes" \(\d+ reads?\): held button "Continue"/);
  assert.match(failed.message, /w-22 "QA Notes" \(\d+ reads?\): held button "Continue"/);
  assert.match(failed.message, /w-23 "QA Notes" \(\d+ reads?\): no button "Continue"/);
  assert.deepEqual(callsOf(world, 'click'), [], 'neither identical window is guessed at');
});

// HAOC-222 review: the two phases must hold their own monotonic deadline even
// when a driver call blocks the event loop so its timer cannot run, in-flight
// reads must be named, and the two ambiguity reasons must not be confused.

test('HAOC-222 review: a candidate that answers after the selection deadline is refused before any focus', async t => {
  // The twin is read slowly and does not hold the target; w-22 blocks the whole
  // event loop for 3100 ms and then answers that it holds the control. The
  // proof's own timer cannot run inside the block, so only a deadline check on
  // the evidence itself can keep the late answer out.
  const twin = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const holder = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  const { world, run } = harness(t, { windows: [holder, twin], focused: 'w-22' });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let blocked = false;
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-22' && !blocked) {
      blocked = true;
      // Block the loop without spinning the CPU: the proof's timer cannot run,
      // so only a deadline check on the evidence itself can refuse it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3100);
    }
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'TARGET_NOT_READY');
  assert.match(failed.message, /while its window was being chosen/);
  assert.deepEqual(callsOf(world, 'focusWindow'), [],
    'a window choice that landed after its deadline is not brought forward');
  assert.deepEqual(callsOf(world, 'click'), [], 'no late evidence becomes input');
});

test('HAOC-222 review: a candidate read that never answers is named and stops further reads', async t => {
  const hanging = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const twin = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  const { world, run } = harness(t, { windows: [hanging, twin], focused: 'w-22' });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  world.desktop.snapshotWindow = async id => {
    if (id === 'w-21') {
      await held;
    }
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'TARGET_NOT_READY');
  assert.match(failed.message, /w-21 "QA Notes" \(1 read\): the read had not answered/,
    'the window whose read never answered is named, with its attempt count');
  assert.doesNotMatch(failed.message, /the window has not been read yet/);
  assert.deepEqual(callsOf(world, 'click'), []);
  assert.deepEqual(callsOf(world, 'focusWindow'), []);

  // The released read must not become the reason to start the next candidate.
  const readsOf = () => callsOf(world, 'snapshotWindow').map(call => call[1]);
  assert.deepEqual(readsOf(), [], 'the hanging read is not even recorded as an answered read');
  release();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!readsOf().includes('w-22'),
    'after the deadline no further candidate read is started');
});

test('HAOC-222 review: one holder plus one ambiguous window is reported as ambiguity, not as several holders', async t => {
  // w-21 addresses the control exactly once; w-22 has two controls under the
  // recorded name; w-23 lacks it. The recorded window could be the ambiguous one,
  // so the choice is refused — and the message must say why, not claim two
  // windows hold the control.
  const holder = windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] });
  const ambiguous = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  ambiguous.data.tree.children = [
    ...ambiguous.data.tree.children.filter(child => child.role !== 'button'),
    { role: 'button', name: 'Continue', ref_id: '@w22:e8', states: [], bounds: { x: 120, y: 480, width: 120, height: 32 } },
    { role: 'button', name: 'Continue', ref_id: '@w22:e9', states: [], bounds: { x: 260, y: 480, width: 120, height: 32 } },
  ];
  const bare = withoutContinue(
    windowRecord({ id: 'w-23', app: textedit, pid: 601, title: 'QA Notes', fields: [['scratch', '@w23:e1']] }),
  );
  const { world, run } = harness(t, { windows: [holder, ambiguous, bare], focused: 'w-21' });

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'blocked');
  const failed = entry(report, 'press');
  assert.equal(failed.code, 'AMBIGUOUS_TARGET');
  assert.match(failed.message, /w-22 "QA Notes" cannot prove button "Continue"/,
    'the window whose own tree is ambiguous is named as such');
  assert.doesNotMatch(failed.message, /More than one window titled "QA Notes" holds/,
    'a single holder plus an ambiguous sibling is not "several windows hold it"');
  assert.match(failed.message, /w-21 "QA Notes" \(\d+ reads?\): held button "Continue"/);
  assert.match(failed.message, /w-23 "QA Notes" \(\d+ reads?\): no button "Continue"/,
    'the window after the ambiguous one is still read, so the message is complete');
  assert.deepEqual(callsOf(world, 'click'), [], 'an ambiguous choice sends no input');
});

// HAOC-222 second review: the deadline must be checked at the real side effect
// and at every driver read, not only where the proof happens to look next.

/** Blocks the event loop for `ms` without spinning the CPU. */
function blockLoop(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('HAOC-222 review 2: the first candidate read that lands late starts no second read', async t => {
  const twin = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const holder = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  const { world, run } = harness(t, { windows: [twin, holder], focused: 'w-21' });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async id => {
    // w-21 answers only after the selection deadline, with its timer unable to run.
    if (id === 'w-21') blockLoop(3100);
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY');
  assert.ok(!callsOf(world, 'snapshotWindow').some(call => call[1] === 'w-22'),
    'the late first read is not a reason to start reading the next candidate');
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.deepEqual(callsOf(world, 'click'), []);
});

test('HAOC-222 review 2: the last candidate read that lands late cannot decide the ambiguity', async t => {
  const twin = withoutContinue(
    windowRecord({ id: 'w-21', app: textedit, pid: 601, title: 'QA Notes', fields: [['notes', '@w21:e1']] }),
  );
  const ambiguous = windowRecord({ id: 'w-22', app: textedit, pid: 601, title: 'QA Notes', fields: [['draft', '@w22:e1']] });
  ambiguous.data.tree.children = [
    ...ambiguous.data.tree.children.filter(child => child.role !== 'button'),
    { role: 'button', name: 'Continue', ref_id: '@w22:e8', states: [], bounds: { x: 120, y: 480, width: 120, height: 32 } },
    { role: 'button', name: 'Continue', ref_id: '@w22:e9', states: [], bounds: { x: 260, y: 480, width: 120, height: 32 } },
  ];
  const { world, run } = harness(t, { windows: [twin, ambiguous], focused: 'w-21' });
  const real = world.desktop.snapshotWindow.bind(world.desktop);
  world.desktop.snapshotWindow = async id => {
    // The last candidate answers ambiguous, but only after the deadline.
    if (id === 'w-22') blockLoop(3100);
    return real(id);
  };

  const report = await run(readinessFlow(pressContinue));

  assert.equal(report.status, 'failed');
  assert.equal(entry(report, 'press').code, 'TARGET_NOT_READY',
    'a late read is a deadline failure, not evidence that the choice was ambiguous');
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
  assert.deepEqual(callsOf(world, 'click'), [], 'zero input either way');
});
