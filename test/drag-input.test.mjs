import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { offlineDesktop, withDesktop } from '../dist/desktop.js';
import { parseFlow, plan } from '../dist/flow.js';
import { parseSnapshot } from '../dist/locator.js';
import { Recording } from '../dist/record.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const signal = new AbortController().signal;
const snapshot = parseSnapshot(fixture.data, fixture.target);
const target = fixture.target;
const flowFor = steps => parseFlow({
  version: 1, id: 'drag-flow', name: 'Drag input', target, steps,
});
const start = { kind: 'point', point: [135, 165] };
const end = { kind: 'point', point: [420, 330] };
// The text field's center is (419.5, 319); only a point on that center becomes
// an element locator, because an element drag replays from the center.
const editor = {
  kind: 'element', role: 'textfield', name: '', path: ['window', 'scrollarea', 'textfield'],
};

function fakeDesktop() {
  const calls = [];
  return {
    ...offlineDesktop(fixture, target),
    calls,
    snapshot: async () => snapshot,
    drag: async (current, requested, from, to, options) => {
      calls.push(['drag', from, to, options, current.windowId]);
      return 'delivered_verified';
    },
  };
}

function recordedDrag(overrides = {}) {
  return {
    kind: 'drag', t: 1, from: [135, 165], to: [420, 330], path: [[220, 240], [330, 300]],
    durationMs: 480, button: 'left', modifiers: [], ...overrides,
  };
}

test('recording keeps a drag start, end, sampled path and duration', () => {
  const recording = new Recording(target);
  assert.equal(recording.add({ event: recordedDrag(), snapshot }), undefined);
  const steps = recording.finish().steps;
  assert.deepEqual(steps, [{
    id: 'step-1', kind: 'drag', from: start, to: end, durationMs: 480,
    path: [[220, 240], [330, 300]],
  }]);
});

test('recording binds an endpoint to an element only on its center', () => {
  const centered = new Recording(target);
  centered.add({ event: recordedDrag({ from: [420, 319], to: [420, 319], path: [] }), snapshot });
  assert.deepEqual(centered.finish().steps[0].from, editor);
  assert.deepEqual(centered.finish().steps[0].to, editor);

  // A text-selection grab is several points off center, so it stays a point.
  const selection = new Recording(target);
  selection.add({ event: recordedDrag({ from: [300, 300], to: [500, 300], path: [] }), snapshot });
  const step = selection.finish().steps[0];
  assert.deepEqual(step.from, { kind: 'point', point: [300, 300] });
  assert.deepEqual(step.to, { kind: 'point', point: [500, 300] });
});

test('recording reports drag gestures it cannot represent instead of dropping them silently', () => {
  const recording = new Recording(target);
  assert.equal(recording.add({ event: recordedDrag({ modifiers: ['alt'] }), snapshot }), 'DRAG_MODIFIERS_SKIPPED');
  assert.equal(recording.add({ event: recordedDrag({ from: [20, 20] }), snapshot }), 'DRAG_OUTSIDE_WINDOW');
  assert.throws(() => recording.finish(), { code: 'EMPTY_RECORDING' });

  // A path-bound recording cannot replay a global coordinate against one copy.
  const bound = new Recording({ ...target, appPath: '/Applications/TextEdit.app' }, { requireElementLocator: true });
  assert.equal(bound.add({ event: recordedDrag(), snapshot }), 'UNTARGETED_DRAG');
  assert.equal(bound.add({ event: recordedDrag({ from: [420, 319], to: [420, 319], path: [] }), snapshot }), undefined);
  assert.deepEqual(bound.finish().steps.map(step => step.kind), ['drag']);
});

test('the v1 schema accepts drags and rejects impossible drags', () => {
  const accepted = [
    [{ id: 'drag', kind: 'drag', from: start, to: end, durationMs: 480 }],
    [{
      id: 'drag-path', kind: 'drag', from: editor, to: editor, durationMs: 0,
      path: [[200, 200]], button: 'left',
    }],
  ];
  for (const steps of accepted) assert.doesNotThrow(() => flowFor(steps), JSON.stringify(steps));
  assert.doesNotThrow(() => parseFlow(example('textedit.flow')));

  const rejected = [
    [[{ id: 'to', kind: 'drag', from: start, durationMs: 10 }], /Invalid flow/],
    [[{ id: 'duration', kind: 'drag', from: start, to: end, durationMs: -1 }], /Invalid flow/],
    [[{ id: 'long', kind: 'drag', from: start, to: end, durationMs: 10, path: Array.from({ length: 65 }, () => [1, 2]) }], /Invalid flow/],
    [[{ id: 'mixed', kind: 'drag', from: start, to: end, durationMs: 10, target: start }], /Invalid flow/],
    [[{ id: 'button', kind: 'drag', from: start, to: end, durationMs: 10, button: 'middle' }], /Invalid flow/],
    [[{ id: 'right', kind: 'drag', from: start, to: end, durationMs: 10, button: 'right' }], /right-button drags/],
  ];
  for (const [steps, pattern] of rejected) assert.throws(() => flowFor(steps), pattern, JSON.stringify(steps));
});

