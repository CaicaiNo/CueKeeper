import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCaptureEvent } from '../dist/capture-protocol.js';
import { flowV2Check } from '../dist/contracts-v2.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { Fault, parseSnapshot, resolve } from '../dist/locator.js';
import { GlobalRecording } from '../dist/record-v2.js';
import { loadSession } from '../dist/workbench-session.js';
import { ABC_SOURCE, imeStub, SOGOU_SOURCE } from './support/ime-stub.mjs';

// The engine is exercised offline: events and window trees come from fixtures,
// no helper is spawned and no accessibility tree is read from the desktop.
const NOW = 1_700_000_000_000;
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function readerFor(data, { failWindow } = {}) {
  return async window => {
    if (failWindow === window.windowNumber) throw new Error('snapshot unavailable');
    const snapshot = data.snapshots[String(window.windowNumber)];
    if (!snapshot) throw new Error(`fixture has no snapshot for window ${window.windowNumber}`);
    return structuredClone(snapshot);
  };
}

async function recordFixture(name, { now = () => NOW, options = {} } = {}) {
  const data = fixture(name);
  const recording = new GlobalRecording(readerFor(data), { now, ...options });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  return recording;
}

test('one recording spans two apps and three windows with one scope per step', async () => {
  const flow = (await recordFixture('two-apps-three-windows')).finish();
  assert.equal(flow.version, 2);
  assert.equal(flowV2Check.Check(flow), true);
  assert.deepEqual(flow.steps.map(step => step.kind), [
    'click', 'type', 'activate_app', 'type', 'focus_window', 'type', 'activate_app', 'key',
  ]);
  assert.deepEqual(flow.steps[0].scope, {
    kind: 'window', app: 'com.apple.finder', windowKey: 'finder-1', windowTitle: 'Downloads',
  });
  // Two keystrokes in the same field are one text step, stored as a parameter.
  assert.equal(flow.steps[1].kind, 'type');
  assert.equal(flow.steps[1].input, 'text_1');
  assert.equal(flow.steps[2].scope.app, 'com.apple.TextEdit');
  assert.equal(flow.steps[2].focusAfter.windowKey, 'textedit-1');
  assert.equal(flow.steps[3].input, 'text_2');
  // The second window of the same process gets its own window key.
  assert.equal(flow.steps[4].kind, 'focus_window');
  assert.equal(flow.steps[4].scope.windowKey, 'textedit-2');
  assert.equal(flow.steps[5].input, 'text_3');
  assert.equal(flow.steps[6].focusAfter.windowKey, 'finder-1');
  assert.equal(flow.steps[7].scope.windowKey, 'finder-1');
  assert.deepEqual(flow.inputs, ['text_1', 'text_2', 'text_3']);
  // Text is never stored: only parameter names appear in the flow.
  const json = JSON.stringify(flow);
  assert.ok(!json.includes('Zq-file'));
  assert.ok(!json.includes('Zq-one'));
  assert.ok(!json.includes('Zq-two'));
});

test('every recorded step carries the time it happened, counted from the first step', async () => {
  const flow = (await recordFixture('two-apps-three-windows')).finish();
  // Fixture events: click 100, text 200+260 (one burst), focus 400, text 500,
  // focus 700, text 800, focus 1000, key 1100. The first retained step is the
  // recording's zero, and a merged burst keeps its first character's time.
  assert.deepEqual(flow.steps.map(step => step.atMs), [0, 100, 300, 400, 600, 700, 900, 1000]);
  assert.equal(flowV2Check.Check(flow), true);
  // The time survives the trip through the parser the workbench uses.
  assert.deepEqual(parseFlowV2(flow).steps.map(step => step.atMs), [0, 100, 300, 400, 600, 700, 900, 1000]);
});

test('a pause is not billed into the step times or the timeline', async () => {
  const data = fixture('two-apps-three-windows');
  // The helper stamps `t` with the recording clock, which freezes while paused,
  // and `seen` with the wall clock, which keeps running. A five-second pause
  // happened after the merged text burst and before the next focus.
  const pauseMs = 5000;
  const events = data.events.map(event => ({
    ...event, ...(event.t > 260 ? { seen: event.seen + pauseMs } : {}),
  }));
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  recording.notePausedMs(pauseMs);
  const flow = recording.finish();

  // The gap between the burst (100 ms) and the next step (300 ms) is 200 ms;
  // the pause is not part of any interval.
  assert.deepEqual(flow.steps.map(step => step.atMs), [0, 100, 300, 400, 600, 700, 900, 1000]);
  assert.equal(flow.pausedMs, pauseMs);
  // The flow also remembers where it started on the wall clock.
  assert.equal(flow.startedAt, new Date(events[0].seen).toISOString());
  assert.equal(flowV2Check.Check(flow), true);
  const parsed = parseFlowV2(flow);
  assert.equal(parsed.pausedMs, pauseMs);
  assert.equal(parsed.startedAt, flow.startedAt);
});

test('a recording with no pause carries no paused time', async () => {
  // The same fixture, unchanged: nothing paused, so the flow keeps its old
  // shape and every step time is exactly what the helper stamped.
  const flow = (await recordFixture('two-apps-three-windows')).finish();
  assert.equal('pausedMs' in flow, false);
  assert.equal(flow.startedAt, new Date(NOW).toISOString());
  assert.deepEqual(flow.steps.map(step => step.atMs), [0, 100, 300, 400, 600, 700, 900, 1000]);
});

test('same-title windows stay distinct and a retitled window keeps its key', async () => {
  const flow = (await recordFixture('same-title-windows')).finish();
  const keys = flow.steps
    .filter(step => step.scope?.kind === 'window')
    .map(step => step.scope.windowKey);
  assert.deepEqual(keys, ['textedit-1', 'textedit-2', 'textedit-2', 'textedit-1', 'textedit-1']);
  // The surviving window follows its new title without taking over the new window's key.
  assert.equal(flow.steps[4].scope.windowTitle, 'Draft 2');
  assert.equal(flow.steps[4].scope.windowKey, 'textedit-1');
});

test('a late focus notification cannot move the flow back to a window it left', async () => {
  const flow = (await recordFixture('late-focus')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), [
    'type', 'activate_app', 'type', 'activate_app', 'type',
  ]);
  const activations = flow.steps.filter(step => step.kind === 'activate_app');
  assert.equal(activations.length, 2);
  assert.equal(flow.steps.at(-1).scope.windowKey, 'finder-1');
});

test('a queue gap splits a text burst and blocks replay until resolved', async () => {
  const flow = (await recordFixture('queue-overflow')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'gap', 'type']);
  assert.equal(flow.steps[1].code, 'CAPTURE_GAP');
  assert.notEqual(flow.steps[0].input, flow.steps[2].input);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('a secure interval becomes one manual checkpoint and never carries content', async () => {
  const data = fixture('secure-input');
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const original of data.events) {
    const event = structuredClone(original);
    if (event.secure) event.chars = secret;
    await recording.add(parseCaptureEvent(event));
  }
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  const checkpoint = flow.steps[1];
  assert.equal(checkpoint.reason, 'secure_input');
  assert.equal(checkpoint.triggerStepId, 's1');
  assert.deepEqual(checkpoint.scope, flow.steps[0].scope);
  assert.deepEqual(checkpoint.resume, {
    scope: flow.steps[0].scope, check: { kind: 'window_exists', equals: true },
  });
  assert.equal(checkpoint.timeoutMs, 120_000);
  // The checkpoint is a normal, replayable step: no content gap remains.
  assert.equal(flowV2Check.Check(flow), true);
  assert.equal(parseFlowV2(flow).steps.length, 3);
  // Only the two non-secure text events read a window tree.
  assert.equal(reads, 2);
  const output = JSON.stringify(flow) + JSON.stringify(recording.captureWarnings);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('"chars"'));
});

test('consecutive secure intervals fold into one checkpoint', async () => {
  const data = fixture('secure-input');
  const [first, ...rest] = data.events;
  // A focus notification ends the first interval but records no step; the next
  // secure event starts a second interval for the same window.
  const focus = {
    kind: 'focus', t: 210, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
    owner: { app: 'com.apple.finder', pid: 100, processInstance: 1_700_000_000_000, windowNumber: 11, windowTitle: 'Downloads' },
  };
  const events = [first, rest[0], focus, ...rest.slice(1)];
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  assert.equal(flow.steps.filter(step => step.kind === 'manual_checkpoint').length, 1);
});

test('a secure interval with no window-scoped trigger stays a SECURE_INPUT gap', async () => {
  const data = fixture('secure-input');
  const secure = data.events.filter(event => event.secure);
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of secure) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'SECURE_INPUT');
});

test('a Security Agent window never becomes a scope, even before the secure flag', async () => {
  const data = fixture('secure-input');
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  const agent = 'com.apple.SecurityAgent';
  const owner = (app, number) => ({
    app, pid: app === agent ? 900 : 100, processInstance: 1_700_000_000_000,
    windowNumber: number, windowTitle: app === agent ? 'Install Test App' : 'Downloads',
  });
  const events = [
    data.events[0],
    {
      kind: 'focus', t: 220, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
      owner: { ...owner(agent, 77), securityAgent: true },
    },
    {
      kind: 'text', t: 240, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
      chars: secret, owner: { ...owner(agent, 77), securityAgent: true },
    },
    {
      kind: 'text', t: 400, seen: 1_700_000_000_000, focusGeneration: 3, secure: false,
      owner: owner('com.apple.finder', 11),
    },
  ];
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  assert.equal(flow.steps.some(step => step.scope?.app === agent), false);
  assert.equal(flow.steps[1].scope.app, 'com.apple.finder');
  assert.equal(reads, 2);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'SECURE_AUTHORIZATION'));
  assert.ok(!JSON.stringify(flow).includes(secret));
});

test('a system dialog after a package double-click is captured once without requiring dialog input', async () => {
  const data = fixture('finder-downloads-pkg-click');
  const owner = data.events[0].owner;
  const readWindows = [];
  const recording = new GlobalRecording(async window => {
    readWindows.push(window.windowNumber);
    return readerFor(data)(window);
  }, { now: () => NOW });
  const dialog = (visible, t) => ({
    kind: 'system_dialog', visible, t, seen: NOW, focusGeneration: 1, secure: false,
  });
  for (const event of [
    ...data.events,
    dialog(true, 280),
    dialog(true, 300),
    { kind: 'text', chars: 'popup-text', t: 350, seen: NOW, focusGeneration: 1, secure: true,
      owner: { app: 'com.apple.CoreServicesUIAgent', pid: 600, windowNumber: 12, windowTitle: 'Popup title' } },
    dialog(false, 500),
    { kind: 'key', key: 'escape', modifiers: [], t: 600, seen: NOW, focusGeneration: 1, secure: false, owner },
  ]) await recording.add(parseCaptureEvent(event));

  const flow = parseFlowV2(recording.finish());
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'manual_checkpoint', 'key']);
  assert.equal(flow.steps[0].count, 2);
  assert.deepEqual(flow.steps[1], {
    id: 's2', kind: 'manual_checkpoint', scope: flow.steps[0].scope, triggerStepId: 's1', reason: 'system_dialog',
    resume: { scope: flow.steps[0].scope, check: { kind: 'window_exists', equals: true } },
    timeoutMs: 120_000,
    // Times run from the first retained step: the click at t=100 is the
    // recording's zero, so the dialog at t=280 is 180 ms in.
    atMs: 180,
  });
  assert.equal(flow.steps[2].scope.windowKey, flow.steps[0].scope.windowKey);
  // Both clicks share the one tree this window was read as; the dialog never
  // makes the recording read the package window again.
  assert.deepEqual(readWindows, [11]);
  assert.doesNotMatch(JSON.stringify(flow), /CoreServicesUIAgent|Popup title|popup-text/);
});

