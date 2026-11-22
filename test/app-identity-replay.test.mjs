import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppIdentitySession } from '../dist/app-identity.js';
import { offlineDesktop, withDesktop } from '../dist/desktop.js';
import { parseFlow, plan } from '../dist/flow.js';
import { Fault, parseSnapshot } from '../dist/locator.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const signal = new AbortController().signal;
const app = 'com.apple.TextEdit';
const title = 'Cuekeeper-M1.txt';
const baseFlow = example('textedit.flow');
const snapshotFixture = example('textedit.snapshot');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function snapshot(windowId, windowTitle = title) {
  const data = structuredClone(snapshotFixture.data);
  data.window = { id: windowId, title: windowTitle };
  return parseSnapshot(data, { app, window: windowTitle });
}

/** Records every driver interaction so the tests assert the real call shape. */
function fakeDesktop(options = {}) {
  const {
    windows = [{ id: 'w-42', title, processInstance: 501 }],
    snapshots = {}, hooks = {},
  } = options;
  const calls = [];
  const read = windowId => snapshots[windowId] ?? snapshot(windowId);
  return {
    calls,
    windows,
    async snapshot(target, timeoutMs, windowId) {
      calls.push({ call: 'snapshot', args: [target.app, windowId] });
      return read(windowId ?? 'w-42');
    },
    async snapshotWindow(windowId, observedTitle) {
      calls.push({ call: 'snapshotWindow', args: [windowId, observedTitle] });
      const result = read(windowId);
      hooks.snapshotWindow?.();
      return result;
    },
    async listAllWindows() {
      calls.push({ call: 'listAllWindows', args: [] });
      return windows;
    },
    async listWindows(appId) {
      calls.push({ call: 'listWindows', args: [appId] });
      return windows;
    },
    async listApps(appId) {
      calls.push({ call: 'listApps', args: [appId] });
      return { count: windows.length, complete: true };
    },
    async focusWindow(windowId) {
      calls.push({ call: 'focusWindow', args: [windowId] });
      hooks.focusWindow?.();
    },
    async screenshotWindow(windowId) {
      calls.push({ call: 'screenshotWindow', args: [windowId] });
      return png;
    },
    async screenshot(appId, windowId) {
      calls.push({ call: 'screenshot', args: [appId, windowId] });
      return png;
    },
    async property(node, property) {
      calls.push({ call: 'property', args: [node.role, property] });
      return property === 'visible' ? true : node.value ?? node.text ?? node.name ?? '';
    },
    async ensure(action, timeoutMs, windowId) {
      calls.push({ call: 'ensure', args: [action.kind] });
      return action.kind === 'window_ready' ? windowId ?? 'w-42' : undefined;
    },
    async click(ref) {
      calls.push({ call: 'click', args: [ref] });
      hooks.click?.();
      return 'delivered_verified';
    },
    async type(ref, text) {
      calls.push({ call: 'type', args: [ref, text] });
      return 'delivered_verified';
    },
    async press(combo, current) {
      calls.push({ call: 'press', args: [combo, current.windowId] });
      return 'delivered_verified';
    },
    async clickPoint(current, target, point) {
      calls.push({ call: 'clickPoint', args: [point] });
      return 'delivered_verified';
    },
  };
}

/**
 * Injects the process, window and filesystem fixtures. `paths` maps a requested
 * path to its canonical form (or an Error to simulate a broken link); bundle ids
 * default to the flow's bundle id.
 */
function identityFor(target, options = {}) {
  const {
    instances = [], windows = [], opens = [], installed = [],
    platform = 'darwin', paths = {}, bundleIds = {}, onOpen,
  } = options;
  const probeCalls = [];
  const realpathCalls = [];
  const probe = {
    async available() { probeCalls.push(['available']); return options.available !== false; },
    async describe(pid) {
      probeCalls.push(['describe', pid]);
      return instances.find(instance => instance.pid === pid);
    },
    async instances(bundleId) {
      probeCalls.push(['instances', bundleId]);
      return instances.filter(instance => instance.bundleId === bundleId);
    },
    async windows() {
      probeCalls.push(['windows']);
      return windows;
    },
    async validate() { probeCalls.push(['validate']); return undefined; },
    async open(path, activate) {
      probeCalls.push(['open', path, activate]);
      opens.push([path, activate]);
      onOpen?.(path, activate);
    },
  };
  const identity = new AppIdentitySession(target, {
    platform,
    probe,
    realpath: async path => {
      realpathCalls.push(path);
      const mapped = paths[path];
      if (mapped instanceof Error) throw mapped;
      return mapped ?? path;
    },
    stat: async path => {
      if (paths[path] instanceof Error) throw paths[path];
      return { isDirectory: () => true };
    },
    readBundleId: async path => {
      const mapped = paths[path];
      if (mapped instanceof Error) throw mapped;
      return bundleIds[mapped ?? path] ?? bundleIds[path] ?? target.app;
    },
    installed: async () => installed,
    sleep: async () => {},
  });
  return { identity, probeCalls, realpathCalls, opens };
}

