import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { validateFlowV2 } from '../dist/flow-v2.js';
import { diffFlowV2, loadEditableFlow } from '../dist/workbench-edit.js';

const examplePath = name => new URL(`../examples/${name}.json`, import.meta.url);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function fixture(t, name = 'global-two-apps.flow') {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'flow.json');
  await copyFile(examplePath(name), path);
  return { root, path, editor: await loadEditableFlow(path) };
}

const step = (editor, id) => editor.flow.steps.find(entry => entry.id === id);

test('load keeps the recording bytes and hash and refuses v1', async t => {
  const { path, editor } = await fixture(t);
  const raw = await readFile(path);
  assert.equal(editor.source.text, raw.toString('utf8'));
  assert.equal(editor.source.sha256, sha256(raw));
  assert.equal(editor.source.flowSha256.length, 64);
  assert.equal(editor.flow.version, 2);
  assert.equal(editor.flow.steps.length, 8);
  assert.equal(editor.diff().changed, false);

  const v1 = new URL('../examples/textedit.flow.json', import.meta.url).pathname;
  await assert.rejects(loadEditableFlow(v1), error => {
    assert.equal(error.code, 'UNSUPPORTED_FLOW_VERSION');
    return true;
  });
});

test('target edits cover element fields and require a point to become an element', async t => {
  const { editor } = await fixture(t);
  editor.updateStep('type-address', {
    target: { kind: 'element', role: 'textfield', name: 'Address field', index: 2 },
  });
  assert.deepEqual(step(editor, 'type-address').target, {
    kind: 'element', role: 'textfield', name: 'Address field', index: 2,
  });

  editor.setTarget('type-address', {
    kind: 'point', x: 320, y: 180,
    element: { role: 'textfield', name: 'Address and search', path: ['toolbar', 'textfield'] },
  });
  assert.deepEqual(step(editor, 'type-address').target, {
    kind: 'element', role: 'textfield', name: 'Address and search', path: ['toolbar', 'textfield'],
  });

  const before = editor.flow;
  assert.throws(
    () => editor.setTarget('type-address', { kind: 'point', x: 10, y: 10 }),
    error => {
      assert.equal(error.code, 'POINT_TARGET_UNRESOLVED');
      assert.equal(error.stepId, 'type-address');
      return true;
    },
  );
  assert.deepEqual(editor.flow, before, 'a refused edit leaves the document untouched');
  assert.ok(!JSON.stringify(editor.flow).includes('"x":320'));
});

test('input edits rename parameters and never store values', async t => {
  const { editor } = await fixture(t);
  editor.updateStep('type-address', { input: 'addr' });
  assert.equal(step(editor, 'type-address').input, 'addr');
  assert.deepEqual(editor.flow.inputs, ['addr', 'note']);

  // A type step switches between literal text and a parameter; the old name is
  // pruned once nothing references it.
  editor.updateStep('type-note', { text: 'literal note' });
  assert.equal(step(editor, 'type-note').text, 'literal note');
  assert.equal(step(editor, 'type-note').input, undefined);
  assert.deepEqual(editor.flow.inputs, ['addr']);

  assert.throws(() => editor.updateStep('type-note', { input: '1bad' }), error => {
    assert.equal(error.code, 'INVALID_INPUT_NAME');
    assert.equal(error.stepId, 'type-note');
    return true;
  });
  assert.throws(
    () => editor.updateStep('type-note', { value: 'do not persist' }),
    error => error.code === 'UNKNOWN_FIELD',
  );
  assert.ok(!JSON.stringify(editor.flow).includes('do not persist'));
  assert.equal(editor.validate().ok, true);
});

test('a changed scope app rebuilds the window key and cannot reuse another app key', async t => {
  const { editor } = await fixture(t);
  const original = step(editor, 'type-address').scope;
  assert.deepEqual(original, {
    kind: 'window', app: 'com.apple.Safari', windowKey: 'browser', windowTitle: 'Cuekeeper 测试页',
  });

  editor.setScope('type-address', {
    kind: 'window', app: 'com.apple.TextEdit', windowTitle: 'Notes',
  });
  const changed = step(editor, 'type-address').scope;
  assert.equal(changed.app, 'com.apple.TextEdit');
  assert.equal(changed.windowTitle, 'Notes');
  assert.notEqual(changed.windowKey, 'browser');
  assert.equal(changed.windowKey, 'textedit');
  assert.equal(step(editor, 'wait-browser').scope.windowKey, 'browser');

  // A title-only edit keeps the stable key.
  editor.setScope('type-address', { kind: 'window', windowTitle: 'Renamed Notes' });
  assert.equal(step(editor, 'type-address').scope.windowKey, 'textedit');

  assert.throws(
    () => editor.setScope('wait-browser', { kind: 'window', app: 'com.apple.TextEdit' }),
    error => {
      assert.equal(error.code, 'SCOPE_TITLE_REQUIRED');
      assert.equal(error.stepId, 'wait-browser');
      return true;
    },
  );
  assert.throws(
    () => editor.setScope('wait-browser', { kind: 'window', app: 'not a bundle id', windowTitle: 'x' }),
    error => error.code === 'INVALID_APP',
  );
  assert.throws(
    () => editor.setScope('wait-browser', {
      kind: 'window', app: 'com.apple.TextEdit', windowKey: 'browser', windowTitle: 'Notes',
    }),
    error => {
      assert.equal(error.code, 'WINDOW_KEY_CONFLICT');
      assert.equal(error.stepId, 'wait-browser');
      return true;
    },
  );
  // A surface cannot host a click step: the step schema rejects the scope.
  assert.throws(
    () => editor.setScope('type-address', { kind: 'surface', surface: 'dock' }),
    error => {
      assert.equal(error.code, 'INVALID_STEP_SCHEMA');
      assert.equal(error.stepId, 'type-address');
      return true;
    },
  );
  assert.equal(editor.validate().ok, true);
});