test('an already visible system dialog without a trigger leaves a gap', async () => {
  const recording = new GlobalRecording(async () => assert.fail('no window tree expected'));
  await recording.add(parseCaptureEvent({
    kind: 'system_dialog', visible: true, t: 0, seen: NOW, focusGeneration: 0, secure: false,
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps, [{ id: 's1', atMs: 0, kind: 'gap', code: 'CAPTURE_SCOPE_UNVERIFIED' }]);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('occluded and unprovable clicks keep their point; activation-only clicks navigate', async () => {
  const flow = (await recordFixture('unprovable-clicks')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click', 'click']);
  assert.equal(flow.steps[1].scope.app, 'com.apple.TextEdit');
  assert.deepEqual(flow.steps[2].target, { kind: 'point', point: [1150, 310] });
  assert.deepEqual(flow.steps[3].target, { kind: 'point', point: [1100, 300] });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('a Dock click navigates once the focus names the app it started', async () => {
  const flow = (await recordFixture('dock-activation')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click']);
  assert.equal(flow.steps[1].scope.app, 'com.google.Chrome');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('a Dock click with no new focus is dropped with a warning', async () => {
  const recording = await recordFixture('dock-click-unproven');
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'DOCK_CLICK_UNPROVEN'));
});

// The helper advances its focus generation while a recording is paused but does
// not emit a focus line for it (noteFocus reports only when not paused). The
// first click after resume can therefore land in a window the engine never saw,
// while still being `record` because it hit the live focused window. Replay gets
// the navigation and the click — not a capture gap.
test('a click proven in the destination app is kept once after activate_app', async () => {
  const recording = await recordFixture('cross-app-click-after-pause');
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click', 'click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  // Cross-app: one activation, carrying the destination window for focusAfter.
  assert.equal(flow.steps.filter(step => step.kind === 'activate_app').length, 1);
  assert.equal(flow.steps[1].scope.app, 'com.electron.atrust');
  assert.equal(flow.steps[1].focusAfter.windowKey, 'atrust-1');
  // The recovered click is recorded exactly once, named from its own evidence,
  // and the next click of the same generation adds no navigation.
  assert.equal(flow.steps[2].scope.windowKey, 'atrust-1');
  assert.deepEqual(flow.steps[2].target, { kind: 'element', role: 'button', name: '设置' });
  assert.equal(flow.steps.filter(step => step.kind === 'click' && step.target.name === '设置').length, 1);
  assert.equal(flow.steps[3].scope.windowKey, 'atrust-1');
  assert.equal(flow.steps.length, 4);
  assert.equal(flowV2Check.Check(flow), true);
  assert.equal(parseFlowV2(flow).steps.length, 4);
});

test('a click proven in another window of the same app is focus_window, once', async () => {
  const flow = (await recordFixture('same-app-window-click-after-pause')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'focus_window', 'click', 'click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap' || step.kind === 'activate_app'), false);
  assert.equal(flow.steps.filter(step => step.kind === 'focus_window').length, 1);
  assert.equal(flow.steps[1].scope.windowKey, 'finder-2');
  assert.equal(flow.steps[1].scope.windowTitle, 'Images');
  assert.deepEqual(flow.steps[2].target, { kind: 'element', role: 'button', name: '排序' });
  assert.equal(flow.steps.filter(step => step.kind === 'click' && step.target.name === '排序').length, 1);
  assert.equal(flow.steps.length, 4);
});

const afterPause = () => fixture('cross-app-click-after-pause');

/** Feed one event list through a fresh recording; fixtures have no pause lines. */
const replayEvents = (data, events, reader = readerFor(data), options = {}) => {
  const recording = new GlobalRecording(reader, { now: () => NOW, ...options });
  return events.reduce((chain, event) => chain.then(() => recording.add(parseCaptureEvent(event))),
    Promise.resolve()).then(() => recording);
};

test('a click that names no window keeps the existing warning, with or without later focus', async () => {
  const data = afterPause();
  const [finderFocus, finderClick] = data.events;
  const unbound = {
    kind: 'click', t: 611, seen: NOW, point: [1400, 300], count: 1,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: { role: 'AXButton', name: 'install', pressable: true },
  };
  const laterFocus = {
    kind: 'focus', t: 665, seen: NOW, focusGeneration: 3, secure: false,
    owner: { app: 'com.electron.atrust', pid: 200, processInstance: NOW, windowNumber: 21, windowTitle: 'aTrust' },
  };
  const withFocus = await replayEvents(data, [finderFocus, finderClick, unbound, laterFocus]);
  const flowWithFocus = withFocus.finish();
  // The click cannot be replayed, so it is dropped with the existing warning;
  // it must not become a gap, and the focus still navigates once.
  assert.deepEqual(flowWithFocus.steps.map(step => step.kind), ['click', 'activate_app']);
  assert.equal(flowWithFocus.steps.some(step => step.kind === 'gap'), false);
  assert.ok(withFocus.captureWarnings.some(warning => warning.code === 'CLICK_OUTSIDE_WINDOW'));

  const withoutFocus = await replayEvents(data, [finderFocus, finderClick, unbound]);
  assert.deepEqual(withoutFocus.finish().steps.map(step => step.kind), ['click']);
  assert.ok(withoutFocus.captureWarnings.some(warning => warning.code === 'CLICK_OUTSIDE_WINDOW'));
});

test('a late or conflicting focus generation is never recovered', async () => {
  const data = afterPause();
  const [finderFocus, finderClick, recovered, sameWindowClick] = data.events;
  // Generation 2 already moved the flow to aTrust; an event from generation 1
  // names the Finder window it claimed back then and must not navigate.
  const late = { ...recovered, t: 800, focusGeneration: 1 };
  const lateRun = await replayEvents(data, [finderFocus, finderClick, recovered, sameWindowClick, late]);
  const lateFlow = lateRun.finish();
  assert.deepEqual(lateFlow.steps.map(step => step.kind), ['click', 'activate_app', 'click', 'click', 'gap']);
  assert.equal(lateFlow.steps[4].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(lateFlow.steps.filter(step => step.kind === 'activate_app').length, 1);

  const inWindow = {
    kind: 'click', t: 300, seen: NOW, point: [340, 320], count: 1,
    focusGeneration: 2, secure: false, decision: 'record', owner: finderClick.owner,
  };
  const conflicting = { ...recovered, t: 400, focusGeneration: 2 };
  const conflictRun = await replayEvents(data, [finderFocus, finderClick, inWindow, conflicting]);
  const conflictFlow = conflictRun.finish();
  // Generation 2 already named the Finder window; the same generation naming
  // the aTrust window is conflicting evidence, so it stays a gap with no nav.
  assert.deepEqual(conflictFlow.steps.map(step => step.kind), ['click', 'click', 'gap']);
  assert.equal(conflictFlow.steps[2].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(conflictFlow.steps.some(step => step.kind === 'activate_app'), false);
});

test('a window the event did not name itself never proves the click', async () => {
  const data = afterPause();
  const [finderFocus, finderClick, recovered] = data.events;
  const rename = {
    kind: 'click', t: 611, seen: NOW, point: [1400, 300], count: 1,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: { app: 'com.electron.atrust', pid: 200, processInstance: NOW, role: 'AXButton', name: '设置' },
  };
  // The click names no window of its own and the inheritance branch cannot fill
  // that in across apps: it stays the existing warning, not a recovery.
  const unnamed = await replayEvents(data, [finderFocus, finderClick, rename]);
  assert.deepEqual(unnamed.finish().steps.map(step => step.kind), ['click']);
  assert.ok(unnamed.captureWarnings.some(warning => warning.code === 'CLICK_OUTSIDE_WINDOW'));

  // Inheritance still records a click in the window the flow already stands in,
  // which is the behaviour this change must not disturb.
  const inherited = {
    ...rename, t: 400, point: [340, 320], focusGeneration: 2,
    owner: { app: 'com.apple.finder', pid: 100, processInstance: NOW, role: 'AXButton', name: '设置' },
  };
  const inheritedFlow = (await replayEvents(data, [finderFocus, finderClick, inherited])).finish();
  assert.deepEqual(inheritedFlow.steps.map(step => step.kind), ['click', 'click']);
  assert.equal(inheritedFlow.steps[1].scope.windowKey, 'finder-1');
  assert.equal(inheritedFlow.steps.some(step => step.kind === 'gap'), false);
});

test('a menu item click keeps the gap instead of navigating', async () => {
  const data = afterPause();
  const [finderFocus, finderClick, , sameWindowClick] = data.events;
  const menuItem = {
    kind: 'click', t: 611, seen: NOW, point: [1400, 300], count: 1,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: {
      app: 'com.electron.atrust', pid: 200, processInstance: NOW,
      windowNumber: 21, windowTitle: 'aTrust', role: 'AXMenuItem', name: '打开',
    },
  };
  const flow = (await replayEvents(data, [finderFocus, finderClick, menuItem, sameWindowClick])).finish();
  // The native menu branch also reports `record`, but its window belongs to the
  // app that opened the menu; the item is not replayed from there.
  // The gap stays, the destination is activated once, and the next click is a
  // normal click in the now-current window.
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'click']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps.filter(step => step.kind === 'activate_app').length, 1);
  assert.equal(flow.steps.some(step => step.kind === 'click' && step.target.name === '打开'), false);
});

test('unowned scrolls and keys still block', async () => {
  const data = afterPause();
  const [finderFocus, finderClick, recovered, sameWindowClick] = data.events;
  const scroll = {
    kind: 'scroll', t: 611, seen: NOW, point: [990, 112], deltaX: 0, deltaY: -3,
    focusGeneration: 2, secure: false, decision: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: recovered.owner,
  };
  const scrollFlow = (await replayEvents(data, [finderFocus, finderClick, scroll, sameWindowClick])).finish();
  assert.deepEqual(scrollFlow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'click']);
  assert.equal(scrollFlow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(scrollFlow.steps.filter(step => step.kind === 'activate_app').length, 1);

  const key = {
    kind: 'key', t: 611, seen: NOW, key: 'return', focusGeneration: 2, secure: false,
    decision: 'record', owner: { app: 'com.electron.atrust', pid: 200, processInstance: NOW },
  };
  const keyFlow = (await replayEvents(data, [finderFocus, finderClick, key, sameWindowClick])).finish();
  assert.deepEqual(keyFlow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'click']);
  assert.equal(keyFlow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(keyFlow.steps.filter(step => step.kind === 'activate_app').length, 1);
});

test('a recovered click only clears the gap for an addressable non-secure element', async () => {
  const source = afterPause();
  const [finderFocus, finderClick, recovered] = source.events;
  // A nameless click forces the tree read that proves what is under the point.
  const nameless = { ...recovered, owner: { ...recovered.owner, role: undefined, name: undefined } };

  // (1) The single read hits a protected control: secure interval, no step, gap.
  const secureData = structuredClone(source);
  secureData.snapshots['21'].tree.children[0].secure = true;
  const secureFlow = (await replayEvents(secureData,
    [finderFocus, finderClick, nameless])).finish();
  assert.equal(secureFlow.steps.filter(step => step.kind === 'activate_app').length, 1);
  assert.ok(secureFlow.steps.some(step => step.kind === 'gap' && step.code === 'CAPTURE_SCOPE_UNVERIFIED'));
  assert.equal(secureFlow.steps.some(step => step.kind === 'click' && step.scope.app === 'com.electron.atrust'), false);
  assert.throws(() => parseFlowV2(secureFlow), { code: 'CAPTURE_GAP' });

  // (2) The first read fails and the fallback read hits the same secure control:
  // the second branch has to honour the same rule.
  const fallbackData = structuredClone(source);
  fallbackData.snapshots['21'].tree.children[0].secure = true;
  let windowReads = 0;
  const fallbackReader = async window => {
    if (window.windowNumber === 21 && windowReads++ === 0) throw new Error('first read failed');
    return structuredClone(fallbackData.snapshots[String(window.windowNumber)]);
  };
  const fallbackFlow = (await replayEvents(fallbackData,
    [finderFocus, finderClick, nameless], fallbackReader)).finish();
  assert.ok(fallbackFlow.steps.some(step => step.kind === 'gap' && step.code === 'CAPTURE_SCOPE_UNVERIFIED'));
  assert.equal(fallbackFlow.steps.some(step => step.kind === 'click' && step.scope.app === 'com.electron.atrust'), false);
  assert.throws(() => parseFlowV2(fallbackFlow), { code: 'CAPTURE_GAP' });

  // (3) Both reads fail: only a bare point is left, so the gap stays rather than
  // letting live replay click an unaddressable coordinate.
  const failingReader = async window => {
    if (window.windowNumber === 21) throw new Error('window unreadable');
    return structuredClone(source.snapshots[String(window.windowNumber)]);
  };
  const pointRecording = await replayEvents(source,
    [finderFocus, finderClick, nameless], failingReader);
  const pointFlow = pointRecording.finish();
  assert.equal(pointFlow.steps.filter(step => step.kind === 'activate_app').length, 1);
  assert.equal(pointFlow.steps.some(step => step.kind === 'click' && step.target?.kind === 'point'), false);
  assert.ok(pointFlow.steps.some(step => step.kind === 'gap' && step.code === 'CAPTURE_SCOPE_UNVERIFIED'));
  assert.ok(pointRecording.captureWarnings.some(warning => warning.code === 'CLICK_RECOVERY_UNNAMED'));
  assert.throws(() => parseFlowV2(pointFlow), { code: 'CAPTURE_GAP' });
});

test('a right click in another window keeps the gap instead of being recovered', async () => {
  const data = fixture('same-app-window-click-after-pause');
  const [finderFocus, finderClick, recovered] = data.events;
  const rightClick = { ...recovered, button: 'right' };
  const flow = (await replayEvents(data, [finderFocus, finderClick, rightClick])).finish();
  // Replay of a right click may reuse the previous left click's target, so a
  // recovered right click could press a different control than the one
  // recorded. It must stay a blocking gap, with no navigation.
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps.some(step => step.kind === 'focus_window'), false);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('a recovered click must resolve to one addressable control', async () => {
  const data = fixture('same-app-window-click-after-pause');
  const [finderFocus, finderClick, recovered] = data.events;
  const nameless = { ...recovered, owner: { ...recovered.owner, role: undefined, name: undefined } };
  const bounds = { x: 900, y: 0, width: 800, height: 600 };
  const imagesTree = children => ({
    windowId: 'w-12',
    tree: {
      role: 'window', name: 'Images', ref: '@w12:e1', bounds, states: [], secure: false, children,
    },
  });
  // The first read fails so the fallback read answers; a shared reader state
  // makes sure only the first attempt fails.
  const failingOnce = snapshot => {
    let failed = false;
    return async window => {
      if (window.windowNumber === 12 && !failed) { failed = true; throw new Error('first read failed'); }
      return structuredClone(window.windowNumber === 12 ? snapshot : data.snapshots[String(window.windowNumber)]);
    };
  };
  const cases = {
    anonymousButton: imagesTree([{
      role: 'button', ref: '@w12:e2', bounds: { x: 950, y: 100, width: 80, height: 24 },
      states: [], secure: false, children: [],
    }]),
    windowRoot: imagesTree([]),
  };
  for (const [label, snapshot] of Object.entries(cases)) {
    const recording = await replayEvents(data, [finderFocus, finderClick, nameless], failingOnce(snapshot));
    const flow = recording.finish();
    assert.ok(flow.steps.some(step => step.kind === 'gap' && step.code === 'CAPTURE_SCOPE_UNVERIFIED'),
      `${label}: the gap must stay`);
    assert.equal(flow.steps.some(step => step.kind === 'click' && step.scope.app === 'com.apple.finder' &&
      step.scope.windowKey === 'finder-2'), false, `${label}: no click may be kept`);
    assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_RECOVERY_UNNAMED'), label);
    assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' }, label);
  }
  // An identifier alone is enough to address one control.
  const identified = imagesTree([{
    role: 'button', ref: '@w12:e2', identifier: 'atrust-sort',
    bounds: { x: 950, y: 100, width: 80, height: 24 }, states: [], secure: false, children: [],
  }]);
  const identifiedFlow = (await replayEvents(data, [finderFocus, finderClick, nameless],
    failingOnce(identified))).finish();
  assert.deepEqual(identifiedFlow.steps.map(step => step.kind), ['click', 'focus_window', 'click']);
  assert.equal(identifiedFlow.steps[2].target.identifier, 'atrust-sort');
  assert.equal(identifiedFlow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(parseFlowV2(identifiedFlow).steps.length, 3);
});

test('a recovered click reserves room for the navigation and the click', async () => {
  const data = afterPause();
  const [finderFocus, finderClick, recovered] = data.events;
  // Two slots: the Finder click takes one, so the recovery cannot add both the
  // navigation and the click. It must leave the gap instead of a lone nav step.
  const recording = await replayEvents(data, [finderFocus, finderClick, recovered],
    readerFor(data), { stepLimit: 2 });
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps.some(step => step.kind === 'activate_app'), false);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('a stale capture keeps its helper reason as a diagnostic and still blocks', async () => {
  const data = fixture('two-apps-three-windows');
  const stale = detail => ({
    kind: 'gap', gapCode: 'STALE_CAPTURE', t: 300, seen: NOW, focusGeneration: 1, secure: false,
    ...(detail === undefined ? {} : { detail }),
  });
  const run = async detail => {
    const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
    await recording.add(parseCaptureEvent(data.events[0]));
    await recording.add(parseCaptureEvent(stale(detail)));
    return recording;
  };
  for (const [detail, code] of [['tap_interrupted', 'STALE_CAPTURE_TAP_INTERRUPTED'],
    ['event_lag', 'STALE_CAPTURE_EVENT_LAG']]) {
    const recording = await run(detail);
    const flow = recording.finish();
    // The reason is carried for diagnosis only: the gap is still a gap.
    assert.deepEqual(flow.steps.map(step => [step.kind, step.code]),
      [['click', undefined], ['gap', 'STALE_CAPTURE']]);
    assert.ok(recording.captureWarnings.some(warning => warning.code === code), `missing ${code}`);
    assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
  }
  // No reason, an unknown one, or a malformed one must all keep the same gap.
  for (const detail of [undefined, 'something_else', 42, 'Tap interrupted!']) {
    const recording = await run(detail);
    const flow = recording.finish();
    assert.equal(flow.steps.length, 2, `detail ${String(detail)} must not drop the gap`);
    assert.equal(flow.steps[1].code, 'STALE_CAPTURE');
    assert.equal(recording.captureWarnings.some(warning => warning.code.startsWith('STALE_CAPTURE_')), false);
    assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
  }
});

test('a drag that crosses a window boundary leaves CROSS_SCOPE_GESTURE', async () => {
  const flow = (await recordFixture('cross-window-drag')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'CROSS_SCOPE_GESTURE');
});

// The user clicked the address bar, dragged across the text to select it, then
// typed. Both drag endpoints hit the same editable control and neither was its
// center, so the drag used to become CAPTURE_SCOPE_UNVERIFIED and blocked every
// run. It selects text, which no v2 step replays, so it is dropped with a
// warning and the typing that follows must stay.
test('a drag that selects text inside one editable control is not a blocking gap', async () => {
  const recording = await recordFixture('drag-select-in-field');
  const flow = recording.finish();
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  // The text that followed the selection is kept, addressed to the field that
  // received it.
  assert.equal(flow.steps[1].input, 'text_1');
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'textfield', name: '地址' });
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
  // The drop is never silent: the capture report names it.
  const warning = recording.captureWarnings.find(entry => entry.code === 'DRAG_SELECTS_TEXT');
  assert.ok(warning, 'the dropped selection must be reported');
  // A drag that selects text is not a business drag, so no drag step appears.
  assert.equal(flow.steps.some(step => step.kind === 'drag'), false);
});

// The same shape, but the drag ends on another control: that is a real gesture
// whose effect this recording cannot prove, so it keeps its gap — and the gap
// report still says the handler was `drag`.
test('a drag between two controls keeps its gap and its drag origin', async () => {
  const recording = await recordFixture('drag-across-controls');
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
  const origin = recording.captureWarnings.find(entry => entry.code === 'CAPTURE_GAP_ORIGIN');
  assert.ok(origin);
  assert.match(origin.message, /^s2 from=drag app=com\.electron\.atrust window=3868 gen=1 decision=record$/);
  assert.equal(recording.captureWarnings.some(entry => entry.code === 'DRAG_SELECTS_TEXT'), false);

  // Two different text fields are two controls too: the drag keeps its gap.
  const data = fixture('drag-across-controls');
  const acrossFields = {
    ...data.events[1],
    to: [900, 374],
    path: [[700, 340], [850, 374]],
    toWindowNumber: 3868,
  };
  const second = new GlobalRecording(readerFor(data), { now: () => NOW });
  await second.add(parseCaptureEvent(data.events[0]));
  await second.add(parseCaptureEvent(acrossFields));
  const secondFlow = second.finish();
  assert.deepEqual(secondFlow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(secondFlow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(second.captureWarnings.some(entry => entry.code === 'DRAG_SELECTS_TEXT'), false);
});

test('a failed fallback tree read drops the text without adding a gap', async () => {
  const data = fixture('queue-overflow');
  const recording = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  // Past the startup window: these are real user events, not opening noise.
  for (const event of data.events) {
    await recording.add(parseCaptureEvent({ ...event, t: event.t + 1000 }));
  }
  const flow = recording.finish();
  // The helper's own queue gap stays; text that could not be bound does not add one.
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'CAPTURE_GAP');
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'STALE_CAPTURE'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_TEXT'));
});

// A double-click on a package in Finder's Downloads: the pointer evidence names
// the window and point, but reading that window's tree during the Installer
// hand-off fails. The click must stay a step, not become the empty gap run the
// user reported.
test('a click whose window tree cannot be read keeps its point and its count', async () => {
  const data = fixture('finder-downloads-pkg-click');
  const recording = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(flow.steps[0].target, { kind: 'point', point: [420, 300] });
  assert.equal(flow.steps[0].count, 2);
  assert.equal(flow.steps[0].scope.windowTitle, 'Downloads');
  assert.equal(flowV2Check.Check(flow), true);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'NATIVE_POINT_FALLBACK'));
  // No STALE_CAPTURE gap is left behind by the failed read.
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'STALE_CAPTURE'), false);
  // The point step is a normal, editable flow step: it parses and validates.
  const parsed = parseFlowV2(flow);
  assert.equal(parsed.steps[0].target.kind, 'point');
});

test('a click the helper saw on an element needs no tree read at all', async () => {
  const data = fixture('finder-downloads-pkg-click');
  const events = data.events.map(event => event.kind !== 'click' ? event : {
    ...event,
    owner: { ...event.owner, role: 'AXImage', name: 'Install Test.pkg' },
  });
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('a click with element evidence must not read the tree');
  }, { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  // The helper reports AX roles; a recorded target uses the snapshot vocabulary
  // so it can be resolved again against the window tree.
  assert.deepEqual(flow.steps[0].target, {
    kind: 'element', role: 'image', name: 'Install Test.pkg',
  });
  assert.equal(flow.steps[0].count, 2);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(recording.captureWarnings.some(warning => warning.code.startsWith('NATIVE_')), false);

  // A role without a name identifies nothing: the click keeps its point and
  // says so, instead of becoming an AXTextField that replay would guess at.
  const anonymous = data.events.map(event => event.kind !== 'click' ? event : {
    ...event, owner: { ...event.owner, role: 'AXTextField' },
  });
  let anonymousReads = 0;
  const second = new GlobalRecording(async () => {
    anonymousReads += 1;
    throw new Error('a click with element evidence must not read the tree');
  }, { now: () => NOW });
  for (const event of anonymous) await second.add(parseCaptureEvent(event));
  const unnamed = second.finish();
  assert.deepEqual(unnamed.steps[0].target, { kind: 'point', point: [420, 300] });
  assert.equal(unnamed.steps[0].count, 2);
  assert.ok(second.captureWarnings.some(warning => warning.code === 'UNTARGETED_FILE_CLICK'));
  assert.equal(second.captureWarnings.some(warning => warning.code === 'NATIVE_ELEMENT_FALLBACK'), false);
  // One fallback read per click, and no retry: the reader throwing twice is the
  // whole cost of two unnamed clicks.
  assert.equal(anonymousReads, 2);
  assert.equal(flowV2Check.Check(unnamed), true);
});

test('a click without element evidence still reads the tree for its target', async () => {
  const data = fixture('finder-downloads-pkg-click');
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps[0].target.kind, 'element');
  assert.equal(flow.steps[0].target.role, 'image');
  assert.equal(flow.steps[0].target.name, 'Install Test.pkg');
  assert.equal(flow.steps[0].count, 2);
  // One read for the window: the two clicks of the double-click share it.
  assert.equal(reads, 1);
});

test('a Finder file click records the file item, not the unnamed field under it', async () => {
  const flow = (await recordFixture('finder-folder-file-click')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  // The pointer hit the row's textfield; the target is the file the row names.
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'row', name: 'manifest.json' });
  assert.equal(flow.steps[0].count, 2);
  assert.equal(flowV2Check.Check(flow), true);
});

test('an item label that carries its name in its value still names the click', async () => {
  const data = fixture('finder-folder-file-click');
  const row = data.snapshots['11'].tree.children[0].children[0];
  delete row.name;
  row.children = [{
    role: 'statictext', value: 'manifest.json', ref: '@w11:e4',
    bounds: { x: 40, y: 42, width: 300, height: 20 }, states: [], secure: false, children: [],
  }];
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'statictext', name: 'manifest.json' });
});

test('a Finder list view click names the file, not its date, size or kind column', async () => {
  const flow = (await recordFixture('finder-list-view-file-click')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  // The row's own name joins every column; the click must record the file the
  // name column shows, or replay would click at a coordinate instead.
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'treeitem', name: 'manifest.json' });
  assert.equal(flow.steps[0].count, 2);
  assert.equal(flowV2Check.Check(flow), true);
});

test('a click on a Finder list view date column still names the file', async () => {
  const data = fixture('finder-list-view-file-click');
  for (const event of data.events) {
    if (event.kind === 'click') event.point = [360, 50];
  }
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'treeitem', name: 'manifest.json' });
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_FILE_CLICK'), false);
});

test('an icon view item keeps the name its single-cell row carries', async () => {
  const data = fixture('finder-folder-file-click');
  const row = data.snapshots['11'].tree.children[0].children[0];
  // Icon view: the row names the file, and its one cell only wraps the icon.
  row.children = [{
    role: 'cell', ref: '@w11:e4', bounds: { x: 20, y: 42, width: 60, height: 16 },
    states: [], secure: false,
    children: [{
      role: 'image', ref: '@w11:e7', bounds: { x: 20, y: 42, width: 16, height: 16 },
      states: [], secure: false, children: [],
    }],
  }];
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'row', name: 'manifest.json' });
});

test('a Finder click on an item with no name anywhere keeps its point and warns', async () => {
  const data = fixture('finder-folder-file-click');
  const outline = data.snapshots['11'].tree.children[0];
  for (const row of outline.children) delete row.name;
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'point', point: [250, 50] });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_FILE_CLICK'));
  assert.equal(flowV2Check.Check(flow), true);
});

test('a tree that cannot name the item falls back to the helper\'s named element evidence', async () => {
  const data = fixture('finder-folder-file-click');
  const outline = data.snapshots['11'].tree.children[0];
  for (const row of outline.children) delete row.name;
  const events = data.events.map(event => event.kind !== 'click' ? event : {
    ...event, owner: { ...event.owner, role: 'AXRow', name: 'manifest.json' },
  });
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('named element evidence must not read the tree');
  }, { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  // The helper named the row itself, so the tree that cannot name it is never
  // consulted and the click still becomes the file item.
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'row', name: 'manifest.json' });
  assert.equal(reads, 0);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_FILE_CLICK'), false);
});

