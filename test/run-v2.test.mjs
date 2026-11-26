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
      return delivered('click');
    },
    async clickPoint(_snapshot, _target, point, { count = 1 } = {}) {
      // The real driver refuses physical coordinate input without --headed,
      // before it posts any event.
      if (!options.headed) {
        throw new Fault('HEADED_REQUIRED', 'Physical coordinate input requires --headed');
      }
      state.calls.push(['clickPoint', point, count]);
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
    async hoverAt(_snapshot, _target, point) {
      state.calls.push(['hoverAt', point]);
      return delivered('hover');
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
