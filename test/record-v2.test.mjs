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
import { resolve } from '../dist/locator.js';
import { GlobalRecording } from '../dist/record-v2.js';
import { loadSession } from '../dist/workbench-session.js';

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
  assert.equal(flow.steps[1].input, 'input_1');
  assert.equal(flow.steps[2].scope.app, 'com.apple.TextEdit');
  assert.equal(flow.steps[2].focusAfter.windowKey, 'textedit-1');
  assert.equal(flow.steps[3].input, 'input_2');
  // The second window of the same process gets its own window key.
  assert.equal(flow.steps[4].kind, 'focus_window');
  assert.equal(flow.steps[4].scope.windowKey, 'textedit-2');
  assert.equal(flow.steps[5].input, 'input_3');
  assert.equal(flow.steps[6].focusAfter.windowKey, 'finder-1');
  assert.equal(flow.steps[7].scope.windowKey, 'finder-1');
  assert.deepEqual(flow.inputs, ['input_1', 'input_2', 'input_3']);
  // Text is never stored: only parameter names appear in the flow.
  const json = JSON.stringify(flow);
  assert.ok(!json.includes('Zq-file'));
  assert.ok(!json.includes('Zq-one'));
  assert.ok(!json.includes('Zq-two'));
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
  assert.deepEqual(flow.steps, [{ id: 's1', kind: 'gap', code: 'CAPTURE_SCOPE_UNVERIFIED' }]);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('occluded and first-mouse clicks become gaps; activation-only clicks navigate', async () => {
  const flow = (await recordFixture('unprovable-clicks')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps[3].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps[2].scope.app, 'com.apple.TextEdit');
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 1);
});

test('a drag that crosses a window boundary leaves CROSS_SCOPE_GESTURE', async () => {
  const flow = (await recordFixture('cross-window-drag')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'CROSS_SCOPE_GESTURE');
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
  assert.equal(flow.steps[1].input, 'input_1');
  assert.deepEqual(flow.inputs, ['input_1']);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'FOCUSED_EDITABLE_TARGET'));
  assert.ok(!JSON.stringify(flow).includes('Zq-vs'));
});

// The helper reports the focused control on every text event, so the container
// a click hit is corrected without reading the tree at all.
const EDITOR_FOCUS = {
  role: 'AXTextField', name: 'manifest.json', editable: true, bounds: [300, 120, 900, 660],
};

test('a container click is retargeted from the text event focus evidence, with no read', async () => {
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    throw new Error('focus evidence must be enough');
  });
  for (const event of [
    vscodeEvent('click', 100, {
      point: EDITOR_POINT, decision: 'record', owner: { ...VSCODE_OWNER, role: 'AXGroup' },
    }),
    vscodeEvent('text', 200, { chars: 'Zq-vs', focus: EDITOR_FOCUS }),
    vscodeEvent('text', 260, { chars: 'Zq-vs', focus: EDITOR_FOCUS }),
  ]) await recording.add(parseCaptureEvent(event));

  const flow = recording.finish();
  assert.equal(reads, 0);
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
    throw new Error('focus evidence must be enough');
  });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, {
    point: EDITOR_POINT, decision: 'record', owner: { ...VSCODE_OWNER, role: 'AXGroup' },
  })));
  for (const [t, chars] of [[200, 'a'], [240, 'b'], [280, 'c']]) {
    await recording.add(parseCaptureEvent(vscodeEvent('text', t, { chars, focus: area })));
  }

  const flow = recording.finish();
  assert.equal(reads, 0);
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

test('a click the cached tree cannot place is read again and keeps its point', async () => {
  // One button in the top-left corner: everything else in the window is empty.
  const snapshot = plainWindow(33, 'Editor', { x: 0, y: 0, width: 1400, height: 900 }, [{
    role: 'button', name: 'Save', ref: '@plain:e2',
    bounds: { x: 20, y: 20, width: 80, height: 30 }, states: [], secure: false, children: [],
  }]);
  const { read, reads } = countingReader({ 33: snapshot });
  const recording = new GlobalRecording(read, { now: () => NOW });
  await recording.add(parseCaptureEvent(vscodeEvent('click', 100, { point: [60, 35], decision: 'record' })));
  // Nothing is under this point but the window root, in the cached tree and in
  // any other: blank space is a point with a warning, never a guessed element.
  await recording.add(parseCaptureEvent(vscodeEvent('click', 2000, { point: [700, 400], decision: 'record' })));
  const flow = recording.finish();
  assert.deepEqual(reads, [33, 33], 'an empty hit costs one fresh read, not a gap');
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'click']);
  assert.deepEqual(flow.steps[1].target, { kind: 'point', point: [700, 400] });
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'UNTARGETED_ELEMENT_CLICK'));
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
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
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record', '--global',
    '--countdown', '0', '--no-indicator', '--max-seconds', String(seconds),
    '--out', output, '--json', ...cliArgs], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: desktop,
      CUEKEEPER_RECORDER: capture,
      CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      CUEKEEPER_IME_DIR: join(dir, 'ime-root'),
      ...(downloadDir === undefined ? {} : {
        CUEKEEPER_LIFECYCLE_DOWNLOAD_DIRS: downloadDir,
        CUEKEEPER_LIFECYCLE_APP_DIRS: join(dir, 'Applications'),
      }),
    },
    encoding: 'utf8', timeout: 20_000,
  });
  const response = JSON.parse(result.stdout);
  const written = existsSync(output) ? readFileSync(output, 'utf8') : undefined;
  return {
    dir, downloadDir, code: result.status, response, stderr: result.stderr, output, written,
    captureArgs: JSON.parse(readFileSync(captureArgs, 'utf8')),
    commands: readFileSync(commandsLog, 'utf8').trim().split('\n').filter(Boolean),
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
  assert.equal(flow.steps[1].input, 'input_1');
  assert.equal(flow.steps[3].scope.app, 'com.apple.TextEdit');
  assert.ok(!run.written.includes(secret));
  assert.ok(!run.stderr.includes(secret));
  assert.ok(!JSON.stringify(run.response).includes(secret));
  // The click's own element evidence and its anchor carry the first text; only
  // the TextEdit window needs one fallback read.
  assert.equal(run.commands.filter(command => command.startsWith('snapshot')).length, 1);
  // The same number is reported as the recording's accessibility cost.
  assert.equal(run.response.data.snapshotReads, 1);
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