function flowFor(target, steps = baseFlow.steps) {
  return parseFlow({ ...baseFlow, target, steps });
}

async function replay(flow, desktop, identity, options = {}) {
  return runFlow(flow, desktop, { dryRun: false, signal, identity, ...options });
}

const pathTarget = appPath => ({ app, window: title, appPath });

test('one installed copy binds by canonical path and keeps the legacy app-scoped route', async () => {
  const requested = '/Users/sheng/应用副本/Link.app';
  const canonical = '/Applications/B 副本.app';
  const { identity, realpathCalls } = identityFor(pathTarget(requested), {
    instances: [{ pid: 501, startedAt: '501.10', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 501, title }],
    paths: { [requested]: canonical, [canonical]: canonical },
  });
  const desktop = fakeDesktop();
  const report = await replay(flowFor(pathTarget(requested)), desktop, identity);

  assert.equal(report.status, 'passed');
  assert.deepEqual(report.appIdentity, { app, mode: 'bundle_path', status: 'verified' });
  assert.equal(identity.canonicalPath, canonical);
  assert.ok(realpathCalls.includes(requested), 'the requested link was resolved');
  assert.deepEqual(desktop.calls.filter(call => call.call === 'snapshotWindow').map(call => call.args[0]),
    ['w-42', 'w-42', 'w-42']);
  assert.equal(desktop.calls.some(call => call.call === 'snapshot'), false, 'path-fixed reads never pass --app');
  assert.deepEqual(desktop.calls.find(call => call.call === 'press').args, ['meta+s', 'w-42']);
  assert.deepEqual(desktop.calls.find(call => call.call === 'click').args, ['@scuekeeper:e1']);

  // Without a path the same single instance keeps the old app-scoped route.
  const legacyDesktop = fakeDesktop();
  const legacy = identityFor({ app, window: title }, {
    instances: [{ pid: 501, startedAt: '501.10', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 501, title }],
  });
  const legacyReport = await replay(flowFor({ app, window: title }), legacyDesktop, legacy.identity);
  assert.equal(legacyReport.status, 'passed');
  assert.deepEqual(legacyReport.appIdentity, { app, mode: 'legacy_bundle_id', status: 'verified' });
  assert.deepEqual(legacyDesktop.calls.filter(call => call.call === 'snapshot').map(call => call.args[0]),
    [app, app, app]);
});

test('with A and B running, selecting B reads and asserts only B', async () => {
  const aPath = '/Applications/A.app';
  const bPath = '/Users/sheng/B apps/B.app';
  const requested = '/Users/sheng/B apps/Link.app';
  const windows = [
    { number: 7, ownerPid: 601, title },
    { number: 8, ownerPid: 602, title },
  ];
  const { identity } = identityFor(pathTarget(requested), {
    instances: [
      { pid: 601, startedAt: '601.1', bundleId: app, bundlePath: aPath },
      { pid: 602, startedAt: '602.1', bundleId: app, bundlePath: bPath },
    ],
    windows,
    paths: { [requested]: bPath, [aPath]: aPath, [bPath]: bPath },
  });
  const desktop = fakeDesktop({
    windows: [
      { id: 'w-7', title, processInstance: 601 },
      { id: 'w-8', title, processInstance: 602 },
    ],
  });
  const steps = [
    ...baseFlow.steps,
    { id: 'assert-window', kind: 'assert', check: {
      target: { kind: 'window', app, window: title }, expect: { property: 'exists', equals: true },
    } },
  ];
  const report = await replay(flowFor(pathTarget(requested), steps), desktop, identity);

  assert.equal(report.status, 'passed');
  assert.deepEqual(report.appIdentity, { app, mode: 'bundle_path', status: 'verified' });
  const snapshotWindows = desktop.calls.filter(call => call.call === 'snapshotWindow').map(call => call.args[0]);
  assert.ok(snapshotWindows.length >= 3);
  assert.ok(snapshotWindows.every(windowId => windowId === 'w-8'), snapshotWindows.join(','));
  assert.equal(desktop.calls.some(call => call.call === 'snapshot'), false);
  assert.equal(desktop.calls.some(call => call.call === 'listWindows'), false,
    'a path-fixed window assertion does not fall back to a bundle-id inventory');
  assert.equal(desktop.calls.find(call => call.call === 'press').args[1], 'w-8');

  // Screenshots for the bound instance carry only the window ID.
  const screenshotDesktop = fakeDesktop({ windows: [{ id: 'w-8', title, processInstance: 602 }] });
  await identity.screenshotWindow(screenshotDesktop, 'w-8');
  assert.deepEqual(screenshotDesktop.calls.at(-1), { call: 'screenshotWindow', args: ['w-8'] });
  assert.equal(screenshotDesktop.calls.some(call => call.call === 'screenshot'), false);
});