test('insert wait, add an assertion after a step, and reject bad inserts', async t => {
  const { editor } = await fixture(t);
  const scope = step(editor, 'wait-browser').scope;

  editor.insertStep(1, {
    id: 'settle', kind: 'wait', scope,
    check: { kind: 'window_exists', equals: true }, timeoutMs: 2000,
  });
  assert.deepEqual(editor.flow.steps.map(entry => entry.id).slice(0, 3), [
    'launch-browser', 'settle', 'wait-browser',
  ]);

  editor.addAssert('type-note', {
    target: { kind: 'element', role: 'textfield' },
    expect: { property: 'exists', equals: true },
  });
  const created = editor.flow.steps.find(entry => entry.kind === 'assert' && entry.id !== 'assert-editor');
  assert.ok(created);
  assert.equal(created.id, 'assert-1');
  assert.deepEqual(created.scope, step(editor, 'type-note').scope);
  const noteIndex = editor.flow.steps.findIndex(entry => entry.id === 'type-note');
  assert.equal(editor.flow.steps[noteIndex + 1].id, 'assert-1');
  assert.equal(editor.validate().ok, true);

  assert.throws(() => editor.insertStep(0, { id: 'wait-browser', kind: 'key', scope, key: 'tab' }), error => {
    assert.equal(error.code, 'DUPLICATE_STEP_ID');
    assert.equal(error.stepId, 'wait-browser');
    return true;
  });
  assert.throws(
    () => editor.insertStep(0, {
      id: 'scroll-1', kind: 'scroll', scope,
      target: { kind: 'element', role: 'scrollarea' }, deltaX: 0, deltaY: 10,
    }),
    error => error.code === 'STEP_KIND_NOT_INSERTABLE',
  );
  assert.throws(() => editor.insertStep(99, { id: 'x', kind: 'key', scope, key: 'tab' }), error => {
    assert.equal(error.code, 'BAD_INDEX');
    assert.equal(error.stepId, 'x');
    return true;
  });
});

test('a gap cannot anchor an assertion and is resolved in place before saving', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-gap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'gap.json');
  await writeFile(path, JSON.stringify({
    version: 2, id: 'gap-flow', name: 'unresolved gap',
    steps: [{ id: 'g1', kind: 'gap', code: 'CAPTURE_GAP' }],
  }));
  const editor = await loadEditableFlow(path);
  assert.throws(
    () => editor.addAssert('g1', {
      target: { kind: 'window' }, expect: { property: 'exists', equals: true },
    }),
    error => {
      assert.equal(error.code, 'STEP_HAS_NO_SCOPE');
      assert.equal(error.stepId, 'g1');
      return true;
    },
  );
  const blocked = editor.validate();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errors[0].code, 'CAPTURE_GAP');
  assert.equal(blocked.errors[0].stepId, 'g1');

  editor.replaceStep('g1', {
    id: 'ignored', kind: 'wait',
    scope: { kind: 'app', app: 'com.apple.TextEdit' },
    check: { kind: 'app_running', equals: true }, timeoutMs: 5000,
  });
  assert.equal(editor.flow.steps[0].id, 'g1');
  assert.equal(editor.flow.steps[0].kind, 'wait');
  assert.equal(editor.validate().ok, true);
  await editor.saveRevision();
});

test('delete and move change order; the diff names steps and fields', async t => {
  const { editor } = await fixture(t);
  editor.updateStep('type-address', { target: { kind: 'element', role: 'textfield', name: 'Search' } });
  editor.deleteStep('assert-editor');
  editor.moveStep('launch-browser', 4);
  const diff = editor.diff();
  assert.deepEqual(diff.removed, [{ id: 'assert-editor', index: 7 }]);
  assert.deepEqual(diff.moved.find(move => move.id === 'launch-browser'), {
    id: 'launch-browser', from: 0, to: 4,
  });
  assert.deepEqual(diff.modified, [{ id: 'type-address', fields: ['target.name'] }]);
  assert.equal(diff.orderChanged, true);
  assert.equal(diff.changed, true);
  assert.equal(editor.validate().ok, true);

  const before = JSON.parse(await readFile(examplePath('global-two-apps.flow'), 'utf8'));
  const after = structuredClone(before);
  after.name = 'renamed';
  after.inputs = ['note'];
  assert.deepEqual(diffFlowV2(before, after).flowFields, ['inputs', 'name']);
});

