import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { parseSnapshot, resolve } from '../dist/locator.js';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// Hover, click and scroll each address one control. Hover keeps a one-line
// summary, the pick entry and its dwell; click and scroll keep the summary, the
// pick entry and the three fields that repair a locator (role / name / index).
// These tests drive the real `app.js` through the DOM stand-in and read back the
// flow the server actually holds.

const canvasScope = {
  kind: 'window', app: 'com.apple.Safari', windowKey: 'canvas', windowTitle: 'Cuekeeper 画布',
};
const hoverTarget = {
  kind: 'element', role: 'group', name: '',
  path: ['window', 'webarea', 'group', 'group', 'group', 'group', 'group', 'group'], index: 3,
};
// A name macOS can report with a line break; a single-line input cannot show
// it, but the flow must keep it as long as the operator does not edit it.
const multilineTarget = {
  kind: 'element', role: 'button', name: '保存\n副标题',
  path: ['window', 'toolbar', 'button'], identifier: 'save-button',
};
// Two toolbar "保存" controls next to a sidebar one: the recorded index 1 only
// means the toolbar second while the recorded path still narrows the match.
// The same window holds a named + two unnamed toolbar buttons (the empty name
// is itself a constraint), and sibling 关闭/取消 controls for name edits.
const dupTarget = {
  kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 1,
};
const unnamedTarget = {
  kind: 'element', role: 'button', name: '', path: ['window', 'toolbar', 'button'], index: 1,
};
const dupSnapshot = parseSnapshot({
  complete: true,
  window: { id: 'w-dup', title: 'Cuekeeper 画布' },
  tree: {
    role: 'window', name: 'Cuekeeper 画布',
    children: [
      {
        role: 'group',
        children: [
          { role: 'button', name: '保存', ref_id: '@fake:e1' },
          { role: 'button', name: '关闭', ref_id: '@fake:e4' },
          { role: 'button', name: '取消', ref_id: '@fake:e6' },
          { role: 'textfield', name: '查询', ref_id: '@fake:e9' },
          { role: 'textfield', ref_id: '@fake:e10' },
        ],
      },
      {
        role: 'toolbar',
        children: [
          { role: 'button', name: '保存', ref_id: '@fake:e2' },
          { role: 'button', name: '保存', ref_id: '@fake:e3' },
          { role: 'button', name: '关闭', ref_id: '@fake:e5' },
          { role: 'button', ref_id: '@fake:e7' },
          { role: 'button', ref_id: '@fake:e8' },
        ],
      },
    ],
  },
}, { app: 'com.apple.Safari', window: 'Cuekeeper 画布' });

/** A picked control with a rectangle, and one the snapshot could not place. */
const candidates = [
  {
    ref: '@fake:e1', interactive: true, role: 'button',
    locator: { kind: 'element', role: 'button', name: '刷新', path: ['window', 'toolbar', 'button'] },
    path: ['window', 'toolbar', 'button'],
    bounds: { x: 430, y: 40, width: 60, height: 30 }, point: [460, 55],
  },
  {
    ref: '@fake:e2', interactive: true, role: 'textfield',
    locator: { kind: 'element', role: 'textfield', name: '画布输入' },
    path: ['window', 'textfield'], bounds: { x: 20, y: 300, width: 300, height: 24 }, point: [170, 312],
  },
  {
    ref: '@fake:e3', interactive: false, role: 'group',
    locator: { kind: 'element', role: 'group', name: '', path: ['window', 'webarea', 'group'] },
    path: ['window', 'webarea', 'group'],
  },
  {
    // A repeated control: the picker's locator carries a non-empty index.
    ref: '@fake:e4', interactive: true, role: 'button',
    locator: { kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 1 },
    path: ['window', 'toolbar', 'button'],
    bounds: { x: 470, y: 40, width: 60, height: 30 }, point: [500, 55],
  },
];