async function blockedReport(target, options, steps = baseFlow.steps) {
  const { identity } = identityFor(target, options);
  const desktop = fakeDesktop();
  const report = await replay(flowFor(target, steps), desktop, identity);
  return { report, desktop };
}

test('path mismatch, multiple instances, and unproven paths block before any input', async () => {
  const aPath = '/Applications/A.app';
  const bPath = '/Users/sheng/B.app';
  const requested = pathTarget(bPath);
  const other = (pid, path) => ({ pid, startedAt: `${pid}.1`, bundleId: app, bundlePath: path });

  const cases = [
    {
      name: 'legacy flow with two same-ID instances',
      target: { app, window: title }, options: { instances: [other(601, aPath), other(602, bPath)] },
      reason: 'multiple_instances',
    },
    {
      name: 'only the other copy runs',
      target: requested, options: { instances: [other(601, aPath)] },
      reason: 'path_mismatch',
    },
    {
      name: 'two processes under the selected path',
      target: requested, options: { instances: [other(601, bPath), other(602, bPath)] },
      reason: 'multiple_instances',
    },
    {
      name: 'an instance whose path cannot be proven',
      target: requested,
      options: { instances: [other(602, bPath), { pid: 603, startedAt: '603.1', bundleId: app }] },
      reason: 'identity_unproven',
    },
  ];

  for (const { name, target, options, reason } of cases) {
    const { report, desktop } = await blockedReport(target, {
      ...options, windows: [{ number: 42, ownerPid: 601, title }],
    });
    assert.equal(report.status, 'blocked', name);
    assert.deepEqual(report.appIdentity, {
      app, mode: target.appPath ? 'bundle_path' : 'legacy_bundle_id',
      status: 'blocked', code: 'APP_AMBIGUOUS', reason,
    }, name);
    assert.deepEqual(report.entries.map(entry => entry.status), plan(flowFor(target)).map(() => 'blocked'), name);
    assert.deepEqual(report.entries.map(entry => entry.kind), plan(flowFor(target)).map(step => step.action.kind));
    const input = desktop.calls.filter(call =>
      ['snapshot', 'snapshotWindow', 'click', 'type', 'press', 'focusWindow', 'ensure'].includes(call.call));
    assert.deepEqual(input, [], `${name} touched the desktop: ${JSON.stringify(input)}`);
  }
});

test('broken, replaced, and foreign-platform paths fail closed', async () => {
  const requested = '/Applications/Gone.app';
  const canonical = '/Applications/Gone.app';
  const missing = await blockedReport(pathTarget(requested), {
    paths: { [requested]: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  });
  assert.deepEqual(missing.report.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_PATH_INVALID', reason: 'invalid_bundle_path',
  });

  const replaced = await blockedReport(pathTarget(requested), {
    paths: { [requested]: canonical }, bundleIds: { [canonical]: 'com.example.Other' },
  });
  assert.deepEqual(replaced.report.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_PATH_INVALID', reason: 'bundle_id_mismatch',
  });

  const foreign = await blockedReport(pathTarget('C:\\Apps\\B.app'), {});
  assert.deepEqual(foreign.report.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'UNSUPPORTED_PLATFORM', reason: 'unsupported_path_platform',
  });

  // The same Windows path imports and resolves offline without touching this machine.
  const fixture = structuredClone(snapshotFixture);
  fixture.target.appPath = 'C:\\Apps\\B.app';
  const offline = await runFlow(flowFor(pathTarget('C:\\Apps\\B.app')), offlineDesktop(fixture, { app, window: title }), {
    dryRun: true, signal, offline: true, fixtureAppPath: fixture.target.appPath,
  });
  assert.equal(offline.status, 'passed');
  assert.deepEqual(offline.appIdentity, { app, mode: 'bundle_path', status: 'offline_unverified' });
});

