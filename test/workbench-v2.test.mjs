import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { flowV2Check } from '../dist/contracts-v2.js';
import { hashFlowV2 } from '../dist/flow-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { pickWindowCandidates } from '../dist/workbench-pick.js';
import {
  assertCheck, checkLabel, checkpointWaitFacts, diffSummary, filterStepsByScope, pickCandidateLabel,
  scopeKey, scopeOptions, statusMap, stepTemplate, v2StepLabel,
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

  // A live run before saving is refused; the revision is the unit of replay.
  await post('run', { session: session.id, mode: 'live', confirm: true }, 400);

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

test('a point target is marked on the timeline and refused by the workbench dry run', async t => {
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
  assert.equal(v2StepLabel(flow.steps[0]), '点击 · 坐标回放 · 需确认 (420, 300)');
  assert.equal(v2StepLabel(flow.steps[1]), '点击 · row · manifest.json');

  const { post } = await server(t, { root });
  const session = await post('import', { directory });
  assert.equal(session.v2.flow.steps[0].target.kind, 'point');
  // A point click is a legal flow step, but no dry run may pass with one.
  const refused = await post('run', { session: session.id, mode: 'dry-run' }, 400);
  assert.equal(refused.error, 'UNSAFE_POINT');
  assert.deepEqual(refused.detail.stepIds, ['click-1']);

  // Turning it into the element the recording already named unblocks the run.
  await edit(post, session, {
    kind: 'update', id: 'click-1',
    patch: { target: { kind: 'element', role: 'row', name: 'manifest.json' } },
  });
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.status, 'passed');
  assert.ok(dry.entries.every(entry => entry.status === 'resolved'));
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
  assert.equal(v2StepLabel(flow.steps[0]), '点击 · button · Go');
  assert.equal(v2StepLabel(flow.steps[1]), '输入参数 query');
  assert.equal(v2StepLabel(flow.steps[2], app => app), '等待 · 窗口属性 · title = Notes');
  // A target with no name must not borrow the window title as its identity.
  assert.equal(
    v2StepLabel({
      kind: 'click', count: 2,
      scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'f', windowTitle: 'cuekeeper-demo' },
      target: { kind: 'element', role: 'AXTextField' },
    }, app => app),
    '双击 · AXTextField · 未知目标');
  assert.equal(checkLabel({ kind: 'window_exists', equals: true }), '窗口存在 = 成立');
  assert.equal(checkLabel({
    target: { kind: 'element', role: 'textfield' },
    expect: { property: 'text', equals: 'hello' },
  }), 'textfield · 未知目标 · text = hello');

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
  }), /^可交互 · button · 刷新 · 60 × 30 @ 430, 40$/);
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
