import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { offlineDesktop, withDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { parseSnapshot } from '../dist/locator.js';
import { Recording } from '../dist/record.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const signal = new AbortController().signal;
const snapshot = parseSnapshot(fixture.data, fixture.target);
const editor = { kind: 'element', role: 'textfield', name: '' };
const target = fixture.target;
const flowFor = steps => parseFlow({
  version: 1, id: 'pointer-flow', name: 'Pointer input', target, steps,
});

function fakeDesktop() {
  const calls = [];
  return {
    ...offlineDesktop(fixture, target),
    calls,
    snapshot: async () => snapshot,
    click: async (ref, options) => { calls.push(['click', ref, options]); return 'delivered_verified'; },
    clickPoint: async (_snapshot, _target, point, options) => {
      calls.push(['clickPoint', point, options]);
      return 'delivered_verified';
    },
    scroll: async (ref, options) => { calls.push(['scroll', ref, options]); return 'delivered_verified'; },
    scrollPoint: async (_snapshot, _target, point, options) => {
      calls.push(['scrollPoint', point, options]);
      return 'delivered_verified';
    },
  };
}

test('recording upgrades a multi-click sequence instead of appending clicks', () => {
  const recording = new Recording(target);
  for (const event of [
    { kind: 'click', t: 1, point: [135, 165] },
    { kind: 'click', t: 140, point: [135, 165], count: 2 },
    { kind: 'click', t: 280, point: [135, 165], count: 3 },
  ]) {
    recording.add({ event, snapshot });
  }
  const flow = recording.finish();
  assert.deepEqual(flow.steps, [
    { id: 'step-1', kind: 'click', target: { ...editor }, count: 3 },
  ]);

  // A second click far away is a new gesture, not an upgrade.
  const apart = new Recording(target);
  apart.add({ event: { kind: 'click', t: 1, point: [105, 110] }, snapshot });
  apart.add({ event: { kind: 'click', t: 140, point: [735, 515], count: 2 }, snapshot });
  assert.deepEqual(apart.finish().steps.map(step => [step.target.point, step.count]), [
    [[105, 110], undefined], [[735, 515], 2],
  ]);
});

test('recording keeps right clicks apart and merges a wheel burst', () => {
  const recording = new Recording(target);
  recording.add({ event: { kind: 'click', t: 1, point: [135, 165], button: 'right' }, snapshot });
  recording.add({ event: { kind: 'scroll', t: 100, point: [135, 165], deltaX: 0, deltaY: -3, phase: 'began' }, snapshot });
  recording.add({ event: { kind: 'scroll', t: 160, point: [135, 165], deltaX: 1, deltaY: -4, phase: 'changed' }, snapshot });
  recording.add({ event: { kind: 'scroll', t: 1200, point: [135, 165], deltaX: 0, deltaY: 2, phase: 'ended' }, snapshot });
  recording.add({ event: { kind: 'scroll', t: 1300, point: [105, 510], deltaX: 3, deltaY: 0 }, snapshot });
  const steps = recording.finish().steps;
  assert.deepEqual(steps, [
    { id: 'step-1', kind: 'click', target: { ...editor }, button: 'right' },
    { id: 'step-2', kind: 'scroll', target: { ...editor }, deltaX: 1, deltaY: -7, durationMs: 60 },
    { id: 'step-3', kind: 'scroll', target: { ...editor }, deltaX: 0, deltaY: 2 },
    { id: 'step-4', kind: 'scroll', target: { kind: 'point', point: [105, 510] }, deltaX: 3, deltaY: 0 },
  ]);
});

test('a path-fixed recording drops scroll and click input it cannot bind to an element', () => {
  const recording = new Recording({ ...target, appPath: '/Applications/TextEdit.app' }, { requireElementLocator: true });
  assert.equal(recording.add({
    event: { kind: 'scroll', t: 1, point: [105, 510], deltaX: 0, deltaY: -2 }, snapshot,
  }), 'UNTARGETED_POINT');
  assert.equal(recording.add({
    event: { kind: 'scroll', t: 2, point: [135, 165], deltaX: 0, deltaY: -2 }, snapshot,
  }), undefined);
  assert.deepEqual(recording.finish().steps.map(step => step.target), [{ ...editor }]);
});

test('the v1 schema accepts the new pointer gestures and unchanged legacy flows', () => {
  assert.doesNotThrow(() => parseFlow(example('textedit.flow')));
  const accepted = [
    [{ id: 'double', kind: 'click', target: editor, count: 2 }],
    [{ id: 'triple', kind: 'click', target: editor, count: 3, button: 'left' }],
    [{ id: 'right', kind: 'click', target: { kind: 'point', point: [105, 110] }, button: 'right' }],
    [{ id: 'wheel', kind: 'scroll', target: editor, deltaX: 0, deltaY: -5, durationMs: 420 }],
    [{ id: 'wheel-authored', kind: 'scroll', target: editor, direction: 'down', amount: 3 }],
  ];
  for (const steps of accepted) assert.doesNotThrow(() => flowFor(steps), JSON.stringify(steps));
});

test('the flow validator rejects impossible counts, buttons and scrolls', () => {
  const cases = [
    [[{ id: 'count', kind: 'click', target: editor, count: 4 }], /Invalid flow/],
    [[{ id: 'count', kind: 'click', target: editor, count: 0 }], /Invalid flow/],
    [[{ id: 'button', kind: 'click', target: editor, button: 'middle' }], /Invalid flow/],
    [[{ id: 'right-count', kind: 'click', target: editor, button: 'right', count: 2 }], /right click cannot carry/],
    [[{ id: 'zero', kind: 'scroll', target: editor, deltaX: 0, deltaY: 0 }], /must not both be zero/],
    [[{ id: 'partial', kind: 'scroll', target: editor, deltaX: 1 }], /Invalid flow/],
    [[{ id: 'amount', kind: 'scroll', target: editor, direction: 'down', amount: 0 }], /Invalid flow/],
    [[{ id: 'mixed', kind: 'scroll', target: editor, direction: 'down', amount: 2, deltaY: -2 }], /Invalid flow/],
    [[{ id: 'large', kind: 'scroll', target: editor, deltaX: 0, deltaY: 5000 }], /Invalid flow/],
    [[{ id: 'slow', kind: 'scroll', target: editor, direction: 'up', amount: 1, durationMs: 90_000 }], /Invalid flow/],
  ];
  for (const [steps, pattern] of cases) assert.throws(() => flowFor(steps), pattern, JSON.stringify(steps));
});

test('replay sends each gesture to the matching desktop action', async () => {
  const desktop = fakeDesktop();
  const flow = flowFor([
    { id: 'double', kind: 'click', target: editor, count: 2 },
    { id: 'triple', kind: 'click', target: editor, count: 3 },
    { id: 'right', kind: 'click', target: editor, button: 'right' },
    { id: 'wheel', kind: 'scroll', target: editor, deltaX: 0, deltaY: -5 },
    { id: 'wheel-point', kind: 'scroll', target: { kind: 'point', point: [200, 200] }, direction: 'down', amount: 4 },
  ]);
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'passed'], ['click', 'passed'], ['click', 'passed'], ['scroll', 'passed'], ['scroll', 'passed'],
  ]);
  assert.deepEqual(desktop.calls, [
    ['click', '@scuekeeper:e1', { count: 2 }],
    ['click', '@scuekeeper:e1', { count: 3 }],
    ['click', '@scuekeeper:e1', { button: 'right' }],
    ['scroll', '@scuekeeper:e1', { direction: 'down', amount: 5 }],
    ['scrollPoint', [200, 200], { deltaX: 0, deltaY: -4 }],
  ]);
});