test('a small list view still records the clicked element rather than a fallback', async () => {
  const data = fixture('two-apps-three-windows');
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('the click must use its own element evidence');
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent(data.events[0]));
  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.equal(flow.steps[0].kind, 'click');
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'Search' });
  assert.equal(recording.captureWarnings.some(warning => warning.code.startsWith('NATIVE_')), false);
});

// VS Code (Electron) exposes the editor as a textfield whose surface is a deep
// group, so a click lands on the group while the caret is in the textfield. The
// live flow recorded that group and lost every typed character to gaps.
const VSCODE_OWNER = {
  app: 'com.microsoft.VSCode', pid: 300, processInstance: 1_700_000_000_000,
  windowNumber: 33, windowTitle: 'manifest.json — saio_副本',
};
const EDITOR = { x: 300, y: 120, width: 900, height: 660 };

function vscodeContextLine(index) {
  return {
    role: 'group', name: `line-${index}`, ref: `@vscode:e${index + 20}`,
    bounds: { x: 300, y: 120 + index * 16, width: 900, height: 16 },
    states: [], secure: false, children: [],
  };
}

function vscodeSnapshot({ focused = true, field = EDITOR } = {}) {
  // A large tree: a sidebar of unrelated surfaces plus forty editor rows. Only
  // the row under the click overlaps the point, so the hit is unambiguous.
  const sidebar = Array.from({ length: 120 }, (_, index) => ({
    role: 'group', name: `sidebar-${index}`, ref: `@vscode:e${index + 200}`,
    bounds: { x: 0, y: index * 7, width: 300, height: 7 },
    states: [], secure: false, children: [],
  }));
  return {
    windowId: 'w-33',
    tree: {
      role: 'window', name: 'manifest.json — saio_副本', ref: '@vscode:e1',
      bounds: { x: 0, y: 0, width: 1400, height: 900 }, states: [], secure: false,
      children: [
        {
          role: 'group', name: 'sidebar', ref: '@vscode:e2',
          bounds: { x: 0, y: 0, width: 300, height: 900 }, states: [], secure: false, children: sidebar,
        },
        {
          role: 'group', name: 'editor', ref: '@vscode:e3', bounds: EDITOR, states: [], secure: false,
          children: [{
            role: 'textfield', name: 'manifest.json', ref: '@vscode:e4', bounds: field,
            states: focused ? ['focused'] : [], secure: false,
            children: [{
              role: 'group', name: 'text surface', ref: '@vscode:e5', bounds: EDITOR,
              states: [], secure: false,
              children: Array.from({ length: 40 }, (_, index) => vscodeContextLine(index)),
            }],
          }],
        },
      ],
    },
  };
}

function vscodeEvent(kind, t, extra = {}) {
  return { kind, t, seen: NOW, focusGeneration: 1, secure: false, owner: VSCODE_OWNER, ...extra };
}

const EDITOR_POINT = [700, 400];

function vscodeRecording(reader, options = {}) {
  return new GlobalRecording(reader, { now: () => NOW, ...options });
}

test('an editor click inside the focused textfield records the field, not the group under the pointer', async () => {
  const snapshot = vscodeSnapshot();
  const recording = vscodeRecording(async () => structuredClone(snapshot));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs' })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 260, { chars: 'Zq-vs' })));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  // Both keystrokes are one parameterised type step against the same field.
  assert.deepEqual(flow.steps[1].target, flow.steps[0].target);
  assert.equal(flow.steps[1].input, 'text_1');
  assert.deepEqual(flow.inputs, ['text_1']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'FOCUSED_EDITABLE_TARGET'));
  assert.ok(!JSON.stringify(flow).includes('Zq-vs'));
});

// The helper reports the focused control on every text event, so the container
// a click hit is corrected without losing the characters. The click itself
// still reads the tree once for identity (the group names nothing); the read
// failing costs a point, which the text evidence then replaces.
const EDITOR_FOCUS = {
  role: 'AXTextField', name: 'manifest.json', editable: true, bounds: [300, 120, 900, 660],
};

test('a container click whose tree read fails is retargeted from the text event focus evidence', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('the container names nothing, so the tree read cannot answer');
  });
  for (const event of [
    vscodeEvent('click', 100, {
      point: EDITOR_POINT, decision: 'record', owner: { ...VSCODE_OWNER, role: 'AXGroup' },
    }),
    vscodeEvent('text', 200, { chars: 'Zq-vs', focus: EDITOR_FOCUS }),
    vscodeEvent('text', 260, { chars: 'Zq-vs', focus: EDITOR_FOCUS }),
  ]) await recording.add(parseCaptureEvent(event));

  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.deepEqual(flow.steps[1].target, flow.steps[0].target);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_RETARGETED_TO_TEXT'));
});

// VS Code's editor is an AXTextArea to the helper, but the desktop driver has a
// single editable role: its own filters fold textarea, textbox and searchfield
// into `textfield`, and the 121 snapshots taken on this machine contain
// `textfield` only. The recorded target has to use that spelling to resolve.
test('an AXTextArea focus records the driver textfield role and resolves at replay', async () => {
  const area = { role: 'AXTextArea', name: 'manifest.json', editable: true, bounds: [300, 120, 900, 660] };
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('the container names nothing, so the tree read cannot answer');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, {
    point: EDITOR_POINT, decision: 'record', owner: { ...VSCODE_OWNER, role: 'AXGroup' },
  })));
  for (const [t, chars] of [[200, 'a'], [240, 'b'], [280, 'c']]) {
    await recording.add(parseCaptureEvent(vscodeEvent('text', t, { chars, focus: area })));
  }

  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  const expected = { kind: 'element', role: 'textfield', name: 'manifest.json' };
  assert.deepEqual(flow.steps[0].target, expected);
  assert.deepEqual(flow.steps[1].target, expected);
  // The point proven by those chars: the recorded target finds the text area in
  // a snapshot of the same window, so replay never falls back to a coordinate.
  const snapshot = {
    windowId: 'w-33',
    tree: {
      role: 'window', name: 'manifest.json — saio_副本', states: [], secure: false, children: [{
        role: 'textfield', name: 'manifest.json', ref: '@vscode:e4', bounds: EDITOR,
        states: ['focused'], secure: false, children: [],
      }],
    },
  };
  assert.equal(resolve(snapshot, flow.steps[1].target).node.role, 'textfield');
});

test('a click that carries focus evidence binds the field at click time, with no read', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('focus evidence must be enough');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXGroup' }, focus: EDITOR_FOCUS,
  })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs', focus: EDITOR_FOCUS })));

  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'FOCUSED_EDITABLE_TARGET'));
});

test('ten typed characters bind from focus evidence with no read and under 50 ms', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('the fast path must not read the tree');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 90, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'manifest.json' },
  })));
  const started = performance.now();
  for (let index = 0; index < 10; index += 1) {
    await recording.add(parseCaptureEvent(vscodeEvent('text', 100 + index * 60, {
      chars: 'a', focus: EDITOR_FOCUS,
    })));
  }
  const elapsed = performance.now() - started;

  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.ok(elapsed < 50, `ten characters took ${elapsed.toFixed(1)} ms`);
  // Three backspaces after the burst stay their own parameterless steps.
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('a fallback focus read is reused by every later character of the burst', async () => {
  const snapshot = vscodeSnapshot();
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    return structuredClone(snapshot);
  });
  for (let index = 0; index < 6; index += 1) {
    await recording.add(parseCaptureEvent(vscodeEvent('text', 200 + index * 60, { chars: 'a' })));
  }
  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('one failed fallback read does not cascade into the next characters', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('snapshot unavailable');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'a' })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 300, { chars: 'a', focus: EDITOR_FOCUS })));
  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_TEXT'));
});

test('a large tree that answers past the pointer budget still binds the typed characters', async () => {
  const snapshot = vscodeSnapshot();
  let clock = NOW;
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    // The text read needs 2.4s: past the 2s pointer budget, inside the text budget.
    if (reads === 2) clock += 2400;
    return structuredClone(snapshot);
  }, { now: () => clock });
  for (const event of [
    vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' }),
    vscodeEvent('text', 200, { chars: 'Zq-vs' }),
    vscodeEvent('text', 260, { chars: 'Zq-vs' }),
  ]) await recording.add(parseCaptureEvent(event));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.equal(flow.steps[1].target.name, 'manifest.json');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('typing keeps its target from the click when no window tree can be read at all', async () => {
  const recording = vscodeRecording(async () => {
    throw new Error('snapshot unavailable');
  });
  for (const event of [
    vscodeEvent('click', 100, {
      point: EDITOR_POINT, decision: 'record',
      owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'manifest.json' },
    }),
    vscodeEvent('text', 200, { chars: 'Zq-vs' }),
    vscodeEvent('key', 400, { key: 'backspace', modifiers: [] }),
    vscodeEvent('text', 500, { chars: 'Zq-vs' }),
  ]) await recording.add(parseCaptureEvent(event));

  const flow = recording.finish();
  // The editing key splits the burst but never costs the characters.
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type', 'key', 'type']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.deepEqual(flow.steps[3].target, flow.steps[1].target);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'TEXT_TARGET_FROM_CLICK'));
});

test('a focus change between fields starts a new type step from evidence, with no read', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('focus evidence must be enough');
  });
  const other = { role: 'AXTextField', name: 'settings.json', editable: true, bounds: [100, 700, 400, 40] };
  await recording.add(parseCaptureEvent(vscodeEvent('text', 100, { chars: 'a', focus: EDITOR_FOCUS })));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 200, {
    point: [200, 720], decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'settings.json' },
  })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 300, { chars: 'b', focus: other })));
  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'click', 'type']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.deepEqual(flow.steps[2].target, { kind: 'element', role: 'textfield', name: 'settings.json' });
  assert.notEqual(flow.steps[0].input, flow.steps[2].input);
});

// aTrust is an Electron app: AXUIElementCopyElementAtPosition answers with an
// anonymous group above the control, so the click itself names nothing. The
// window tree the driver reads does carry the button, and that read is what
// turns the click into an element target instead of a point a dry run rejects.
const ATRUST_OWNER = {
  app: 'com.electron.atrust', pid: 500, processInstance: 1_700_000_000_500,
  windowNumber: 44, windowTitle: 'aTrust',
};

test('an anonymous Electron container click reads the tree and binds the named control', async () => {
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1',
      bounds: { x: 400, y: 200, width: 800, height: 640 }, states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@atrust:e2',
        bounds: { x: 400, y: 200, width: 800, height: 640 }, states: [], secure: false,
        children: [
          {
            role: 'textfield', name: '请输入账号', ref: '@atrust:e3',
            bounds: { x: 520, y: 380, width: 500, height: 40 }, states: [], secure: false, children: [],
          },
          {
            role: 'button', name: '登录', ref: '@atrust:e4',
            bounds: { x: 520, y: 480, width: 500, height: 80 }, states: [], secure: false, children: [],
          },
        ],
      }],
    },
  };
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    return structuredClone(snapshot);
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [620, 520], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps[0].target.kind, 'element');
  assert.equal(flow.steps[0].target.role, 'button');
  assert.equal(flow.steps[0].target.name, '登录');
  assert.equal(flow.steps[0].target.point, undefined);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

// A click that opens a sheet or switches the page changes the screen before
// its own tree read can run, so the click's element is only in the tree from
// before it. That tree is read right after the previous click and is what
// names the click that would otherwise keep a point a dry run rejects.
test('a click that changes the page is named from the tree read before it', async () => {
  const windowBounds = { x: 400, y: 200, width: 800, height: 500 };
  const pageWithSidebar = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@atrust:e2', bounds: windowBounds, states: [], secure: false,
          children: [
            {
              role: 'button', name: '设置', ref: '@atrust:e3',
              bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
            },
          ],
        },
      ],
    },
  };
  const settingsPage = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@atrust:e2', bounds: windowBounds, states: [], secure: false,
          children: [
            {
              role: 'group', name: 'https://sdpc.sangfor.com:6440', ref: '@atrust:e3',
              bounds: { x: 699, y: 246, width: 175, height: 24 }, states: [], secure: false,
              children: [{
                role: 'statictext', name: 'https://sdpc.sangfor.com:6440', ref: '@atrust:e4',
                bounds: { x: 699, y: 249, width: 175, height: 17 }, states: [], secure: false, children: [],
              }],
            },
          ],
        },
      ],
    },
  };
  const sheetOpen = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@atrust:e2', bounds: { x: 600, y: 300, width: 400, height: 200 },
          states: [], secure: false, children: [],
        },
      ],
    },
  };

  let screen = pageWithSidebar;
  const settles = [];
  const recording = new GlobalRecording(async () => structuredClone(screen), {
    now: () => NOW,
    scheduleSettle: task => { settles.push(task); },
  });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW + 1000, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  // The sidebar click opened the settings page; the reads after it see that page.
  screen = settingsPage;
  for (const task of settles.splice(0)) await task();

  // The next click opens the address sheet, so nothing is at its point any more.
  screen = sheetOpen;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW + 2000, focusGeneration: 1, secure: false,
    point: [821, 256], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'button', name: '设置' });
  const target = flow.steps[1].target;
  assert.equal(target.kind, 'element');
  assert.equal(target.name, 'https://sdpc.sangfor.com:6440');
  assert.equal(target.point, undefined);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_FROM_SETTLED_TREE'));
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

// Reading an Electron window can take most of a second. The tree such a read
// returns is the screen the walk started on, so a read that began before the
// next click is that click's screen even though it only finished after it.
test('a tree read that began before the click names it even when it finished after', async () => {
  const windowBounds = { x: 400, y: 200, width: 800, height: 500 };
  const pageWithSidebar = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@atrust:e2', bounds: windowBounds, states: [], secure: false,
          children: [
            {
              role: 'button', name: '设置', ref: '@atrust:e3',
              bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
            },
          ],
        },
      ],
    },
  };
  const settingsPage = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@atrust:e2', bounds: windowBounds, states: [], secure: false,
          children: [
            {
              role: 'group', name: 'https://sdpc.sangfor.com:6440', ref: '@atrust:e3',
              bounds: { x: 699, y: 246, width: 175, height: 24 }, states: [], secure: false,
              children: [{
                role: 'statictext', name: 'https://sdpc.sangfor.com:6440', ref: '@atrust:e4',
                bounds: { x: 699, y: 249, width: 175, height: 17 }, states: [], secure: false, children: [],
              }],
            },
          ],
        },
      ],
    },
  };
  const sheetOpen = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@atrust:e2', bounds: { x: 600, y: 300, width: 400, height: 200 },
        states: [], secure: false, children: [],
      }],
    },
  };

  let clock = NOW;
  let slow = false;
  let screen = pageWithSidebar;
  const settles = [];
  const recording = new GlobalRecording(async () => {
    // The walk runs long: by the time it returns, the next click has arrived.
    if (slow) clock = NOW + 1150;
    return structuredClone(screen);
  }, { now: () => clock, scheduleSettle: task => { settles.push(task); } });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW + 100, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '设置' },
  }));
  // The sidebar click opened the settings page, and its settle read starts at
  // NOW+350 but only finishes at NOW+1150 — after the next click at NOW+400.
  screen = settingsPage;
  slow = true;
  // Both settle reads the click scheduled start together at NOW+350; the clock
  // only moves when a read returns, so each one still starts before the click.
  for (const task of settles.splice(0)) { clock = NOW + 350; await task(); }
  slow = false;

  screen = sheetOpen;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW + 400, focusGeneration: 1, secure: false,
    point: [721, 258], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  const target = flow.steps[1].target;
  assert.equal(target.kind, 'element');
  assert.equal(target.role, 'statictext');
  assert.equal(target.name, 'https://sdpc.sangfor.com:6440');
  assert.equal(target.point, undefined);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_FROM_SETTLED_TREE'));
  assert.equal(flowV2Check.Check(flow), true);
});

// A click can arrive while the read taken after the previous click is still
// walking the page it just drew. That read describes this click's screen, so
// the click finishes it before naming itself instead of falling back to a point.
test('a click waits for the read already walking its page', async () => {
  const windowBounds = { x: 400, y: 100, width: 900, height: 600 };
  const wrap = children => ({
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children,
    },
  });
  const settingsPage = wrap([{
    role: 'group', name: '添加地址', ref: '@atrust:e2',
    bounds: { x: 700, y: 240, width: 120, height: 32 }, states: [], secure: false, children: [],
  }]);
  const stillEmpty = wrap([]);

  let release;
  let read = 0;
  const settles = [];
  const recording = new GlobalRecording(async () => {
    read += 1;
    // The read taken after the settings click is still under way when the next
    // click arrives, and the click's own read sees an empty frame.
    if (read === 1) return new Promise(resolve => { release = () => resolve(structuredClone(settingsPage)); });
    return structuredClone(stillEmpty);
  }, { now: () => NOW, scheduleSettle: task => settles.push(task) });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '设置' },
  }));
  const walking = settles.shift()();
  await Promise.resolve();

  const adding = recording.add(parseCaptureEvent({
    kind: 'click', t: 1900, seen: NOW + 100, focusGeneration: 1, secure: false,
    point: [760, 256], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  await Promise.resolve();
  release();
  await adding;
  await walking;

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'group', name: '添加地址' });
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

// In an Electron page a control is often a container with no action reference.
// A click on its padding used to look like a click on empty space, which made
// naming depend on which pixel of the control the pointer happened to land on.
test('a click inside a control that carries no action reference is named by its container', async () => {
  const tree = {
    role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: { x: 400, y: 100, width: 900, height: 600 },
    states: [], secure: false, children: [{
      // Neither the control nor the card around it carries an action reference.
      role: 'group', name: '接入地址',
      bounds: { x: 600, y: 200, width: 400, height: 200 }, states: [], secure: false,
      children: [{
        role: 'group', bounds: { x: 610, y: 210, width: 380, height: 40 },
        states: [], secure: false, children: [],
      }],
    }],
  };
  const recording = new GlobalRecording(
    async () => ({ windowId: 'w-44', tree: structuredClone(tree) }),
    { now: () => NOW },
  );
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 400, seen: NOW, focusGeneration: 1, secure: false,
    point: [700, 225], decision: 'record',
    owner: { ...ATRUST_OWNER, windowNumber: 44, windowTitle: 'aTrust', role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'group', name: '接入地址' });
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'), false);
  // The recorded control and every container above it carry no action
  // reference, so replay can only click its centre as physical input. The
  // recording says that up front instead of promising a semantic press.
  const unpressable = recording.captureWarnings.find(warning => warning.code === 'CLICK_TARGET_UNPRESSABLE');
  assert.ok(unpressable, JSON.stringify(recording.captureWarnings));
  assert.match(unpressable.message, /group "接入地址"/);
  assert.match(unpressable.message, /click its centre as physical input/);
  assert.equal(flowV2Check.Check(flow), true);
});

// The same Electron shape, but the named container is pressable: the step stays
// a semantic press and the recording must not warn about a physical fallback.
test('a click named by a container that is itself pressable needs no unpressable warning', async () => {
  const tree = {
    role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: { x: 400, y: 100, width: 900, height: 600 },
    states: [], secure: false, children: [{
      role: 'group', name: '接入地址', ref: '@atrust:e2',
      bounds: { x: 600, y: 200, width: 400, height: 200 }, states: [], secure: false,
      actions: ['Press'],
      children: [{
        role: 'group', bounds: { x: 610, y: 210, width: 380, height: 40 },
        states: [], secure: false, children: [],
      }],
    }],
  };
  const recording = new GlobalRecording(
    async () => ({ windowId: 'w-44', tree: structuredClone(tree) }),
    { now: () => NOW },
  );
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 400, seen: NOW, focusGeneration: 1, secure: false,
    point: [700, 225], decision: 'record',
    owner: { ...ATRUST_OWNER, windowNumber: 44, windowTitle: 'aTrust', role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'group', name: '接入地址' });
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'CLICK_TARGET_UNPRESSABLE'), false);
});

