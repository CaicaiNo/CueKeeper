import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { flowV2Check } from '../dist/contracts-v2.js';
import { hashFlowV2 } from '../dist/flow-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { pickWindowCandidates } from '../dist/workbench-pick.js';
import {
  assertCheck, checkLabel, checkpointWaitFacts, defaultLibraryExpanded, diffSummary, dragSummary,
  filterStepsByScope, libraryGroups, locatorDetail, pickCandidateLabel, roleLabel, scopeDescription,
  scopeKey, scopeOptions, stateCheckLabel, statusMap, stepTemplate, stepTiming, targetLabel,
  toggleLibraryGroup, v2StepLabel,
} from '../workbench/model.js';

const examplePath = name => new URL(`../examples/${name}.json`, import.meta.url);
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  await copyFile(examplePath('global-two-apps.flow'), join(directory, 'flow.json'));
  const flow = JSON.parse(await readFile(join(directory, 'flow.json'), 'utf8'));
  return { root, directory, flow };
}

/** A replay CLI that records its argv and prints one passing v2 report. */
async function reportingStub(root) {
  const stub = join(root, 'stub-cli.mjs');
  await writeFile(stub, [
    "import { writeFile } from 'node:fs/promises';",
    'await writeFile(process.env.CUEKEEPER_V2_STUB_ARGV, JSON.stringify(process.argv.slice(2)));',
    'const entry = { id: "wait-browser", kind: "wait", status: "passed", atMs: 0, durationMs: 4 };',
    'const report = { version: 2, flowId: "global-two-apps", flowSha256: "a".repeat(64),',
    '  startedAt: new Date().toISOString(), mode: "replay", status: "passed", entries: [entry] };',
    'process.stdout.write(JSON.stringify({ ok: true, data: report }) + "\\n");',
    '',
  ].join('\n'));
  return stub;
}