test('only a confirmed ensure launches the exact path and re-reads the instance', async () => {
  const requested = '/Applications/B.app';
  const canonical = '/Applications/B 副本.app';
  const setup = [{
    id: 'ready', name: '启动', state: 'confirmed',
    check: { target: { kind: 'element', role: 'window', name: title }, expect: { property: 'exists', equals: true } },
    ensure: { kind: 'app_running', app },
  }];

  // The confirmed setup launches the canonical path without substitution.
  const launchedInstances = [];
  const launchedWindows = [];
  const launchOpens = [];
  const launched = identityFor(pathTarget(requested), {
    instances: launchedInstances,
    windows: launchedWindows,
    opens: launchOpens,
    paths: { [requested]: canonical, [canonical]: canonical },
    onOpen: () => {
      launchedInstances.push({ pid: 702, startedAt: '702.1', bundleId: app, bundlePath: canonical });
      launchedWindows.push({ number: 42, ownerPid: 702, title });
    },
  });
  const launchedDesktop = fakeDesktop({ windows: [{ id: 'w-42', title, processInstance: 702 }] });
  const launchedFlow = parseFlow({ ...baseFlow, target: pathTarget(requested), setup, steps: [baseFlow.steps[0]] });
  const launchedReport = await replay(launchedFlow, launchedDesktop, launched.identity);
  assert.equal(launchedReport.status, 'passed', JSON.stringify(launchedReport.entries));
  assert.deepEqual(launchOpens, [[canonical, false]]);
  assert.deepEqual(launchedDesktop.calls.filter(call => call.call === 'snapshotWindow').map(call => call.args[0]), ['w-42', 'w-42']);

  // A launch that resolves to another URL blocks without sending the click.
  const wrongInstances = [];
  const wrong = identityFor(pathTarget(requested), {
    instances: wrongInstances,
    windows: [],
    paths: { [requested]: canonical, [canonical]: canonical, '/Applications/Other.app': '/Applications/Other.app' },
    onOpen: () => wrongInstances.push({ pid: 703, startedAt: '703.1', bundleId: app, bundlePath: '/Applications/Other.app' }),
  });
  const wrongDesktop = fakeDesktop({ windows: [{ id: 'w-42', title, processInstance: 703 }] });
  const wrongReport = await replay(parseFlow({ ...baseFlow, target: pathTarget(requested), setup, steps: [baseFlow.steps[0]] }),
    wrongDesktop, wrong.identity);
  assert.equal(wrongReport.status, 'blocked');
  assert.deepEqual(wrongReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'path_mismatch',
    entryId: 'global/setup/ready',
  });
  assert.deepEqual(wrongReport.entries.map(entry => [entry.kind, entry.status, entry.code]),
    [['setup', 'blocked', 'ENSURE_FAILED'], ['click', 'skipped', undefined]]);
  assert.equal(wrongDesktop.calls.some(call => call.call === 'click'), false);
});

test('zero instances stay read-only, and a legacy launch needs one installed candidate', async () => {
  // No ensure: the driver keeps its existing APP_NOT_FOUND, and nothing launches.
  const idle = identityFor(pathTarget('/Applications/B.app'), {
    paths: { '/Applications/B.app': '/Applications/B.app' },
    instances: [],
  });
  const idleDesktop = fakeDesktop();
  const idleReport = await replay(flowFor(pathTarget('/Applications/B.app'), [baseFlow.steps[0]]), idleDesktop, idle.identity);
  assert.equal(idleReport.status, 'failed');
  assert.equal(idleReport.entries[0].code, 'APP_NOT_FOUND');
  assert.deepEqual(idle.opens, []);
  assert.equal(idleDesktop.calls.some(call => call.call === 'click'), false);

  // A read-only `exists: false` window assertion may pass with no instance.
  const absent = identityFor(pathTarget('/Applications/B.app'), {
    paths: { '/Applications/B.app': '/Applications/B.app' },
    instances: [],
  });
  const absentReport = await replay(flowFor(pathTarget('/Applications/B.app'), [{
    id: 'absent', kind: 'assert', check: {
      target: { kind: 'window', app, window: 'Missing' }, expect: { property: 'exists', equals: false },
    },
  }]), fakeDesktop(), absent.identity);
  assert.equal(absentReport.status, 'passed');

  // A legacy flow with several installed copies blocks instead of guessing.
  const ambiguous = identityFor({ app, window: title }, {
    instances: [],
    installed: ['/Applications/A.app', '/Applications/B.app'],
    paths: {
      '/Applications/A.app': '/Applications/A.app',
      '/Applications/B.app': '/Applications/B.app',
    },
  });
  const ambiguousDesktop = fakeDesktop();
  ambiguousDesktop.snapshot = async () => { throw new Fault('WINDOW_NOT_FOUND', 'The target window is not open'); };
  const setup = [{
    id: 'ready', name: '窗口就绪', state: 'confirmed',
    check: { target: { kind: 'element', role: 'window', name: title }, expect: { property: 'exists', equals: true } },
    ensure: { kind: 'window_ready', app, window: title },
  }];
  const ambiguousReport = await replay(parseFlow({ ...baseFlow, target: { app, window: title }, setup, steps: [baseFlow.steps[0]] }),
    ambiguousDesktop, ambiguous.identity);
  assert.equal(ambiguousReport.status, 'blocked');
  assert.deepEqual(ambiguousReport.appIdentity, {
    app, mode: 'legacy_bundle_id', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'multiple_installed_copies',
    entryId: 'global/setup/ready',
  });
  assert.deepEqual(ambiguous.opens, []);
  assert.equal(ambiguousReport.entries[0].repair.code, 'APP_AMBIGUOUS');
});