async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'target-dialog';
  flow.name = '目标编辑弹窗夹具';
  flow.steps.splice(3, 0,
    { id: 'hover-group', kind: 'hover', scope: canvasScope, target: hoverTarget, durationMs: 405 },
    { id: 'click-point', kind: 'click', scope: canvasScope, target: { kind: 'point', point: [120, 80] } },
    {
      id: 'click-element', kind: 'click', scope: canvasScope,
      target: { kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 1 },
    },
    { id: 'click-multiline', kind: 'click', scope: canvasScope, target: multilineTarget },
    { id: 'click-dup', kind: 'click', scope: canvasScope, target: dupTarget },
    { id: 'click-unnamed', kind: 'click', scope: canvasScope, target: unnamedTarget },
    {
      id: 'scroll-group', kind: 'scroll', scope: canvasScope,
      target: { kind: 'element', role: 'group' }, deltaX: 0, deltaY: 300, durationMs: 120,
    });
  const errors = [...flowV2Check.Errors(flow)];
  assert.deepEqual(errors, [], 'the fixture is a valid version 2 flow');
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return { directory };
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-target-dialog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { directory } = await recording(root);
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'),
    allowLive: false, allowShell: false, signal: cancellation.signal,
    // The dialog's pick goes through `v2/pick`; only the live window read is
    // stubbed, and it never touches the desktop.
    pickWindow: scope => Promise.resolve({ windowId: 'w-7', windowTitle: scope.windowTitle, candidates }),
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, {
      ...init, headers: { ...(init.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();
  await import(`../workbench/app.js?page=${nextPage()}`);
  await new Promise(resolve => setTimeout(resolve, 30));

  const state = async () => {
    const response = await realFetch(`${started.url}/api/state`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: '{}',
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.session;
  };
  const stepOf = async id => (await state()).v2.flow.steps.find(step => step.id === id);

  return { document, state, stepOf };
}

const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
let page = 0;
const nextPage = () => (page += 1);

const dialog = document => document.getElementById('dialog');
const pickerDialog = document => document.getElementById('v2-pick-dialog');
const v2Rows = document => document.querySelector('.v2-rows').children
  .filter(node => node.classList.contains('v2-row'));
const rowOf = (document, stepId) => v2Rows(document)
  .find(row => row.querySelector('.step-id')?.textContent === stepId);
const buttonByText = (node, text) => node.querySelectorAll('button').find(candidate =>
  [candidate.textContent.trim(), candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
    .includes(text));
const submitModal = async modal => {
  const form = modal.children.find(node => node.tagName === 'FORM');
  await form.onsubmit({ preventDefault() {} });
  await tick();
};
const submitDialog = document => submitModal(dialog(document));
const submitPicker = document => submitModal(pickerDialog(document));
const durationInput = node => node.querySelectorAll('input')
  .find(input => input.getAttribute('type') === 'number');
/** The three editable locator fields, in the order the dialog shows them. */
const locatorInputs = node => {
  const inputs = node.querySelectorAll('input');
  return {
    role: inputs.find(item => item.getAttribute('placeholder') === '例如 button'),
    name: inputs.find(item => item.getAttribute('placeholder') === '例如 保存'),
    index: inputs.find(item => item.getAttribute('type') === 'number'),
  };
};

async function openEditor(document, stepId) {
  buttonByText(rowOf(document, stepId), '编辑').click();
  assert.equal(dialog(document).open, true);
  return dialog(document);
}

/** Pick candidate `index` from the stubbed read-only snapshot. */
async function pickCandidate(document, editor, index) {
  buttonByText(editor, '从窗口拾取').click();
  await tick();
  assert.equal(pickerDialog(document).open, true);
  pickerDialog(document).querySelectorAll('select')[0].value = String(index);
  await submitPicker(document);
  assert.equal(pickerDialog(document).open, false);
}

test('点击与滚动弹窗只留摘要、拾取与 role / name / index 三个字段', async t => {
  const { document } = await bootPage(t);
  const cases = [
    ['click-element', '编辑点击目标', 'button（保存）· Cuekeeper 画布'],
    ['click-point', '编辑点击目标', '屏幕坐标 (120, 80)· Cuekeeper 画布'],
    ['scroll-group', '编辑滚动目标', 'group（无名称）· Cuekeeper 画布'],
  ];
  for (const [stepId, title, summary] of cases) {
    const editor = await openEditor(document, stepId);
    assert.match(editor.textContent, new RegExp(`${title} · ${stepId}`));
    assert.ok(editor.textContent.includes(summary), `${stepId} shows one summary line`);
    assert.ok(buttonByText(editor, '从窗口拾取'), `${stepId} keeps the pick entry`);

    // Exactly the three fields an everyday repair needs — nothing from the old
    // locator form (path, exact-name flag, 高级定位, preview, snapshot dropdown).
    const inputs = editor.querySelectorAll('input');
    assert.equal(inputs.length, 3, `${stepId} has exactly role / name / index`);
    const locator = locatorInputs(editor);
    assert.ok(locator.role && locator.name && locator.index, `${stepId} names all three fields`);
    assert.match(editor.textContent, /控件类型（role）/);
    assert.match(editor.textContent, /控件名称（name）/);
    assert.match(editor.textContent, /同名控件序号（index/);
    assert.equal(editor.querySelectorAll('details').length, 0, `${stepId} has no advanced block`);
    assert.doesNotMatch(editor.textContent, /高级定位/);
    assert.doesNotMatch(editor.textContent, /按这些值回放会找/);
    assert.doesNotMatch(editor.textContent, /要求名称完全一致/);
    assert.doesNotMatch(editor.textContent, /层级路径/);
    assert.doesNotMatch(editor.textContent, /toolbar/, `${stepId} never prints the recorded path`);
    assert.equal(editor.querySelectorAll('select').length, 0, `${stepId} has no snapshot dropdown`);
    assert.equal(editor.querySelectorAll('textarea').length, 0);

    buttonByText(editor, '关闭').click();
    assert.equal(dialog(document).open, false);
  }
});

test('打开点击对象时三个字段按当前 target 回填', async t => {
  const { document } = await bootPage(t);

  const element = locatorInputs(await openEditor(document, 'click-element'));
  assert.equal(element.role.value, 'button');
  assert.equal(element.name.value, '保存');
  assert.equal(element.index.value, '1');
  buttonByText(dialog(document), '关闭').click();

  const group = locatorInputs(await openEditor(document, 'scroll-group'));
  assert.equal(group.role.value, 'group');
  assert.equal(group.name.value, '', 'a control without a name leaves the field empty');
  assert.equal(group.index.value, '', 'no recorded index leaves the field empty');
  buttonByText(dialog(document), '关闭').click();

  const point = locatorInputs(await openEditor(document, 'click-point'));
  assert.equal(point.role.value, '', 'a coordinate target has no role to show');
  assert.equal(point.name.value, '');
  assert.equal(point.index.value, '');
});

test('拾取候选后 role / name / index 同步更新', async t => {
  const { document } = await bootPage(t);
  const editor = await openEditor(document, 'click-point');

  await pickCandidate(document, editor, 1);
  const textfield = locatorInputs(editor);
  assert.equal(textfield.role.value, 'textfield');
  assert.equal(textfield.name.value, '画布输入');
  assert.equal(textfield.index.value, '');
  assert.ok(editor.textContent.includes('textfield（画布输入）· Cuekeeper 画布'));

  // A repeated control's picker locator carries a non-empty index; all three
  // fields follow it.
  await pickCandidate(document, editor, 3);
  const repeated = locatorInputs(editor);
  assert.equal(repeated.role.value, 'button');
  assert.equal(repeated.name.value, '保存');
  assert.equal(repeated.index.value, '1');

  // A control the snapshot reports without a name clears the field again.
  await pickCandidate(document, editor, 2);
  const group = locatorInputs(editor);
  assert.equal(group.role.value, 'group');
  assert.equal(group.name.value, '');
  assert.equal(group.index.value, '');
});

test('改 role / name / index 后应用，写回的定位器与输入一致', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-element');

  const fields = locatorInputs(editor);
  fields.role.value = 'button';
  fields.name.value = '关闭';
  fields.index.value = '2';
  await submitDialog(document);

  assert.equal(dialog(document).open, false);
  assert.deepEqual((await stepOf('click-element')).target,
    { kind: 'element', role: 'button', name: '关闭', index: 2 },
    'the edited name names a new control, so the old toolbar path is gone');
});

test('清空 name 与 index 后应用，名称与序号不再收窄匹配', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-element');

  const fields = locatorInputs(editor);
  fields.name.value = '';
  fields.index.value = '';
  await submitDialog(document);

  assert.deepEqual((await stepOf('click-element')).target, { kind: 'element', role: 'button' },
    'an empty name or index means "not restricted", not an empty string');
});

test('原样应用不丢掉 target 里隐藏的 path', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-element');

  await submitDialog(document);
  assert.deepEqual((await stepOf('click-element')).target,
    { kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 1 },
    'opening and applying the untouched form changes nothing');
});

test('名称含换行时打开即应用不改写原名称、path 与 identifier', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-multiline');
  // The browser stores a single-line input without the line break.
  assert.equal(locatorInputs(editor).name.value, '保存副标题');

  await submitDialog(document);
  assert.deepEqual((await stepOf('click-multiline')).target, multilineTarget,
    'the location the operator never edited is kept verbatim');
});

