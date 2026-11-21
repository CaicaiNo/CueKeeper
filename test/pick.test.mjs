import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contains, parseSnapshot, resolve } from '../dist/locator.js';
import { pickCandidates, selectCandidate } from '../dist/pick.js';

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const snapshotPath = fileURLToPath(new URL('../examples/textedit.snapshot.json', import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 20000 });
  return { code: result.status, response: JSON.parse(result.stdout), stderr: result.stderr };
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-pick-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// A TextEdit-like tree with several candidates, a duplicated textfield, a hidden
// control, a secure field, and a ref-bearing container.
async function crowded(t) {
  const root = await workspace(t);
  const fixture = await example('textedit.snapshot');
  const content = fixture.data.tree.children[0];
  content.ref_id = '@scuekeeper:e0';
  content.children.push(
    { role: 'button', name: 'Save', ref_id: '@scuekeeper:e2', bounds: { x: 200, y: 520, width: 80, height: 32 } },
    { role: 'checkbox', name: 'Enable proxy', ref_id: '@scuekeeper:e3', bounds: { x: 112, y: 520, width: 20, height: 20 } },
    { role: 'textfield', name: '', ref_id: '@scuekeeper:e4', bounds: { x: 112, y: 550, width: 120, height: 24 } },
    { role: 'button', name: 'Hidden', ref_id: '@scuekeeper:e5', states: ['hidden'], bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { role: 'textfield', name: 'Password', ref_id: '@scuekeeper:e6', states: ['secure'], bounds: { x: 112, y: 580, width: 120, height: 24 } },
  );
  const path = join(root, 'snapshot.json');
  await writeFile(path, JSON.stringify(fixture));
  return { root, fixture, path, snapshot: parseSnapshot(fixture.data, fixture.target) };
}

test('candidates put interactive controls first and keep one locator per element', async t => {
  const { snapshot } = await crowded(t);
  const candidates = pickCandidates(snapshot);
  assert.deepEqual(candidates.map(candidate => candidate.ref), [
    '@scuekeeper:e1', '@scuekeeper:e2', '@scuekeeper:e3', '@scuekeeper:e4', '@scuekeeper:e0',
  ]);
  assert.deepEqual(candidates.map(candidate => candidate.interactive), [true, true, true, true, false]);
  for (const candidate of candidates) {
    assert.ok(candidate.path.length >= 2);
    if (candidate.bounds) assert.ok(contains(candidate.bounds, candidate.point), candidate.ref);
  }

  const first = candidates.find(candidate => candidate.ref === '@scuekeeper:e1');
  const twin = candidates.find(candidate => candidate.ref === '@scuekeeper:e4');
  assert.deepEqual(first.locator, {
    kind: 'element', role: 'textfield', name: '', path: ['window', 'scrollarea', 'textfield'], index: 0,
  });
  assert.deepEqual(twin.locator, { ...first.locator, index: 1 });
  assert.equal(resolve(snapshot, first.locator).node.ref, '@scuekeeper:e1');
  assert.equal(resolve(snapshot, twin.locator).node.ref, '@scuekeeper:e4');

  assert.equal(selectCandidate(candidates, '@scuekeeper:e4').ref, '@scuekeeper:e4');
  assert.equal(selectCandidate(candidates, 'e4').ref, '@scuekeeper:e4');
  assert.equal(selectCandidate(candidates, '@scuekeeper:e99'), undefined);
  assert.equal(selectCandidate(candidates, '@scuekeeper:e5'), undefined, 'hidden controls are not pickable');
  assert.equal(selectCandidate(candidates, '@scuekeeper:e6'), undefined, 'secure fields are not pickable');
});

test('pick lists TextEdit textfields from a saved snapshot without touching the desktop', async () => {
  const list = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
    '--snapshot', snapshotPath, '--json']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.response.ok, true);
  assert.equal(list.response.data.windowId, 'w-1234');
  assert.deepEqual(list.response.data.candidates.map(candidate => [
    candidate.ref, candidate.role, candidate.name, candidate.path, candidate.point,
  ]), [['@scuekeeper:e1', 'textfield', '', ['window', 'scrollarea', 'textfield'], [419, 319]]]);

  const selected = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
    '--snapshot', snapshotPath, '--select', 'e1', '--json']);
  assert.equal(selected.code, 0, selected.stderr);
  const data = selected.response.data;
  assert.equal(data.ref, '@scuekeeper:e1');
  assert.equal(data.role, 'textfield');
  assert.equal(data.name, '');
  assert.deepEqual(data.path, ['window', 'scrollarea', 'textfield']);
  assert.deepEqual(data.point, [419, 319]);
  assert.deepEqual(data.frame, { x: 112, y: 130, width: 615, height: 378 });
  assert.deepEqual(data.locator, { kind: 'element', role: 'textfield', name: '' });
});

test('a picked locator drops into a flow and passes validate and offline resolution', async t => {
  const root = await workspace(t);
  const flow = await example('textedit.flow');
  for (const select of ['e1', '@scuekeeper:e1']) {
    const selected = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
      '--snapshot', snapshotPath, '--select', select, '--json']);
    assert.equal(selected.code, 0, selected.stderr);
    flow.steps[0].target = selected.response.data.locator;
    flow.steps[1].target = selected.response.data.locator;
  }
  const path = join(root, 'picked.flow.json');
  await writeFile(path, JSON.stringify(flow));

  const validate = run(['flow', 'validate', path, '--json']);
  assert.equal(validate.code, 0, validate.stdout + validate.stderr);
  assert.deepEqual(validate.response.data, { flowId: flow.id, actions: 3 });

  const dry = run(['run', path, '--dry-run', '--snapshot', snapshotPath, '--json']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.deepEqual(dry.response.data.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['type', 'resolved'], ['key', 'resolved'],
  ]);
});

test('a duplicate-name element picked by ref resolves to that exact element', async t => {
  const { root, fixture, path, snapshot } = await crowded(t);
  const listed = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
    '--snapshot', path, '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.response.data.candidates.map(candidate => candidate.ref), [
    '@scuekeeper:e1', '@scuekeeper:e2', '@scuekeeper:e3', '@scuekeeper:e4', '@scuekeeper:e0',
  ]);

  const selected = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
    '--snapshot', path, '--select', '@scuekeeper:e4', '--json']);
  assert.equal(selected.code, 0, selected.stderr);
  assert.deepEqual(selected.response.data.locator, {
    kind: 'element', role: 'textfield', name: '', path: ['window', 'scrollarea', 'textfield'], index: 1,
  });
  assert.equal(resolve(snapshot, selected.response.data.locator).node.ref, '@scuekeeper:e4');

  const flow = await example('textedit.flow');
  flow.steps[0].target = selected.response.data.locator;
  flow.steps[1].target = selected.response.data.locator;
  const flowPath = join(root, 'twin.flow.json');
  await writeFile(flowPath, JSON.stringify(flow));
  const dry = run(['run', flowPath, '--dry-run', '--snapshot', path, '--json']);
  assert.equal(dry.code, 0, dry.stdout + dry.stderr);
  assert.equal(dry.response.data.status, 'passed');
  assert.equal(fixture.data.window.id, 'w-1234');
});

test('selecting an unknown ref fails with NOT_FOUND', async () => {
  const missing = run(['pick', '--app', 'com.apple.TextEdit', '--window', 'Cuekeeper-M1.txt',
    '--snapshot', snapshotPath, '--select', 'e99', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(missing.response.ok, false);
  assert.equal(missing.response.error.code, 'NOT_FOUND');
  assert.match(missing.response.error.message, /e99/);
});