async function server(t, options = {}) {
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, allowLive: false, library: join(options.root, 'library'),
    signal: cancellation.signal, ...options,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${started.url}/api/${route}`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }
  return { url: started.url, post };
}

const edit = (post, session, op) => post('v2/edit', { session: session.id, op });
const stepOf = (flow, id) => flow.steps.find(step => step.id === id);

test('a v2 recording opens editable with a diff, undo/redo and a read-only checkpoint contract', async t => {
  const { root, directory, flow } = await fixture(t);
  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  assert.equal(session.version, 2);
  assert.equal(session.v2.flowPath, join(await realpath(directory), 'flow.json'));
  assert.equal(session.v2.diff.changed, false);
  assert.equal(session.v2.dirty, false);
  assert.deepEqual(session.v2.flow.steps.map(step => step.id), flow.steps.map(step => step.id));
  assert.equal(session.v2.canUndo, false);
  assert.equal(session.v2.validation.ok, true);

  // A repicked target is one EditOp; the returned snapshot is the new flow.
  const retargeted = await edit(post, session, {
    kind: 'update', id: 'type-address',
    patch: { target: { kind: 'element', role: 'searchfield', name: '地址栏' } },
  });
  assert.deepEqual(stepOf(retargeted.flow, 'type-address').target, {
    kind: 'element', role: 'searchfield', name: '地址栏',
  });
  assert.equal(retargeted.diff.changed, true);
  assert.equal(retargeted.dirty, true);
  assert.deepEqual(retargeted.diff.modified.find(item => item.id === 'type-address').fields,
    ['target.name', 'target.role']);
  assert.equal(retargeted.canUndo, true);

  // An assertion follows an existing step and inherits its scope.
  const asserted = await edit(post, session, {
    kind: 'assert', afterStepId: 'wait-browser',
    check: { target: { kind: 'window' }, expect: { property: 'exists', equals: true } },
  });
  const added = asserted.flow.steps.find(step => step.kind === 'assert' && step.id.startsWith('assert-'));
  assert.ok(added, 'the engine allocated an assert id');
  assert.deepEqual(added.scope, stepOf(asserted.flow, 'wait-browser').scope);
  assert.deepEqual(asserted.diff.added.map(item => item.id), [added.id]);

  // Moving is undoable and redoable without touching the recording.
  const moved = await edit(post, session, { kind: 'move', id: added.id, toIndex: 0 });
  assert.equal(moved.flow.steps[0].id, added.id);
  assert.equal(moved.flow.steps[0].id, added.id);
  const undone = await post('v2/undo', { session: session.id });
  assert.equal(undone.flow.steps[0].id, 'launch-browser');
  assert.equal(undone.canRedo, true);
  const redone = await post('v2/redo', { session: session.id });
  assert.equal(redone.flow.steps[0].id, added.id);

  // Deleting a redundant step keeps the flow valid.
  const deleted = await edit(post, session, { kind: 'delete', id: 'switch-notes' });
  assert.equal(stepOf(deleted.flow, 'switch-notes'), undefined);
  assert.deepEqual(deleted.diff.removed.map(item => item.id), ['switch-notes']);
  assert.equal(deleted.validation.ok, true);

  // An invalid app is refused with the step and field; nothing changes.
  const before = JSON.stringify(stepOf(deleted.flow, 'wait-browser').scope);
  const refused = await post('v2/edit', {
    session: session.id,
    op: { kind: 'update', id: 'wait-browser', patch: { scope: { kind: 'window', app: 'not-a-bundle' } } },
  }, 400);
  assert.equal(refused.error, 'INVALID_APP');
  assert.equal(refused.detail.stepId, 'wait-browser');
  const state = await post('state', {});
  assert.equal(JSON.stringify(stepOf(state.session.v2.flow, 'wait-browser').scope), before);
  assert.equal(state.session.v2.saved.length, 0);

  // The dry run reports the structural scope plan of the edited flow.
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.status, 'passed');
  assert.equal(dry.entries.length, state.session.v2.flow.steps.length);
  assert.equal(dry.flowSha256, hashFlowV2(state.session.v2.flow));
  assert.ok(dry.entries.every(entry => entry.status === 'resolved'));
});

test('copying a step inserts a new id and leaves every recorded id in place', async t => {
  const { root, directory, flow } = await fixture(t);
  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  const source = stepOf(flow, 'type-address');
  const copied = await edit(post, session, {
    kind: 'insert', index: 1, step: { ...structuredClone(source), id: 'type-address-copy' },
  });
  assert.deepEqual(copied.flow.steps.slice(0, 3).map(step => step.id),
    ['launch-browser', 'type-address-copy', 'wait-browser']);
  // The original steps keep the ids the recording wrote; only the copy is new.
  assert.deepEqual(copied.flow.steps.filter(step => step.id !== 'type-address-copy').map(step => step.id),
    flow.steps.map(step => step.id));
});

test('a recording without a report shows the times its own steps were recorded at', async t => {
  const { root, directory, flow } = await fixture(t);
  // A plain recording writes flow.json only: no report.json, no actions.json.
  const timed = { ...flow, steps: flow.steps.map((step, index) => ({ ...step, atMs: index * 620 })) };
  await writeFile(join(directory, 'flow.json'), JSON.stringify(timed));
  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  assert.equal(session.timingSource, 'capture');
  assert.deepEqual(session.timeline.map(row => row.atMs), timed.steps.map(step => step.atMs));
  // The recording ran until its last step; it has no per-step durations.
  assert.equal(session.durationMs, (timed.steps.length - 1) * 620);
  assert.deepEqual(session.timeline.map(row => row.durationMs), timed.steps.map(() => undefined));

  // The older recording without times still opens; it just has nothing to show.
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow));
  const untimed = await post('import', { directory });
  assert.equal(untimed.timingSource, undefined);
  assert.equal(untimed.timeline.every(row => row.atMs === undefined), true);
  assert.equal(untimed.durationMs, undefined);
});

test('an edit keeps the recorded time of the edited step, the copy and the new assertion', async t => {
  const { root, directory, flow } = await fixture(t);
  const timed = { ...flow, steps: flow.steps.map((step, index) => ({ ...step, atMs: index * 620 })) };
  await writeFile(join(directory, 'flow.json'), JSON.stringify(timed));
  const { post } = await server(t, { root });
  const session = await post('import', { directory });

  const edited = await edit(post, session, { kind: 'update', id: 'type-address', patch: { text: 'ck.test' } });
  assert.equal(stepOf(edited.flow, 'type-address').atMs, 1240);

  const copied = await edit(post, session, {
    kind: 'insert', index: 3,
    step: { ...structuredClone(stepOf(edited.flow, 'type-address')), id: 'type-address-copy' },
  });
  assert.equal(stepOf(copied.flow, 'type-address-copy').atMs, 1240);

  const asserted = await edit(post, session, {
    kind: 'assert', afterStepId: 'wait-browser',
    check: { target: { kind: 'window' }, expect: { property: 'exists', equals: true } },
  });
  const added = asserted.flow.steps.find(step => step.kind === 'assert' && step.id.startsWith('assert-'));
  assert.equal(added.atMs, 620);
  assert.equal(asserted.validation.ok, true);
});

test('saving writes a sibling revision, keeps the recording bytes and a live run shells out to the CLI', async t => {
  const { root, directory, flow } = await fixture(t);
  const originalBytes = await readFile(join(directory, 'flow.json'));
  const argvFile = join(root, 'argv.json');
  const stub = join(root, 'stub-cli.mjs');
  await writeFile(stub, [
    "import { writeFile } from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    'await writeFile(process.env.CUEKEEPER_V2_STUB_ARGV, JSON.stringify(args));',
    "const status = process.env.CUEKEEPER_V2_STUB_STATUS === 'failed' ? 'failed' : 'passed';",
    'const entry = { id: "wait-browser", kind: "wait", status, atMs: 0, durationMs: 4 };',
    'if (status !== "passed") Object.assign(entry, { code: "ASSERTION_FALSE", message: "stub failed" });',
    'const report = { version: 2, flowId: "global-two-apps", flowSha256: "a".repeat(64),',
    '  startedAt: new Date().toISOString(), mode: "replay", status, entries: [entry] };',
    'process.stdout.write(JSON.stringify({ ok: status === "passed", data: report }) + "\\n");',
    'if (status !== "passed") process.exitCode = 1;',
    '',
  ].join('\n'));
  process.env.CUEKEEPER_V2_STUB_ARGV = argvFile;
  t.after(() => { delete process.env.CUEKEEPER_V2_STUB_ARGV; delete process.env.CUEKEEPER_V2_STUB_STATUS; });
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });

  // Repoint one target, then make both type steps literal so no runtime values
  // are needed for a live run.
  await edit(post, session, {
    kind: 'update', id: 'type-address',
    patch: { target: { kind: 'element', role: 'textfield', name: '地址栏' } },
  });
  const literal = await edit(post, session, { kind: 'update', id: 'type-address', patch: { text: 'ck.test' } });
  assert.equal(literal.flow.inputs.includes('address'), false);
  const done = await edit(post, session, { kind: 'update', id: 'type-note', patch: { text: 'hello' } });
  assert.equal(done.flow.inputs, undefined);
  assert.equal(done.diff.changed, true);

  // A live run before saving is refused; the saved workflow is the unit of
  // replay, and the refusal says so in the same words as the page.
  const refused = await post('run', { session: session.id, mode: 'live', confirm: true }, 400);
  assert.match(refused.error, /save the workflow before a live replay/);

  const saved = await post('save', { session: session.id }, 201);
  assert.match(saved.output, /flow\.edited-.+\.json$/);
  assert.equal(saved.originalSha256, sha256(originalBytes));
  assert.equal(sha256(await readFile(join(directory, 'flow.json'))), sha256(originalBytes));
  const revision = JSON.parse(await readFile(saved.output, 'utf8'));
  assert.equal(flowV2Check.Check(revision), true);
  assert.equal(stepOf(revision, 'type-address').text, 'ck.test');
  assert.equal(stepOf(revision, 'type-address').target.name, '地址栏');
  assert.equal(saved.v2.diff.changed, true);
  assert.equal(saved.v2.dirty, false);
  assert.equal(saved.v2.saved.length, 1);

  // A page reload sees the same edited flow from the server's editor state.
  const state = await post('state', {});
  assert.equal(stepOf(state.session.v2.flow, 'type-address').text, 'ck.test');
  assert.equal(state.session.v2.saved.at(-1).path, saved.output);

  // The live replay wraps the CLI with the foreground/headed flags and the
  // revision path, then returns the v2 report it printed.
  const live = await post('run', { session: session.id, mode: 'live', confirm: true });
  assert.equal(live.status, 'passed');
  assert.equal(live.exitCode, 0);
  assert.equal(live.stopped, false);
  const argv = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.equal(argv[0], 'run');
  assert.equal(argv[1], saved.output);
  assert.ok(argv.includes('--foreground'));
  assert.ok(argv.includes('--headed'));
  assert.ok(argv.includes('--json'));
  // A flow without checkpoints keeps the human terminal channel.
  assert.equal(argv.includes('--checkpoint-events'), false);

  process.env.CUEKEEPER_V2_STUB_STATUS = 'failed';
  const failed = await post('run', { session: session.id, mode: 'live', confirm: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.entries[0].code, 'ASSERTION_FALSE');
  const statuses = statusMap(failed);
  assert.equal(statuses.get('wait-browser').status, 'failed');
});

test('a freshly imported recording replays live without a revision file', async t => {
  const { root, directory } = await fixture(t);
  const argvFile = join(root, 'argv.json');
  const stub = await reportingStub(root);
  process.env.CUEKEEPER_V2_STUB_ARGV = argvFile;
  t.after(() => { delete process.env.CUEKEEPER_V2_STUB_ARGV; });
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  const recording = join(await realpath(directory), 'flow.json');

  // The untouched import names the recording it would replay, so the page has
  // no reason to demand a revision the operator never made.
  assert.equal(session.v2.dirty, false);
  assert.equal(session.v2.saved.length, 0);
  assert.deepEqual(session.v2.live, { path: recording, revision: false });

  const live = await post('run', {
    session: session.id, mode: 'live', confirm: true,
    inputs: { address: 'ck.test', note: 'hello' },
  });
  assert.equal(live.status, 'passed');
  assert.equal(live.exitCode, 0);
  assert.equal(live.entries[0].status, 'passed');
  const argv = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.equal(argv[0], 'run');
  assert.equal(argv[1], recording);
  assert.ok(argv.includes('--headed'));
  // Replaying the recording must not leave a revision file behind.
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('flow.edited-')), []);
});

test('a live replay follows the newest revision and refuses an unsaved edit', async t => {
  const { root, directory } = await fixture(t);
  const argvFile = join(root, 'argv.json');
  const stub = await reportingStub(root);
  process.env.CUEKEEPER_V2_STUB_ARGV = argvFile;
  t.after(() => { delete process.env.CUEKEEPER_V2_STUB_ARGV; });
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  const recording = join(await realpath(directory), 'flow.json');
  const runLive = () => post('run', {
    session: session.id, mode: 'live', confirm: true, inputs: { address: 'ck.test', note: 'hello' },
  });

  // One unsaved edit has no file to replay: ask for the workflow to be saved
  // instead of silently running a recording that no longer matches the timeline.
  const edited = await edit(post, session, { kind: 'update', id: 'type-note', patch: { text: 'hello' } });
  assert.equal(edited.dirty, true);
  assert.equal(edited.live, undefined);
  const refused = await post('run', { session: session.id, mode: 'live', confirm: true }, 400);
  assert.match(refused.error, /save the workflow before a live replay/);
  await assert.rejects(readFile(argvFile), error => error.code === 'ENOENT');

  // Undoing the edit returns to the recording bytes, so the raw file replays.
  const undone = await post('v2/undo', { session: session.id });
  assert.equal(undone.dirty, false);
  assert.deepEqual(undone.live, { path: recording, revision: false });
  const replayed = await runLive();
  assert.equal(replayed.status, 'passed');
  assert.equal(JSON.parse(await readFile(argvFile, 'utf8'))[1], recording);

  // Once a revision is saved it is the replay target, even for the same bytes.
  const saved = await post('save', { session: session.id }, 201);
  const state = await post('state', {});
  assert.deepEqual(state.session.v2.live, { path: saved.output, revision: true });
  const fromRevision = await runLive();
  assert.equal(fromRevision.status, 'passed');
  assert.equal(JSON.parse(await readFile(argvFile, 'utf8'))[1], saved.output);

  // Editing after the save leaves the revision behind and blocks the run.
  await edit(post, session, { kind: 'update', id: 'type-note', patch: { text: 'changed' } });
  const refusedAgain = await post('run', { session: session.id, mode: 'live', confirm: true }, 400);
  assert.match(refusedAgain.error, /save the workflow before a live replay/);
});

test('a capture gap can be imported, blocks running and is replaced in place', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-gap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  await writeFile(join(directory, 'flow.json'), JSON.stringify({
    version: 2, id: 'gap-flow', name: '缺口流程',
    steps: [{ id: 'gap-1', kind: 'gap', code: 'CAPTURE_GAP' }],
  }));
  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  assert.equal(session.v2.flow.steps[0].kind, 'gap');
  assert.equal(session.v2.validation.ok, false);

  const blocked = await post('run', { session: session.id, mode: 'dry-run' }, 400);
  assert.equal(blocked.error, 'GAP_UNRESOLVED');
  assert.equal(blocked.detail.stepId, 'gap-1');
  await post('save', { session: session.id }, 400);

  const replaced = await post('v2/replace', {
    session: session.id, id: 'gap-1',
    step: {
      id: 'gap-1', kind: 'wait', timeoutMs: 5000,
      scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'editor', windowTitle: 'Notes' },
      check: { kind: 'window_exists', equals: true },
    },
  });
  assert.equal(replaced.flow.steps[0].kind, 'wait');
  assert.equal(replaced.validation.ok, true);
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.status, 'passed');
  const saved = await post('save', { session: session.id }, 201);
  assert.match(saved.output, /flow\.edited-/);
});

test('a point target is marked on the timeline and blocked step by step in the workbench dry run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-point-workbench-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const flow = {
    version: 2, id: 'point-flow', name: '坐标点击',
    steps: [
      {
        id: 'click-1', kind: 'click',
        scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'files', windowTitle: 'Downloads' },
        target: { kind: 'point', point: [420, 300] },
      },
      {
        id: 'click-2', kind: 'click',
        scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'files', windowTitle: 'Downloads' },
        target: { kind: 'element', role: 'row', name: 'manifest.json' },
      },
    ],
  };
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow));

  // The timeline says a recorded coordinate is not a proven target.
  assert.equal(v2StepLabel(flow.steps[0]), '点击 坐标回放 · 需确认 (420, 300)');
  assert.equal(v2StepLabel(flow.steps[1]), '点击 manifest.json');

  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  assert.equal(session.v2.flow.steps[0].target.kind, 'point');
  // A point click is a legal flow step, and the dry run reports it per step
  // instead of failing the request: the operator sees a blocked entry it can
  // turn into an element target while every other step stays resolved.
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.status, 'blocked');
  assert.deepEqual(dry.entries.map(entry => [entry.id, entry.status, entry.code]), [
    ['click-1', 'blocked', 'UNSAFE_POINT'],
    ['click-2', 'resolved', undefined],
  ]);
  assert.match(dry.entries[0].message, /元素目标/);
  assert.match(dry.entries[0].message, /实时回放/);

  // Turning it into the element the recording already named clears the block.
  await edit(post, session, {
    kind: 'update', id: 'click-1',
    patch: { target: { kind: 'element', role: 'row', name: 'manifest.json' } },
  });
  const passed = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(passed.status, 'passed');
  assert.ok(passed.entries.every(entry => entry.status === 'resolved'));
});

test('a target label names the control in product words and never leaks a raw AX role', () => {
  // The recorded name wins: a file, a field or a button the user can recognise.
  assert.equal(targetLabel({ kind: 'element', role: 'AXCell', name: 'manifest.json' }), 'manifest.json');
  assert.equal(targetLabel({ kind: 'element', role: 'AXButton', name: '保存' }), '保存');
  // Without a name the role is translated; both AX spellings land on one word.
  assert.equal(targetLabel({ kind: 'element', role: 'AXTextField' }), '文本输入框');
  assert.equal(targetLabel({ kind: 'element', role: 'textfield' }), '文本输入框');
  assert.equal(targetLabel({ kind: 'element', role: 'AXGroup' }), '区域');
  assert.equal(roleLabel('AXCell'), '文件项');
  assert.equal(roleLabel('AXMenuItem'), '菜单项');
  // The deepest path segment is the next best readable name.
  assert.equal(targetLabel({
    kind: 'element', role: 'AXGroup', path: ['AXWindow', 'AXScrollArea', 'AXButton'],
  }), '按钮');
  // Nothing readable left: an honest placeholder instead of `AX*`.
  assert.equal(targetLabel({ kind: 'element', role: 'AXFancyNewControl' }), '控件');
  assert.equal(targetLabel({ kind: 'element', role: '' }), '未命名控件');
  // A raw point keeps its own warning; a window marker stays a window.
  assert.equal(targetLabel({ kind: 'point', point: [420, 300] }), '坐标回放 · 需确认 (420, 300)');
  assert.equal(targetLabel({ kind: 'window' }), '窗口');
  assert.equal(targetLabel(null), '目标窗口');

  const labels = [
    targetLabel({ kind: 'element', role: 'AXTextField', name: '搜索' }),
    targetLabel({ kind: 'element', role: 'AXTextField' }),
    targetLabel({ kind: 'point', point: [1, 2] }),
    dragSummary({ from: { kind: 'element', role: 'AXCell' }, to: { kind: 'element', role: 'AXButton', name: '打开' } }),
    checkLabel({ target: { kind: 'element', role: 'AXTextField' }, expect: { property: 'text', equals: 'hi' } }),
    pickCandidateLabel({ interactive: true, locator: { kind: 'element', role: 'AXGroup' } }),
  ];
  for (const label of labels) assert.doesNotMatch(label, /AX/, label);

  // The inspector keeps the raw locator so role, name, path and index stay visible.
  assert.equal(locatorDetail({
    kind: 'element', role: 'AXCell', name: 'manifest.json',
    path: ['AXWindow', 'AXOutline', 'AXCell'], index: 2,
  }), 'AXCell · 名称 “manifest.json” · AXWindow › AXOutline › AXCell · [2]');
  assert.equal(locatorDetail({ kind: 'element', role: 'AXTextField' }), 'AXTextField');
  assert.equal(locatorDetail({ kind: 'point', point: [10, 20] }), 'point (10, 20)');
});

test('v2 timeline helpers describe steps, scopes, diffs and build EditOp payloads', () => {
  const flow = {
    version: 2, id: 'helpers', name: 'Helpers',
    steps: [
      {
        id: 'click-1', kind: 'click', scope: { kind: 'window', app: 'com.apple.Safari', windowKey: 'b', windowTitle: 'Page' },
        target: { kind: 'element', role: 'button', name: 'Go' },
      },
      {
        id: 'type-1', kind: 'type', scope: { kind: 'window', app: 'com.apple.Safari', windowKey: 'b', windowTitle: 'Page' },
        target: { kind: 'element', role: 'textfield' }, input: 'query',
      },
      {
        id: 'wait-1', kind: 'wait', scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'n', windowTitle: 'Notes' },
        check: { kind: 'window', expect: { property: 'title', equals: 'Notes' } }, timeoutMs: 5000,
      },
      { id: 'gap-1', kind: 'gap', code: 'CAPTURE_GAP' },
    ],
  };
  assert.equal(v2StepLabel(flow.steps[0]), '点击 Go');
  assert.equal(v2StepLabel(flow.steps[1]), '输入参数 query');
  assert.equal(v2StepLabel(flow.steps[2], app => app), '等待 · 窗口属性 · title = Notes');
  // A target with no name is named by its role in product words, never by the
  // window title and never by the raw AX spelling.
  assert.equal(
    v2StepLabel({
      kind: 'click', count: 2,
      scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'f', windowTitle: 'cuekeeper-demo' },
      target: { kind: 'element', role: 'AXTextField' },
    }, app => app),
    '双击 文本输入框');
  assert.equal(checkLabel({ kind: 'window_exists', equals: true }), '窗口存在 = 成立');
  assert.equal(checkLabel({
    target: { kind: 'element', role: 'textfield' },
    expect: { property: 'text', equals: 'hello' },
  }), '文本输入框 · text = hello');

  const options = scopeOptions(flow, appId => appId);
  assert.deepEqual(options.map(option => option.key), [
    'window:com.apple.Safari:b', 'window:com.apple.TextEdit:n',
  ]);
  assert.deepEqual(filterStepsByScope(flow, scopeKey(flow.steps[2].scope)).map(step => step.id), ['wait-1']);
  assert.equal(filterStepsByScope(flow, '').length, 4);

  const summary = diffSummary({
    added: [{ id: 'a', index: 0 }], removed: [{ id: 'b', index: 1 }],
    moved: [{ id: 'c', from: 2, to: 3 }], modified: [{ id: 'd', fields: ['target.role'] }],
    flowFields: ['inputs[0]'], orderChanged: true, changed: true,
  });
  assert.equal(summary.changed, true);
  assert.match(summary.lines.join('；'), /新增 a/);
  assert.match(summary.lines.join('；'), /删除 b/);
  assert.match(summary.lines.join('；'), /修改 d（target\.role）/);

  assert.deepEqual(assertCheck({
    target: { kind: 'window' }, property: 'exists', equals: false,
  }), { target: { kind: 'window' }, expect: { property: 'exists', equals: false } });
  assert.deepEqual(assertCheck({
    target: { kind: 'element', role: 'textfield' }, property: 'text', equals: 'done',
  }), {
    target: { kind: 'element', role: 'textfield' },
    expect: { property: 'text', equals: 'done' },
  });
  assert.throws(() => assertCheck({ target: { kind: 'window' }, property: 'unknown', equals: 1 }), /未知/);

  const scope = { kind: 'window', app: 'com.apple.Safari', windowKey: 'b', windowTitle: 'Page' };
  assert.deepEqual(stepTemplate('wait', { id: 'wait-2', scope, timeoutMs: 1200 }), {
    id: 'wait-2', kind: 'wait', scope,
    check: { kind: 'window_exists', equals: true }, timeoutMs: 1200,
  });
  assert.deepEqual(stepTemplate('key', { id: 'key-2', scope, key: 'tab' }),
    { id: 'key-2', kind: 'key', scope, key: 'tab' });
  assert.throws(() => stepTemplate('launch_app', { id: 'launch-2', scope }), /App 作用域/);
  assert.throws(() => stepTemplate('click', { id: 'click-2', scope }), /元素定位器/);
  // An inserted step keeps the recorded time of the step it follows; without a
  // time it stays untimed instead of inventing one.
  assert.equal(stepTemplate('key', { id: 'key-3', scope, atMs: 620 }).atMs, 620);
  assert.equal(stepTemplate('key', { id: 'key-4', scope }).atMs, undefined);

  // The timeline reads a step's time and the wait before it; an untimed row is
  // skipped rather than adding a gap it never measured.
  const timing = stepTiming([
    { id: 's1', atMs: 0 }, { id: 's2' }, { id: 's3', atMs: 620 }, { id: 's4', atMs: 1860 },
  ]);
  assert.deepEqual([...timing.entries()], [
    ['s1', { atMs: 0, sinceMs: undefined }],
    ['s3', { atMs: 620, sinceMs: 620 }],
    ['s4', { atMs: 1860, sinceMs: 1240 }],
  ]);
});

// --- Picking a live target -----------------------------------------------------
// The fake desktop replaces the agent-desktop process: list one window, read one
// fixture snapshot. No GUI, focus or input is involved.

function fakeSnapshot(windowId) {
  return {
    windowId,
    tree: {
      role: 'window', name: 'Cuekeeper 测试页', states: [], secure: false,
      bounds: { x: 0, y: 0, width: 900, height: 700 },
      children: [
        {
          role: 'textfield', name: '地址与搜索', ref: '@fake:e1', states: [], secure: false,
          bounds: { x: 20, y: 40, width: 400, height: 30 }, children: [],
        },
        {
          role: 'button', name: '刷新', ref: '@fake:e2', states: [], secure: false,
          bounds: { x: 430, y: 40, width: 60, height: 30 }, children: [],
        },
      ],
    },
  };
}

function fakeDesktop(list = [{ id: 'w-7', title: 'Cuekeeper 测试页' }]) {
  const calls = [];
  return {
    calls,
    async listWindows(app, timeoutMs) {
      calls.push(['listWindows', app, timeoutMs]);
      return list;
    },
    async snapshotWindow(windowId) {
      calls.push(['snapshotWindow', windowId]);
      return fakeSnapshot(windowId);
    },
  };
}

test('the v2 editor picks a target from the scoped window snapshot', async t => {
  const { root, directory } = await fixture(t);
  const desktop = fakeDesktop();
  const { post } = await server(t, {
    root, pickWindow: (scope, signal) => pickWindowCandidates(desktop, scope),
  });
  const session = await post('import', { directory });

  // type-address is bound to the browser window; its scope selects the window.
  const picked = await post('v2/pick', { session: session.id, stepId: 'type-address' });
  assert.equal(picked.windowId, 'w-7');
  assert.equal(picked.windowTitle, 'Cuekeeper 测试页');
  assert.deepEqual(picked.scope.windowKey, 'browser');
  assert.deepEqual(picked.candidates.map(candidate => candidate.role), ['textfield', 'button']);
  const chosen = picked.candidates[1];
  assert.equal(chosen.ref, '@fake:e2');
  assert.deepEqual(chosen.path, ['window', 'button']);
  assert.deepEqual(chosen.bounds, { x: 430, y: 40, width: 60, height: 30 });
  assert.deepEqual(chosen.point, [460, 55]);
  assert.deepEqual(chosen.locator, { kind: 'element', role: 'button', name: '刷新' });
  assert.equal(desktop.calls[0][1], 'com.apple.Safari');

  // Confirming a candidate is one EditOp; the step now names the element.
  const updated = await edit(post, session, {
    kind: 'update', id: 'type-address', patch: { target: chosen.locator },
  });
  assert.deepEqual(stepOf(updated.flow, 'type-address').target, chosen.locator);

  // A coordinate target resolves to the element picked at that point.
  const converted = await edit(post, session, {
    kind: 'update', id: 'paste-address',
    patch: { target: { kind: 'point', x: 12, y: 34, element: { role: 'textfield', name: '正文' } } },
  });
  assert.deepEqual(stepOf(converted.flow, 'paste-address').target,
    { kind: 'element', role: 'textfield', name: '正文' });

  // An app-scoped step has no window to read; the error is explicit.
  const appScope = await post('v2/pick', { session: session.id, stepId: 'launch-browser' }, 400);
  assert.equal(appScope.code, 'SCOPE_NOT_WINDOW');
  assert.match(appScope.error, /window scope/);
  const unknown = await post('v2/pick', { session: session.id, stepId: 'missing-step' }, 404);
  assert.match(unknown.error, /No step missing-step/);
});

test('a closed window is an explicit pick error, never a silent old target', async t => {
  const { root, directory } = await fixture(t);
  const { post } = await server(t, {
    root,
    pickWindow: (scope, signal) => pickWindowCandidates(
      fakeDesktop([{ id: 'w-9', title: '别的窗口' }]), scope),
  });
  const session = await post('import', { directory });
  const missing = await post('v2/pick', { session: session.id, stepId: 'type-address' }, 400);
  assert.equal(missing.code, 'WINDOW_NOT_FOUND');
  assert.match(missing.error, /Cuekeeper 测试页/);
  assert.match(missing.error, /别的窗口/);
  // The failed pick changed nothing.
  const state = await post('state', {});
  assert.deepEqual(stepOf(state.session.v2.flow, 'type-address').target,
    { kind: 'element', role: 'textfield', name: '地址与搜索' });
});

test('pick labels and checkpoint facts describe exactly what the page shows', () => {
  assert.match(pickCandidateLabel({
    interactive: true, locator: { kind: 'element', role: 'button', name: '刷新' },
    bounds: { x: 430, y: 40, width: 60, height: 30 },
  }), /^可交互 · 刷新 · 60 × 30 @ 430, 40$/);
  assert.deepEqual(checkpointWaitFacts({
    stepId: 'auth', triggerStepId: 'type-note', timeoutMs: 120_000,
    scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'QA Notes' },
  }), [
    ['当前步骤', 'auth'], ['触发步骤', 'type-note'],
    ['App / 窗口', 'com.apple.TextEdit · QA Notes'], ['等待上限', '120 秒'],
  ]);
  assert.deepEqual(checkpointWaitFacts(undefined), []);
});

// --- Checkpoint runs -----------------------------------------------------------
// The stub CLI announces the fixed marker on stderr and reads its answer from
// stdin; the page only talks to the workbench API.

async function checkpointFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const windowScope = {
    kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'QA Notes',
  };
  await writeFile(join(directory, 'flow.json'), JSON.stringify({
    version: 2, id: 'checkpoint-flow', name: '人工检查点流程',
    appPaths: { 'com.apple.TextEdit': '/System/Applications/TextEdit.app' },
    steps: [
      {
        id: 'wait-start', kind: 'wait', scope: windowScope,
        check: { kind: 'window_exists', equals: true }, timeoutMs: 15000,
      },
      {
        id: 'auth', kind: 'manual_checkpoint', scope: windowScope,
        triggerStepId: 'wait-start', reason: 'secure_input',
        resume: { scope: windowScope, check: { kind: 'window_exists', equals: true } },
        timeoutMs: 60000,
      },
      {
        id: 'wait-after', kind: 'wait', scope: windowScope,
        check: { kind: 'window_exists', equals: true }, timeoutMs: 15000,
      },
    ],
  }));
  const argvFile = join(root, 'argv.json');
  const stub = join(root, 'stub-checkpoint.mjs');
  await writeFile(stub, [
    "import { writeFile } from 'node:fs/promises';",
    "import { createInterface } from 'node:readline';",
    'const args = process.argv.slice(2);',
    'await writeFile(process.env.CUEKEEPER_V2_STUB_ARGV, JSON.stringify(args));',
    "const mode = process.env.CUEKEEPER_V2_STUB_MODE ?? 'marker';",
    "const base = { version: 2, flowId: 'checkpoint-flow', flowSha256: 'a'.repeat(64),",
    "  startedAt: new Date().toISOString(), mode: 'replay' };",
    'const entry = (id, kind, status, extra = {}) => ({ id, kind, status, atMs: 0, durationMs: 1, ...extra });',
    'const emit = (status, entries) => {',
    '  const code = status === \'passed\' ? 0 : 1;',
    '  process.stdout.write(JSON.stringify({ ok: code === 0, data: { ...base, status, entries } }) + "\\n",',
    '    () => process.exit(code));',
    '};',
    'const passed = () => emit(\'passed\', [entry(\'wait-start\', \'wait\', \'passed\'),',
    '  entry(\'auth\', \'manual_checkpoint\', \'passed\', { checkpoint: { reason: \'secure_input\',',
    "    triggerStepId: 'wait-start', timeoutMs: 60000, confirmedBy: 'operator' } }),",
    "  entry('wait-after', 'wait', 'passed')]);",
    "if (mode === 'silent') {",
    '  passed();',
    '} else {',
    "  process.stderr.write('CHECKPOINT_WAIT auth wait-start 60000\\n');",
    "  if (mode === 'timeout') {",
    '    setTimeout(() => emit(\'blocked\', [entry(\'wait-start\', \'wait\', \'passed\'),',
    "      entry('auth', 'manual_checkpoint', 'failed', { code: 'MANUAL_CHECKPOINT_TIMEOUT',",
    "        message: 'not confirmed' }), entry('wait-after', 'wait', 'skipped')]), 150);",
    '  } else {',
    '    const reader = createInterface({ input: process.stdin, terminal: false });',
    '    reader.on(\'line\', line => {',
    '      const answer = line.trim();',
    "      if (answer !== 'continue' && answer !== 'cancel') return;",
    '      reader.close();',
    "      if (answer === 'continue') passed();",
    '      else emit(\'blocked\', [entry(\'wait-start\', \'wait\', \'passed\'),',
    "        entry('auth', 'manual_checkpoint', 'failed', { code: 'MANUAL_CHECKPOINT_CANCELLED',",
    "          message: 'cancelled' }), entry('wait-after', 'wait', 'skipped')]);",
    '    });',
    '  }',
    '}',
    '',
  ].join('\n'));
  process.env.CUEKEEPER_V2_STUB_ARGV = argvFile;
  t.after(() => {
    delete process.env.CUEKEEPER_V2_STUB_ARGV;
    delete process.env.CUEKEEPER_V2_STUB_MODE;
  });
  return { root, directory, stub, argvFile };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForCheckpoint(post, sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await post('run/status', { session: sessionId });
    if (info.checkpoint) return info;
    await sleep(25);
  }
  throw new Error('the replay never announced a checkpoint');
}

test('a checkpoint flow waits in the workbench and resumes when the page answers', async t => {
  const { root, directory, stub, argvFile } = await checkpointFixture(t);
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  const saved = await post('save', { session: session.id }, 201);

  const running = post('run', { session: session.id, mode: 'live', confirm: true });
  const waiting = await waitForCheckpoint(post, session.id);
  assert.equal(waiting.running, true);
  assert.equal(waiting.checkpoint.stepId, 'auth');
  assert.equal(waiting.checkpoint.triggerStepId, 'wait-start');
  assert.equal(waiting.checkpoint.timeoutMs, 60000);
  assert.deepEqual(waiting.checkpoint.scope, {
    kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'QA Notes',
  });
  assert.ok(waiting.checkpoint.deadline > Date.now());

  const answered = await post('run/checkpoint', { session: session.id, answer: 'continue' });
  assert.deepEqual(answered, { sent: true, answer: 'continue' });
  const report = await running;
  assert.equal(report.status, 'passed');
  assert.equal(report.entries[1].checkpoint.confirmedBy, 'operator');
  assert.equal(report.stopped, false);

  const argv = JSON.parse(await readFile(argvFile, 'utf8'));
  assert.equal(argv[0], 'run');
  assert.equal(argv[1], saved.output);
  assert.ok(argv.includes('--checkpoint-events'));
  assert.ok(argv.includes('--foreground'));
  assert.ok(argv.includes('--json'));

  const after = await post('run/status', { session: session.id });
  assert.equal(after.running, false);
  assert.equal(after.checkpoint, undefined);
});

test('cancelling the checkpoint stops the run and skips later steps', async t => {
  const { root, directory, stub } = await checkpointFixture(t);
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  await post('save', { session: session.id }, 201);

  const running = post('run', { session: session.id, mode: 'live', confirm: true });
  await waitForCheckpoint(post, session.id);
  await post('run/checkpoint', { session: session.id, answer: 'cancel' });
  const report = await running;
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[1].code, 'MANUAL_CHECKPOINT_CANCELLED');
  assert.equal(report.entries[2].status, 'skipped');
  assert.equal(statusMap(report).get('wait-after').status, 'skipped');

  // The next report is already over; another answer is refused.
  const late = await post('run/checkpoint', { session: session.id, answer: 'continue' }, 409);
  assert.match(late.error, /No checkpoint run/);
});

test('an unanswered checkpoint times out and the report keeps the failure', async t => {
  const { root, directory, stub } = await checkpointFixture(t);
  process.env.CUEKEEPER_V2_STUB_MODE = 'timeout';
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  await post('save', { session: session.id }, 201);

  const running = post('run', { session: session.id, mode: 'live', confirm: true });
  await waitForCheckpoint(post, session.id);
  const report = await running;
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[1].code, 'MANUAL_CHECKPOINT_TIMEOUT');
  assert.equal(report.entries[2].status, 'skipped');
  const after = await post('run/status', { session: session.id });
  assert.equal(after.running, false);
  assert.equal(after.checkpoint, undefined);
});

test('a checkpoint flow whose CLI never announces a wait finishes report-only', async t => {
  const { root, directory, stub } = await checkpointFixture(t);
  process.env.CUEKEEPER_V2_STUB_MODE = 'silent';
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  await post('save', { session: session.id }, 201);

  const report = await post('run', { session: session.id, mode: 'live', confirm: true });
  assert.equal(report.status, 'passed');
  assert.equal(report.entries.length, 3);
  const status = await post('run/status', { session: session.id });
  assert.equal(status.running, false);
  assert.equal(status.checkpoint, undefined);
  const refused = await post('run/checkpoint', { session: session.id, answer: 'continue' }, 409);
  assert.match(refused.error, /No checkpoint run/);
});

test('stop while a checkpoint waits cancels it instead of killing the report', async t => {
  const { root, directory, stub } = await checkpointFixture(t);
  const { post } = await server(t, { root, cliPath: stub, allowLive: true });
  const session = await post('import', { directory });
  await post('save', { session: session.id }, 201);

  const running = post('run', { session: session.id, mode: 'live', confirm: true });
  await waitForCheckpoint(post, session.id);
  const stopped = await post('stop', {});
  assert.equal(stopped.stopped, true);
  const report = await running;
  assert.equal(report.stopped, true);
  assert.equal(report.entries[1].code, 'MANUAL_CHECKPOINT_CANCELLED');
  assert.equal(report.entries[2].status, 'skipped');
});

test('both behavior library groups open collapsed and toggle independently', () => {
  const library = {
    builtin: [
      { id: 'finder-copy', group: 'finder' },
      { id: 'check-file-exists', group: 'check' },
    ],
    custom: [
      { behavior: { name: 'B 行为' } },
      { behavior: { name: 'A 行为' } },
    ],
  };
  // Every page load starts with both groups closed, showing only title + count.
  const collapsed = libraryGroups(library, defaultLibraryExpanded());
  assert.deepEqual(collapsed.map(group => [group.key, group.title, group.count, group.expanded]), [
    ['builtin', '内置行为', 2, false],
    ['custom', '我的行为', 2, false],
  ]);
  // Custom cards keep their name order inside the group.
  assert.deepEqual(collapsed[1].items.map(item => item.behavior.name), ['A 行为', 'B 行为']);

  // Opening one group leaves the other closed; the state is page memory only.
  const builtinOpen = toggleLibraryGroup(defaultLibraryExpanded(), 'builtin');
  assert.deepEqual(libraryGroups(library, builtinOpen).map(group => group.expanded), [true, false]);
  const customOpen = toggleLibraryGroup(builtinOpen, 'custom');
  assert.deepEqual(libraryGroups(library, customOpen).map(group => group.expanded), [true, true]);
  const builtinClosed = toggleLibraryGroup(customOpen, 'builtin');
  assert.deepEqual(libraryGroups(library, builtinClosed).map(group => group.expanded), [false, true]);
  assert.throws(() => toggleLibraryGroup(customOpen, 'other'), /未知的行为库分组/);
});

test('a system check reads as a file or process line in the timeline', () => {
  const file = { kind: 'assert', scope: { kind: 'file', path: '/tmp/报告.pdf' }, check: { kind: 'file_exists', equals: false } };
  const process = { kind: 'assert', scope: { kind: 'process', name: 'Google Chrome' }, check: { kind: 'process_running', equals: true } };
  assert.equal(v2StepLabel(file), '断言 · 文件存在 = 不成立');
  assert.equal(v2StepLabel(process), '断言 · 进程运行中 = 成立');
  // Arguments refine the check, never the label: the timeline shows no values.
  const withArgs = {
    kind: 'assert', scope: { kind: 'process', name: 'controlled sleeper' },
    check: { kind: 'process_running', equals: true, args: ['--profile', 'a b'] },
  };
  assert.equal(v2StepLabel(withArgs), '断言 · 进程运行中 = 成立');
  assert.equal(v2StepLabel(withArgs).includes('a b'), false);
  assert.equal(v2StepLabel(withArgs).includes('--profile'), false);
  assert.equal(checkLabel(file.check), '文件存在 = 不成立');
  assert.equal(scopeDescription(file.scope), '文件 · /tmp/报告.pdf');
  assert.equal(scopeDescription(process.scope), '进程 · Google Chrome');
  assert.equal(scopeKey(process.scope), 'process:name:Google Chrome');
  assert.equal(scopeKey({ kind: 'process', path: '/usr/bin/sleep' }), 'process:path:/usr/bin/sleep');
  // The report shows both values, including a passing reverse check and an
  // unknown observation.
  assert.equal(stateCheckLabel({ kind: 'file_exists', expected: false, actual: false }),
    '期望 不存在 · 实际 不存在');
  assert.equal(stateCheckLabel({ kind: 'process_running', expected: true, actual: null }),
    '期望 运行 · 实际 未知');
  assert.equal(stateCheckLabel(undefined), '');
});