// An app that hides its window when it loses focus hands it a new number each
// time. A read of the old window must not become a gap the flow can never close.
test('a read of a window that was replaced is skipped instead of becoming a gap', async () => {
  const recording = new GlobalRecording(async () => {
    throw new Fault('WINDOW_NOT_FOUND', 'agent-desktop snapshot returned WINDOW_NOT_FOUND');
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [700, 240], decision: 'record',
    owner: { ...ATRUST_OWNER, windowNumber: 44, windowTitle: 'aTrust', role: 'AXButton', name: '连接' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 300, seen: NOW + 50, focusGeneration: 1, secure: false,
    point: [760, 256], dwellMs: 320,
    owner: { ...ATRUST_OWNER, windowNumber: 44, windowTitle: 'aTrust', role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'WINDOW_REPLACED'));
});

// A click on the desktop or another window-less surface has no window a replay
// could look in. After the recording has started such a click is not part of
// the flow: keeping it as a gap would block every addressable step around it.
test('a click outside every window after a recorded step is dropped, not a gap', async () => {
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1',
      bounds: { x: 400, y: 200, width: 800, height: 500 }, states: [], secure: false,
      children: [{
        role: 'button', name: '设置', ref: '@atrust:e2',
        bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
      }],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '设置' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW, focusGeneration: 1, secure: false,
    point: [40, 900], decision: 'record', owner: {},
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_OUTSIDE_WINDOW'));
  assert.equal(flowV2Check.Check(flow), true);
});

// The first click on a window that is not focused yet is the press macOS
// swallows to bring the window forward. The focus notification that follows
// proves it did nothing, so it becomes the window activation, not a gap.
test('a click on a window that is not focused yet becomes its activation, not a gap', async () => {
  const recording = new GlobalRecording(async () => assert.fail('no window tree expected'), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, focusGeneration: 1, secure: false,
    point: [500, 300], decision: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 12, windowTitle: '下载', role: 'AXRow', pressable: true,
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 260, seen: NOW, focusGeneration: 2, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 12, windowTitle: '下载',
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['focus_window']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_ONLY_ACTIVATED_WINDOW'));
  assert.equal(flowV2Check.Check(flow), true);
});

// global-4f702beb / global-6fad6ee0 in one fixture: the press on the window that
// is not focused yet, the focus that proves it only brought the window forward,
// and the hover that follows. The gap the user sees must not come from any of
// these events.
test('a press before its window is focused becomes activate_app with no gap, and the hover adds no click', async () => {
  const flow = (await recordFixture('cross-app-press-before-activation')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'hover']);
  assert.equal(flow.steps[1].scope.app, 'com.electron.atrust');
  // The press was swallowed by the activation; replay must not click it, and
  // the flow must not need a gap resolution before it can run.
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 1);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// The literal sequence in the native order: a press on a window that is not
// focused yet, a hover 365 ms later (the helper needs a 300 ms dwell and resets
// it on the button event), then the focus that proves the press only brought the
// window forward. The hover must not settle the press — settling it here records
// a click the user never made — and the focus must still navigate exactly once.
test('a press, a hover, then the focus: one navigation, no invented click', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '设置', ref: '@w21:e2',
          bounds: { x: 950, y: 100, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const settles = [];
  const recording = new GlobalRecording(
    async window => structuredClone(windows[window.windowNumber]),
    { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
  );
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  const drain = async () => { while (settles.length) await settles.shift()(); };

  // The recording starts in aTrust, so that window's tree is the screen the
  // press will be looked up in: a click in it leaves one settled read behind.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [1090, 112], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台', pressable: false }),
  }));
  await drain();
  // The user moves to Finder and works there.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 300, seen: NOW, focusGeneration: 2, secure: false,
    owner: owner('com.apple.finder', 100, 11, '图片'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 400, seen: NOW, point: [340, 290], count: 1,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: owner('com.apple.finder', 100, 11, '图片', { role: 'AXCell', name: '下载', pressable: true }),
  }));
  // Back to aTrust: the first press is swallowed by the window activation. The
  // helper proves the window but not the control under the pointer, so the press
  // arrives with Quartz window identity only and a gap decision.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 5435, seen: NOW, point: [990, 112], count: 1,
    focusGeneration: 2, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  // The press is held, and the pointer passes back over the still-focused
  // Finder window before aTrust is proved frontmost: the hover arrives between
  // the press and the focus that settles it, after a full dwell.
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 5800, seen: NOW, point: [340, 290], dwellMs: 365,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: owner('com.apple.finder', 100, 11, '图片', { role: 'AXCell', name: '下载', pressable: true }),
  }));
  // The focus that proves the press only brought aTrust forward.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 5900, seen: NOW, focusGeneration: 3, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  // The hover the pointer settles on once aTrust is frontmost, a dwell later.
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 6300, seen: NOW, point: [990, 112], dwellMs: 400,
    focusGeneration: 3, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '设置' }),
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click', 'activate_app', 'hover']);
  assert.deepEqual(flow.steps.slice(1, 4).map(step => step.scope.app), [
    'com.apple.finder', 'com.apple.finder', 'com.electron.atrust',
  ]);
  // The held press is the one that activated aTrust: nothing records a click in
  // aTrust for it, so the recording holds exactly the two presses the user made.
  assert.deepEqual(flow.steps.filter(step => step.kind === 'click').map(step => step.scope.app), [
    'com.electron.atrust', 'com.apple.finder',
  ]);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_ONLY_ACTIVATED_WINDOW'));
  // The press is never named from the screen that was read before it, and the
  // hover is not replayed before the press is settled.
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_FROM_SETTLED_TREE'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'HOVER_WHILE_CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// A press inside the window the flow already stands in cannot be the press that
// activated it, and a focus the press did not cause cannot erase it. Three native
// shapes: Cmd+Tab (a boundary plus two focus lines), an excursion the helper
// reported as two focus lines, and a late focus on the same window whose earlier
// excursion was never reported (a silent switch while paused). In all three the
// press stays, before the first navigation the excursion caused.
test('an unrelated focus never erases the press it did not cause', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '工作台', ref: '@w21:e2',
          bounds: { x: 990, y: 100, width: 120, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  const press = (t) => ({
    kind: 'click', t, seen: NOW, point: [1000, 112], count: 1,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    // The helper knew the window and the generation, but its AX read of the
    // element contradicted the Quartz window, so no role or name is reported.
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  });
  const hoverInTrust = (t) => ({
    kind: 'hover', t, seen: NOW, point: [1000, 112], dwellMs: 400,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台' }),
  });
  const record = async (extra, { boundary = false } = {}) => {
    const settles = [];
    const recording = new GlobalRecording(
      async window => structuredClone(windows[window.windowNumber]),
      { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
    );
    // The recording stands in aTrust with one recorded press, so the flow is
    // already in the window the next press lands in.
    await recording.add(parseCaptureEvent({
      kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
      owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
    }));
    await recording.add(parseCaptureEvent({
      kind: 'click', t: 100, seen: NOW, point: [1000, 112], count: 1,
      focusGeneration: 1, secure: false, decision: 'record',
      owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台', pressable: false }),
    }));
    while (settles.length) await settles.shift()();
    await recording.add(parseCaptureEvent(press(1200)));
    await recording.add(parseCaptureEvent(hoverInTrust(1600)));
    if (boundary) recording.noteBoundary();
    for (const event of extra) await recording.add(parseCaptureEvent(event));
    return { flow: recording.finish(), recording };
  };

  const kindsOf = flow => flow.steps.map(step => step.kind);
  const firstNavigation = flow => flow.steps.findIndex(step => step.kind === 'activate_app');

  // 1. Cmd+Tab: the helper emits a boundary for the switcher and then two focus
  //    notifications. The press must be recorded before the first navigation.
  const viaSwitcher = await record([
    { kind: 'focus', t: 1700, seen: NOW, focusGeneration: 2, secure: false,
      owner: owner('com.apple.finder', 100, 11, '图片') },
    { kind: 'focus', t: 1800, seen: NOW, focusGeneration: 3, secure: false,
      owner: owner('com.electron.atrust', 200, 21, 'aTrust') },
  ], { boundary: true });
  assert.deepEqual(kindsOf(viaSwitcher.flow), ['click', 'click', 'activate_app', 'activate_app']);
  assert.equal(firstNavigation(viaSwitcher.flow), 2);
  assert.equal(viaSwitcher.flow.steps[1].scope.app, 'com.electron.atrust');
  assert.equal(viaSwitcher.recording.captureWarnings.some(warning => warning.code === 'CLICK_ONLY_ACTIVATED_WINDOW'), false);
  assert.equal(viaSwitcher.flow.steps.some(step => step.kind === 'gap'), false);
  assert.doesNotThrow(() => parseFlowV2(viaSwitcher.flow));

  // 2. The same excursion without a boundary: the helper reported both focus
  //    changes, so the press is settled by the first one that left its window.
  const viaFocus = await record([
    { kind: 'focus', t: 1700, seen: NOW, focusGeneration: 2, secure: false,
      owner: owner('com.apple.finder', 100, 11, '图片') },
    { kind: 'focus', t: 1800, seen: NOW, focusGeneration: 3, secure: false,
      owner: owner('com.electron.atrust', 200, 21, 'aTrust') },
  ]);
  assert.deepEqual(kindsOf(viaFocus.flow), ['click', 'click', 'activate_app', 'activate_app']);
  assert.equal(firstNavigation(viaFocus.flow), 2);

  // 3. A silent excursion (a switch while paused): only the late focus on the
  //    press's own window arrives, so nothing can be concluded about the press.
  const lateFocus = await record([
    { kind: 'focus', t: 1700, seen: NOW, focusGeneration: 3, secure: false,
      owner: owner('com.electron.atrust', 200, 21, 'aTrust') },
  ]);
  assert.deepEqual(kindsOf(lateFocus.flow), ['click', 'click']);
  assert.equal(lateFocus.recording.captureWarnings.some(warning => warning.code === 'CLICK_ONLY_ACTIVATED_WINDOW'), false);
  assert.equal(lateFocus.flow.steps.some(step => step.kind === 'gap'), false);
  assert.doesNotThrow(() => parseFlowV2(lateFocus.flow));
});

// While paused the focus moves on without a line, and the flow keeps standing in
// the window it last recorded. The first press after resume is then a real
// activation press on a window the flow already stands in — the window identity
// confirmed for the press's own generation is what says whether that window was
// already focused, not the flow's last scope. It must be dropped as activation,
// never recorded as a second click.
test('a press after a silent focus change is still the activation it was', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '工作台', ref: '@w21:e2',
          bounds: { x: 990, y: 100, width: 120, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const settles = [];
  const recording = new GlobalRecording(
    async window => structuredClone(windows[window.windowNumber]),
    { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
  );
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [1000, 112], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台', pressable: false }),
  }));
  while (settles.length) await settles.shift()();
  // Paused: the front app becomes Finder and the generation advances, but the
  // helper reports no focus line (noteFocus does not report while paused).
  // Resume: the first press goes back to aTrust, so it activates it.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 900, seen: NOW, point: [1000, 112], count: 1,
    focusGeneration: 2, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  // The focus the activation produced, with the full window identity.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 1000, seen: NOW, focusGeneration: 3, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps[0].target.name, '工作台');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_ONLY_ACTIVATED_WINDOW'));
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_FROM_SETTLED_TREE'), false);
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// A right click that could not be proven must stay blocking evidence. Writing it
// as a click would replay it as a left press, and replay addresses a right click
// through the control the previous left click selected — pressing something the
// user never touched.
test('an unproven right click blocks instead of becoming a left click', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '工作台', ref: '@w21:e2',
          bounds: { x: 990, y: 100, width: 120, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const settles = [];
  const recording = new GlobalRecording(
    async window => structuredClone(windows[window.windowNumber]),
    { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
  );
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [1000, 112], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台', pressable: false }),
  }));
  while (settles.length) await settles.shift()();
  // The same window, second button: the helper accepts the right press but
  // cannot prove the control under it.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [1000, 112], count: 1, button: 'right',
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));
  // Cmd+Tab: the switcher is a capture boundary, then the two focus lines.
  recording.noteBoundary();
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 300, seen: NOW, focusGeneration: 2, secure: false,
    owner: owner('com.apple.finder', 100, 11, '图片'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 400, seen: NOW, focusGeneration: 3, secure: false,
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'activate_app']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  // No second click, left or otherwise.
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 1);
  assert.equal(flow.steps.some(step => step.button !== undefined), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'RIGHT_CLICK_UNPROVEN'));
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

// The gap a settled press leaves is the press's gap: it keeps the press's own
// time and its own window evidence, not those of the focus or hover that merely
// triggered the settlement. Otherwise the diagnostic that is meant to locate a
// real gap would blame the wrong event at the wrong moment.
test('a settled right press keeps its own time and origin in the gap report', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '工作台', ref: '@w21:e2',
          bounds: { x: 990, y: 100, width: 120, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  const build = () => {
    const settles = [];
    const recording = new GlobalRecording(
      async window => structuredClone(windows[window.windowNumber]),
      { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
    );
    return { recording, settles };
  };
  const press = {
    kind: 'click', t: 1100, seen: NOW, point: [1000, 112], count: 1, button: 'right',
    focusGeneration: 2, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
  };
  const open = async ({ recording, settles }) => {
    await recording.add(parseCaptureEvent({
      kind: 'focus', t: 0, seen: NOW, focusGeneration: 2, secure: false,
      owner: owner('com.electron.atrust', 200, 21, 'aTrust'),
    }));
    await recording.add(parseCaptureEvent({
      kind: 'click', t: 0, seen: NOW, point: [1000, 112], count: 1,
      focusGeneration: 2, secure: false, decision: 'record',
      owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台', pressable: false }),
    }));
    while (settles.length) await settles.shift()();
    await recording.add(parseCaptureEvent(press));
  };
  const originOf = recording => recording.captureWarnings
    .find(warning => warning.code === 'CAPTURE_GAP_ORIGIN')?.message;

  // Settled by another app's focus, 700 ms after the press.
  const viaFocus = build();
  await open(viaFocus);
  await viaFocus.recording.add(parseCaptureEvent({
    kind: 'focus', t: 1800, seen: NOW, focusGeneration: 3, secure: false,
    owner: owner('com.apple.finder', 100, 11, '图片'),
  }));
  const focusFlow = viaFocus.recording.finish();
  assert.deepEqual(focusFlow.steps.map(step => step.kind), ['click', 'gap', 'activate_app']);
  assert.equal(focusFlow.steps[1].atMs, 1100);
  assert.match(originOf(viaFocus.recording), /^s2 from=click app=com\.electron\.atrust window=21 gen=2 decision=gap$/);
  assert.throws(() => parseFlowV2(focusFlow), { code: 'CAPTURE_GAP' });

  // Settled by the end of the recording after a hover: the hover is not blamed.
  const viaHover = build();
  await open(viaHover);
  await viaHover.recording.add(parseCaptureEvent({
    kind: 'hover', t: 1500, seen: NOW, point: [1000, 112], dwellMs: 400,
    focusGeneration: 2, secure: false, decision: 'record',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', name: '工作台' }),
  }));
  const hoverFlow = viaHover.recording.finish();
  assert.deepEqual(hoverFlow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(hoverFlow.steps[1].atMs, 1100);
  assert.match(originOf(viaHover.recording), /^s2 from=click app=com\.electron\.atrust window=21 gen=2 decision=gap$/);
  assert.ok(!originOf(viaHover.recording).includes('from=hover'));
  assert.throws(() => parseFlowV2(hoverFlow), { code: 'CAPTURE_GAP' });
});

// The hover exemption is not a way to drop presses. A hover inside the press's
// own generation proves nothing about it either, so it is skipped and the press
// keeps its own evidence: it is still recorded where it landed, exactly once.
test('a hover in the press generation never settles the held press', async () => {
  const snapshot = {
    windowId: 'w-11',
    tree: {
      role: 'window', name: 'client', ref: '@finder:e1',
      bounds: { x: 400, y: 200, width: 800, height: 500 }, states: [], secure: false,
      children: [{
        role: 'button', name: '刷新', ref: '@finder:e2',
        bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
      }],
    },
  };
  const settles = [];
  const recording = new GlobalRecording(
    async () => structuredClone(snapshot),
    { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
  );
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false, owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }));
  while (settles.length) await settles.shift()();
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 300, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: { ...window, role: 'AXRow', pressable: true },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 340, seen: NOW, point: [450, 250], dwellMs: 300,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  // The press is kept from the tree that was on screen before it, once.
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'button', name: '刷新' });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'HOVER_WHILE_CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
});

// A hover that proves nothing about the held press is skipped, never used as
// the event that settles it: settling there would emit a navigation back to
// whichever window the pointer drifted over.
test('a hover elsewhere does not settle the held press or navigate to it', async () => {
  const windows = {
    11: {
      windowId: 'w-11',
      tree: {
        role: 'window', name: '图片', ref: '@w11:e1',
        bounds: { x: 0, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@w11:e2',
          bounds: { x: 300, y: 280, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
    21: {
      windowId: 'w-21',
      tree: {
        role: 'window', name: 'aTrust', ref: '@w21:e1',
        bounds: { x: 900, y: 0, width: 800, height: 600 }, states: [], secure: false,
        children: [{
          role: 'group', name: '设置', ref: '@w21:e2',
          bounds: { x: 950, y: 100, width: 80, height: 24 }, states: [], secure: false, children: [],
        }],
      },
    },
  };
  const recording = new GlobalRecording(
    async window => structuredClone(windows[window.windowNumber]), { now: () => NOW },
  );
  const owner = (app, pid, windowNumber, title, extra = {}) => ({
    app, pid, processInstance: 1700000000000, windowNumber, windowTitle: title, ...extra,
  });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: owner('com.apple.finder', 100, 11, '图片'),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [340, 290], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.apple.finder', 100, 11, '图片', { role: 'AXCell', name: '下载', pressable: true }),
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [990, 112], count: 1,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: owner('com.electron.atrust', 200, 21, 'aTrust', { role: 'AXGroup', pressable: false }),
  }));
  // The pointer drifts back over the still-focused Finder window.
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 240, seen: NOW, point: [340, 290], dwellMs: 300,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: owner('com.apple.finder', 100, 11, '图片', { role: 'AXCell', name: '下载', pressable: true }),
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click']);
  assert.equal(flow.steps.filter(step => step.kind === 'activate_app').length, 1);
  assert.equal(flow.steps[1].scope.app, 'com.electron.atrust');
  assert.equal(flow.steps.some(step => step.kind === 'hover'), false);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'HOVER_WHILE_CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
});

// A hover is read-only. When the helper could not attribute it, recording a gap
// blocks every replay over a step no replay could perform; the warning is the
// honest record that the dwell was skipped.
test('a hover that names no window is skipped instead of blocking the flow', async () => {
  const recording = new GlobalRecording(async () => assert.fail('no window tree expected'), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 160, seen: NOW, point: [900, 900], dwellMs: 300,
    focusGeneration: 1, secure: false, decision: 'record', owner: {},
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_HOVER'));
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// The same rule for a hover whose own evidence is a scope gap — but only that
// code: a hover inside a secure interval still opens the checkpoint, because
// dropping it would hide protected input.
test('a hover with a scope gap is skipped, and a secure hover still opens the interval', async () => {
  const recording = new GlobalRecording(async () => assert.fail('no window tree expected'), { now: () => NOW });
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false, owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 150, seen: NOW, point: [450, 250], dwellMs: 300,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED', owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 200, seen: NOW, point: [450, 250], dwellMs: 300,
    focusGeneration: 1, secure: true, secureEvidence: ['system_secure_input'],
    decision: 'gap', gapCode: 'SECURE_INPUT', owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 260, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'manual_checkpoint', 'click']);
  assert.equal(flow.steps[1].reason, 'secure_input');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_HOVER'));
  assert.equal(flowV2Check.Check(flow), true);
});

// A hover whose own evidence is a gap must not delete the held press either:
// the press is settled by the same paths as before, and the hover's scope gap
// stays read-only noise.
test('a hover with a scope gap never deletes the held press', async () => {
  const snapshot = {
    windowId: 'w-11',
    tree: {
      role: 'window', name: 'client', ref: '@finder:e1',
      bounds: { x: 400, y: 200, width: 800, height: 500 }, states: [], secure: false,
      children: [{
        role: 'button', name: '刷新', ref: '@finder:e2',
        bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
      }],
    },
  };
  const settles = [];
  const recording = new GlobalRecording(
    async () => structuredClone(snapshot),
    { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
  );
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false, owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }));
  while (settles.length) await settles.shift()();
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 300, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: { ...window, role: 'AXRow', pressable: true },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 340, seen: NOW, point: [450, 250], dwellMs: 300,
    focusGeneration: 1, secure: false, decision: 'gap',
    gapCode: 'CAPTURE_SCOPE_UNVERIFIED', owner: window,
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'button', name: '刷新' });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'HOVER_WHILE_CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
});

