import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { offlineDesktop } from '../dist/desktop.js';
import { parseSnapshot } from '../dist/locator.js';
import { Recording, record } from '../dist/record.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const target = fixture.target;
const editor = { kind: 'element', role: 'textfield', name: '' };
const center = [420, 319];
const buttonPoint = [520, 410];
const signal = new AbortController().signal;

// The TextEdit fixture tree, with the focus flag and value Safari may lag on.
function makeSnapshot({ focused = false, value = '', button = false } = {}) {
  const doc = structuredClone(fixture.data);
  const field = doc.tree.children[0].children[0];
  field.states = focused ? ['focused'] : [];
  field.value = value;
  if (button) {
    doc.tree.children[0].children.push({
      role: 'button', name: 'Save', ref_id: '@scuekeeper:e9',
      bounds: { x: 500, y: 400, width: 80, height: 30 }, states: [],
    });
  }
  return parseSnapshot(doc, fixture.target);
}

const click = { kind: 'click', t: 100, point: center };
const typeText = (chars, t = 260) => ({ kind: 'text', t, chars });

test('a click on an editable control binds text when focus is not reported yet', () => {
  const recording = new Recording(target, { clickTextFallback: true });
  assert.equal(recording.add({ event: click, snapshot: makeSnapshot() }), undefined);
  // Safari's tree names no focused control, but the clicked field shows the text.
  assert.equal(recording.add({ event: typeText('safari'), snapshot: makeSnapshot({ value: 'safari' }) }),
    undefined);
  assert.deepEqual(recording.finish().steps, [
    { id: 'step-1', kind: 'click', target: editor },
    { id: 'step-2', kind: 'type', target: editor, text: 'safari' },
  ]);
});

test('a click fallback without the typed text in the field is refused', () => {
  const recording = new Recording(target, { clickTextFallback: true });
  recording.add({ event: click, snapshot: makeSnapshot() });
  // The clicked control never received the text: binding it would replay a type
  // into the wrong place, so the burst is dropped with the existing warning.
  assert.throws(() => recording.add({ event: typeText('safari'), snapshot: makeSnapshot() }),
    { code: 'UNSAFE_TEXT_TARGET' });
  assert.deepEqual(recording.finish().steps.map(step => step.kind), ['click']);

  // Without the fallback option the focused-only rule is unchanged.
  const strict = new Recording(target);
  strict.add({ event: click, snapshot: makeSnapshot() });
  assert.throws(() => strict.add({ event: typeText('safari'), snapshot: makeSnapshot({ value: 'safari' }) }),
    { code: 'UNSAFE_TEXT_TARGET' });
  assert.deepEqual(strict.finish().steps.map(step => step.kind), ['click']);
});

test('a protected or non-editable click never becomes a text target', () => {
  const secure = structuredClone(makeSnapshot({ value: 'secret' }));
  secure.tree.children[0].children[0].secure = true;
  const protectedTarget = new Recording(target, { clickTextFallback: true });
  assert.throws(() => protectedTarget.add({ event: click, snapshot: secure }), { code: 'SECURE_INPUT' });
  assert.throws(() => protectedTarget.add({ event: typeText('secret'), snapshot: secure }),
    { code: 'UNSAFE_TEXT_TARGET' });
  assert.throws(() => protectedTarget.finish(), { code: 'EMPTY_RECORDING' });

  // A button is not editable, so text after clicking it has no target.
  const recording = new Recording(target, { clickTextFallback: true });
  assert.equal(recording.add({
    event: { kind: 'click', t: 100, point: buttonPoint }, snapshot: makeSnapshot({ button: true }),
  }), undefined);
  assert.throws(() => recording.add({
    event: typeText('safari'), snapshot: makeSnapshot({ value: 'safari', button: true }),
  }), { code: 'UNSAFE_TEXT_TARGET' });
});

function captureHelper(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-safari-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'capture');
  const seen = Date.now();
  writeFileSync(helper, `#!/usr/bin/env node
const rows = ${JSON.stringify(rows)};
for (const row of rows) console.log(JSON.stringify({ ...row, seen: ${seen} }));
`, { mode: 0o700 });
  const previous = process.env.CUEKEEPER_RECORDER;
  process.env.CUEKEEPER_RECORDER = helper;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_RECORDER;
    else process.env.CUEKEEPER_RECORDER = previous;
  });
}

function stubDesktop(snapshots) {
  const queue = [...snapshots];
  const reads = [];
  return {
    reads,
    desktop: {
      ...offlineDesktop(fixture, target),
      snapshot: async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra snapshot read');
        reads.push(next);
        return next;
      },
    },
  };
}

const ready = { kind: 'ready', indicator: false, hotkeysFiltered: true, identity: null };
const options = { seconds: 5, indicator: false, sound: false };

test('record re-reads once so a focus flag that arrives late still records the type', async t => {
  captureHelper(t, [ready, { ...click, t: 100 }, { ...typeText('safari'), t: 200 }]);
  const { desktop, reads } = stubDesktop([
    makeSnapshot(), makeSnapshot(), makeSnapshot(), makeSnapshot({ focused: true, value: 'safari' }),
  ]);
  const result = await record(desktop, target, options, signal);
  assert.deepEqual(result.flow.steps, [
    { id: 'step-1', kind: 'click', target: editor },
    { id: 'step-2', kind: 'type', target: editor, text: 'safari' },
  ]);
  assert.deepEqual(result.warnings, []);
  // The delayed second read is what recovered the text.
  assert.equal(reads.length, 4);
});

test('record binds a never-focused Safari field to the click once its value shows the text', async t => {
  captureHelper(t, [ready, { ...click, t: 100 }, { ...typeText('safari'), t: 200 }]);
  const { desktop } = stubDesktop([
    makeSnapshot(), makeSnapshot(), makeSnapshot(), makeSnapshot({ value: 'safari' }),
  ]);
  const result = await record(desktop, target, options, signal);
  assert.deepEqual(result.flow.steps.map(step => step.kind), ['click', 'type']);
  assert.equal(result.flow.steps[1].text, 'safari');
  assert.deepEqual(result.flow.steps[1].target, editor);
  assert.deepEqual(result.warnings, []);
});

test('record still warns and drops text that no control received', async t => {
  captureHelper(t, [ready, { ...click, t: 100 }, { ...typeText('safari'), t: 200 }]);
  const { desktop } = stubDesktop([makeSnapshot(), makeSnapshot(), makeSnapshot(), makeSnapshot()]);
  const result = await record(desktop, target, options, signal);
  assert.deepEqual(result.flow.steps.map(step => step.kind), ['click']);
  assert.deepEqual(result.warnings.map(warning => warning.code), ['UNSAFE_TEXT_TARGET']);
});