test('拾取后直接应用写回完整拾取定位器，不掺入旧目标的字段', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-multiline');

  await pickCandidate(document, editor, 3);
  const fields = locatorInputs(editor);
  assert.equal(fields.name.value, '保存');
  assert.equal(fields.index.value, '1');

  await submitDialog(document);
  assert.deepEqual((await stepOf('click-multiline')).target, candidates[3].locator,
    'the picked locator replaces the old name/path/identifier wholesale');
});

test('只改序号时保留原匹配范围，序号仍落在同一个控件上', async t => {
  const { document, stepOf } = await bootPage(t);
  // Without the recorded path the same index 0 addresses the sidebar control.
  assert.equal(resolve(dupSnapshot, { kind: 'element', role: 'button', name: '保存', index: 0 }).node.ref,
    '@fake:e1');

  const editor = await openEditor(document, 'click-dup');
  const fields = locatorInputs(editor);
  assert.equal(fields.index.value, '1');
  fields.index.value = '0';
  await submitDialog(document);

  const target = (await stepOf('click-dup')).target;
  assert.deepEqual(target, {
    kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 0,
  });
  assert.equal(resolve(dupSnapshot, target).node.ref, '@fake:e2',
    'the toolbar control, not the sidebar one the path-less locator would take');
});

test('无名控件只改序号时保留「没有名称」这一约束', async t => {
  const { document, stepOf } = await bootPage(t);
  // An empty name matches unnamed controls only; dropping it would make the
  // same index select the named button that happens to come first.
  assert.equal(resolve(dupSnapshot, unnamedTarget).node.ref, '@fake:e8');
  assert.equal(resolve(dupSnapshot,
    { kind: 'element', role: 'button', path: ['window', 'toolbar', 'button'], index: 0 }).node.ref,
  '@fake:e2');

  const editor = await openEditor(document, 'click-unnamed');
  assert.equal(locatorInputs(editor).name.value, '');
  locatorInputs(editor).index.value = '0';
  await submitDialog(document);

  const target = (await stepOf('click-unnamed')).target;
  assert.equal(target.name, '', 'the untouched empty name stays an exact constraint');
  assert.deepEqual(target.path, ['window', 'toolbar', 'button'], 'an index-only edit keeps the range');
  assert.equal(target.index, 0);
  assert.equal(resolve(dupSnapshot, target).node.ref, '@fake:e7',
    'the first unnamed toolbar button, not the named one');
});

