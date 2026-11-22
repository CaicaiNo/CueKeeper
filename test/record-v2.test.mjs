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
  assert.deepEqual(readWindows, [11, 11]);
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

test('an event whose snapshot missed its budget leaves STALE_CAPTURE', async () => {
  const data = fixture('queue-overflow');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW + 5000 });
  await recording.add(parseCaptureEvent(data.events[0]));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'STALE_CAPTURE');
});

test('an unreadable window snapshot becomes a gap instead of a guessed step', async () => {
  const data = fixture('queue-overflow');
  const recording = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.ok(flow.steps.some(step => step.kind === 'gap' && step.code === 'STALE_CAPTURE'));
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

test('a click the helper saw on an element keeps that element when the tree read fails', async () => {
  const data = fixture('finder-downloads-pkg-click');
  const events = data.events.map(event => event.kind !== 'click' ? event : {
    ...event,
    owner: { ...event.owner, role: 'AXImage', name: 'Install Test.pkg' },
  });
  const recording = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(flow.steps[0].target, {
    kind: 'element', role: 'AXImage', name: 'Install Test.pkg',
  });
  assert.equal(flow.steps[0].count, 2);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'NATIVE_ELEMENT_FALLBACK'));
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);

  // An element fallback without a name still records the role alone.
  const anonymous = data.events.map(event => event.kind !== 'click' ? event : {
    ...event, owner: { ...event.owner, role: 'AXImage' },
  });
  const second = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  for (const event of anonymous) await second.add(parseCaptureEvent(event));
  assert.deepEqual(second.finish().steps[0].target, { kind: 'element', role: 'AXImage' });
});

test('a window tree read that fails once is retried before a fallback is used', async () => {
  const data = fixture('finder-downloads-pkg-click');
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    if (reads === 1) throw new Error('snapshot unavailable');
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  // The retry read the real tree, so the step names the element it hit.
  assert.equal(flow.steps[0].target.kind, 'element');
  assert.equal(flow.steps[0].target.role, 'image');
  assert.equal(flow.steps[0].target.name, 'Install Test.pkg');
  assert.equal(flow.steps[0].count, 2);
  assert.equal(recording.captureWarnings.some(warning => warning.code.startsWith('NATIVE_')), false);
  assert.equal(reads, 3);
});

test('a click that already missed its budget keeps a point target, not a gap', async () => {
  const data = fixture('finder-downloads-pkg-click');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW + 5000 });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
  assert.equal(flow.steps[0].target.kind, 'point');
});

test('a small list view still records the clicked element rather than a fallback', async () => {
  const data = fixture('two-apps-three-windows');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  await recording.add(parseCaptureEvent(data.events[0]));
  const flow = recording.finish();
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

test('a click that lost its window tree is retargeted to the textfield the following text proves', async () => {
  const snapshot = vscodeSnapshot();
  let reads = 0;
  const recording = vscodeRecording(async () => {
    reads += 1;
    // The click's two attempts fail, exactly like the live VS Code recording;
    // the first text event then reads the tree successfully.
    if (reads <= 2) throw new Error('snapshot unavailable');
    return structuredClone(snapshot);
  });
  for (const event of [
    vscodeEvent('click', 100, { point: EDITOR_POINT, decision: 'record', owner: { ...VSCODE_OWNER, role: 'AXGroup' } }),
    vscodeEvent('text', 200, { chars: 'Zq-vs' }),
    vscodeEvent('text', 260, { chars: 'Zq-vs' }),
  ]) await recording.add(parseCaptureEvent(event));

  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type']);
  // The group recorded from native evidence is corrected in place.
  assert.deepEqual(flow.steps[0].target, { kind: 'element', role: 'textfield', name: 'manifest.json' });
  assert.deepEqual(flow.steps[1].target, flow.steps[0].target);
  assert.equal(flow.steps.some(step => step.kind === 'gap'), false);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'CLICK_RETARGETED_TO_TEXT'));
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

test('a text event with no focused control and no click anchor leaves a reasoned gap', async () => {
  const snapshot = vscodeSnapshot({ focused: false });
  const recording = vscodeRecording(async () => structuredClone(snapshot));
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs' })));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'CAPTURE_SCOPE_UNVERIFIED');
  const warning = recording.captureWarnings.find(entry => entry.code === 'TEXT_TARGET_UNRESOLVED');
  assert.ok(warning, 'the gap must say why the text could not be bound');
});

test('a text event too far behind the stream stays a stale gap', async () => {
  const snapshot = vscodeSnapshot();
  const recording = new GlobalRecording(async () => structuredClone(snapshot), { now: () => NOW + 11_000 });
  await recording.add(parseCaptureEvent(vscodeEvent('text', 200, { chars: 'Zq-vs' })));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'STALE_CAPTURE');
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
 * No GUI, accessibility API or capture tap is involved.
 */
function globalCliFixture(t, {
  events, snapshots, cliArgs = [], seconds = 2, exit = 0, ready, download,
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
    window: { id: window.id, title: window.title }, tree: window.tree,
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
  assert.equal(run.commands.filter(command => command.startsWith('snapshot')).length, 3);
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
