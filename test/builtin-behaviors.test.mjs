import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import {
  builtinBehaviors, builtinBehaviorViews, builtinKeyLabel, builtinStepLabel,
} from '../dist/builtin-behaviors.js';
import { flowV2Check } from '../dist/contracts-v2.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { startWorkbench } from '../dist/workbench.js';

const examplePath = name => new URL(`../examples/${name}.json`, import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-builtin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  await copyFile(examplePath('global-two-apps.flow'), join(directory, 'flow.json'));
  const flow = JSON.parse(await readFile(join(directory, 'flow.json'), 'utf8'));
  return { root, directory, flow };
}

async function server(t, root) {
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'), signal: cancellation.signal,
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
  return { post, library: join(root, 'library') };
}

const edit = (post, session, op) => post('v2/edit', { session: session.id, op });
const stepOf = (flow, id) => flow.steps.find(step => step.id === id);

test('the shipped library has Finder actions and universal shortcuts, all as v2 steps', () => {
  const finder = builtinBehaviors.filter(behavior => behavior.group === 'finder');
  assert.deepEqual(finder.map(behavior => behavior.name), [
    '重命名', '拷贝', '粘贴', '剪切', '删除', '新建文件夹', '全选', '打开选中项', '关闭窗口', '前往文件夹',
  ]);
  assert.deepEqual(builtinBehaviors.filter(behavior => behavior.group === 'universal')
    .map(behavior => behavior.name), ['复制', '粘贴', '撤销', '保存', '全选']);

  // The product wording is what the panel shows, so the shortcuts are proven
  // here rather than by a screenshot.
  const views = builtinBehaviorViews();
  const labels = id => views.find(view => view.id === id).steps.map(step => step.label);
  assert.deepEqual(labels('finder-rename'), ['⌘R', '输入 {name}', 'Return']);
  assert.deepEqual(labels('finder-new-folder'), ['⇧⌘N', '输入 {name}', 'Return']);
  assert.deepEqual(labels('finder-go-to-folder'), ['⇧⌘G', '输入 {path}', 'Return']);
  assert.deepEqual(labels('finder-delete'), ['⌘Delete']);
  assert.deepEqual(labels('finder-cut'), ['⌘X']);
  assert.deepEqual(labels('universal-save'), ['⌘S']);
  assert.deepEqual(views.find(view => view.id === 'finder-rename').parameters.map(parameter => parameter.name),
    ['name']);

  // A built-in is read-only and only produces the step kinds the v2 schema
  // already has: shortcuts, parameterized text and the two system checks.
  assert.ok(views.every(view => view.source === 'builtin' && view.editable === false));
  assert.equal(new Set(views.map(view => view.id)).size, views.length);
  for (const behavior of builtinBehaviors) {
    for (const step of behavior.steps) {
      assert.ok(['key', 'type', 'assert'].includes(step.kind), `${behavior.id} uses ${step.kind}`);
      if (step.kind === 'type') {
        assert.ok(behavior.parameters.some(parameter => parameter.name === step.input),
          `${behavior.id} declares ${step.input}`);
      }
    }
  }
  // Shortcut labels read as the product writes them.
  assert.equal(builtinKeyLabel('n', ['shift', 'meta']), '⇧⌘N');
  assert.equal(builtinStepLabel({ kind: 'type', input: 'path', role: 'textfield' }), '输入 {path}');
});