test('范围改变后删掉再输入同一个序号可以提交', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-dup');
  const fields = locatorInputs(editor);

  fields.name.value = '关闭';
  fields.index.value = '';
  fields.index.oninput?.({});
  fields.index.value = '1';
  fields.index.oninput?.({});
  await submitDialog(document);

  assert.equal(dialog(document).open, false, 'retyping the same number counts as re-specifying it');
  const target = (await stepOf('click-dup')).target;
  assert.deepEqual(target, { kind: 'element', role: 'button', name: '关闭', index: 1 });
  assert.equal(resolve(dupSnapshot, target).node.ref, '@fake:e5', 'the toolbar 关闭, second of two');
});

test('手填新名称时丢掉旧路径，按新名称解析到侧栏控件', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-dup');
  const fields = locatorInputs(editor);

  fields.name.value = '取消';
  fields.index.value = '';
  await submitDialog(document);

  const target = (await stepOf('click-dup')).target;
  assert.deepEqual(target, { kind: 'element', role: 'button', name: '取消' });
  assert.equal(resolve(dupSnapshot, target).node.ref, '@fake:e6', 'the sidebar 取消 control');
  // The recorded toolbar path could never match that sidebar control.
  assert.throws(() => resolve(dupSnapshot, { ...target, path: ['window', 'toolbar', 'button'] }),
    /did not match/);
});

