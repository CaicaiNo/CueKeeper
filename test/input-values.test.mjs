import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  mergeValues, parseInputValues, readValuesFile, resolveValues, usableValues, valuesPath, writeValues,
} from '../dist/input-values.js';

// The sidecar is plain file logic: one path rule, one schema, one lookup order.
// These tests read the same bytes a replay or the page would read.

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-values-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const document = (overrides = {}) => ({
  version: 1,
  flowId: 'global-abc12345',
  recordedFlowSha256: 'a'.repeat(64),
  updatedAt: '2026-11-26T08:00:00.000Z',
  values: {
    text_1: {
      value: 'https://example.com/pkg', complete: true, steps: ['s11'],
      targets: [{ role: 'textfield', name: '请输入地址' }],
    },
  },
  ...overrides,
});

test('the sidecar path replaces a trailing .json and survives a name without one', () => {
  assert.equal(
    valuesPath('/Users/me/.cuekeeper/recordings/recording-20261126T080121Z.flow.json'),
    '/Users/me/.cuekeeper/recordings/recording-20261126T080121Z.flow.values.json');
  // A revision gets its own path; the lookup falls back to the recording's file.
  assert.equal(valuesPath('/r/flow.edited-2026-11-26.json'), '/r/flow.edited-2026-11-26.values.json');
  // A name that does not end in .json still cannot collide with another flow.
  assert.equal(valuesPath('/r/recording.flow'), '/r/recording.flow.values.json');
});

test('a written sidecar is 0600, reads back identically, and leaves no temp file', async t => {
  const root = await workspace(t);
  const path = valuesPath(join(root, 'recording.flow.json'));
  const doc = document();
  await writeValues(path, doc);

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const read = await readValuesFile(path);
  assert.deepEqual(read.doc, doc);
  assert.equal(read.warning, undefined);
  // The atomic rename is the only file that survives.
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.tmp')), []);
  assert.deepEqual(await readdir(root), ['recording.flow.values.json']);
});

test('a document outside the contract is refused instead of trimmed', async t => {
  const root = await workspace(t);
  const tooMany = Object.fromEntries(Array.from({ length: 65 },
    (_, index) => [`text_${index}`, { value: 'x', complete: true }]));
  assert.throws(() => parseInputValues(document({ version: 2 })), { code: 'INPUT_VALUES_VERSION' });
  assert.throws(() => parseInputValues(document({
    values: { text_1: { value: 'x'.repeat(4001), complete: true } },
  })), { code: 'INPUT_VALUES_TOO_LONG' });
  assert.throws(() => parseInputValues(document({ values: tooMany })), { code: 'INPUT_VALUES_TOO_MANY' });

  // A sensitive entry never reads as text, even if a writer left one behind.
  const sensitive = parseInputValues(document({
    values: { text_1: { value: 'secret', sensitive: true, complete: true } },
  }));
  assert.deepEqual(sensitive.values.text_1, { sensitive: true, complete: true });
  assert.deepEqual(usableValues(sensitive, ['text_1']), {});
  // A broken file on disk is a warning, not an exception the caller must catch.
  const path = valuesPath(join(root, 'broken.flow.json'));
  await writeFile(path, '{ not json');
  const read = await readValuesFile(path);
  assert.equal(read.doc, undefined);
  assert.match(read.warning, /已忽略/);
});

test('a revision finds the recording sidecar by flowId, ignores another flow, and takes the newest', async t => {
  const root = await workspace(t);
  const recording = join(root, 'recording.flow.json');
  const revision = join(root, 'flow.edited-2026-11-26.json');
  const recorded = document({ updatedAt: '2026-11-26T08:00:00.000Z' });
  await writeValues(valuesPath(recording), recorded);

  // The revision has no sidecar of its own; the recording's file answers.
  const found = await resolveValues(revision, 'global-abc12345');
  assert.equal(found.path, valuesPath(recording));
  assert.deepEqual(found.doc, recorded);

  // A same-name file for another flow is ignored, not applied.
  await writeValues(valuesPath(revision), document({ flowId: 'global-other' }));
  const still = await resolveValues(revision, 'global-abc12345');
  assert.equal(still.doc?.flowId, 'global-abc12345');
  assert.equal(still.path, valuesPath(recording));

  // Two files for the same flow: the newest updatedAt wins.
  const newer = document({ updatedAt: '2026-11-26T09:30:00.000Z', values: {
    text_1: { value: 'newer', complete: true },
  } });
  await writeValues(join(root, 'copy-a.values.json'), newer);
  const newest = await resolveValues(revision, 'global-abc12345');
  assert.equal(newest.doc?.values.text_1.value, 'newer');

  // A corrupt same-name file is reported with no document: the caller falls
  // back to "no stored value" and the dialog asks for the text.
  const corruptFlow = join(root, 'corrupt.flow.json');
  await writeFile(valuesPath(corruptFlow), '{ broken');
  const empty = await resolveValues(corruptFlow, 'global-abc12345');
  assert.equal(empty.doc, undefined);
  assert.match(empty.warning, /corrupt\.flow\.values\.json/);
});

