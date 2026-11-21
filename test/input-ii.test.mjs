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
import { Recording, isPasteChord, pasteIntent, record } from '../dist/record.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';
import { renderViewer } from '../dist/viewer.js';
import { KIND_LABELS, changeTarget } from '../workbench/model.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const snapshot = parseSnapshot(fixture.data, fixture.target);
const target = fixture.target;
const signal = new AbortController().signal;
const editor = { kind: 'element', role: 'textfield', name: '' };
const center = [420, 319];
const flowFor = steps => parseFlow({
  version: 1, id: 'input-ii', name: 'Input II', target, steps,
});
const pasteKey = { kind: 'key', t: 10, key: 'v', modifiers: ['meta'] };

test('the v1 schema accepts hover and paste, and keeps old flows valid', () => {
  assert.doesNotThrow(() => flowFor([
    { id: 'hover', kind: 'hover', target: editor, durationMs: 450 },
    { id: 'hover-point', kind: 'hover', target: { kind: 'point', point: center }, durationMs: 300 },
    { id: 'paste', kind: 'paste', target: editor, text: '你好, Cuekeeper' },
  ]));
  assert.doesNotThrow(() => parseFlow(example('textedit.flow')));

  const rejected = [
    [{ id: 'no-target', kind: 'hover', durationMs: 300 }],
    [{ id: 'negative', kind: 'hover', target: editor, durationMs: -1 }],
    [{ id: 'too-long', kind: 'hover', target: editor, durationMs: 60_001 }],
    [{ id: 'bare-paste', kind: 'paste', target: editor }],
    [{ id: 'empty-paste', kind: 'paste', target: editor, text: '' }],
    [{ id: 'nul-paste', kind: 'paste', target: editor, text: 'a\u0000b' }],
    [{ id: 'extra', kind: 'paste', target: editor, text: 'ok', clipboard: 'text' }],
  ];
  for (const [steps] of rejected) {
    assert.throws(() => flowFor(steps), /Invalid flow/, JSON.stringify(steps));
  }
  assert.deepEqual(plan(flowFor([
    { id: 'paste', kind: 'paste', target: editor, text: '你好' },
  ]))[0].action, { id: 'paste', kind: 'paste', target: editor, text: '你好' });
});

test('recording turns a settled mouse move into a hover step', () => {  const recording = new Recording(target);
  assert.equal(recording.add({ event: { kind: 'hover', t: 100, point: center, dwellMs: 420 }, snapshot }), undefined);
  assert.deepEqual(recording.finish().steps, [
    { id: 'step-1', kind: 'hover', target: editor, durationMs: 420 },
  ]);

  // A point outside the target window never becomes a step.
  const outside = new Recording(target);
  assert.throws(
    () => outside.add({ event: { kind: 'hover', t: 1, point: [10, 10], dwellMs: 300 }, snapshot }),
    { code: 'OUTSIDE_WINDOW' },
  );

  // Path-fixed recordings cannot replay a global coordinate.
  const bound = new Recording({ ...target, appPath: '/Applications/TextEdit.app' }, { requireElementLocator: true });
  assert.equal(bound.add({ event: { kind: 'hover', t: 1, point: [105, 105], dwellMs: 300 }, snapshot }),
    'UNTARGETED_HOVER');
  assert.equal(bound.add({ event: { kind: 'hover', t: 2, point: center, dwellMs: 300 }, snapshot }), undefined);
  assert.deepEqual(bound.finish().steps.map(step => step.target), [editor]);
});

test('paste intent pins only bounded plain text from an explicit Cmd+V', () => {
  assert.equal(isPasteChord(pasteKey), true);
  assert.equal(isPasteChord({ kind: 'key', key: 'v', modifiers: ['meta', 'shift'] }), false);
  assert.equal(isPasteChord({ kind: 'key', key: 'c', modifiers: ['meta'] }), false);

  assert.deepEqual(pasteIntent(pasteKey, { type: 'text', text: 'hello' }), { text: 'hello' });
  assert.equal(pasteIntent(pasteKey, undefined), undefined);
  assert.deepEqual(pasteIntent(pasteKey, { type: 'image' }), { warning: 'CLIPBOARD_UNSUPPORTED_TYPE' });
  assert.deepEqual(pasteIntent(pasteKey, { type: 'text', text: 'x'.repeat(4001) }),
    { warning: 'CLIPBOARD_TOO_LARGE' });
  assert.deepEqual(pasteIntent(pasteKey, { type: 'text', text: 'a\u0000b' }),
    { warning: 'CLIPBOARD_INVALID_TEXT' });
});

