import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// Hover, click and scroll each address one control, so their editors keep only
// a one-line target summary and the pick entry (hover adds its dwell). These
// tests drive the real `app.js` through the DOM stand-in and read back the flow
// the server actually holds.

const canvasScope = {
  kind: 'window', app: 'com.apple.Safari', windowKey: 'canvas', windowTitle: 'Cuekeeper 画布',
};
const hoverTarget = {
  kind: 'element', role: 'group', name: '',
  path: ['window', 'webarea', 'group', 'group', 'group', 'group', 'group', 'group'], index: 3,
};

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

test('点击、滚动、悬停的目标弹窗都只留摘要与拾取入口', async t => {
  const { document } = await bootPage(t);
  const cases = [
    ['click-element', '编辑点击目标', 'button（保存）· Cuekeeper 画布', 0],
    ['click-point', '编辑点击目标', '屏幕坐标 (120, 80)· Cuekeeper 画布', 0],
    ['scroll-group', '编辑滚动目标', 'group（无名称）· Cuekeeper 画布', 0],
    ['hover-group', '编辑悬停目标', 'group（无名称）· Cuekeeper 画布', 1],
  ];
  for (const [stepId, title, summary, inputs] of cases) {
    const editor = await openEditor(document, stepId);
    assert.match(editor.textContent, new RegExp(`${title} · ${stepId}`));
    assert.ok(editor.textContent.includes(summary), `${stepId} shows one summary line`);
    assert.ok(buttonByText(editor, '从窗口拾取'), `${stepId} keeps the pick entry`);

    // No locator form survives: no role/name/path/index field, no preview, no
    // 「高级定位」 block, no candidate dropdown.
    assert.equal(editor.querySelectorAll('details').length, 0, `${stepId} has no advanced block`);
    assert.doesNotMatch(editor.textContent, /高级定位/);
    assert.doesNotMatch(editor.textContent, /按这些值回放会找/);
    assert.doesNotMatch(editor.textContent, /要求名称完全一致/);
    assert.doesNotMatch(editor.textContent, /toolbar/, `${stepId} never prints the recorded path`);
    assert.equal(editor.querySelectorAll('select').length, 0, `${stepId} has no snapshot dropdown`);
    assert.equal(editor.querySelectorAll('textarea').length, 0);
    assert.deepEqual(editor.querySelectorAll('input').map(input => input.getAttribute('placeholder')),
      Array(inputs).fill(null), `${stepId} keeps only its own inputs`);
    if (inputs === 1) assert.ok(durationInput(editor), 'hover keeps its dwell input');

    buttonByText(editor, '关闭').click();
    assert.equal(dialog(document).open, false);
  }
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