test('merge writes only the operator-confirmed names and deletes what it was told to', () => {
  const base = document();
  const merged = mergeValues(base, 'global-abc12345', {
    text_1: '  padded  ', text_2: 'second', ignored: null,
  }, { now: new Date('2026-11-26T10:00:00.000Z') });
  assert.equal(merged.values.text_1.value, '  padded  ');
  assert.equal(merged.values.text_1.complete, true);
  // Provenance from the recording survives a value edit.
  assert.deepEqual(merged.values.text_1.steps, ['s11']);
  assert.deepEqual(merged.values.text_1.targets, [{ role: 'textfield', name: '请输入地址' }]);
  assert.equal(merged.values.text_2.value, 'second');
  assert.equal(merged.updatedAt, '2026-11-26T10:00:00.000Z');
  assert.deepEqual(merged.recordedFlowSha256, base.recordedFlowSha256);

  const cleared = mergeValues(merged, 'global-abc12345', { text_1: null });
  assert.deepEqual(Object.keys(cleared.values), ['text_2']);
  // Values for another flow never leak into this one.
  const other = mergeValues(base, 'global-other', { text_1: 'x' });
  assert.deepEqual(Object.keys(other.values), ['text_1']);
  assert.equal(other.values.text_1.value, 'x');
});

test('usable values cover declared names only and skip sensitive or empty entries', () => {
  const doc = parseInputValues(document({ values: {
    text_1: { value: '  keep me  ', complete: true },
    text_2: { sensitive: true, complete: true },
    text_3: { value: '', complete: false },
    text_4: { value: 'orphan', complete: true },
  } }));
  assert.deepEqual(usableValues(doc, ['text_1', 'text_2', 'text_3', 'missing']), {
    text_1: '  keep me  ',
  });
  assert.deepEqual(usableValues(undefined, ['text_1']), {});
  // Serialising and re-reading keeps padding: the value is stored verbatim.
  assert.equal(doc.values.text_1.value, '  keep me  ');
  assert.equal(JSON.parse(JSON.stringify(doc)).values.text_1.value, '  keep me  ');
});

test('writing a document that breaks the limit fails before touching the disk', async t => {
  const root = await workspace(t);
  const path = valuesPath(join(root, 'big.flow.json'));
  await assert.rejects(writeValues(path, document({
    values: { text_1: { value: 'x'.repeat(4001), complete: true } },
  })), { code: 'INPUT_VALUES_TOO_LONG' });
  assert.deepEqual(await readdir(root), []);
});

test('a document over the byte limit is refused before the old file changes', async t => {
  const root = await workspace(t);
  const path = valuesPath(join(root, 'bytes.flow.json'));
  await writeValues(path, document());
  const before = await readFile(path);

  // 64 × 4000 Chinese characters is 768 KB of UTF-8: valid per-field, but a
  // file the reader would reject. The writer must refuse it and keep the old
  // bytes intact, or the next run would silently lose every stored value.
  const huge = document({
    values: Object.fromEntries(Array.from({ length: 64 },
      (_, index) => [`text_${index}`, { value: '汉'.repeat(4000), complete: true }])),
  });
  await assert.rejects(writeValues(path, huge), { code: 'INPUT_VALUES_TOO_LARGE' });
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.tmp')), []);
});

test('writing never replaces a file that belongs to another flow or is not a sidecar', async t => {
  const root = await workspace(t);
  const path = valuesPath(join(root, 'taken.flow.json'));

  // Another flow's valid sidecar sits at the name ours would use.
  await writeFile(path, JSON.stringify(document({ flowId: 'global-other' })));
  const foreignBytes = await readFile(path);
  await assert.rejects(writeValues(path, document()), { code: 'INPUT_VALUES_FOREIGN_FILE' });
  assert.deepEqual(await readFile(path), foreignBytes);

  // A normal workflow can legitimately be called `*.values.json`; it is not ours.
  const workflow = JSON.stringify({
    version: 2, id: 'global-abc12345', name: 'ordinary flow',
    steps: [{ id: 's1', kind: 'wait', scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'w', windowTitle: 'W' },
      check: { kind: 'window_exists', equals: true } }],
  });
  await writeFile(path, workflow);
  await assert.rejects(writeValues(path, document()), { code: 'INPUT_VALUES_FOREIGN_FILE' });
  assert.equal(await readFile(path, 'utf8'), workflow);

  // A file for this same flow is ours to update.
  await writeFile(path, JSON.stringify(document()));
  await writeValues(path, document({ values: { text_1: { value: 'updated', complete: true } } }));
  assert.equal((await readValuesFile(path)).doc.values.text_1.value, 'updated');
});