test('PID reuse, a window changing owner, and an unconfirmed driver stop the run', async () => {
  const requested = '/Applications/B.app';
  const canonical = '/Applications/B.app';
  const instances = [{ pid: 801, startedAt: '801.1', bundleId: app, bundlePath: canonical }];

  const reused = identityFor(pathTarget(requested), {
    instances,
    windows: [{ number: 42, ownerPid: 801, title }],
    paths: { [requested]: canonical },
  });
  const reusedDesktop = fakeDesktop({
    windows: [{ id: 'w-42', title, processInstance: 801 }],
    hooks: { click: () => { instances[0].startedAt = '801.2'; } },
  });
  const reusedReport = await replay(flowFor(pathTarget(requested)), reusedDesktop, reused.identity);
  assert.equal(reusedReport.status, 'blocked');
  assert.deepEqual(reusedReport.entries.map(entry => [entry.kind, entry.status]),
    [['click', 'passed'], ['type', 'blocked'], ['key', 'skipped']],
    JSON.stringify({ entries: reusedReport.entries, identity: reusedReport.appIdentity }));
  assert.deepEqual(reusedReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'instance_changed',
    entryId: 'type-text',
  });
  assert.deepEqual(reusedDesktop.calls.filter(call => call.call === 'type').length, 0);

  const movedNative = [{ number: 42, ownerPid: 802, title }];
  const moved = identityFor(pathTarget(requested), {
    instances: [{ pid: 802, startedAt: '802.1', bundleId: app, bundlePath: canonical }],
    windows: movedNative,
    paths: { [requested]: canonical },
  });
  const movedDesktop = fakeDesktop({
    windows: [{ id: 'w-42', title, processInstance: 802 }],
    hooks: { click: () => { movedNative[0].ownerPid = 999; } },
  });
  const movedReport = await replay(flowFor(pathTarget(requested)), movedDesktop, moved.identity);
  assert.equal(movedReport.status, 'blocked');
  assert.deepEqual(movedReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'instance_changed',
    entryId: 'type-text',
  });

  const unconfirmed = identityFor(pathTarget(requested), {
    instances: [{ pid: 803, startedAt: '803.1', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 803, title }],
    paths: { [requested]: canonical },
  });
  const unconfirmedDesktop = fakeDesktop({ windows: [] });
  const unconfirmedReport = await replay(flowFor(pathTarget(requested)), unconfirmedDesktop, unconfirmed.identity);
  assert.equal(unconfirmedReport.status, 'blocked');
  assert.deepEqual(unconfirmedReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'driver_target_unconfirmed',
    entryId: 'click-body',
  });
  assert.equal(unconfirmedDesktop.calls.some(call => call.call === 'click'), false);

  // A snapshot that comes back as another window keeps the WINDOW_CHANGED code.
  const swapped = identityFor(pathTarget(requested), {
    instances: [{ pid: 804, startedAt: '804.1', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 804, title }],
    paths: { [requested]: canonical },
  });
  const swappedDesktop = fakeDesktop({
    windows: [{ id: 'w-42', title, processInstance: 804 }],
    snapshots: { 'w-42': snapshot('w-99') },
  });
  const swappedReport = await replay(flowFor(pathTarget(requested)), swappedDesktop, swapped.identity);
  assert.equal(swappedReport.status, 'failed');
  assert.equal(swappedReport.entries[0].code, 'WINDOW_CHANGED');
  assert.deepEqual(swappedReport.entries.map(entry => entry.status), ['failed', 'skipped', 'skipped']);
});