test('recording keeps a paste pinned as content and falls back explicitly', () => {
  const recording = new Recording(target);
  assert.equal(recording.add({ event: pasteKey, snapshot }, { type: 'text', text: '你好, Cuekeeper' }), undefined);
  assert.deepEqual(recording.finish().steps, [
    { id: 'step-1', kind: 'paste', target: editor, text: '你好, Cuekeeper' },
  ]);

  // Clipboard recording is off by default: the shortcut stays a shortcut.
  const disabled = new Recording(target);
  assert.equal(disabled.add({ event: pasteKey, snapshot }), undefined);
  assert.deepEqual(disabled.finish().steps, [
    { id: 'step-1', kind: 'key', key: 'v', modifiers: ['meta'] },
  ]);

  // Unsupported content is reported, not silently dropped.
  const image = new Recording(target);
  assert.equal(image.add({ event: pasteKey, snapshot }, { type: 'image' }), 'CLIPBOARD_UNSUPPORTED_TYPE');
  assert.deepEqual(image.finish().steps, [
    { id: 'step-1', kind: 'key', key: 'v', modifiers: ['meta'] },
  ]);

  // A protected focused field stops the recording instead of capturing text.
  const secure = structuredClone(snapshot);
  secure.tree.children[0].children[0].secure = true;
  const protectedTarget = new Recording(target);
  assert.throws(
    () => protectedTarget.add({ event: pasteKey, snapshot: secure }, { type: 'text', text: 'secret' }),
    { code: 'SECURE_INPUT' },
  );
});

test('IME text is recorded as committed Unicode and replayed as text insertion', async () => {
  const recording = new Recording(target);
  assert.equal(recording.add({
    event: { kind: 'text', t: 1, chars: '你好', ime: true }, snapshot,
  }), 'IME_COMPOSITION_UNSUPPORTED');
  assert.equal(recording.add({
    event: { kind: 'text', t: 40, chars: '世界', ime: true }, snapshot,
  }), 'IME_COMPOSITION_UNSUPPORTED');
  const flow = recording.finish();
  assert.deepEqual(flow.steps, [
    { id: 'step-1', kind: 'type', target: editor, text: '你好世界', ime: true },
  ]);

  const calls = [];
  const desktop = {
    ...offlineDesktop(fixture, target),
    snapshot: async () => snapshot,
    type: async (ref, text) => { calls.push(['type', ref, text]); return 'delivered_verified'; },
  };
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(calls, [['type', '@scuekeeper:e1', '你好世界']]);
  assert.deepEqual(report.entries.filter(entry => entry.kind !== 'setup').map(entry => entry.kind), ['type']);
});

test('replay moves the pointer, waits the dwell and reports a hover step', async () => {
  const calls = [];
  const desktop = {
    ...offlineDesktop(fixture, target),
    snapshot: async () => snapshot,
    hoverAt: async (current, requested, point) => {
      calls.push(['hoverAt', point, current.windowId]);
      return 'delivered_verified';
    },
  };
  const flow = flowFor([
    { id: 'hover', kind: 'hover', target: editor, durationMs: 20 },
    { id: 'hover-point', kind: 'hover', target: { kind: 'point', point: [200, 200] }, durationMs: 1 },
  ]);
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(calls, [
    ['hoverAt', center, 'w-1234'],
    ['hoverAt', [200, 200], 'w-1234'],
  ]);
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [
    ['hover', 'passed'], ['hover', 'passed'],
  ]);
  const html = renderViewer(report, flow, plan(flow), []).html;
  assert.match(html, /悬停 textfield · 20 ms/);
  assert.match(html, /悬停 坐标 \(200, 200\) · 1 ms/);

  // An element without bounds has no replay point, and no move is sent.
  const unresolved = await runFlow(flowFor([
    { id: 'hover', kind: 'hover', target: { kind: 'element', role: 'scrollarea' }, durationMs: 1 },
  ]), desktop, { dryRun: false, signal });
  assert.equal(unresolved.status, 'failed');
  assert.equal(unresolved.entries[0].code, 'HOVER_UNRESOLVED');
  assert.equal(calls.length, 2);
});

test('paste resolves the field, writes the clipboard and sends Cmd+V without text in the report', async () => {
  const calls = [];
  const secret = 'clipboard-秘密-42';
  const desktop = {
    ...offlineDesktop(fixture, target),
    snapshot: async () => snapshot,
    focus: async ref => { calls.push(['focus', ref]); },
    writeClipboard: async text => { calls.push(['writeClipboard', text]); return 'delivered_verified'; },
    press: async (combo, current) => { calls.push(['press', combo, current.windowId]); return 'delivered_verified'; },
  };
  const flow = flowFor([{ id: 'paste', kind: 'paste', target: editor, text: secret }]);
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(calls, [
    ['focus', '@scuekeeper:e1'],
    ['writeClipboard', secret],
    ['press', 'meta+v', 'w-1234'],
  ]);
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.delivery]), [['paste', 'delivered_verified']]);
  assert.equal(JSON.stringify(report).includes(secret), false);

  // The viewer names the step and its size, never the clipboard text.
  const html = renderViewer(report, flow, plan(flow), []).html;
  assert.match(html, /粘贴 15 字 textfield/);
  assert.match(html, /内容不写入报告/);
  assert.equal(html.includes(secret), false);

  // Packing embeds the flow, so a clipboard flow is refused rather than leaked.
  assert.throws(() => packReport(report, flow), /clipboard text/);

  // A dry run resolves the target without focusing or touching the clipboard.
  const dryCalls = [];
  const dryDesktop = {
    ...offlineDesktop(fixture, target),
    focus: async () => { dryCalls.push('focus'); },
    writeClipboard: async () => { dryCalls.push('writeClipboard'); },
    press: async () => { dryCalls.push('press'); },
  };
  const dry = await runFlow(flow, dryDesktop, { dryRun: true, signal });
  assert.deepEqual(dry.entries.filter(entry => entry.kind !== 'setup').map(entry => entry.status), ['resolved']);
  assert.deepEqual(dryCalls, []);
});

