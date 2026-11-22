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
import {
  assertCheck, checkLabel, diffSummary, filterStepsByScope, scopeKey, scopeOptions, statusMap,
  stepTemplate, v2StepLabel,
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
  assert.equal(checkLabel({ kind: 'window_exists', equals: true }), '窗口存在 = 成立');
  assert.equal(checkLabel({
    target: { kind: 'element', role: 'textfield' },
    expect: { property: 'text', equals: 'hello' },
  }), 'textfield · text = hello');

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