test('dry-run resolves pointer gestures without touching the desktop', async () => {
  const flow = flowFor([
    { id: 'double', kind: 'click', target: editor, count: 2 },
    { id: 'wheel', kind: 'scroll', target: editor, deltaX: 2, deltaY: -5 },
    { id: 'wheel-point', kind: 'scroll', target: { kind: 'point', point: [200, 200] }, deltaX: 0, deltaY: -2 },
  ]);
  // offlineDesktop refuses actions, so a dry run proves nothing was delivered.
  const report = await runFlow(flow, offlineDesktop(fixture, target), { dryRun: true, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['scroll', 'resolved'], ['scroll', 'resolved'],
  ]);
});

test('a missing scroll target fails instead of scrolling another control', async () => {
  const desktop = fakeDesktop();
  const flow = flowFor([{
    id: 'wheel', kind: 'scroll', target: { kind: 'element', role: 'scrollarea', name: 'missing' },
    deltaX: 0, deltaY: -3,
  }]);
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'NOT_FOUND');
  assert.deepEqual(desktop.calls, []);
});

test('the adapter maps gestures to driver commands and refuses unheaded physical input', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-pointer-adapter-'));
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
  { disposition: { delivery: 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const flow = flowFor([
    { id: 'double', kind: 'click', target: editor, count: 2 },
    { id: 'triple', kind: 'click', target: editor, count: 3 },
    { id: 'right', kind: 'click', target: editor, button: 'right' },
    { id: 'wheel', kind: 'scroll', target: editor, deltaX: 0, deltaY: -5 },
    { id: 'wheel-point', kind: 'scroll', target: { kind: 'point', point: [200, 200] }, deltaX: 3, deltaY: -4 },
  ]);
  const report = await withDesktop({ headed: true, signal }, desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.command), [
    'version', 'snapshot', 'double-click', 'snapshot', 'triple-click', 'snapshot', 'right-click',
    'snapshot', 'scroll', 'snapshot', 'focus-window', 'snapshot', 'mouse-wheel',
  ]);
  assert.deepEqual(calls[2].args, ['--headed', '@scuekeeper:e1']);
  assert.deepEqual(calls[4].args, ['--headed', '@scuekeeper:e1']);
  assert.deepEqual(calls[6].args, ['--headed', '@scuekeeper:e1']);
  assert.deepEqual(calls[8].args, ['--headed', '@scuekeeper:e1', '--direction', 'down', '--amount', '5']);
  assert.deepEqual(calls[10].args, ['--window-id', 'w-1234']);
  assert.deepEqual(calls[12].args, ['--headed', '--x', '200', '--y', '200', '--dx=3', '--dy=-4']);

  // The same gestures fail closed without --headed instead of clicking once.
  writeFileSync(log, '');
  const headless = await withDesktop({ headed: false, signal }, desktop =>
    runFlow(flowFor([{ id: 'double', kind: 'click', target: editor, count: 2 }]), desktop, { dryRun: false, signal }));
  assert.equal(headless.status, 'failed');
  assert.equal(headless.entries[0].code, 'HEADED_REQUIRED');
  const refused = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(refused.map(call => call.command), ['version', 'snapshot']);
});
