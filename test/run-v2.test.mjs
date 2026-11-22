import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppIdentitySession } from '../dist/app-identity.js';
import { reportV2Check } from '../dist/contracts-v2.js';
import { DesktopFault } from '../dist/desktop.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { Fault, parseSnapshot } from '../dist/locator.js';
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
    async type(ref, text) {
      state.calls.push(['type', ref, text]);
      state.hooks.beforeType?.(state);
      return delivered('type');
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

function identityFactory(world, readBundleId = {}) {
  const sessions = new Map();
  const pathToBundle = Object.fromEntries(Object.entries(appPaths).map(([app, path]) => [path, app]));
  return app => {
    let session = sessions.get(app);
    if (!session) {
      session = new AppIdentitySession(
        { app, window: '', appPath: appPaths[app] },
        {
          platform: 'darwin',
          probe: world.probe,
          realpath: async path => path,
          stat: async () => ({ isDirectory: () => true }),
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
    identityFor: identityFactory(world, overrides.readBundleId ?? options.readBundleId),
    leaseDirectory: dir,
    inputs: overrides.inputs ?? inputs,
    ...((overrides.launchTimeoutMs ?? options.launchTimeoutMs) === undefined
      ? {} : { launchTimeoutMs: overrides.launchTimeoutMs ?? options.launchTimeoutMs }),
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

test('two windows with the recorded title stop the first bind as ambiguous', async t => {
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

  assert.equal(report.status, 'blocked');
  assert.equal(entry(report, 'switch-notes').status, 'blocked');
  assert.equal(entry(report, 'switch-notes').code, 'AMBIGUOUS_TARGET');
  assert.equal(entry(report, 'type-note').status, 'skipped');
  // No input is ever guessed into one of the two windows.
  assert.deepEqual(callsOf(world, 'type'), []);
  assert.deepEqual(callsOf(world, 'focusWindow'), []);
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