test('record pipes hover and Cmd+V into one flow, with clipboard content only on opt-in', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-record-ii-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'capture');
  const seen = Date.now();
  writeFileSync(helper, `#!/usr/bin/env node
const rows = [
  { kind: 'ready', indicator: false, hotkeysFiltered: true, identity: null },
  { kind: 'hover', point: [420, 319], dwellMs: 320, t: 120, seen: ${seen} },
  { kind: 'key', key: 'v', modifiers: ['meta'], t: 900, seen: ${seen} },
];
for (const row of rows) console.log(JSON.stringify(row));
`, { mode: 0o700 });
  const previous = process.env.CUEKEEPER_RECORDER;
  process.env.CUEKEEPER_RECORDER = helper;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_RECORDER;
    else process.env.CUEKEEPER_RECORDER = previous;
  });
  const secret = 'clipboard-秘密-42';
  const calls = [];
  const desktop = {
    ...offlineDesktop(fixture, target),
    snapshot: async () => snapshot,
    readClipboard: async () => { calls.push('readClipboard'); return { type: 'text', text: secret }; },
  };
  const options = { seconds: 5, indicator: false, sound: false };

  const enabled = await record(desktop, target, { ...options, clipboard: true }, signal);
  assert.deepEqual(enabled.flow.steps, [
    { id: 'step-1', kind: 'hover', target: editor, durationMs: 320 },
    { id: 'step-2', kind: 'paste', target: editor, text: secret },
  ]);
  assert.deepEqual(calls, ['readClipboard']);
  assert.equal(JSON.stringify(enabled.warnings).includes(secret), false);

  // Without --clipboard the same input keeps the shortcut and reads nothing.
  const disabled = await record(desktop, target, { ...options, clipboard: false }, signal);
  assert.deepEqual(disabled.flow.steps, [
    { id: 'step-1', kind: 'hover', target: editor, durationMs: 320 },
    { id: 'step-2', kind: 'key', key: 'v', modifiers: ['meta'] },
  ]);
  assert.deepEqual(calls, ['readClipboard']);
});

test('the adapter sends mouse-move for hover and clipboard-set before Cmd+V', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-input-ii-'));
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
const input = command === 'clipboard-set' ? fs.readFileSync(0, 'utf8') : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, input }) + String.fromCharCode(10));
const data = command === 'version' ? { version: '1.3.1' } :
  command === 'snapshot' ? ${JSON.stringify(fixture.data)} :
  command === 'focus-window' ? { focused: { id: 'w-1234' } } :
  command === 'clipboard-get' ? { type: 'text', text: 'from clipboard' } :
  { disposition: { delivery: 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const flow = flowFor([
    { id: 'hover', kind: 'hover', target: editor, durationMs: 1 },
    { id: 'paste', kind: 'paste', target: editor, text: '粘贴文本' },
  ]);
  const report = await withDesktop({ headed: true, signal },
    desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.command), [
    'version',
    'snapshot', 'focus-window', 'snapshot', 'mouse-move',
    'snapshot', 'focus', 'clipboard-set', 'press',
  ]);
  assert.deepEqual(calls[4].args, ['--headed', '--xy=420,319']);
  assert.deepEqual(calls[6].args, ['@scuekeeper:e1']);
  assert.deepEqual(calls[7].args, ['--stdin']);
  assert.equal(calls[7].input, '粘贴文本');
  assert.deepEqual(calls[8].args, ['--headed', 'meta+v', '--window-id', 'w-1234']);
});

test('workbench labels and retargeting expose the two new step kinds', () => {
  assert.equal(KIND_LABELS.hover, '悬停');
  assert.equal(KIND_LABELS.paste, '粘贴');
  const point = { kind: 'point', point: [10, 20] };
  assert.deepEqual(changeTarget({ kind: 'hover', target: editor, durationMs: 300 }, point),
    { kind: 'hover', target: point, durationMs: 300 });
  assert.deepEqual(changeTarget({ kind: 'paste', target: editor, text: 'x' }, point),
    { kind: 'paste', target: point, text: 'x' });
});