test('a built-in insert expands into real steps, names runtime inputs, and is one undo', async t => {
  const { root, directory, flow } = await fixture(t);
  const { post, library } = await server(t, root);
  const session = await post('import', { directory });

  // Built-ins are present before anything custom exists, and nothing is
  // written under the library directory for them.
  const initial = await post('state', {});
  assert.deepEqual(initial.library.custom, []);
  assert.equal(initial.library.builtin.length, builtinBehaviors.length);
  await assert.rejects(access(library), { code: 'ENOENT' });

  const anchor = 'type-address';
  const anchorIndex = flow.steps.findIndex(step => step.id === anchor);
  const scope = {
    kind: 'window', app: 'com.apple.Safari', windowTitle: 'Cuekeeper 测试页', windowKey: 'browser',
  };
  const inserted = await post('v2/behavior', {
    session: session.id, behavior: 'finder-rename', scope,
    params: { name: 'fileName' }, afterStepId: anchor,
  });

  const added = inserted.flow.steps.slice(anchorIndex + 1, anchorIndex + 4);
  assert.deepEqual(added.map(step => step.id), ['finder-rename-1', 'finder-rename-2', 'finder-rename-3']);
  // Cmd+R and Return are plain shortcuts: no element locator at all.
  assert.deepEqual(added[0], {
    id: 'finder-rename-1', kind: 'key', scope, key: 'r', modifiers: ['meta'],
  });
  assert.deepEqual(added[1], {
    id: 'finder-rename-2', kind: 'type', scope,
    target: { kind: 'element', role: 'textfield' }, input: 'fileName',
  });
  assert.deepEqual(added[2], { id: 'finder-rename-3', kind: 'key', scope, key: 'return' });

  // The insert declared the runtime input in the flow and only added a diff.
  assert.deepEqual(inserted.flow.inputs, ['address', 'note', 'fileName']);
  assert.deepEqual(inserted.diff.added.map(item => item.id), added.map(step => step.id));
  assert.ok(inserted.diff.flowFields.includes('inputs'));
  assert.equal(inserted.validation.ok, true);
  assert.equal([...flowV2Check.Errors(inserted.flow)].length, 0);
  assert.equal(inserted.canUndo, true);

  // One undo removes the whole behavior; redo brings it back.
  const undone = await post('v2/undo', { session: session.id });
  assert.deepEqual(undone.flow.steps.map(step => step.id), flow.steps.map(step => step.id));
  const redone = await post('v2/redo', { session: session.id });
  assert.deepEqual(redone.flow.steps.slice(anchorIndex + 1, anchorIndex + 4).map(step => step.id),
    ['finder-rename-1', 'finder-rename-2', 'finder-rename-3']);

  // A dry run resolves the inserted steps structurally; the shortcuts carry no
  // target, the text step names the element it types into.
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.status, 'passed');
  assert.equal(dry.entries.length, redone.flow.steps.length);
  assert.deepEqual(dry.entries.slice(anchorIndex + 1, anchorIndex + 4)
    .map(entry => [entry.id, entry.kind, entry.status]),
  [['finder-rename-1', 'key', 'resolved'], ['finder-rename-2', 'type', 'resolved'],
    ['finder-rename-3', 'key', 'resolved']]);

  // The parameter name is editable in the detail dialog, which moves the
  // declared input with it and leaves a saveable flow.
  const renamed = await edit(post, session, {
    kind: 'update', id: 'finder-rename-2', patch: { input: 'title' },
  });
  assert.equal(stepOf(renamed.flow, 'finder-rename-2').input, 'title');
  assert.deepEqual(renamed.flow.inputs, ['address', 'note', 'title']);
  assert.equal(renamed.validation.ok, true);

  const saved = await post('save', { session: session.id }, 201);
  const written = JSON.parse(await readFile(saved.output, 'utf8'));
  assert.doesNotThrow(() => parseFlowV2(written));
  assert.deepEqual(written.steps.find(step => step.id === 'finder-rename-2').target,
    { kind: 'element', role: 'textfield' });
  await assert.rejects(access(library), { code: 'ENOENT' });
});

test('a repeated insert gets fresh step ids and honors a picked text target', async t => {
  const { root, directory, flow } = await fixture(t);
  const { post } = await server(t, root);
  const session = await post('import', { directory });
  const scope = { app: 'com.apple.finder', windowTitle: 'Downloads' };

  const first = await post('v2/behavior', {
    session: session.id, behavior: 'finder-go-to-folder', scope,
  });
  assert.deepEqual(first.flow.steps.slice(-3).map(step => step.id),
    ['finder-go-to-folder-1', 'finder-go-to-folder-2', 'finder-go-to-folder-3']);
  assert.deepEqual(first.flow.inputs, ['address', 'note', 'path']);

  // The same behavior again must not collide with its own first expansion, and
  // the picked text field is what the type step names.
  const second = await post('v2/behavior', {
    session: session.id, behavior: 'finder-go-to-folder', scope,
    target: { kind: 'element', role: 'textfield', name: '前往文件夹', index: 0 },
  });
  assert.deepEqual(second.flow.steps.slice(-3).map(step => step.id),
    ['finder-go-to-folder-2-1', 'finder-go-to-folder-2-2', 'finder-go-to-folder-2-3']);
  const typed = second.flow.steps.at(-2);
  assert.deepEqual(typed.target, { kind: 'element', role: 'textfield', name: '前往文件夹', index: 0 });
  assert.equal(typed.input, 'path');
  // The second expansion reuses the window key the first one bound.
  assert.deepEqual(typed.scope,
    { kind: 'window', app: 'com.apple.finder', windowKey: 'finder', windowTitle: 'Downloads' });
  // Declaring `path` twice still leaves one flow-level declaration.
  assert.deepEqual(second.flow.inputs, ['address', 'note', 'path']);
  assert.equal(second.flow.steps.length, flow.steps.length + 6);
  assert.equal(second.validation.ok, true);

  // One undo removes only the second expansion.
  const undone = await post('v2/undo', { session: session.id });
  assert.equal(undone.flow.steps.length, flow.steps.length + 3);
  assert.ok(stepOf(undone.flow, 'finder-go-to-folder-1'));
  assert.equal(stepOf(undone.flow, 'finder-go-to-folder-2-1'), undefined);
});