// A capture-side gap is not a hover's to downgrade, whether the pointer can be
// attributed to a window or not, and whether or not a press is held.
test('an explicit capture gap on a hover still blocks the flow', async () => {
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  const cases = [
    { name: 'held press, bound window', owner: window, pending: true },
    { name: 'held press, unbound window', owner: {}, pending: true },
    { name: 'no press, unbound window', owner: {}, pending: false },
  ];
  for (const label of cases) {
    const recording = new GlobalRecording(async () => assert.fail('no window tree expected'), { now: () => NOW });
    await recording.add(parseCaptureEvent({
      kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false, owner: window,
    }));
    await recording.add(parseCaptureEvent({
      kind: 'click', t: 100, seen: NOW, point: [450, 250], count: 1,
      focusGeneration: 1, secure: false, decision: 'record',
      owner: { ...window, role: 'AXButton', name: '刷新' },
    }));
    if (label.pending) {
      await recording.add(parseCaptureEvent({
        kind: 'click', t: 200, seen: NOW, point: [450, 250], count: 1,
        focusGeneration: 1, secure: false, decision: 'gap',
        gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
        owner: { ...window, role: 'AXRow', pressable: true },
      }));
    }
    await recording.add(parseCaptureEvent({
      kind: 'hover', t: 240, seen: NOW, point: [450, 250], dwellMs: 300,
      focusGeneration: 1, secure: false, decision: 'gap',
      gapCode: 'STALE_CAPTURE', owner: label.owner,
    }));

    const flow = recording.finish();
    const gaps = flow.steps.filter(step => step.kind === 'gap').map(step => step.code);
    assert.ok(gaps.includes('STALE_CAPTURE'), label.name);
    assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' }, label.name);
  }
});

// The input paths keep their existing settlement: a second press, a scroll or a
// key shows the held press did something, so it is recorded where it landed and
// no gap is invented. Only hover is exempt from settling the press.
test('a second press, a scroll or a key still settles the held press', async () => {
  const snapshot = {
    windowId: 'w-11',
    tree: {
      role: 'window', name: 'client', ref: '@finder:e1',
      bounds: { x: 400, y: 200, width: 800, height: 500 }, states: [], secure: false,
      children: [{
        role: 'button', name: '刷新', ref: '@finder:e2',
        bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
      }],
    },
  };
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  const settleWith = async (event, expected) => {
    const settles = [];
    const recording = new GlobalRecording(
      async () => structuredClone(snapshot),
      { now: () => NOW, scheduleSettle: task => { settles.push(task); } },
    );
    await recording.add(parseCaptureEvent({
      kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false, owner: window,
    }));
    await recording.add(parseCaptureEvent({
      kind: 'click', t: 200, seen: NOW, point: [450, 250], count: 1,
      focusGeneration: 1, secure: false, decision: 'record',
      owner: { ...window, role: 'AXButton', name: '刷新' },
    }));
    while (settles.length) await settles.shift()();
    await recording.add(parseCaptureEvent({
      kind: 'click', t: 300, seen: NOW, point: [450, 250], count: 1,
      focusGeneration: 1, secure: false, decision: 'gap',
      gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
      owner: { ...window, role: 'AXRow', pressable: true },
    }));
    await recording.add(parseCaptureEvent(event));
    const flow = recording.finish();
    assert.deepEqual(flow.steps.map(step => step.kind), expected, event.kind);
    assert.equal(flow.steps.some(step => step.kind === 'gap'), false, event.kind);
    // The held press is kept exactly once, before the event that settled it.
    assert.equal(
      flow.steps.filter(step => step.kind === 'click').length,
      expected.filter(kind => kind === 'click').length,
      event.kind,
    );
    assert.equal(flowV2Check.Check(flow), true, event.kind);
  };

  await settleWith({
    kind: 'click', t: 340, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }, ['click', 'click', 'click']);
  await settleWith({
    kind: 'scroll', t: 340, seen: NOW, point: [450, 250], deltaX: 0, deltaY: -3,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXButton', name: '刷新' },
  }, ['click', 'click', 'scroll']);
  await settleWith({
    kind: 'key', t: 340, seen: NOW, key: 'return', modifiers: [],
    focusGeneration: 1, secure: false, decision: 'record', owner: window,
  }, ['click', 'click', 'key']);
});

// A menu item is the native exception to "hover only for the focused window":
// the helper attributes the menu action to the app window that opened it and
// reports `record`. The hover that follows must not change how the menu choice
// is recorded — the click keeps the item name and the app window scope.
test('a menu item hover keeps the menu choice that follows', async () => {
  const snapshot = {
    windowId: 'w-11',
    tree: {
      role: 'window', name: 'client', ref: '@finder:e1',
      bounds: { x: 400, y: 200, width: 800, height: 500 }, states: [], secure: false,
      children: [{
        role: 'menuitem', name: '重新命名', ref: '@finder:e2',
        bounds: { x: 430, y: 230, width: 90, height: 24 }, states: [], secure: false, children: [],
      }],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  const window = {
    app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
    windowNumber: 11, windowTitle: 'client',
  };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false, owner: window,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 150, seen: NOW, point: [450, 240], dwellMs: 320,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXMenuItem', name: '重新命名', pressable: true },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [450, 240], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: { ...window, role: 'AXMenuItem', name: '重新命名', pressable: true },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['hover', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'menuitem', name: '重新命名' });
  assert.equal(flow.steps[1].scope.app, 'com.apple.finder');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// CAPTURE_SCOPE_UNVERIFIED is raised by many handlers. The flow step alone
// cannot say which one, so the capture report names the handler and the event's
// own window evidence for every such gap — with the step id the flow really has.
test('a capture gap names the handler and window that raised it', async () => {
  const recording = new GlobalRecording(async () => assert.fail('no window tree expected'), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));
  // A right click in another window is never recovered, so it still blocks.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, point: [990, 112], count: 1, button: 'right',
    focusGeneration: 1, secure: false, decision: 'record',
    owner: {
      app: 'com.electron.atrust', pid: 200, processInstance: 1700000000000,
      windowNumber: 21, windowTitle: 'aTrust', role: 'AXGroup', pressable: false,
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  const origin = recording.captureWarnings.find(warning => warning.code === 'CAPTURE_GAP_ORIGIN');
  assert.ok(origin);
  // The id is the gap step the flow actually contains.
  assert.match(origin.message, /^s2 from=click app=com\.electron\.atrust window=21 gen=1 decision=record$/);
  assert.equal(origin.message.length <= 500, true);
  // A gap the step limit dropped has no id, so the report says nothing rather
  // than pointing at a step that is not there.
  const limited = new GlobalRecording(async () => assert.fail('no window tree expected'), {
    now: () => NOW, stepLimit: 1,
  });
  for (const event of [{
    kind: 'focus', t: 50, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }, {
    kind: 'click', t: 100, seen: NOW, point: [450, 250], count: 1,
    focusGeneration: 1, secure: false, decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }, {
    kind: 'click', t: 200, seen: NOW, point: [990, 112], count: 1, button: 'right',
    focusGeneration: 1, secure: false, decision: 'record',
    owner: {
      app: 'com.electron.atrust', pid: 200, processInstance: 1700000000000,
      windowNumber: 21, windowTitle: 'aTrust', role: 'AXGroup', pressable: false,
    },
  }]) await limited.add(parseCaptureEvent(event));
  const truncated = limited.finish();
  assert.deepEqual(truncated.steps.map(step => step.kind), ['click']);
  assert.equal(limited.captureWarnings.some(warning => warning.code === 'CAPTURE_GAP_ORIGIN'), false);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

// A held click that something other than a focus followed did something, so it
// is recorded where it landed: blocking the flow with a gap over a press the
// recording already placed on screen would make the flow unreplayable.
test('a click that cannot be proven is recorded at its point when the next event is not its focus', async () => {
  const windowBounds = { x: 400, y: 200, width: 800, height: 500 };
  const snapshot = {
    windowId: 'w-11',
    tree: {
      role: 'window', name: 'client', ref: '@finder:e1', bounds: windowBounds, states: [], secure: false,
      children: [{
        role: 'button', name: '刷新', ref: '@finder:e2',
        bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
      }],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 300, seen: NOW, focusGeneration: 1, secure: false,
    point: [500, 300], decision: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXRow', pressable: true,
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'point', point: [500, 300] });
  assert.equal(flow.steps[1].scope.windowKey, 'finder-1');
  assert.equal(flow.steps[1].atMs, 100);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
  assert.doesNotThrow(() => parseFlowV2(flow));
});

// The second press of a double click names the control the first press could
// only place; the merged step must keep the element, not the point.
test('a double click upgrades a held point click to the control it names', async () => {
  const recording = new GlobalRecording(async () => undefined, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 300, seen: NOW, focusGeneration: 1, secure: false,
    point: [500, 300], decision: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXRow', pressable: true,
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 420, seen: NOW, focusGeneration: 1, secure: false,
    point: [501, 301], decision: 'record', count: 2,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'button', name: '刷新' });
  assert.equal(flow.steps[0].count, 2);
});

// Clicking the Dock icon of the app that is already frontmost changes nothing:
// no focus follows, and a gap would block a flow over a press that had no effect.
test('a Dock click that activated no application is dropped with a warning', async () => {
  const recording = new GlobalRecording(async () => undefined, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 400, seen: NOW, focusGeneration: 1, secure: false,
    point: [120, 900], decision: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED',
    owner: {
      app: 'com.apple.dock', pid: 200, processInstance: 1700000000001,
      windowNumber: 300, windowTitle: 'Dock', role: 'AXList', name: 'Finder', pressable: true,
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 500, seen: NOW, focusGeneration: 1, secure: false,
    point: [460, 251], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 100, processInstance: 1700000000000,
      windowNumber: 11, windowTitle: 'client', role: 'AXButton', name: '刷新',
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flow.steps.some(step => step.scope?.app === 'com.apple.dock'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'DOCK_CLICK_UNPROVEN'));
  assert.equal(flowV2Check.Check(flow), true);
});

// One settle read can hang on a window that is still drawing; that must not
// cost the next click its own tree, or every click after it keeps a point.
test('a settle read that never finishes does not stop the next click from getting a tree', async () => {
  const windowBounds = { x: 400, y: 200, width: 800, height: 500 };
  const oldPage = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '设置', ref: '@atrust:e2', bounds: { x: 410, y: 230, width: 60, height: 40 },
          states: [], secure: false, children: [],
        },
        {
          role: 'group', name: '', ref: '@atrust:e3', bounds: windowBounds, states: [], secure: false,
          children: [],
        },
      ],
    },
  };
  const settingsPage = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '设置', ref: '@atrust:e2', bounds: { x: 410, y: 230, width: 60, height: 40 },
          states: [], secure: false, children: [],
        },
        {
          role: 'group', name: '', ref: '@atrust:e3', bounds: windowBounds, states: [], secure: false,
          children: [{
            role: 'group', name: 'https://10.242.5.14', ref: '@atrust:e4',
            bounds: { x: 699, y: 246, width: 175, height: 24 }, states: [], secure: false,
            children: [{
              role: 'statictext', name: 'https://10.242.5.14', ref: '@atrust:e5',
              bounds: { x: 699, y: 249, width: 175, height: 17 }, states: [], secure: false, children: [],
            }],
          }],
        },
      ],
    },
  };
  const sheetOpen = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@atrust:e2', bounds: { x: 600, y: 300, width: 300, height: 200 },
        states: [], secure: false, children: [],
      }],
    },
  };

  let screen = oldPage;
  const settles = [];
  const recording = new GlobalRecording(async () => structuredClone(screen), {
    now: () => NOW,
    scheduleSettle: task => { settles.push(task); },
  });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [430, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  const afterFirst = settles.length;
  // The first settle never finishes (the window was still drawing); the click
  // that opened the sheet still schedules one of its own.
  screen = sheetOpen;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW + 1000, focusGeneration: 1, secure: false,
    point: [817, 260], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  assert.equal(settles.length, afterFirst + 1, 'the second click schedules its own settle');
  screen = settingsPage;
  await settles.at(-1)();

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW + 2000, focusGeneration: 1, secure: false,
    point: [817, 260], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  const clicks = flow.steps.filter(step => step.kind === 'click');
  assert.equal(clicks.at(-1).target.kind, 'element');
  assert.equal(clicks.at(-1).target.name, 'https://10.242.5.14');
  assert.equal(flowV2Check.Check(flow), true);
});

// A click on a window that is not current is usually just the activation, and
// the helper says so with `navigate`. Web content accepts the first mouse-down
// though, so a click on a named control there also acted and must be replayed.
test('a click that activates a window and lands on a named web control is recorded', async () => {
  const finderTree = {
    windowId: 'w-下载',
    tree: {
      role: 'window', name: '下载', ref: '@find:e1', bounds: { x: 0, y: 0, width: 800, height: 600 },
      states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@find:e2', bounds: { x: 0, y: 0, width: 800, height: 600 },
        states: [], secure: false,
        children: [{
          role: 'cell', name: '下载', ref: '@find:e3', bounds: { x: 40, y: 60, width: 120, height: 24 },
          states: [], secure: false, children: [],
        }],
      }],
    },
  };
  const atrustTree = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: { x: 400, y: 200, width: 800, height: 500 },
      states: [], secure: false,
      children: [{
        role: 'webarea', name: 'aTrust', ref: '@atrust:e2', bounds: { x: 400, y: 200, width: 800, height: 500 },
        states: [], secure: false,
        children: [{
          role: 'group', name: '', ref: '@atrust:e3', bounds: { x: 400, y: 200, width: 800, height: 500 },
          states: [], secure: false,
          children: [{
            role: 'group', name: '设置', ref: '@atrust:e4', bounds: { x: 499, y: 323, width: 64, height: 32 },
            states: [], secure: false, children: [],
          }],
        }],
      }],
    },
  };
  const trees = [finderTree, atrustTree];
  const recording = new GlobalRecording(async () => structuredClone(trees.shift() ?? atrustTree), {
    now: () => NOW,
  });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [100, 70], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 600, processInstance: 1_700_000_000_600,
      windowNumber: 7, windowTitle: '下载', role: 'AXGroup',
    },
  }));
  // aTrust is behind Finder: this click brought it forward and hit 设置.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW + 2000, focusGeneration: 2, secure: false,
    point: [515, 335], decision: 'navigate', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app', 'click']);
  assert.deepEqual(flow.steps[2].scope.app, 'com.electron.atrust');
  assert.deepEqual(flow.steps[2].target, { kind: 'element', role: 'group', name: '设置' });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_ACTIVATED_WINDOW'));
  assert.equal(flowV2Check.Check(flow), true);
});

// The same navigate click on a window surface stays navigation only: nothing
// there proves the click did anything past activating the window.
test('a navigate click on a window surface is recorded as navigation only', async () => {
  const atrustTree = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: { x: 400, y: 200, width: 800, height: 500 },
      states: [], secure: false,
      children: [{
        role: 'webarea', name: 'aTrust', ref: '@atrust:e2', bounds: { x: 400, y: 200, width: 800, height: 500 },
        states: [], secure: false,
        children: [{
          role: 'group', name: '', ref: '@atrust:e3', bounds: { x: 400, y: 200, width: 800, height: 500 },
          states: [], secure: false, children: [],
        }],
      }],
    },
  };
  const finderTree = {
    windowId: 'w-下载',
    tree: {
      role: 'window', name: '下载', ref: '@find:e1', bounds: { x: 0, y: 0, width: 800, height: 600 },
      states: [], secure: false,
      children: [{
        role: 'cell', name: '下载', ref: '@find:e2', bounds: { x: 40, y: 60, width: 120, height: 24 },
        states: [], secure: false, children: [],
      }],
    },
  };
  const trees = [finderTree, atrustTree];
  const recording = new GlobalRecording(async () => structuredClone(trees.shift() ?? atrustTree), {
    now: () => NOW,
  });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 500, seen: NOW, focusGeneration: 1, secure: false,
    point: [100, 70], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 600, processInstance: 1_700_000_000_600,
      windowNumber: 7, windowTitle: '下载', role: 'AXGroup',
    },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW + 1500, focusGeneration: 2, secure: false,
    point: [515, 335], decision: 'navigate', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app']);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'CLICK_ACTIVATED_WINDOW'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