test('改角色重建范围时，空名称不再表示「只匹配无名控件」', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-unnamed');
  const fields = locatorInputs(editor);

  fields.role.value = 'textfield';
  // Retyping the recorded position is the operator pointing inside the new
  // range; keeping the old number would be refused.
  fields.index.value = '';
  fields.index.oninput?.({});
  fields.index.value = '0';
  fields.index.oninput?.({});
  await submitDialog(document);

  const target = (await stepOf('click-unnamed')).target;
  assert.deepEqual(target, { kind: 'element', role: 'textfield', index: 0 },
    'a blank name on a rebuilt range means "no name restriction"');
  assert.equal(resolve(dupSnapshot, target).node.ref, '@fake:e9', 'the named 查询 textfield, first in order');
  // Keeping the recorded empty-name constraint would land on the unnamed field.
  assert.equal(resolve(dupSnapshot, { ...target, name: '' }).node.ref, '@fake:e10');
});

test('换了控件类型或名称但序号没重填时拒绝应用', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-dup');
  const fields = locatorInputs(editor);

  fields.name.value = '关闭';
  await submitDialog(document);
  assert.equal(editor.open, true, 'a new name and the old index is refused');
  assert.match(editor.textContent, /原来的同名序号不再指向同一个控件/);
  assert.deepEqual((await stepOf('click-dup')).target, dupTarget, 'nothing was saved');

  fields.name.value = '保存';
  fields.role.value = 'menuitem';
  await submitDialog(document);
  assert.equal(editor.open, true, 'a new role and the old index is refused too');
  assert.deepEqual((await stepOf('click-dup')).target, dupTarget, 'still nothing saved');

  // Clearing the index is the explicit "no position" answer; the new role also
  // drops the recorded path, which was tied to the old role chain.
  fields.index.value = '';
  await submitDialog(document);
  assert.deepEqual((await stepOf('click-dup')).target, { kind: 'element', role: 'menuitem', name: '保存' });
});

test('坐标目标不填字段时保持坐标，填 role 后变元素定位器', async t => {
  const { document, stepOf } = await bootPage(t);
  let editor = await openEditor(document, 'click-point');

  await submitDialog(document);
  assert.deepEqual((await stepOf('click-point')).target, { kind: 'point', point: [120, 80] },
    'an untouched coordinate target stays a coordinate');

  editor = await openEditor(document, 'click-point');
  const fields = locatorInputs(editor);
  fields.role.value = 'button';
  fields.name.value = '确定';
  fields.index.value = '1';
  await submitDialog(document);
  assert.deepEqual((await stepOf('click-point')).target,
    { kind: 'element', role: 'button', name: '确定', index: 1 },
    'a filled role turns the coordinate into an element locator');
});

test('只填名称不填 role 时应用被拒，且不落盘', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-point');

  locatorInputs(editor).name.value = '确定';
  await submitDialog(document);
  assert.equal(editor.open, true, 'the refused apply keeps the editor open');
  assert.match(editor.textContent, /填写控件类型（role）/);
  assert.deepEqual((await stepOf('click-point')).target, { kind: 'point', point: [120, 80] });
});

test('index 不是非负整数时应用被拒，且不落盘', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-element');

  locatorInputs(editor).index.value = '-1';
  await submitDialog(document);
  assert.equal(editor.open, true);
  assert.match(editor.textContent, /同名控件序号（index）填 0 或更大的整数/);
  assert.deepEqual((await stepOf('click-element')).target,
    { kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 1 });
});

test('坐标点击显示屏幕坐标，拾取后变元素定位器；不应用不落盘', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'click-point');
  assert.ok(editor.textContent.includes('屏幕坐标 (120, 80)· Cuekeeper 画布'));

  await pickCandidate(document, editor, 1);
  assert.equal(editor.open, true, 'the editor stays open behind the picker');
  assert.ok(editor.textContent.includes('textfield（画布输入）· Cuekeeper 画布'),
    'the summary names the picked control');
  assert.deepEqual((await stepOf('click-point')).target, { kind: 'point', point: [120, 80] },
    'a pick alone does not write the step');

  // Closing the editor discards the pick.
  buttonByText(editor, '关闭').click();
  assert.deepEqual((await stepOf('click-point')).target, { kind: 'point', point: [120, 80] });

  const reopened = await openEditor(document, 'click-point');
  await pickCandidate(document, reopened, 1);
  await submitDialog(document);
  assert.equal(dialog(document).open, false);
  assert.deepEqual((await stepOf('click-point')).target, candidates[1].locator,
    'the coordinate target became the picked element');
});