test('offline fixtures never claim a live instance and block path conflicts', async () => {
  const fixture = structuredClone(snapshotFixture);
  fixture.target.appPath = '/Applications/B.app';
  const conflicting = await runFlow(flowFor(pathTarget('/Applications/A.app')), offlineDesktop(fixture, { app, window: title }), {
    dryRun: true, signal, offline: true, fixtureAppPath: fixture.target.appPath,
  });
  assert.equal(conflicting.status, 'blocked');
  assert.deepEqual(conflicting.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'APP_AMBIGUOUS', reason: 'fixture_path_mismatch',
  });
  assert.deepEqual(conflicting.entries.map(entry => entry.status), ['blocked', 'blocked', 'blocked']);

  // A path-fixed flow against an older snapshot without a path still resolves.
  const { identity, probeCalls, realpathCalls } = identityFor(pathTarget('/Applications/B.app'), { available: false });
  const report = await runFlow(flowFor(pathTarget('/Applications/B.app')), offlineDesktop(snapshotFixture, { app, window: title }), {
    dryRun: true, signal, offline: true, identity,
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.appIdentity, { app, mode: 'bundle_path', status: 'offline_unverified' });
  assert.deepEqual(probeCalls, []);
  assert.deepEqual(realpathCalls, []);
});

test('duplicate titles, secondary windows, and bare coordinates follow the design table', async () => {
  const requested = '/Applications/B.app';
  const canonical = '/Applications/B.app';
  const twins = identityFor(pathTarget(requested), {
    instances: [{ pid: 901, startedAt: '901.1', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 901, title }, { number: 43, ownerPid: 901, title }],
    paths: { [requested]: canonical },
  });
  const twinDesktop = fakeDesktop({
    windows: [{ id: 'w-42', title, processInstance: 901 }, { id: 'w-43', title, processInstance: 901 }],
  });
  const twinReport = await replay(flowFor(pathTarget(requested), [baseFlow.steps[0]]), twinDesktop, twins.identity);
  assert.equal(twinReport.status, 'failed');
  assert.equal(twinReport.entries[0].code, 'AMBIGUOUS_TARGET');
  assert.equal(twinDesktop.calls.some(call => call.call === 'click'), false);

  // A second window of the same copy is visible to a window assertion.
  const secondary = identityFor(pathTarget(requested), {
    instances: [{ pid: 902, startedAt: '902.1', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 902, title }, { number: 43, ownerPid: 902, title: 'Settings' }],
    paths: { [requested]: canonical },
  });
  const secondaryDesktop = fakeDesktop({
    windows: [{ id: 'w-42', title, processInstance: 902 }, { id: 'w-43', title: 'Settings', processInstance: 902 }],
  });
  const secondaryReport = await replay(flowFor(pathTarget(requested), [{
    id: 'settings', kind: 'assert', check: {
      target: { kind: 'window', app, window: 'Settings' }, expect: { property: 'exists', equals: true },
    },
  }]), secondaryDesktop, secondary.identity);
  assert.equal(secondaryReport.status, 'passed');

  // A global coordinate cannot be bound to one copy, so it stops unfocused.
  const point = identityFor(pathTarget(requested), {
    instances: [{ pid: 903, startedAt: '903.1', bundleId: app, bundlePath: canonical }],
    windows: [{ number: 42, ownerPid: 903, title }],
    paths: { [requested]: canonical },
  });
  const pointDesktop = fakeDesktop({ windows: [{ id: 'w-42', title, processInstance: 903 }] });
  const pointReport = await replay(flowFor(pathTarget(requested), [{
    id: 'point', kind: 'click', target: { kind: 'point', point: [420, 320] },
  }]), pointDesktop, point.identity);
  assert.equal(pointReport.status, 'blocked');
  assert.deepEqual(pointReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'UNSAFE_POINT', reason: 'untargeted_input',
    entryId: 'point',
  });
  assert.equal(pointDesktop.calls.some(call => call.call === 'clickPoint' || call.call === 'focusWindow'), false);

  // A drag with a coordinate endpoint is equally unprovable for one copy.
  const dragReport = await replay(flowFor(pathTarget(requested), [{
    id: 'drag', kind: 'drag', from: { kind: 'point', point: [135, 165] },
    to: { kind: 'element', role: 'textfield' }, durationMs: 200,
  }]), pointDesktop, point.identity);
  assert.equal(dragReport.status, 'blocked');
  assert.deepEqual(dragReport.appIdentity, {
    app, mode: 'bundle_path', status: 'blocked', code: 'UNSAFE_POINT', reason: 'untargeted_input',
    entryId: 'drag',
  });
  assert.equal(pointDesktop.calls.some(call => call.call === 'drag' || call.call === 'focusWindow'), false);
});