// Finder's column view shows a file's name in the value of the row's text
// field, not in a name. Replay matches a target by that value, so the label is
// a name the step can carry; without it the click would keep a point.
test('a Finder column-view row is named by the file label in its text field', async () => {
  const rowBounds = { x: 412, y: 500, width: 206, height: 23 };
  const snapshot = {
    windowId: 'w-下载',
    tree: {
      role: 'window', name: '下载', ref: '@find:e1', bounds: { x: 233, y: 252, width: 600, height: 500 },
      states: [], secure: false,
      children: [{
        role: 'browser', name: '分栏视图', ref: '@find:e2', bounds: { x: 233, y: 252, width: 600, height: 500 },
        states: [], secure: false,
        children: [{
          role: 'scrollarea', name: '', ref: '@find:e3', bounds: { x: 240, y: 300, width: 580, height: 440 },
          states: [], secure: false,
          children: [{
            role: 'list', name: '', ref: '@find:e4', bounds: { x: 400, y: 300, width: 246, height: 440 },
            states: [], secure: false,
            children: [{
              role: 'group', name: '', ref: '@find:e5', bounds: rowBounds, states: [], secure: false,
              actions: ['Click'],
              children: [{
                role: 'textfield', name: '', value: 'ATrustSDK-arm64-macos11.0', ref: '@find:e6',
                bounds: { x: 412, y: 503, width: 200, height: 17 }, states: [], secure: false,
                actions: ['Click', 'RightClick', 'SetValue'], children: [],
              }],
            }],
          }],
        }],
      }],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [519, 507], decision: 'record',
    owner: {
      app: 'com.apple.finder', pid: 600, processInstance: 1_700_000_000_600,
      windowNumber: 7, windowTitle: '下载', role: 'AXGroup',
    },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps[0].target.kind, 'element');
  assert.equal(flow.steps[0].target.name, 'ATrustSDK-arm64-macos11.0');
  assert.equal(flow.steps[0].target.role, 'textfield');
  assert.equal(flow.steps[0].target.point, undefined);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_FILE_CLICK'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

// A drop-down arrow has no accessible name at all, but it is the only pressable
// part of a control whose display carries the name. The step clicks the named
// control, which is the same control the arrow belongs to.
test('an anonymous arrow next to one labelled control is recorded as that control', async () => {
  const windowBounds = { x: 400, y: 200, width: 800, height: 500 };
  const settingsPage = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@atrust:e2', bounds: windowBounds, states: [], secure: false,
        children: [{
          role: 'group', name: '设置', ref: '@atrust:e3a', bounds: { x: 410, y: 230, width: 60, height: 40 },
          states: [], secure: false, children: [],
        }, {
          role: 'group', name: '', ref: '@atrust:e3', bounds: { x: 699, y: 246, width: 721, height: 24 },
          states: [], secure: false,
          children: [{
            role: 'group', name: 'https://10.242.5.14', ref: '@atrust:e4',
            bounds: { x: 699, y: 246, width: 175, height: 24 }, states: [], secure: false,
            actions: ['RightClick', 'ScrollTo'],
            children: [{
              role: 'statictext', name: 'https://10.242.5.14', ref: '@atrust:e5',
              bounds: { x: 699, y: 249, width: 175, height: 17 }, states: [], secure: false, children: [],
            }],
          }, {
            role: 'button', name: '', ref: '@atrust:e6', bounds: { x: 881, y: 247, width: 17, height: 22 },
            states: [], secure: false, actions: ['Click', 'SetFocus'], children: [],
          }],
        }],
      }],
    },
  };
  // The arrow opens the address sheet, so nothing is left at the click point in
  // the tree read after it; the tree read before it still shows the arrow.
  const sheetOpen = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@atrust:e1', bounds: windowBounds, states: [], secure: false,
      children: [{
        role: 'group', name: '', ref: '@atrust:e2', bounds: { x: 500, y: 300, width: 400, height: 200 },
        states: [], secure: false, children: [],
      }],
    },
  };

  let screen = settingsPage;
  const settles = [];
  const recording = new GlobalRecording(async () => structuredClone(screen), {
    now: () => NOW,
    scheduleSettle: task => { settles.push(task); },
  });
  // A click that leaves the page alone seeds the tree read before the arrow.
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [430, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  for (const task of settles.splice(0)) await task();

  screen = sheetOpen;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW + 1000, focusGeneration: 1, secure: false,
    point: [887, 258], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  const click = flow.steps.filter(step => step.kind === 'click').at(-1);
  assert.equal(click.target.kind, 'element');
  assert.equal(click.target.role, 'group');
  assert.equal(click.target.name, 'https://10.242.5.14');
  assert.equal(click.target.point, undefined);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_BY_CONTAINER_LABEL'));
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

test('a click in another field starts a new typing target in the same window', async () => {
  const fieldSnapshot = focused => ({
    windowId: 'w-34',
    tree: {
      role: 'window', name: 'settings.txt — Editor', ref: '@doc:e1',
      bounds: { x: 0, y: 0, width: 1400, height: 900 }, states: [], secure: false,
      children: [{
        role: 'group', name: 'body', ref: '@doc:e2',
        bounds: { x: 0, y: 0, width: 1400, height: 900 }, states: [], secure: false,
        children: [
          {
            role: 'textfield', name: 'title.txt', ref: '@doc:e3',
            bounds: { x: 300, y: 120, width: 400, height: 200 },
            states: focused === 'title' ? ['focused'] : [], secure: false, children: [],
          },
          {
            role: 'textfield', name: 'body.txt', ref: '@doc:e4',
            bounds: { x: 720, y: 120, width: 400, height: 200 },
            states: focused === 'body' ? ['focused'] : [], secure: false, children: [],
          },
        ],
      }],
    },
  });
  const owner = { app: 'com.microsoft.VSCode', pid: 301, windowNumber: 34, windowTitle: 'settings.txt — Editor' };
  const event = (kind, t, extra) => ({ kind, t, seen: NOW, focusGeneration: 1, secure: false, owner, ...extra });
  let focused = 'title';
  const recording = new GlobalRecording(async () => structuredClone(fieldSnapshot(focused)), { now: () => NOW });
  await recording.add(parseCaptureEvent(event('click', 100, { point: [400, 200], decision: 'record' })));
  await recording.add(parseCaptureEvent(event('text', 200, { chars: 'Zq-a' })));
  focused = 'body';
  await recording.add(parseCaptureEvent(event('click', 400, { point: [900, 200], decision: 'record' })));
  await recording.add(parseCaptureEvent(event('text', 500, { chars: 'Zq-b' })));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type', 'click', 'type']);
  assert.equal(flow.steps[1].target.name, 'title.txt');
  assert.equal(flow.steps[3].target.name, 'body.txt');
  assert.notEqual(flow.steps[1].input, flow.steps[3].input);
});

test('a focused field elsewhere is never taken as the target of an unrelated click', async () => {
  const snapshot = vscodeSnapshot({ field: { x: 0, y: 0, width: 300, height: 40 } });
  const recording = vscodeRecording(async () => structuredClone(snapshot));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  const flow = recording.finish();
  assert.equal(flow.steps[0].kind, 'click');
  assert.equal(flow.steps[0].target.role, 'group');
  assert.notEqual(flow.steps[0].target.name, 'manifest.json');
});

// --- One read per window -------------------------------------------------------

/** A reader that serves a snapshot per window and records every read. */
function countingReader(snapshots) {
  const reads = [];
  const read = async window => {
    reads.push(window.windowNumber);
    const snapshot = snapshots[window.windowNumber];
    if (!snapshot) throw new Error(`no fixture snapshot for window ${window.windowNumber}`);
    return structuredClone(snapshot);
  };
  return { read, reads };
}

/** A window whose root box is `bounds` and whose children are `nodes`. */
function plainWindow(windowNumber, title, bounds, nodes = []) {
  return {
    windowId: `w-${windowNumber}`,
    tree: {
      role: 'window', name: title, ref: '@plain:e1', bounds, states: [], secure: false, children: nodes,
    },
  };
}

test('one window is read once for twenty clicks and twenty typed characters', async () => {
  const { read, reads } = countingReader({ 33: vscodeSnapshot() });
  const recording = new GlobalRecording(read, { now: () => NOW });
  for (let index = 0; index < 20; index += 1) {
    await recording.add(parseCaptureEvent(vscodeEvent('click', 100 + index * 50, {
      point: [320 + index * 20, 400], decision: 'record',
    })));
  }
  for (let index = 0; index < 20; index += 1) {
    await recording.add(parseCaptureEvent(vscodeEvent('text', 1200 + index * 50, { chars: 'a' })));
  }
  const flow = recording.finish();

  assert.deepEqual(reads, [33], 'the window must be read exactly once');
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 20);
  // Twenty characters in one control are one parameterised type step.
  const types = flow.steps.filter(step => step.kind === 'type');
  assert.equal(types.length, 1);
  assert.equal(types[0].target.name, 'manifest.json');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('a retitled window is read again exactly once', async () => {
  const { read, reads } = countingReader({ 33: vscodeSnapshot() });
  const recording = new GlobalRecording(read, { now: () => NOW });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  // Switching file retitles the same native window; its old tree no longer
  // describes what the next click lands on.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, windowTitle: 'settings.json — saio_副本' },
  })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33, 33]);
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 2);
  assert.equal(flow.steps[1].scope.windowTitle, 'settings.json — saio_副本');
});

test('a window that no longer covers the click is read again exactly once', async () => {
  const small = plainWindow(33, 'Editor', { x: 0, y: 0, width: 1400, height: 900 }, [{
    role: 'button', name: 'Save', ref: '@plain:e2',
    bounds: { x: 320, y: 380, width: 80, height: 30 }, states: [], secure: false, children: [],
  }]);
  // The window was enlarged past every edge of the tree that was read first.
  const large = plainWindow(33, 'Editor', { x: 0, y: 0, width: 1800, height: 1100 }, [{
    role: 'button', name: 'Save', ref: '@plain:e2',
    bounds: { x: 1500, y: 950, width: 80, height: 30 }, states: [], secure: false, children: [],
  }]);
  let call = 0;
  const reads = [];
  const recording = new GlobalRecording(async window => {
    reads.push(window.windowNumber);
    call += 1;
    return structuredClone(call === 1 ? small : large);
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: [360, 390], decision: 'record' })));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, { point: [1540, 960], decision: 'record' })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33, 33]);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'button', name: 'Save' });
});

test('a click with element evidence completes its path from a tree already read', async () => {
  const group = (name, y) => ({
    role: 'group', name, ref: `@g:${name}`, bounds: { x: 0, y, width: 400, height: 100 },
    states: [], secure: false, children: [{
      role: 'button', name: 'Go', ref: `@g:${name}:b`,
      bounds: { x: 20, y: y + 20, width: 80, height: 30 }, states: [], secure: false, children: [],
    }],
  });
  const snapshot = plainWindow(33, 'Editor', { x: 0, y: 0, width: 800, height: 600 }, [
    group('top', 0), group('bottom', 200),
  ]);
  const { read, reads } = countingReader({ 33: snapshot });
  const recording = new GlobalRecording(read, { now: () => NOW });
  // A click with no element evidence reads the window once.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: [60, 35], decision: 'record' })));
  // The helper's own evidence names the second Go button; the cached tree adds
  // the index that tells the two look-alikes apart, with no second read.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, {
    point: [60, 235], decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXButton', name: 'Go' },
  })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33]);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, {
    kind: 'element', role: 'button', name: 'Go', path: ['window', 'group', 'button'], index: 1,
  });
});

test('a scroll names its element from the cached tree and invalidates it afterwards', async () => {
  const { read, reads } = countingReader({ 33: vscodeSnapshot() });
  const recording = new GlobalRecording(read, { now: () => NOW });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  // The scroll names what the pointer was over before the content moved, which
  // is exactly what the cached tree still describes.
  await recording.add(parseCaptureEvent(vscodeEvent('scroll', 2000, {
    point: EDITOR_POINT, deltaX: 0, deltaY: -3, decision: 'record',
  })));
  // After the content moved, the same window is read before its coordinates are
  // believed again.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2100, { point: [700, 420], decision: 'record' })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33, 33]);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'scroll', 'click']);
});

test('a click both trees leave empty is read again and not recorded', async () => {
  // One button in the top-left corner: everything else in the window is empty.
  const snapshot = plainWindow(33, 'Editor', { x: 0, y: 0, width: 1400, height: 900 }, [{
    role: 'button', name: 'Save', ref: '@plain:e2',
    bounds: { x: 20, y: 20, width: 80, height: 30 }, states: [], secure: false, children: [],
  }]);
  const { read, reads } = countingReader({ 33: snapshot });
  const settles = [];
  const recording = new GlobalRecording(read, { now: () => NOW, scheduleSettle: task => settles.push(task) });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: [60, 35], decision: 'record' })));
  // The tree read after the first click is the screen the next click is made
  // against; it is empty at this point too.
  for (const task of settles.splice(0)) await task();
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, { point: [700, 400], decision: 'record' })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33, 33, 33], 'two clicks, each with its own read, plus the settle read');
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'));
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flowV2Check.Check(flow), true);
});

test('a settle read keeps reading until the page has finished building', async () => {
  // Chromium builds a page's accessibility tree after the view changes, so the
  // first read after a click can see a half-built page. The click that follows
  // must be named from the finished screen, not from the half-built one.
  const windowBounds = { x: 400, y: 100, width: 900, height: 600 };
  const wrap = (children) => ({
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@trust:e1', bounds: windowBounds, states: [], secure: false,
      children,
    },
  });
  const building = wrap([{
    role: 'group', name: '', ref: '@trust:e2', bounds: windowBounds, states: [], secure: false, children: [],
  }]);
  const built = wrap([{
    role: 'group', name: 'https://sdpc.sangfor.com:6440', ref: '@trust:e2',
    bounds: { x: 699, y: 246, width: 400, height: 24 }, states: [], secure: false, children: [],
  }]);
  const navigated = wrap([{
    role: 'group', name: '', ref: '@trust:e2', bounds: windowBounds, states: [], secure: false,
    children: [{
      role: 'group', name: '', ref: '@trust:e3', bounds: windowBounds, states: [], secure: false, children: [],
    }],
  }]);

  let screen = wrap([{
    role: 'group', name: '设置', ref: '@trust:e2', bounds: { x: 430, y: 230, width: 60, height: 40 },
    states: [], secure: false, children: [],
  }]);
  let reads = 0;
  const reader = async () => { reads += 1; return structuredClone(screen); };
  const settles = [];
  const recording = new GlobalRecording(reader, { now: () => NOW, scheduleSettle: task => settles.push(task) });

  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '设置' },
  }));
  // The settings page starts drawing: first read half-built, then finished.
  screen = building;
  await settles.shift()();
  screen = built;
  await settles.shift()();
  await settles.shift()();
  assert.equal(settles.length, 0, 'the chain stops once two reads agree');

  // The address row click navigates, so its own read sees the next page.
  screen = navigated;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW + 2000, focusGeneration: 1, secure: false,
    point: [884, 256], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));

  const flow = recording.finish();
  assert.equal(reads, 4, 'three settle reads, then the click own read');
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.equal(flow.steps[1].target.kind, 'element');
  assert.equal(flow.steps[1].target.name, 'https://sdpc.sangfor.com:6440');
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_FROM_SETTLED_TREE'));
  assert.equal(flowV2Check.Check(flow), true);
});

test('a click that only one tree leaves empty keeps its point', async () => {
  // The tree read before the click could not answer the point (the window was
  // still drawing), so the point cannot be called empty space: the click stays
  // as a point rather than losing a step the user performed.
  const snapshot = plainWindow(33, 'Editor', { x: 0, y: 0, width: 1400, height: 900 }, [{
    role: 'button', name: 'Save', ref: '@plain:e2',
    bounds: { x: 20, y: 20, width: 80, height: 30 }, states: [], secure: false, children: [],
  }]);
  const { read } = countingReader({ 33: snapshot });
  const recording = new GlobalRecording(read, { now: () => NOW, scheduleSettle: () => {} });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: [60, 35], decision: 'record' })));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, { point: [700, 400], decision: 'record' })));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'point', point: [700, 400] });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'));
});

test('a click on an anonymous page container keeps its point', async () => {
  // An Electron page is a stack of unnamed groups; a click on one of them names
  // nothing, so it keeps its point. Dropping it would lose a step the user made
  // — the unnamed group can be the image that navigates the page.
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@trust:e1',
      bounds: { x: 400, y: 100, width: 900, height: 600 }, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@trust:e2', bounds: { x: 591, y: 254, width: 701, height: 393 },
          states: [], secure: false,
          children: [{
            role: 'group', name: '', ref: '@trust:e3', bounds: { x: 591, y: 254, width: 701, height: 393 },
            states: [], secure: false, children: [],
          }],
        },
        {
          role: 'button', name: '登录', ref: '@trust:e4',
          bounds: { x: 860, y: 400, width: 100, height: 40 }, states: [], secure: false, children: [],
        },
      ],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [822, 255], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 2000, seen: NOW, focusGeneration: 1, secure: false,
    point: [880, 420], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '登录' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[0].target, { kind: 'point', point: [822, 255] });
  assert.equal(flow.steps[1].target.name, '登录');
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'));
  assert.equal(flowV2Check.Check(flow), true);
});

test('a click on a control that has only an identifier is recorded with it', async () => {
  // The QR code on the aTrust page has no name at all, only Chromium's
  // AXDOMIdentifier. The identifier addresses this exact element.
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@trust:e1',
      bounds: { x: 400, y: 100, width: 900, height: 600 }, states: [], secure: false,
      children: [
        {
          role: 'image', name: '', ref: '@trust:e2', identifier: 'qr-code',
          bounds: { x: 600, y: 200, width: 120, height: 120 }, states: [], secure: false, children: [],
        },
        {
          role: 'button', name: '确定接入', ref: '@trust:e3',
          bounds: { x: 430, y: 480, width: 60, height: 40 }, states: [], secure: false, children: [],
        },
      ],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [650, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXImage' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 500], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '确定接入' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'image', name: '', identifier: 'qr-code' });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_BY_IDENTIFIER'));
  assert.doesNotThrow(() => parseFlowV2(flow));
  assert.equal(flowV2Check.Check(flow), true);
});

test('the driver identifier reaches the node and other native ids are ignored', () => {
  const snapshot = parseSnapshot({
    complete: true,
    window: { id: 'w-9', title: 'aTrust' },
    tree: {
      role: 'window', name: 'aTrust', bounds: { x: 0, y: 0, width: 20, height: 20 }, states: [],
      children: [
        {
          role: 'image', native_id: { kind: 'ax_dom_identifier', value: 'qr-code' },
          bounds: { x: 0, y: 0, width: 5, height: 5 }, states: [], children: [],
        },
        {
          role: 'image', native_id: { kind: 'ax_ref', value: 'not-an-id' },
          bounds: { x: 5, y: 5, width: 5, height: 5 }, states: [], children: [],
        },
      ],
    },
  }, { window: 'aTrust' });
  assert.equal(snapshot.tree.children[0].identifier, 'qr-code');
  assert.equal(snapshot.tree.children[1].identifier, undefined);
});

test('a click on an anonymous icon inside a named control is recorded as that control', async () => {
  // The aTrust title bar draws "切换接入地址" as an anonymous glyph inside a
  // named group; clicking the glyph is what switches to the address page.
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@trust:e1',
      bounds: { x: 400, y: 100, width: 900, height: 600 }, states: [], secure: false,
      children: [
        {
          role: 'group', name: '', ref: '@trust:e2', bounds: { x: 400, y: 100, width: 900, height: 600 },
          states: [], secure: false,
          children: [
            {
              role: 'group', name: '切换接入地址', ref: '@trust:e3',
              bounds: { x: 1252, y: 129, width: 24, height: 24 }, states: [], secure: false,
              children: [{
                role: 'statictext', name: '', ref: '@trust:e4',
                bounds: { x: 1256, y: 133, width: 16, height: 16 }, states: [], secure: false, children: [],
              }],
            },
            {
              role: 'button', name: '确定接入', ref: '@trust:e5',
              bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
            },
          ],
        },
      ],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [1260, 140], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXImage' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '确定接入' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.equal(flow.steps[0].target.kind, 'element');
  assert.equal(flow.steps[0].target.role, 'group');
  assert.equal(flow.steps[0].target.name, '切换接入地址');
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_NAMED_BY_CONTAINER_LABEL'));
  assert.equal(flowV2Check.Check(flow), true);
});