test('滚动目标应用写回拾取的控件，滚动方向与数值不动', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'scroll-group');
  assert.ok(editor.textContent.includes('group（无名称）· Cuekeeper 画布'));

  await pickCandidate(document, editor, 0);
  assert.ok(editor.textContent.includes('button（刷新）· Cuekeeper 画布 · 60 × 30'),
    'a picked rectangle is shown with its size');
  assert.equal((await stepOf('scroll-group')).target.role, 'group', 'nothing is written before 应用');

  await submitDialog(document);
  const step = await stepOf('scroll-group');
  assert.deepEqual(step.target, candidates[0].locator);
  assert.equal(step.deltaY, 300, 'the scroll amount lives outside this dialog');
});

test('悬停弹窗只有目标摘要、拾取入口与悬停时长', async t => {
  const { document } = await bootPage(t);
  const editor = await openEditor(document, 'hover-group');

  assert.ok(editor.textContent.includes('group（无名称）· Cuekeeper 画布'));
  assert.match(editor.textContent, /悬停时长（毫秒）/);
  const duration = durationInput(editor);
  assert.ok(duration, 'the dwell is editable');
  assert.equal(duration.value, '405', 'the recorded dwell is the default');
  assert.deepEqual(editor.querySelectorAll('input').map(input => input.getAttribute('placeholder')), [null],
    'the dwell is the only input on the form');
});

test('改悬停时长后应用，写回 durationMs 且目标不变', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'hover-group');

  durationInput(editor).value = '650';
  await submitDialog(document);

  assert.equal(dialog(document).open, false, 'applying closes the editor');
  const step = await stepOf('hover-group');
  assert.equal(step.durationMs, 650);
  assert.deepEqual(step.target, hoverTarget, 'a dwell edit never rewrites the locator');
});

test('悬停拾取后摘要带尺寸，应用时目标与时长一起写回', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'hover-group');

  await pickCandidate(document, editor, 0);
  assert.ok(editor.textContent.includes('button（刷新）· Cuekeeper 画布 · 60 × 30'));
  assert.deepEqual((await stepOf('hover-group')).target, hoverTarget,
    'a confirmed pick alone does not write the step');

  durationInput(editor).value = '700';
  await submitDialog(document);
  const step = await stepOf('hover-group');
  assert.deepEqual(step.target, candidates[0].locator);
  assert.equal(step.durationMs, 700);
  assert.equal(step.target.index, undefined, 'a stale recorded index is not inherited');
});

test('悬停拾取到没有 bounds 的控件时报 HOVER_UNRESOLVED，且不落盘', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'hover-group');

  await pickCandidate(document, editor, 2);
  assert.ok(editor.textContent.includes('group（无名称）· Cuekeeper 画布'));
  assert.match(editor.textContent, /HOVER_UNRESOLVED/,
    'a control the snapshot cannot place is named as the replay error it becomes');
  assert.doesNotMatch(editor.textContent, /· \d+ × \d+/, 'no invented size');

  durationInput(editor).value = '900';
  await submitDialog(document);
  assert.equal(editor.open, true, 'the refused apply keeps the editor open');
  assert.match(editor.textContent, /HOVER_UNRESOLVED/, 'the form error explains the refusal');

  const step = await stepOf('hover-group');
  assert.deepEqual(step.target, hoverTarget, 'nothing was saved');
  assert.equal(step.durationMs, 405, 'the dwell was not saved either');
});

test('悬停时长越界或留空时不写回', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openEditor(document, 'hover-group');

  for (const bad of ['', '70000', '-5', '12.5']) {
    durationInput(editor).value = bad;
    await submitDialog(document);
    assert.equal(editor.open, true, `"${bad}" is refused`);
    assert.match(editor.textContent, /悬停时长填 0–60000 之间的整数毫秒/);
  }
  assert.equal((await stepOf('hover-group')).durationMs, 405);
});