test('window-only driver calls carry the window ID and never --app', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-window-only-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const stub = join(root, 'desktop');
  const data = structuredClone(snapshotFixture.data);
  data.window = { id: 'w-42', title };
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
let payload;
if (command === 'version') payload = { version: '1.3.1' };
else if (command === 'list-windows') payload = [{ id: 'w-42', title: ${JSON.stringify(title)}, process_instance: 501 }];
else if (command === 'snapshot') payload = ${JSON.stringify(data)};
else if (command === 'focus-window') payload = { focused: { id: 'w-42' } };
else if (command === 'screenshot') { fs.writeFileSync(args.at(-1), ${JSON.stringify(png.toString('base64'))}, 'base64'); payload = {}; }
else payload = {};
console.log(JSON.stringify({ version: '2.6', command, ok: true, data: payload }));
`, { mode: 0o700 });
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  process.env.CUEKEEPER_AGENT_DESKTOP = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
  });
  const snapshot = await withDesktop({ headed: false, signal }, async desktop => {
    await desktop.focusWindow('w-42');
    const image = await desktop.screenshotWindow('w-42');
    const windows = await desktop.listAllWindows();
    return { image, windows, tree: await desktop.snapshotWindow('w-42', title) };
  });
  assert.equal(snapshot.image.length, png.length);
  assert.deepEqual(snapshot.windows.map(window => [window.id, window.title, window.processInstance]),
    [['w-42', title, 501]]);
  assert.equal(snapshot.tree.windowId, 'w-42');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const focus = calls.find(call => call.command === 'focus-window');
  assert.deepEqual(focus.args, ['--window-id', 'w-42']);
  const image = calls.find(call => call.command === 'screenshot');
  assert.equal(image.args[0], '--window-id');
  assert.equal(image.args[1], 'w-42');
  assert.equal(image.args.includes('--app'), false);
  const list = calls.find(call => call.command === 'list-windows');
  assert.equal(list.args.includes('--app'), false);
  const snap = calls.find(call => call.command === 'snapshot');
  assert.equal(snap.args[snap.args.indexOf('--window-id') + 1], 'w-42');
  assert.equal(snap.args.includes('--app'), false);
});

test('a window bound by ID reads its tree after the title changed', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-window-retitle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const stub = join(root, 'desktop');
  const retitled = structuredClone(snapshotFixture.data);
  // The window is the same one; only its title moved on since the event that
  // named it (an unsaved dot, a problem count, a folder that followed the view).
  retitled.window = { id: 'w-42', title: `${title} — 1 problem in this file` };
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
const index = args.indexOf('--window-id');
const bound = index < 0 ? '' : args[index + 1];
let payload;
if (command === 'version') payload = { version: '1.3.1' };
else if (bound === 'w-42') payload = ${JSON.stringify(retitled)};
else if (bound === 'w-55') payload = { ...${JSON.stringify(retitled)}, complete: false,
  window: { id: 'w-55', title: 'Sales report — edited' } };
else payload = { ...${JSON.stringify(retitled)}, window: { id: 'w-78', title: 'Another window' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data: payload }));
`, { mode: 0o700 });
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  process.env.CUEKEEPER_AGENT_DESKTOP = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
  });

  const tree = await withDesktop({ headed: false, signal },
    desktop => desktop.snapshotWindow('w-42', title));
  // The recorded title was a hint, not the identity: the tree still reads.
  assert.equal(tree.windowId, 'w-42');
  assert.equal(tree.tree.role, snapshotFixture.data.tree.role);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const snap = calls.find(call => call.command === 'snapshot');
  assert.equal(snap.args[snap.args.indexOf('--window-id') + 1], 'w-42');
  assert.equal(snap.args.includes('--app'), false);

  // A driver that answers with another window is still refused, and the error
  // names both windows so the next read can be traced.
  await assert.rejects(withDesktop({ headed: false, signal },
    desktop => desktop.snapshotWindow('w-77', title)), error => {
    assert.equal(error.code, 'WINDOW_CHANGED');
    assert.match(error.message, /w-78/);
    assert.match(error.message, /w-77/);
    return true;
  });

  // A read that does answer but cannot be parsed still says which window and
  // which title it was of, alongside the recorded hint.
  await assert.rejects(withDesktop({ headed: false, signal },
    desktop => desktop.snapshotWindow('w-55', title)), error => {
    assert.equal(error.code, 'INCOMPLETE_TREE');
    assert.match(error.message, /w-55/);
    assert.match(error.message, /Sales report — edited/);
    assert.match(error.message, /Cuekeeper-M1\.txt/);
    return true;
  });
});