test('a click on empty space under a page-sized named container is still dropped', async () => {
  // The settings page is one named group covering the window; clicking its
  // blank area must not become "click the page".
  const windowBounds = { x: 400, y: 100, width: 900, height: 600 };
  const snapshot = {
    windowId: 'w-44',
    tree: {
      role: 'window', name: 'aTrust', ref: '@trust:e1', bounds: windowBounds, states: [], secure: false,
      children: [
        {
          role: 'group', name: '基本设置', ref: '@trust:e2', bounds: windowBounds, states: [], secure: false,
          children: [{
            role: 'group', name: '', ref: '@trust:e3', bounds: { x: 500, y: 200, width: 600, height: 300 },
            states: [], secure: false, children: [],
          }],
        },
        {
          role: 'button', name: '确定接入', ref: '@trust:e4',
          bounds: { x: 430, y: 230, width: 60, height: 40 }, states: [], secure: false, children: [],
        },
      ],
    },
  };
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [700, 300], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXGroup' },
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 3000, seen: NOW, focusGeneration: 1, secure: false,
    point: [450, 250], decision: 'record', owner: { ...ATRUST_OWNER, role: 'AXButton', name: '确定接入' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  // The page container is too big to stand for the click, so the point stays.
  assert.deepEqual(flow.steps[0].target, { kind: 'point', point: [700, 300] });
  assert.equal(flow.steps[1].target.name, '确定接入');
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'));
  assert.equal(flowV2Check.Check(flow), true);
});

test('two windows alternating are each read once and never invalidate each other', async () => {
  const { read, reads } = countingReader({ 33: vscodeSnapshot(), 34: plainWindow(34, 'Settings', {
    x: 0, y: 0, width: 900, height: 700,
  }, [{
    role: 'button', name: 'Apply', ref: '@settings:e2',
    bounds: { x: 400, y: 300, width: 90, height: 30 }, states: [], secure: false, children: [],
  }]) });
  const recording = new GlobalRecording(read, { now: () => NOW });
  const other = { ...VSCODE_OWNER, windowNumber: 34, windowTitle: 'Settings' };
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  await recording.add(parseCaptureEvent({ ...vscodeEvent('focus', 150, {}), owner: other, focusGeneration: 2 }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('click', 200, { point: [440, 315], decision: 'record' }), owner: other, focusGeneration: 2,
  }));
  await recording.add(parseCaptureEvent({ ...vscodeEvent('focus', 250, {}), focusGeneration: 3 }));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 300, { point: EDITOR_POINT, decision: 'record' })));
  await recording.add(parseCaptureEvent({ ...vscodeEvent('focus', 350, {}), owner: other, focusGeneration: 4 }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('click', 400, { point: [450, 320], decision: 'record' }), owner: other, focusGeneration: 4,
  }));
  const flow = recording.finish();
  // Two reads, one per window; switching focus never discards the other one.
  assert.deepEqual(reads, [33, 34]);
  const clicks = flow.steps.filter(step => step.kind === 'click');
  assert.deepEqual(clicks.map(step => step.scope.windowTitle),
    ['manifest.json — saio_副本', 'Settings', 'manifest.json — saio_副本', 'Settings']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
});

test('a cached tree older than the TTL is read again', async () => {
  const { read, reads } = countingReader({ 33: vscodeSnapshot() });
  let clock = NOW;
  const recording = new GlobalRecording(read, { now: () => clock });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record' })));
  clock += 31_000;
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, {
    point: [700, 420], decision: 'record', seen: clock,
  })));
  assert.deepEqual(reads, [33, 33]);
});

test('the tree cache keeps at most eight windows and evicts the least recent', async () => {
  const snapshots = {};
  const events = [];
  for (let windowNumber = 1; windowNumber <= 9; windowNumber += 1) {
    snapshots[windowNumber] = plainWindow(windowNumber, `Window ${windowNumber}`, {
      x: 0, y: 0, width: 900, height: 700,
    }, [{
      role: 'button', name: `Go ${windowNumber}`, ref: `@w${windowNumber}:e2`,
      bounds: { x: 400, y: 300, width: 90, height: 30 }, states: [], secure: false, children: [],
    }]);
    const owner = { ...VSCODE_OWNER, windowNumber, windowTitle: `Window ${windowNumber}` };
    events.push({ ...vscodeEvent('focus', 100 * windowNumber - 50, {}), owner, focusGeneration: windowNumber });
    events.push({
      ...vscodeEvent('click', 100 * windowNumber, { point: [440, 315], decision: 'record' }),
      owner, focusGeneration: windowNumber,
    });
  }
  const { read, reads } = countingReader(snapshots);
  const recording = new GlobalRecording(read, { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  assert.equal(reads.length, 9);
  // Window 1 was evicted by window 9, so returning to it reads it once more.
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('focus', 1000, {}),
    owner: { ...VSCODE_OWNER, windowNumber: 1, windowTitle: 'Window 1' }, focusGeneration: 10,
  }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('click', 1050, { point: [440, 315], decision: 'record' }),
    owner: { ...VSCODE_OWNER, windowNumber: 1, windowTitle: 'Window 1' }, focusGeneration: 10,
  }));
  assert.equal(reads.length, 10);
  // Window 8 is still cached: the eviction took the oldest, not the newest.
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('focus', 1100, {}),
    owner: { ...VSCODE_OWNER, windowNumber: 8, windowTitle: 'Window 8' }, focusGeneration: 11,
  }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('click', 1150, { point: [440, 315], decision: 'record' }),
    owner: { ...VSCODE_OWNER, windowNumber: 8, windowTitle: 'Window 8' }, focusGeneration: 11,
  }));
  assert.equal(reads.length, 10);
});

test('text with neither focus evidence nor a provable control is dropped, not a gap', async () => {
  const snapshot = vscodeSnapshot({ focused: false });
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    return structuredClone(snapshot);
  });
  // A key step first: text alone would leave an empty recording to assert on.
  await recording.add(parseCaptureEvent(vscodeEvent('key', 100, { key: 'escape', modifiers: [] })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs' })));
  const flow = recording.finish();
  assert.equal(reads, 1);
  assert.deepEqual(flow.steps.map(step => step.kind), ['key']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_TEXT'),
    'the drop must say why the text could not be bound');
});

test('a failed focus probe keeps the window it proved, so typing stays bound', async () => {
  const recording = vscodeRecording(async () => {
    throw new Error('focus evidence must be enough');
  });
  // The recording proves VS Code's editor window with a click in it.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'manifest.json' },
  })));
  // The next focus probe reads the app but not its window number, as Finder's
  // inline rename field does: the generation advances and the owner loses the
  // window. The window the same app process proved is still the right one.
  const unprobed = { app: VSCODE_OWNER.app, pid: VSCODE_OWNER.pid, processInstance: VSCODE_OWNER.processInstance };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 150, seen: NOW, focusGeneration: 2, secure: false, owner: unprobed,
  }));
  for (const t of [200, 250, 300, 350, 400]) {
    await recording.add(parseCaptureEvent({
      ...vscodeEvent('text', t, { chars: 'N', focus: EDITOR_FOCUS }), owner: unprobed, focusGeneration: 2,
    }));
  }
  const flow = recording.finish();
  // Five characters are one bound burst, not five scope gaps.
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  assert.deepEqual(flow.steps[1].scope, {
    kind: 'window', app: 'com.microsoft.VSCode', windowKey: 'vscode-1',
    windowTitle: 'manifest.json — saio_副本',
  });
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.equal(flow.steps[1].input, 'text_1');
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flowV2Check.Check(flow), true);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'WINDOW_SCOPE_FROM_LAST_WINDOW'),
    'the reuse of a proved window must say why it happened');
  assert.ok(!JSON.stringify(flow).includes('NNNNN'));
});

test('an app switch never reuses the window the previous app proved', async () => {
  const recording = vscodeRecording(async () => {
    throw new Error('focus evidence must be enough');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'manifest.json' },
  })));
  // TextEdit comes forward, but its probe fails too: another app means the old
  // window number is not this app's and must not be reached for.
  const unprobed = { app: 'com.apple.TextEdit', pid: 200, processInstance: 2 };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 150, seen: NOW, focusGeneration: 5, secure: false, owner: unprobed,
  }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('text', 200, { chars: 'Zq-x', focus: { ...EDITOR_FOCUS, name: 'draft.txt' } }),
    owner: unprobed, focusGeneration: 5,
  }));
  // Proof for the new app restores normal binding: the recording is not stuck.
  const textedit = { ...unprobed, windowNumber: 21, windowTitle: 'draft.txt' };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 300, seen: NOW, focusGeneration: 6, secure: false, owner: textedit,
  }));
  await recording.add(parseCaptureEvent({
    ...vscodeEvent('text', 350, { chars: 'Zq-y', focus: { ...EDITOR_FOCUS, name: 'draft.txt' } }),
    owner: textedit, focusGeneration: 6,
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'type']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  // The characters typed after the switch never land in VS Code's window.
  assert.deepEqual(flow.steps[3].scope, {
    kind: 'window', app: 'com.apple.TextEdit', windowKey: 'textedit-1', windowTitle: 'draft.txt',
  });
  assert.equal(flow.steps.some(step => step.scope?.windowKey === 'vscode-1' && step.kind === 'type'), false);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'TEXT_SCOPE_FROM_LAST_WINDOW'), false);
});

test('a 2.5 second queue delay still records text without STALE_CAPTURE', async () => {
  const snapshot = vscodeSnapshot();
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('focus evidence must be enough');
  }, { now: () => NOW + 2500 });
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs', focus: EDITOR_FOCUS })));
  const flow = recording.finish();
  assert.equal(reads, 0);
  assert.deepEqual(flow.steps.map(step => step.kind), ['type']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'STALE_CAPTURE'), false);
});

test('a text event eight seconds behind the stream is dropped with one backlog warning', async () => {
  const recording = new GlobalRecording(async () => {
    throw new Error('a backlogged text event must not be read for');
  }, { now: () => NOW + 11_000 });
  await recording.add(parseCaptureEvent(vscodeEvent('key', 100, { key: 'escape', modifiers: [] })));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs', focus: EDITOR_FOCUS })));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['key']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CAPTURE_BACKLOG'));
});

test('unverified startup events are dropped without leaving a gap', async () => {
  const recording = vscodeRecording(async () => {
    throw new Error('startup noise must not be read for');
  });
  // The helper's first line has no window: the live recording turned it into s1 gap.
  await recording.add(parseCaptureEvent({
    kind: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED', t: 40, seen: NOW,
    focusGeneration: 0, secure: false,
  }));
  await recording.add(parseCaptureEvent(vscodeEvent('click', 120, {
    point: EDITOR_POINT, decision: 'record',
    owner: { ...VSCODE_OWNER, role: 'AXTextField', name: 'manifest.json' },
  })));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CAPTURE_STARTUP'));
});

const FINDER_WINDOW = {
  app: 'com.apple.finder', pid: 100, processInstance: 1, windowNumber: 11, windowTitle: 'Downloads',
};
const NOTES_WINDOW = {
  app: 'com.apple.TextEdit', pid: 200, processInstance: 2, windowNumber: 21, windowTitle: 'Notes 1',
};

test('a gap and an unprovable click before the first step are startup noise', async () => {
  const data = fixture('two-apps-three-windows');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  // The helper's opening line arrives long after any fixed grace period, and it
  // names nothing a replay could stand at, so it must not become s1.
  await recording.add(parseCaptureEvent({
    kind: 'gap', gapCode: 'CAPTURE_SCOPE_UNVERIFIED', t: 900, seen: NOW, focusGeneration: 0, secure: false,
  }));
  // The stream has already claimed TextEdit's window; the click that brings
  // Finder forward belongs to another window and is only a first mouse-down.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 950, seen: NOW, focusGeneration: 1, secure: false, owner: NOTES_WINDOW,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1000, seen: NOW, focusGeneration: 1, secure: false, decision: 'record',
    point: [150, 110], owner: FINDER_WINDOW,
  }));
  // The first action the flow can actually replay: Finder comes forward, a
  // click lands in its window.
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 1100, seen: NOW, focusGeneration: 2, secure: false, owner: FINDER_WINDOW,
  }));
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 1200, seen: NOW, focusGeneration: 2, secure: false, decision: 'record',
    point: [150, 110], owner: { ...FINDER_WINDOW, role: 'AXTextField', name: 'Search', pressable: true },
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['activate_app', 'click']);
  assert.equal(flow.steps[0].id, 's1');
  assert.deepEqual(flow.steps[0].focusAfter, {
    kind: 'window', app: 'com.apple.finder', windowKey: 'finder-1', windowTitle: 'Downloads',
  });
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CAPTURE_STARTUP'));
});

test('a failed tree read reports the window and title it was of', async () => {
  const recording = new GlobalRecording(async window => {
    throw new Fault('INCOMPLETE_TREE',
      `Window snapshot is incomplete (window w-${window.windowNumber}, title "Downloads — 1 item selected")`);
  }, { now: () => NOW });
  // A hover carries no element evidence of its own, so it must read the tree.
  await recording.add(parseCaptureEvent({
    kind: 'hover', t: 100, seen: NOW, focusGeneration: 1, secure: false,
    point: [150, 110], dwellMs: 400, owner: FINDER_WINDOW,
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'STALE_CAPTURE');
  const warning = recording.captureWarnings.find(entry => entry.code === 'SNAPSHOT_UNAVAILABLE');
  // The warning the user sees on the next recording has to say which window and
  // title the read was of, not just the code.
  assert.match(warning.message, /INCOMPLETE_TREE/);
  assert.match(warning.message, /w-11/);
  assert.match(warning.message, /1 item selected/);
});

test('a gap after the first step is still kept', async () => {
  const data = fixture('two-apps-three-windows');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  await recording.add(parseCaptureEvent(data.events[0]));
  await recording.add(parseCaptureEvent({
    kind: 'gap', gapCode: 'CAPTURE_GAP', t: 150, seen: NOW, focusGeneration: 1, secure: false,
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_GAP');
  assert.equal(recording.captureWarnings.some(warning => warning.code === 'CAPTURE_STARTUP'), false);
});

test('excluded apps are dropped before their window is read', async () => {
  const data = fixture('queue-overflow');
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('excluded app must not be read');
  }, { now: () => NOW, exclude: ['com.apple.finder'] });
  for (const event of data.events.filter(entry => entry.kind !== 'gap')) {
    await recording.add(parseCaptureEvent(event));
  }
  assert.equal(reads, 0);
  assert.throws(() => recording.finish(), { code: 'EMPTY_RECORDING' });
});

test('capture protocol rejects a malformed global event', () => {
  assert.throws(() => parseCaptureEvent({ kind: 'click' }), { code: 'CAPTURE_PROTOCOL' });
  assert.throws(() => parseCaptureEvent({
    kind: 'system_dialog', t: 1, seen: 1, focusGeneration: 0, secure: false, visible: 'true',
  }), { code: 'CAPTURE_PROTOCOL' });
  assert.throws(() => parseCaptureEvent({
    kind: 'gap', t: 1, seen: 1, focusGeneration: 0, secure: false, gapCode: 'NOPE',
  }), { code: 'CAPTURE_PROTOCOL' });
  // A helper may name why a gap happened; the field is optional so an older
  // helper that never sends it still parses, and the value stays a bounded
  // identifier.
  assert.equal(parseCaptureEvent({
    kind: 'gap', t: 1, seen: 1, focusGeneration: 0, secure: false, gapCode: 'STALE_CAPTURE',
  }).detail, undefined);
  assert.equal(parseCaptureEvent({
    kind: 'gap', t: 1, seen: 1, focusGeneration: 0, secure: false,
    gapCode: 'STALE_CAPTURE', detail: 'tap_interrupted',
  }).detail, 'tap_interrupted');
  // Only the two known reasons are carried; anything else is "no reason" and
  // must never reject the line, which would drop the gap it explains.
  for (const detail of ['event_lag_x', 'Tap interrupted!', 42, null]) {
    const parsed = parseCaptureEvent({
      kind: 'gap', t: 1, seen: 1, focusGeneration: 0, secure: false,
      gapCode: 'STALE_CAPTURE', detail,
    });
    assert.equal(parsed.kind, 'gap');
    assert.equal(parsed.gapCode, 'STALE_CAPTURE');
    assert.equal(parsed.detail, undefined);
  }
  const valid = parseCaptureEvent({
    kind: 'click', t: 1, seen: 1, focusGeneration: 2, secure: false,
    point: [10, 20], decision: 'record', owner: { app: 'com.apple.TextEdit', pid: 7, windowNumber: 3 },
  });
  assert.equal(valid.kind, 'click');
  assert.equal(valid.point[0], 10);
  // Secure evidence names why an event was refused, without carrying content.
  const secure = parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: true,
    secureEvidence: ['system_secure_input', 'secure_control'],
    owner: { app: 'com.apple.SecurityAgent', pid: 8, securityAgent: true },
  });
  assert.deepEqual(secure.secureEvidence, ['system_secure_input', 'secure_control']);
  assert.equal(secure.owner.securityAgent, true);
  assert.throws(() => parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: true, secureEvidence: ['nope'],
  }), { code: 'CAPTURE_PROTOCOL' });
  assert.throws(() => parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: false,
    secureEvidence: ['secure_control'],
  }), { code: 'CAPTURE_PROTOCOL' });
});

test('record --global is an explicit mode that rejects target flags', { skip: process.platform !== 'darwin' }, () => {
  for (const args of [
    ['record', '--global', '--app', 'com.apple.TextEdit'],
    ['record', '--global', '--window', 'Notes'],
    ['record', '--global', '--app-path', '/Applications/TextEdit.app'],
    ['record', '--global', '--seconds', '5'],
    ['record', '--global', '--max-seconds', '0'],
    ['record', '--global', '--max-seconds', '3601'],
    ['record', '--global', '--exclude', 'not-a-bundle-id'],
    ['record', '--global', '--clipboard'],
    ['record', '--global', '--progress-fd', '2'],
    ['record', '--app', 'com.apple.TextEdit', '--progress-fd', '3'],
    ['record', '--exclude', 'com.apple.TextEdit'],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: process.env.HOME },
    });
    const response = JSON.parse(result.stdout);
    assert.equal(result.status, 2, `${args.join(' ')} should be invalid input`);
    assert.equal(response.ok, false);
  }
});

/**
 * Runs the real CLI against stub helper and desktop executables. The helper
 * emits a ready line and the events; the desktop only serves the fixture trees.
 * `retitle` is appended to every window title the desktop answers with, which
 * models a window that has retitled since the event that named it. No GUI,
 * accessibility API or capture tap is involved.
 */
function globalCliFixture(t, {
  events, snapshots, cliArgs = [], seconds = 2, exit = 0, ready, download, retitle = '',
  imeSource = ABC_SOURCE, progress = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-global-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    recursive: true,
    filter: source => !source.endsWith('/cuekeeper-capture') && !source.endsWith('/cuekeeper-ime'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');

  const desktop = join(dir, 'desktop');
  const commandsLog = join(dir, 'desktop-commands.log');
  writeFileSync(commandsLog, '');
  const trees = Object.fromEntries(Object.entries(snapshots).map(([number, snapshot]) => {
    const convert = node => ({
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(node.ref === undefined ? {} : { ref_id: node.ref }),
      ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
      states: node.states ?? [],
      secure: node.secure ?? false,
      children: (node.children ?? []).map(convert),
    });
    return [number, { id: snapshot.windowId, title: snapshot.tree.name, tree: convert(snapshot.tree) }];
  }));
  writeFileSync(desktop, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandsLog)}, command + ' ' + args.join(' ') + '\\n');
const windows = ${JSON.stringify(trees)};
if (command === 'version') {
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: { version: '1.3.1' } }));
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
    complete: true, truncated: false,
    window: { id: window.id, title: window.title + ${JSON.stringify(retitle)} }, tree: window.tree,
  } }));
  process.exit(0);
}
console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'UNSUPPORTED' } }));
process.exit(1);
`, { mode: 0o700 });

  const capture = join(dir, 'cuekeeper-capture');
  const captureArgs = join(dir, 'capture-args.json');
  const downloadDir = download === undefined ? undefined : join(dir, 'Downloads');
  // The directory exists before the recording starts, so only the file that
  // appears mid-session is a lifecycle event.
  if (downloadDir !== undefined) mkdirSync(downloadDir, { recursive: true });
  writeFileSync(capture, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(captureArgs)}, JSON.stringify(args));
if (args[0] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
assert.equal(args[0], '--global');
const seen = Date.now();
const messages = [
  ${JSON.stringify(ready ?? { kind: 'ready', global: true, hotkeysFiltered: true, indicator: false })},
  ...${JSON.stringify(events)},
];
writeFileSync(1, messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n') + '\\n');
// A download that appears during the recording is what the lifecycle watcher
// turns into a candidate wait; the helper stays alive so it can observe it. The
// short delay keeps the file out of the watcher's baseline.
await new Promise(resolve => setTimeout(resolve, ${download === undefined ? 0 : 300}));
${download === undefined ? '' : `writeFileSync(${JSON.stringify(join(downloadDir, download.name))}, 'x'.repeat(${download.size}));`}
await new Promise(resolve => setTimeout(resolve, ${download === undefined ? 0 : (download.stayAliveMs ?? 1800)}));
process.exitCode = ${exit};
`, { mode: 0o700 });

  const output = join(dir, 'global.flow.json');
  const ime = imeStub(dir, { current: imeSource });
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record', '--global',
    '--countdown', '0', '--no-indicator', '--max-seconds', String(seconds),
    '--out', output, '--json',
    // Descriptor 3 is the stage-report channel the workbench asks for.
    ...(progress ? ['--progress-fd', '3'] : []), ...cliArgs], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: desktop,
      CUEKEEPER_RECORDER: capture,
      CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      CUEKEEPER_IME: ime.helper,
      CUEKEEPER_IME_DIR: join(dir, 'ime-root'),
      ...(downloadDir === undefined ? {} : {
        CUEKEEPER_LIFECYCLE_DOWNLOAD_DIRS: downloadDir,
        CUEKEEPER_LIFECYCLE_APP_DIRS: join(dir, 'Applications'),
      }),
    },
    encoding: 'utf8', timeout: 20_000,
    ...(progress ? { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] } : {}),
  });
  const response = JSON.parse(result.stdout);
  const stages = progress
    ? (result.output[3] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : undefined;
  const written = existsSync(output) ? readFileSync(output, 'utf8') : undefined;
  return {
    dir, downloadDir, code: result.status, response, stderr: result.stderr, output, written, stages,
    captureArgs: JSON.parse(readFileSync(captureArgs, 'utf8')),
    commands: readFileSync(commandsLog, 'utf8').trim().split('\n').filter(Boolean),
    imeSelects: ime.selects(),
    imeCurrent: ime.current(),
  };
}