test('saveRevision writes a new sibling file and leaves the recording byte-identical', async t => {
  const { root, path, editor } = await fixture(t);
  const rawBefore = await readFile(path);
  editor.updateStep('type-address', {
    target: { kind: 'element', role: 'textfield', name: 'Address field' },
  });
  editor.addAssert('type-address', {
    target: { kind: 'element', role: 'textfield', name: 'Address field' },
    expect: { property: 'value', equals: 'x' },
  });

  const saved = await editor.saveRevision();
  assert.match(saved.path, /flow\.edited-.+\.json$/);
  assert.equal(saved.flowSha256.length, 64);
  assert.ok(saved.diff.modified.some(change => change.id === 'type-address'));
  assert.deepEqual(await readFile(path), rawBefore, 'the recording is never rewritten');

  const written = JSON.parse(await readFile(saved.path, 'utf8'));
  assert.equal(flowV2Check.Check(written), true);
  validateFlowV2(written);
  assert.equal(written.steps.length, editor.stepCount);
  const reloaded = await loadEditableFlow(saved.path);
  assert.equal(reloaded.source.flowSha256, saved.flowSha256);
  assert.equal(reloaded.diff().changed, false);

  await editor.saveRevision();
  const revisions = (await readdir(root)).filter(name => name.startsWith('flow.edited-'));
  assert.equal(revisions.length, 2);

  const explicit = join(root, 'revision.json');
  await editor.saveRevision(explicit);
  assert.equal((await stat(explicit)).isFile(), true);
  assert.deepEqual(await readFile(path), rawBefore);
});

test('save refuses the original path and invalid documents', async t => {
  const { path, editor } = await fixture(t);
  await assert.rejects(editor.saveRevision(path), error => error.code === 'ORIGINAL_OVERWRITE');

  editor.deleteStep('copy-address');
  await assert.rejects(editor.saveRevision(), error => {
    assert.equal(error.code, 'INVALID_FLOW');
    assert.equal(error.stepId, 'paste-address');
    assert.match(error.message, /copy source copy-address/);
    return true;
  });
});

test('undo and redo walk the in-memory stack and a refused op changes nothing', async t => {
  const { editor } = await fixture(t);
  const originalTarget = step(editor, 'type-address').target;
  assert.equal(editor.canUndo, false);
  assert.equal(editor.canRedo, false);

  editor.updateStep('type-address', { target: { kind: 'element', role: 'textfield', name: 'Changed' } });
  const changedTarget = step(editor, 'type-address').target;
  assert.equal(editor.canUndo, true);

  assert.equal(editor.undo(), true);
  assert.deepEqual(step(editor, 'type-address').target, originalTarget);
  assert.equal(editor.canRedo, true);

  assert.equal(editor.redo(), true);
  assert.deepEqual(step(editor, 'type-address').target, changedTarget);

  editor.undo();
  editor.updateStep('type-address', { target: { kind: 'element', role: 'textfield', name: 'Other' } });
  assert.equal(editor.canRedo, false, 'a new edit drops the redo branch');

  const before = editor.flow;
  const refused = editor.apply({ kind: 'update', id: 'missing-step', patch: { key: 'tab' } });
  assert.deepEqual(refused, {
    ok: false,
    error: {
      code: 'STEP_NOT_FOUND',
      message: 'step missing-step: no step with id missing-step',
      stepId: 'missing-step',
    },
  });
  assert.deepEqual(editor.flow, before);
});

test('apply covers update, move, insert and assert in one contract', async t => {
  const { editor } = await fixture(t);
  const scope = step(editor, 'wait-browser').scope;

  const update = editor.apply({
    kind: 'update', id: 'type-address', patch: { scope: { kind: 'window', windowTitle: 'Address bar' } },
  });
  assert.equal(update.ok, true);
  assert.equal(update.flow.steps.find(entry => entry.id === 'type-address').scope.windowTitle, 'Address bar');

  const move = editor.apply({ kind: 'move', id: 'assert-editor', toIndex: 0 });
  assert.equal(move.ok, true);
  assert.equal(move.flow.steps[0].id, 'assert-editor');

  const insert = editor.apply({
    kind: 'insert', index: 2, step: { id: 'wait-2', kind: 'wait', scope, check: { kind: 'window_exists', equals: true } },
  });
  assert.equal(insert.ok, true);
  assert.equal(insert.flow.steps[2].id, 'wait-2');

  const assertion = editor.apply({
    kind: 'assert', afterStepId: 'type-note',
    check: { target: { kind: 'window' }, expect: { property: 'exists', equals: true } },
  });
  assert.equal(assertion.ok, true);
  assert.ok(assertion.flow.steps.some(entry => entry.id === 'assert-1' && entry.kind === 'assert'));

  const bad = editor.apply({ kind: 'move', id: 'type-address', toIndex: 99 });
  assert.deepEqual(bad, {
    ok: false,
    error: {
      code: 'BAD_INDEX',
      message: 'step type-address: index 99 is outside 0..9',
      stepId: 'type-address',
      field: 'index',
    },
  });
});