test('the CLI sends window-only commands for a path-fixed flow', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-identity-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(root, 'B 副本.app');
  const requested = join(root, 'Link.app');
  mkdirSync(join(canonical, 'Contents'), { recursive: true });
  writeFileSync(join(canonical, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string></dict></plist>
`);
  symlinkSync(canonical, requested);

  const helper = join(root, 'identity.js');
  const instances = [{
    pid: 501, startedAt: '501.10', bundleId: app, bundlePath: canonical,
  }];
  writeFileSync(helper, `#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
const instances = ${JSON.stringify(instances)};
const windows = [{ number: 42, ownerPid: 501, title: ${JSON.stringify(title)} }];
const data = command === 'describe' ? instances[0] :
  command === 'instances' ? { instances } :
  command === 'windows' ? windows :
  command === 'validate' ? { bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(canonical)} } :
  null;
console.log(JSON.stringify({ ok: true, data }));
`, { mode: 0o700 });

  const driver = join(root, 'desktop.js');
  const log = join(root, 'calls.jsonl');
  const data = structuredClone(snapshotFixture.data);
  data.window = { id: 'w-42', title };
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
const fixture = ${JSON.stringify(data)};
let payload;
if (command === 'version') payload = { version: '1.3.1' };
else if (command === 'list-windows') payload = [{ id: 'w-42', title: ${JSON.stringify(title)}, process_instance: 501 }];
else if (command === 'snapshot') payload = fixture;
else if (command === 'focus-window') payload = { focused: { id: 'w-42' } };
else payload = { disposition: { delivery: 'delivered_verified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data: payload }));
`, { mode: 0o700 });

  const flowPath = join(root, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({ ...baseFlow, target: { app, window: title, appPath: requested } }));
  // The flow types ASCII, and the replay guard reads the active input source.
  // A stub keeps the run off this Mac's TIS and out of the user's IME.
  const imeHelper = join(root, 'ime.js');
  writeFileSync(imeHelper, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const source = { id: 'com.apple.keylayout.ABC', name: 'ABC', ascii: true, selectable: true };
const reply = data => console.log(JSON.stringify({ ok: true, data }));
if (command === 'version') reply({ helper: 'cuekeeper-ime', version: 1 });
else if (command === 'list') reply({ sources: [source] });
else if (command === 'current') reply({ source });
else {
  console.log(JSON.stringify({ ok: false, error: { code: 'INPUT_ERROR', message: 'unknown command' } }));
  process.exit(1);
}
`, { mode: 0o700 });
  const reportPath = join(root, 'report.json');
  const result = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--report', reportPath, '--json'], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: driver,
      CUEKEEPER_APP_IDENTITY: helper,
      CUEKEEPER_IME: imeHelper,
      CUEKEEPER_IME_DIR: join(root, 'ime-root'),
    },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.appIdentity, { app, mode: 'bundle_path', status: 'verified' });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const commands = calls.map(call => call.command);
  assert.deepEqual(commands, ['version', 'list-windows', 'snapshot', 'click', 'snapshot', 'type', 'snapshot', 'press']);
  assert.deepEqual(calls[1].args.includes('--app'), false, 'the identity cross-check lists windows without --app');
  for (const call of calls.filter(call => call.command === 'snapshot')) {
    const index = call.args.indexOf('--window-id');
    assert.equal(index >= 0, true);
    assert.equal(call.args[index + 1], 'w-42');
    assert.equal(call.args.includes('--app'), false);
  }
  assert.deepEqual(calls.find(call => call.command === 'click').args, ['@scuekeeper:e1']);
  const press = calls.find(call => call.command === 'press');
  assert.deepEqual(press.args, ['meta+s', '--window-id', 'w-42']);
  assert.equal(press.args.includes('--app'), false);
});