test('record --global writes a v2 flow with scopes and no typed content', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  // Only the first three windows' earliest events are needed for the CLI pass.
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  const events = [
    data.events[0],
    { ...data.events[1], chars: secret },
    data.events[3],
    { ...data.events[4], chars: secret },
  ];
  const run = globalCliFixture(t, {
    events, snapshots: data.snapshots, cliArgs: ['--exclude', 'com.apple.mail'],
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.deepEqual(run.captureArgs.slice(0, 2), ['--global', '2']);
  assert.deepEqual(run.captureArgs.slice(-2), ['--exclude', 'com.apple.mail']);
  assert.ok(run.written, 'the CLI must write the flow');
  const flow = JSON.parse(run.written);
  assert.equal(flow.version, 2);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type', 'activate_app', 'type']);
  assert.equal(flow.steps[1].input, 'text_1');
  assert.equal(flow.steps[3].scope.app, 'com.apple.TextEdit');
  assert.ok(!run.written.includes(secret));
  assert.ok(!run.stderr.includes(secret));
  assert.ok(!JSON.stringify(run.response).includes(secret));
  // The click's own element evidence and its anchor carry the first text; only
  // the TextEdit window needs one fallback read. Clicks also schedule one read
  // of the window they changed, which is what lets the next click in that
  // window name an element a sheet or page switch would have hidden. Those run
  // off the event stream and are independent of each other, so a run that ends
  // before some of them fire does not wait for them; whatever ran is counted.
  const reads = run.commands.filter(command => command.startsWith('snapshot')).length;
  assert.ok(reads >= 1, `snapshot commands: ${reads}`);
  assert.equal(run.response.data.snapshotReads, reads);
});

test('record --global reports its stages with the helper ready moment', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  // The helper dates its own ready moment; the CLI must carry that value, not
  // the moment it happened to read the line.
  const readyAt = Date.now() - 1500;
  const run = globalCliFixture(t, {
    events: [data.events[0]], snapshots: data.snapshots, progress: true,
    ready: { kind: 'ready', global: true, hotkeysFiltered: true, indicator: false, readyAt },
  });
  // `JSON.parse(result.stdout)` inside the fixture already proves the result
  // still leaves as one envelope; the stage reports go elsewhere.
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.deepEqual(run.stages.map(entry => entry.stage), ['countdown', 'preparing', 'recording']);
  assert.ok(Number.isFinite(run.stages[0].endsAt), 'the countdown report dates its real end');
  assert.equal(run.stages[2].readyAt, readyAt);
  assert.ok(run.written, 'the flow is still written');
});

test('record --global dates ready from the report when the helper omits it', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const before = Date.now();
  const run = globalCliFixture(t, {
    events: [data.events[0]], snapshots: data.snapshots, progress: true,
  });
  const after = Date.now();
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  const ready = run.stages.at(-1);
  assert.equal(ready.stage, 'recording');
  // An older helper has no readyAt; the arrival of its ready line is the only
  // honest substitute, and it is far better than a fixed sleep.
  assert.ok(Number.isInteger(ready.readyAt) && ready.readyAt >= before && ready.readyAt <= after,
    `readyAt ${ready.readyAt} must fall within ${before}..${after}`);
});

test('record --global consumes a drag pickup and saves the drag step', { skip: process.platform !== 'darwin' }, t => {  const data = fixture('drag-across-controls');
  // The helper announces every pickup before the drop. A drag from one control
  // to another is a business drag and must yield one drag step, not a protocol
  // error for the announcement the helper sends first. A drag inside one text
  // field is a selection instead and is dropped (see the recorder test above).
  const drag = { ...data.events[1], from: [820, 314], to: [1190, 314], path: [] };
  const run = globalCliFixture(t, {
    events: [{ kind: 'drag_start' }, drag],
    snapshots: { 3868: data.snapshots['3868'] },
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.ok(run.written, 'the CLI must write the flow');
  const flow = JSON.parse(run.written);
  assert.deepEqual(flow.steps.map(step => step.kind), ['drag']);
  assert.equal(run.response.data.partial, undefined);
  assert.equal(run.response.error, undefined);
});

test('record --global names a click after its window retitled', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('finder-list-view-file-click');
  // The click carries no element evidence, so it is named by reading the tree.
  // That read answers a window whose title has moved on since the event that
  // bound it, exactly like an editor's unsaved dot or problem count.
  const run = globalCliFixture(t, {
    events: data.events,
    snapshots: data.snapshots,
    retitle: ' — 1 problem in this file',
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  const flow = JSON.parse(run.written);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'treeitem', name: 'manifest.json' });
  // A retitle is not a capture failure: no gap and no unavailable-read warning.
  assert.equal(run.response.data.warnings, undefined);
  assert.equal(run.response.data.snapshotReads, 1);
});

test('record --global keeps a partial flow when the helper stops after an event', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    seconds: 1,
    exit: 1,
  });
  assert.equal(run.code, 1);
  assert.equal(run.response.ok, false);
  assert.equal(run.response.error.code, 'CAPTURE_FAILED');
  assert.equal(run.response.data.partial, true);
  const flow = JSON.parse(run.written);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
});

test('record --global switches a Chinese source to ABC and restores it afterwards', {
  skip: process.platform !== 'darwin',
}, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    imeSource: SOGOU_SOURCE,
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  // Capture ran under ABC, then the user's own source came back.
  assert.deepEqual(run.imeSelects, [ABC_SOURCE.id, SOGOU_SOURCE.id]);
  assert.deepEqual(run.imeCurrent, SOGOU_SOURCE);
  // The source the user had is still reported, without the old warning: the
  // recording solved it instead of asking the user to switch.
  assert.deepEqual(run.response.data.inputSource, SOGOU_SOURCE);
  assert.equal(run.response.data.warnings, undefined);
  assert.doesNotMatch(run.stderr, /输入法处于中文状态/);
  const flow = JSON.parse(run.written);
  assert.equal(flow.steps[0].kind, 'click');
});

test('record --global restores the Chinese source when the capture helper fails', {
  skip: process.platform !== 'darwin',
}, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    seconds: 1,
    exit: 1,
    imeSource: SOGOU_SOURCE,
  });
  assert.equal(run.code, 1);
  assert.equal(run.response.data.partial, true);
  // A failed recording is still a finished recording for the input source.
  assert.deepEqual(run.imeSelects, [ABC_SOURCE.id, SOGOU_SOURCE.id]);
  assert.deepEqual(run.imeCurrent, SOGOU_SOURCE);
});

test('record --global leaves an already-ASCII source alone', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
  });
  assert.equal(run.code, 0, run.stderr + JSON.stringify(run.response));
  // No switch and no restore: the source was never touched.
  assert.deepEqual(run.imeSelects, []);
  assert.deepEqual(run.imeCurrent, ABC_SOURCE);
  assert.deepEqual(run.response.data.inputSource, ABC_SOURCE);
  assert.equal(run.response.data.warnings, undefined);
});

test('record --global keeps the paused time the helper reports when it stops', {
  skip: process.platform !== 'darwin',
}, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0], data.events[3], { kind: 'stopped', pausedMs: 5000 }],
    snapshots: data.snapshots,
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  const flow = JSON.parse(run.written);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'activate_app']);
  // The closing summary is the only place the paused time comes from.
  assert.equal(flow.pausedMs, 5000);
  assert.match(flow.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('a helper that does not confirm global mode is refused', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    ready: { kind: 'ready', hotkeysFiltered: true, indicator: false },
  });
  assert.equal(run.code, 2);
  assert.equal(run.response.ok, false);
  assert.equal(run.response.error.code, 'CAPTURE_PROTOCOL');
  assert.equal(run.written, undefined);
});

test('a recording exposes its lifecycle facts for candidates without a hand-written file', async t => {
  const recording = await recordFixture('two-apps-three-windows');
  const lastStep = recording.stepCount;
  recording.recordLifecycle({ at: 120_000, kind: 'download_completed', path: '/Users/qa/Downloads/App.pkg' });
  recording.recordLifecycle({
    at: 130_000, kind: 'install_completed',
    app: 'com.apple.TextEdit', path: '/Applications/TextEdit.app',
  });
  recording.recordLifecycle({ at: 140_000, kind: 'uninstall_completed', app: 'com.apple.TextEdit' });
  const flow = recording.finish();
  const events = recording.lifecycle;

  assert.equal(events.length, 3);
  // Each event is placed after the step that was recorded when it arrived.
  assert.deepEqual(events.map(event => event.afterStepId), Array(3).fill(`s${lastStep}`));
  assert.deepEqual(events.map(event => event.kind),
    ['download_completed', 'install_completed', 'uninstall_completed']);

  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-record-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'flow.json'), JSON.stringify(flow));
  writeFileSync(join(dir, 'lifecycle.json'), JSON.stringify({ version: 1, events }));

  const session = await loadSession(dir);
  const candidates = session.view.waitCandidates;
  assert.deepEqual(candidates.map(candidate => candidate.eventKind),
    ['download_completed', 'install_completed', 'uninstall_completed']);
  assert.deepEqual(candidates.map(candidate => candidate.ready), [true, true, true]);
  // The recorded download waits on the recorded file, not on a download window.
  assert.deepEqual(candidates[0].step.scope,
    { kind: 'file', directory: '/Users/qa/Downloads', name: 'App.pkg' });
  assert.deepEqual(candidates[0].step.check, { kind: 'file_stable' });
  assert.deepEqual(candidates[1].step.check, { kind: 'app_installed', equals: true });
  assert.deepEqual(candidates[2].step.check, { kind: 'app_installed', equals: false });
});

test('record --global writes lifecycle.json from what the download directory proved', {
  skip: process.platform !== 'darwin',
}, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0], data.events[1]],
    snapshots: data.snapshots,
    download: { name: 'CuekeeperTest.pkg', size: 4096, stayAliveMs: 1800 },
    seconds: 3,
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.equal(run.response.data.lifecycle, 1);
  const lifecyclePath = join(run.dir, 'lifecycle.json');
  assert.ok(existsSync(lifecyclePath), 'the CLI writes lifecycle.json next to the flow');
  const lifecycle = JSON.parse(readFileSync(lifecyclePath, 'utf8'));
  assert.equal(lifecycle.version, 1);
  assert.equal(lifecycle.events.length, 1);
  const [event] = lifecycle.events;
  assert.equal(event.kind, 'download_completed');
  assert.equal(event.path, join(run.downloadDir, 'CuekeeperTest.pkg'));
  // The event knows which recorded step it followed, so the workbench can place
  // a wait without any hand-written afterStepId.
  assert.match(event.afterStepId, /^s\d+$/);
  assert.ok(!JSON.stringify(run.response).includes(run.downloadDir));
});

test('record --global --no-lifecycle writes no lifecycle file', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    cliArgs: ['--no-lifecycle'],
    download: { name: 'CuekeeperTest.pkg', size: 4096, stayAliveMs: 1800 },
    seconds: 3,
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.equal(run.response.data.lifecycle, undefined);
  assert.equal(existsSync(join(run.dir, 'lifecycle.json')), false);
});

// The Finder session behind HAOC-148: right-click a file, choose 重命名 from the
// context menu, type the new name and press Return.
const FINDER_FOLDER = {
  app: 'com.apple.finder', pid: 100, processInstance: 1_700_000_000_000,
  windowNumber: 11, windowTitle: 'cuekeeper-demo',
};

test('a context-menu choice and the rename editor stay on the window that opened them', async () => {
  const recording = new GlobalRecording(async () => {
    throw new Error('every step carries its own element evidence');
  }, { now: () => NOW });
  const finderEvent = (kind, t, extra) => ({
    kind, t, seen: NOW, focusGeneration: 1, secure: false, owner: FINDER_FOLDER, ...extra,
  });
  // The folder window is proved, then two clicks land in it: the view control,
  // then the item the user picked from the context menu the right click opened.
  await recording.add(parseCaptureEvent(finderEvent('click', 100, {
    point: [700, 160], count: 1, button: 'right', decision: 'record',
    owner: { ...FINDER_FOLDER, role: 'AXOutline', name: '列表视图', pressable: true },
  })));
  await recording.add(parseCaptureEvent(finderEvent('click', 900, {
    point: [812, 214], count: 1, decision: 'record',
    owner: { ...FINDER_FOLDER, role: 'AXMenuItem', name: '重命名', pressable: true },
  })));
  // Finder's inline rename editor is reported as an untitled window of its own.
  // It is a surface of the folder window, never a scope a replay can navigate to.
  const editor = {
    app: 'com.apple.finder', pid: 100, processInstance: 1_700_000_000_000,
    windowNumber: 12, windowTitle: '',
  };
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 1000, seen: NOW, focusGeneration: 2, secure: false, owner: editor,
  }));
  const renameFocus = { role: 'AXTextField', editable: true, bounds: [620, 150, 180, 24] };
  await recording.add(parseCaptureEvent({
    kind: 'text', t: 1060, seen: NOW, focusGeneration: 2, secure: false,
    owner: editor, focus: renameFocus, chars: 'Zq-renamed',
  }));
  await recording.add(parseCaptureEvent({
    kind: 'text', t: 1120, seen: NOW, focusGeneration: 2, secure: false,
    owner: editor, focus: renameFocus, chars: 'Zq-2',
  }));
  // Return ends the rename; the folder window is focused again.
  await recording.add(parseCaptureEvent({
    kind: 'key', t: 1400, seen: NOW, focusGeneration: 3, secure: false,
    owner: FINDER_FOLDER, key: 'return', modifiers: [],
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click', 'type', 'key']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.equal(flow.steps.some(step => step.kind === 'focus_window'), false,
    'an untitled surface must not add a navigation step');
  // Every step stands in the folder window that was open the whole time.
  assert.deepEqual([...new Set(flow.steps.map(step => step.scope?.windowKey))], ['finder-1']);
  assert.deepEqual([...new Set(flow.steps.map(step => step.scope?.windowTitle))], ['cuekeeper-demo']);
  // The menu press names the item, not the menu window it was drawn in.
  assert.deepEqual(flow.steps[1].target, { kind: 'element', role: 'menuitem', name: '重命名' });
  assert.equal(flow.steps[1].button, undefined);
  assert.deepEqual(flow.steps[2].target, { kind: 'element', role: 'textfield' });
  assert.equal(flowV2Check.Check(flow), true);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'WINDOW_SCOPE_FROM_LAST_WINDOW'));
});

test('a titleless event does not rename a window that was already proved', async () => {
  const recording = new GlobalRecording(async () => {
    throw new Error('no tree read');
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'focus', t: 100, seen: NOW, focusGeneration: 1, secure: false, owner: FINDER_FOLDER,
  }));
  // The menu surface carries no title of its own. The window it belongs to is
  // already bound under its folder name, and the title must survive.
  const { windowTitle: _title, ...titleless } = FINDER_FOLDER;
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 200, seen: NOW, focusGeneration: 1, secure: false, decision: 'record',
    point: [812, 214], owner: { ...titleless, role: 'AXMenuItem', name: '重命名', pressable: true },
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(flow.steps[0].scope, {
    kind: 'window', app: 'com.apple.finder', windowKey: 'finder-1', windowTitle: 'cuekeeper-demo',
  });
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'menuitem', name: '重命名' });
});

test('a window-less event never inherits a scope from another app', async () => {
  const recording = new GlobalRecording(async () => {
    throw new Error('no tree read');
  }, { now: () => NOW });
  await recording.add(parseCaptureEvent({
    kind: 'click', t: 100, seen: NOW, focusGeneration: 1, secure: false, decision: 'record',
    point: [700, 160], owner: FINDER_FOLDER,
  }));
  // Another app that has proved no window of its own: the folder window the
  // recording already knows must not be reached for.
  await recording.add(parseCaptureEvent({
    kind: 'key', t: 300, seen: NOW, focusGeneration: 2, secure: false,
    owner: { app: 'com.apple.TextEdit', pid: 200, processInstance: 2 }, key: 'return', modifiers: [],
  }));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
});

test('HAOC-175 review: a queued follow-up read waits out a secure interval', async () => {
  const data = fixture('two-apps-three-windows');
  const queued = [];
  let reads = 0;
  const read = readerFor(data);
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return read(window);
  }, { now: () => NOW, scheduleSettle: task => queued.push(task) });
  await recording.add(parseCaptureEvent(data.events[0]));
  const readCountBeforeSecure = reads;
  assert.equal(queued.length, 1);
  await recording.add(parseCaptureEvent({
    ...data.events[1], secure: true, secureEvidence: ['system_secure_input'],
  }));
  await queued.shift()();
  recording.finish();
  assert.equal(reads, readCountBeforeSecure, 'a queued task read an AX tree inside the secure interval');
});

test('HAOC-175 review: a read completed across secure input cannot name a later click', async () => {
  const data = fixture('two-apps-three-windows');
  const click = data.events[0];
  const expired = structuredClone(data.snapshots[String(click.owner.windowNumber)]);
  expired.tree.children = [{
    role: 'button', name: 'Expired target', ref: '@w11:e42',
    bounds: { x: 140, y: 100, width: 30, height: 30 },
    states: [], secure: false, children: [],
  }];
  const queued = [];
  let reads = 0;
  let completeRead;
  const delayed = new Promise(resolve => { completeRead = resolve; });
  const recording = new GlobalRecording(async () => {
    reads += 1;
    if (reads === 1) return delayed;
    throw new Error('fresh tree unavailable');
  }, { now: () => NOW, scheduleSettle: task => queued.push(task) });

  await recording.add(parseCaptureEvent(click));
  const pending = queued.shift()();
  assert.equal(reads, 1);
  await recording.add(parseCaptureEvent({
    ...data.events[1], secure: true, secureEvidence: ['system_secure_input'],
  }));
  completeRead(expired);
  await pending;
  await recording.add(parseCaptureEvent({
    ...click, t: 300, seen: NOW + 200, owner: { ...click.owner, name: '' },
  }));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'manual_checkpoint', 'click']);
  assert.deepEqual(flow.steps[2].target, { kind: 'point', point: click.point });
});