test('a built-in insert derives a window key and refuses bad requests without changing the flow', async t => {
  const { root, directory, flow } = await fixture(t);
  const { post } = await server(t, root);
  const session = await post('import', { directory });

  // No key and no matching window: the app gets a key derived from its bundle
  // id, and the default parameter name comes from the behavior itself.
  const newFolder = await post('v2/behavior', {
    session: session.id, behavior: 'finder-new-folder',
    scope: { app: 'com.apple.finder', windowTitle: 'Downloads' },
  });
  const appended = newFolder.flow.steps.slice(-3);
  assert.deepEqual(appended.map(step => step.id),
    ['finder-new-folder-1', 'finder-new-folder-2', 'finder-new-folder-3']);
  assert.deepEqual(appended[0].scope,
    { kind: 'window', app: 'com.apple.finder', windowKey: 'finder', windowTitle: 'Downloads' });
  assert.equal(appended[0].key, 'n');
  assert.deepEqual(appended[0].modifiers, ['meta', 'shift']);
  assert.equal(appended[1].input, 'name');
  assert.deepEqual(newFolder.flow.inputs, ['address', 'note', 'name']);

  const before = JSON.stringify(newFolder.flow);
  const refusals = [
    [{ behavior: 'finder-eject' }, 'UNKNOWN_BEHAVIOR'],
    [{ behavior: 'finder-rename', scope: { app: 'com.apple.finder', windowTitle: 'Downloads', windowKey: 'browser' } },
      'WINDOW_KEY_CONFLICT'],
    [{ behavior: 'finder-rename', scope: { app: 'not-a-bundle', windowTitle: 'Downloads' } }, 'INVALID_APP'],
    [{ behavior: 'finder-rename', scope: { app: 'com.apple.finder', windowTitle: '' } }, 'INVALID_WINDOW_TITLE'],
    [{ behavior: 'finder-rename', scope: { app: 'com.apple.finder', windowTitle: 'Downloads' },
      params: { name: '1bad' } }, 'INVALID_INPUT_NAME'],
    [{ behavior: 'finder-rename', scope: { app: 'com.apple.finder', windowTitle: 'Downloads' },
      afterStepId: 'missing-step' }, 'UNKNOWN_STEP'],
    [{ behavior: 'finder-rename', scope: { app: 'com.apple.finder', windowTitle: 'Downloads' },
      target: { kind: 'element', role: 'textfield', path: [] } }, 'INVALID_TARGET'],
  ];
  for (const [payload, code] of refusals) {
    const refused = await post('v2/behavior', { session: session.id, ...payload }, 400);
    assert.equal(refused.code, code, JSON.stringify(refused));
  }
  // Every refusal rolled back; the flow is exactly what the last insert left.
  const state = await post('state', {});
  assert.equal(JSON.stringify(state.session.v2.flow), before);
  assert.equal(state.session.v2.validation.ok, true);
  // The flow still has the original step count plus the one inserted behavior.
  assert.equal(state.session.v2.flow.steps.length, flow.steps.length + 3);
});