test('replay sends a drag to the adapter with its endpoints and duration', async () => {
  const desktop = fakeDesktop();
  const flow = flowFor([
    { id: 'drag', kind: 'drag', from: start, to: { kind: 'element', role: 'textfield' }, durationMs: 480, path: [[220, 240]] },
  ]);
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [['drag', 'passed']]);
  assert.deepEqual(desktop.calls, [
    ['drag', { point: [135, 165] }, { ref: '@scuekeeper:e1' }, { durationMs: 480 }, snapshot.windowId],
  ]);
});

test('dry-run resolves both drag endpoints without touching the desktop', async () => {
  const flow = flowFor([{ id: 'drag', kind: 'drag', from: start, to: end, durationMs: 200 }]);
  const report = await runFlow(flow, offlineDesktop(fixture, target), { dryRun: true, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [['drag', 'resolved']]);
});

test('a drag endpoint that does not resolve fails before any gesture starts', async () => {
  const desktop = fakeDesktop();
  const missing = await runFlow(flowFor([{
    id: 'drag', kind: 'drag', from: start, to: { kind: 'element', role: 'button', name: 'Missing' }, durationMs: 200,
  }]), desktop, { dryRun: false, signal });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.entries[0].code, 'NOT_FOUND');
  assert.deepEqual(desktop.calls, []);

  const outside = await runFlow(flowFor([{
    id: 'drag', kind: 'drag', from: { kind: 'point', point: [900, 900] }, to: end, durationMs: 200,
  }]), desktop, { dryRun: false, signal });
  assert.equal(outside.status, 'failed');
  assert.equal(outside.entries[0].code, 'UNSAFE_POINT');
  assert.deepEqual(desktop.calls, []);
});

test('the adapter maps a drag to the driver command and refuses physical input without --headed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-drag-adapter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  const previousIdentity = process.env.CUEKEEPER_APP_IDENTITY;
  process.env.CUEKEEPER_AGENT_DESKTOP = join(dir, 'desktop');
  process.env.CUEKEEPER_APP_IDENTITY = join(dir, 'identity');
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
    if (previousIdentity === undefined) delete process.env.CUEKEEPER_APP_IDENTITY;
    else process.env.CUEKEEPER_APP_IDENTITY = previousIdentity;
  });
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'desktop'), `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + String.fromCharCode(10));
const data = command === 'version' ? { version: '1.3.1' } :
  command === 'snapshot' ? ${JSON.stringify(fixture.data)} :
  command === 'focus-window' ? { focused: { id: 'w-1234' } } :
  { disposition: { delivery: 'delivered_verified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const flow = flowFor([{
    id: 'drag', kind: 'drag', from: { kind: 'point', point: [135, 165] },
    to: { kind: 'point', point: [420, 330] }, durationMs: 480,
  }]);
  const report = await withDesktop({ headed: true, signal },
    desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.command), ['version', 'snapshot', 'focus-window', 'snapshot', 'drag']);
  assert.deepEqual(calls[4].args, [
    '--headed', '--from-xy=135,165', '--to-xy=420,330', '--duration', '480', '--timeout-ms', '5480',
  ]);

  // Element endpoints pass their refs; the driver drags from each center.
  writeFileSync(log, '');
  const elementFlow = flowFor([{
    id: 'drag', kind: 'drag', from: { kind: 'element', role: 'textfield' },
    to: { kind: 'element', role: 'textfield' }, durationMs: 250,
  }]);
  const elementReport = await withDesktop({ headed: true, signal },
    desktop => runFlow(elementFlow, desktop, { dryRun: false, signal }));
  assert.equal(elementReport.status, 'passed');
  const elementCalls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(elementCalls.map(call => call.command), ['version', 'snapshot', 'drag']);
  assert.deepEqual(elementCalls[2].args, [
    '--headed', '--from', '@scuekeeper:e1', '--to', '@scuekeeper:e1', '--duration', '250', '--timeout-ms', '5250',
  ]);

  writeFileSync(log, '');
  const headless = await withDesktop({ headed: false, signal }, desktop =>
    runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(headless.status, 'failed');
  assert.equal(headless.entries[0].code, 'HEADED_REQUIRED');
  const refused = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(refused.map(call => call.command), ['version', 'snapshot']);

  // Element endpoints are physical input too: no drag command is sent headless.
  writeFileSync(log, '');
  const elementHeadless = await withDesktop({ headed: false, signal },
    desktop => runFlow(elementFlow, desktop, { dryRun: false, signal }));
  assert.equal(elementHeadless.status, 'failed');
  assert.equal(elementHeadless.entries[0].code, 'HEADED_REQUIRED');
  const elementRefused = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(elementRefused.map(call => call.command), ['version', 'snapshot']);
});

test('a drag path is capped when the capture helper sends more samples', () => {
  const recording = new Recording(target);
  recording.add({ event: recordedDrag({ path: Array.from({ length: 80 }, (_, index) => [index, index]) }), snapshot });
  const [step] = recording.finish().steps;
  assert.equal(step.path.length, 64);
});

test('plan keeps the drag duration and its endpoint shape', () => {
  const planned = plan(flowFor([{ id: 'drag', kind: 'drag', from: start, to: end, durationMs: 480 }]));
  assert.equal(planned[0].action.kind, 'drag');
  assert.equal(planned[0].action.durationMs, 480);
});