test('the library ships two system checks that expand into real assert steps', async t => {
  const views = builtinBehaviorViews().filter(view => view.group === 'check');
  assert.deepEqual(views.map(view => [view.name, view.check, view.appLabel]), [
    ['检查文件是否存在', 'file_exists', '系统'],
    ['检查进程是否运行', 'process_running', '系统'],
  ]);
  // A system card belongs to no app and expands to exactly one assert step.
  assert.equal(views[0].app, undefined);
  assert.deepEqual(views[0].steps.map(step => step.kind), ['assert']);
  assert.equal(builtinStepLabel({ kind: 'assert', check: 'process_running' }), '检查进程运行');

  const { root, directory, flow } = await fixture(t);
  const { post } = await server(t, root);
  const session = await post('import', { directory });
  const anchor = 'type-address';
  const anchorIndex = flow.steps.findIndex(step => step.id === anchor);

  // A file check inserted after a step keeps the declared expectation and its
  // absolute path; it carries no window or app scope.
  const inserted = await post('v2/behavior', {
    session: session.id, behavior: 'check-file-exists',
    path: '/Users/qa/Downloads/report.pdf', equals: false, afterStepId: anchor,
  });
  assert.deepEqual(inserted.flow.steps[anchorIndex + 1], {
    id: 'check-file-exists-1', kind: 'assert',
    scope: { kind: 'file', path: '/Users/qa/Downloads/report.pdf' },
    check: { kind: 'file_exists', equals: false },
  });
  assert.equal(inserted.validation.ok, true);
  assert.equal([...flowV2Check.Errors(inserted.flow)].length, 0);

  // A process check appended at the end matches by executable name; a second
  // one matches a full path that contains spaces.
  const byName = await post('v2/behavior', {
    session: session.id, behavior: 'check-process-running', match: 'name', name: 'Google Chrome', equals: true,
  });
  assert.deepEqual(byName.flow.steps.at(-1), {
    id: 'check-process-running-1', kind: 'assert',
    scope: { kind: 'process', name: 'Google Chrome' },
    check: { kind: 'process_running', equals: true },
  });
  const byPath = await post('v2/behavior', {
    session: session.id, behavior: 'check-process-running', match: 'path',
    path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', equals: false,
  });
  assert.deepEqual(byPath.flow.steps.at(-1), {
    id: 'check-process-running-2-1', kind: 'assert',
    scope: { kind: 'process', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    check: { kind: 'process_running', equals: false },
  });
  assert.equal(byPath.validation.ok, true);

  // Saving writes a revision that reopens with the same values, and a dry run
  // resolves the checks structurally without starting a desktop.
  const saved = await post('save', { session: session.id }, 201);
  const written = JSON.parse(await readFile(saved.output, 'utf8'));
  assert.doesNotThrow(() => parseFlowV2(written));
  assert.deepEqual(written.steps.find(step => step.id === 'check-file-exists-1'), {
    id: 'check-file-exists-1', kind: 'assert',
    scope: { kind: 'file', path: '/Users/qa/Downloads/report.pdf' },
    check: { kind: 'file_exists', equals: false },
  });
  assert.deepEqual(written.steps.find(step => step.id === 'check-process-running-2-1').scope,
    { kind: 'process', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const dry = await post('run', { session: session.id, mode: 'dry-run' });
  assert.equal(dry.status, 'passed');
  assert.deepEqual(dry.entries.slice(-2).map(entry => [entry.id, entry.status]),
    [['check-process-running-1', 'resolved'], ['check-process-running-2-1', 'resolved']]);

  // Bad inputs are refused without changing the flow.
  const settled = byPath.flow.steps.map(step => step.id);
  for (const [payload, code] of [
    [{ behavior: 'check-file-exists', path: 'relative/report.pdf' }, 'INVALID_PATH'],
    [{ behavior: 'check-file-exists', path: '/tmp/../etc/passwd' }, 'INVALID_PATH'],
    [{ behavior: 'check-file-exists', path: '/tmp/report.pdf', equals: 'yes' }, 'INVALID_EXPECTED'],
    [{ behavior: 'check-file-exists' }, 'INVALID_PATH'],
    [{ behavior: 'check-process-running', match: 'path', path: 'relative/Safari' }, 'INVALID_PATH'],
    [{ behavior: 'check-process-running', match: 'name', name: 'Safari/Contents/MacOS/Safari' }, 'INVALID_PROCESS_NAME'],
    [{ behavior: 'check-process-running', match: 'pid', name: 'Safari' }, 'INVALID_PROCESS_MATCH'],
    [{ behavior: 'check-process-running', match: 'name' }, 'INVALID_PROCESS_NAME'],
    [{ behavior: 'check-file-exists', path: '/tmp/report.pdf', afterStepId: 'missing-step' }, 'UNKNOWN_STEP'],
  ]) {
    const refused = await post('v2/behavior', { session: session.id, ...payload }, 400);
    assert.equal(refused.code, code, JSON.stringify(refused));
  }
  const state = await post('state', {});
  assert.deepEqual(state.session.v2.flow.steps.map(step => step.id), settled);
});
