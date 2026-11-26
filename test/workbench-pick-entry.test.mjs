import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// Picking lives in the step editor, not on every timeline row. This file drives
// the real `app.js` through the DOM stand-in: the row buttons and the dialog
// below are the ones the operator clicks.

const canvasScope = {
  kind: 'window', app: 'com.apple.Safari', windowKey: 'canvas', windowTitle: 'Cuekeeper 画布',
};

const refreshPath = ['window', 'group / toolbar', 'button'];
const candidates = [
  {
    ref: '@fake:e1', interactive: true, role: 'button',
    locator: { kind: 'element', role: 'button', name: '刷新', path: refreshPath },
    path: refreshPath, bounds: { x: 430, y: 40, width: 60, height: 30 }, point: [460, 55],
  },
  {
    ref: '@fake:e2', interactive: true, role: 'textfield',
    locator: { kind: 'element', role: 'textfield', name: '画布输入' },
    path: ['window', 'textfield'], bounds: { x: 20, y: 300, width: 300, height: 24 }, point: [170, 312],
  },
];

/** A recording with a coordinate click, a scroll, a type and a paste step. */
async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'pick-entry';
  flow.name = '拾取入口夹具';
  flow.steps.splice(3, 0,
    { id: 'click-canvas', kind: 'click', scope: canvasScope, target: { kind: 'point', point: [120, 80] } },
    {
      id: 'scroll-canvas', kind: 'scroll', scope: canvasScope,
      target: { kind: 'element', role: 'group' }, deltaX: 0, deltaY: 300,
    });
  const errors = [...flowV2Check.Errors(flow)];
  assert.deepEqual(errors, [], 'the fixture is a valid version 2 flow');
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return { directory, flow };
}

async function bootPage(t, { deferredPick = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-pick-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { directory } = await recording(root);
  const pickedScopes = [];
  // A deferred pick holds the snapshot response until the test releases it, so
  // the page can be closed or replaced while the request is still in flight.
  const pending = [];
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'),
    allowLive: false, allowShell: false, signal: cancellation.signal,
    // The page's pick goes through the same `v2/pick` route; only the live
    // window read is stubbed, and it records the scope the page asked for.
    pickWindow: scope => {
      pickedScopes.push(scope);
      const result = { windowId: 'w-7', windowTitle: scope.windowTitle, candidates };
      if (!deferredPick) return Promise.resolve(result);
      return new Promise(resolve => pending.push(() => resolve(result)));
    },
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
  // A fresh URL per test re-runs `app.js` against this test's own document
  // instead of reusing the module the previous test already booted.
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

  const releasePick = async (index = 0) => {
    assert.ok(pending[index], `pick request ${index} is waiting`);
    pending[index]();
    await tick();
  };

  return { document, pickedScopes, state, releasePick };
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
const closeModal = modal => buttonByText(modal, '关闭').click();

test('the timeline row keeps edit and move, but no pick button on any step kind', async t => {
  const { document } = await bootPage(t);

  for (const [stepId, kind] of [['click-canvas', 'click'], ['scroll-canvas', 'scroll'],
    ['type-address', 'type'], ['paste-address', 'paste'], ['launch-browser', 'launch_app']]) {
    const row = rowOf(document, stepId);
    assert.ok(row, `${kind} row renders`);
    assert.equal(row.textContent.includes('从窗口拾取'), false,
      `${kind} row must not offer picking`);
    assert.ok(buttonByText(row, '编辑'), `${kind} row still opens its editor`);
    assert.ok(buttonByText(row, '删除步骤'), `${kind} row still keeps the other actions`);
  }
});

test('the click editor picks a control and replaces a coordinate target', async t => {
  const { document, pickedScopes, state } = await bootPage(t);

  buttonByText(rowOf(document, 'click-canvas'), '编辑').click();
  assert.equal(dialog(document).open, true);
  assert.match(dialog(document).textContent, /编辑点击目标 · click-canvas/);
  assert.match(dialog(document).textContent, /屏幕坐标 \(120, 80\)/);

  const entry = buttonByText(dialog(document), '从窗口拾取');
  assert.ok(entry, 'the click editor offers the pick entry');
  entry.click();
  await tick();

  // The picker stacks over the editor; the editor itself stays mounted behind it.
  assert.equal(pickerDialog(document).open, true);
  assert.equal(dialog(document).open, true, 'the step editor is not replaced by the picker');
  assert.match(pickerDialog(document).textContent, /从当前窗口拾取 · Cuekeeper 画布 · click-canvas/);

  // The pick reads the step's own window scope and lists its candidates.
  assert.deepEqual(pickedScopes.map(scope => [scope.app, scope.windowTitle]),
    [['com.apple.Safari', 'Cuekeeper 画布']]);
  assert.match(pickerDialog(document).textContent, /2 个控件/);
  assert.match(pickerDialog(document).textContent, /可交互 · 刷新/);
  assert.match(pickerDialog(document).textContent, /只读快照：不会点击、聚焦或输入/);

  const chooser = pickerDialog(document).querySelectorAll('select')[0];
  chooser.value = '1';
  await submitPicker(document);

  // The pick lands in the editor; the step itself changes only on 应用.
  assert.equal(pickerDialog(document).open, false, 'the picker closed after the pick');
  assert.equal(dialog(document).open, true, 'the step editor stays open behind the picker');
  assert.match(dialog(document).textContent, /textfield（画布输入）· Cuekeeper 画布/);
  assert.equal((await state()).v2.flow.steps.find(item => item.id === 'click-canvas').target.kind, 'point',
    'a confirmed pick does not write the step');

  // Re-opening the picker from this editor still shows what it would replace.
  buttonByText(dialog(document), '从窗口拾取').click();
  await tick();
  assert.match(pickerDialog(document).textContent, /回到编辑框点「应用」才保存/);
  closeModal(pickerDialog(document));

  await submitDialog(document);
  const session = await state();
  const step = session.v2.flow.steps.find(item => item.id === 'click-canvas');
  assert.deepEqual(step.target, { kind: 'element', role: 'textfield', name: '画布输入' },
    'the coordinate target became the picked element');
  assert.match(rowOf(document, 'click-canvas').textContent, /画布输入/);
});

test('the type editor and the read-only facts panel keep their own pick entry', async t => {
  const { document, pickedScopes } = await bootPage(t);

  buttonByText(rowOf(document, 'type-address'), '编辑').click();
  assert.match(dialog(document).textContent, /编辑输入步骤 · type-address/);
  const typeEntry = buttonByText(dialog(document), '从窗口拾取');
  assert.ok(typeEntry, 'the type editor offers the pick entry');
  typeEntry.click();
  await tick();
  assert.match(pickerDialog(document).textContent, /从当前窗口拾取 · Cuekeeper 测试页/);
  assert.match(pickerDialog(document).textContent, /确认后会替换这一步的目标定位器/);
  assert.deepEqual(pickedScopes.map(scope => scope.windowKey), ['browser']);
  closeModal(pickerDialog(document));

  // A paste step has no dedicated editor; its read-only panel still offers the
  // same entry instead of losing the capability the row used to carry.
  closeModal(dialog(document));
  buttonByText(rowOf(document, 'paste-address'), '编辑').click();
  assert.match(dialog(document).textContent, /步骤详情（只读） · paste-address/);
  const pasteEntry = buttonByText(dialog(document), '从窗口拾取');
  assert.ok(pasteEntry, 'the paste panel offers the pick entry');
  pasteEntry.click();
  await tick();
  assert.match(pickerDialog(document).textContent, /从当前窗口拾取 · QA Notes/);
  assert.deepEqual(pickedScopes.map(scope => scope.windowKey), ['browser', 'notes']);
});

test('cancelling the picker keeps the step editor and its unsaved values', async t => {
  const { document, state } = await bootPage(t);

  buttonByText(rowOf(document, 'type-address'), '编辑').click();
  const editor = dialog(document);
  const mode = editor.querySelectorAll('select')[0];
  mode.value = 'text';
  mode.onchange();
  const text = editor.querySelectorAll('textarea')[0];
  text.value = '草稿文本';

  buttonByText(editor, '从窗口拾取').click();
  await tick();
  assert.equal(pickerDialog(document).open, true);
  closeModal(pickerDialog(document));
  assert.equal(pickerDialog(document).open, false);
  assert.equal(editor.open, true, 'the editor is still open after cancelling the pick');
  assert.equal(mode.value, 'text', 'the chosen content source survived the cancelled pick');
  assert.equal(text.value, '草稿文本', 'the typed draft survived the cancelled pick');

  // A confirmed pick writes the locator immediately and still returns to that
  // same form, with the draft intact.
  buttonByText(editor, '从窗口拾取').click();
  await tick();
  const chooser = pickerDialog(document).querySelectorAll('select')[0];
  chooser.value = '0';
  await submitPicker(document);
  assert.deepEqual((await state()).v2.flow.steps.find(item => item.id === 'type-address').target,
    candidates[0].locator);
  assert.equal(editor.open, true);
  assert.equal(mode.value, 'text');
  assert.equal(text.value, '草稿文本');

  await submitDialog(document);
  const step = (await state()).v2.flow.steps.find(item => item.id === 'type-address');
  assert.deepEqual(step.target, candidates[0].locator,
    'applying the editor keeps the exact path returned by the picker');
  assert.equal(step.text, '草稿文本', 'applying the editor writes the preserved draft');
});

test('a scroll target pick is discarded when the editor is closed', async t => {
  const { document, state } = await bootPage(t);
  buttonByText(rowOf(document, 'scroll-canvas'), '编辑').click();
  const editor = dialog(document);
  buttonByText(editor, '从窗口拾取').click();
  await tick();
  pickerDialog(document).querySelector('select').value = '1';
  await submitPicker(document);
  assert.match(editor.textContent, /textfield（画布输入）· Cuekeeper 画布/,
    'the summary shows the control that would replace the target');

  closeModal(editor);
  const step = (await state()).v2.flow.steps.find(item => item.id === 'scroll-canvas');
  assert.deepEqual(step.target, { kind: 'element', role: 'group' }, 'closing the editor writes nothing');
});

test('a snapshot that arrives after the picker closed never reopens it', async t => {
  const { document, state, releasePick } = await bootPage(t, { deferredPick: true });

  buttonByText(rowOf(document, 'click-canvas'), '编辑').click();
  buttonByText(dialog(document), '从窗口拾取').click();
  await tick();
  assert.equal(pickerDialog(document).open, true, 'the picker shows it is reading the window');
  assert.match(pickerDialog(document).textContent, /正在读取/);

  closeModal(pickerDialog(document));
  await releasePick();

  assert.equal(pickerDialog(document).open, false, 'the late snapshot did not reopen the picker');
  assert.equal(pickerDialog(document).querySelectorAll('select').length, 0, 'no candidates were rendered');
  assert.equal(dialog(document).open, true, 'the step editor was never disturbed');
  assert.match(dialog(document).textContent, /屏幕坐标 \(120, 80\)/);
  assert.equal((await state()).v2.flow.steps.find(item => item.id === 'click-canvas').target.kind, 'point');

  // The same holds when the operator moved on to editing another step.
  buttonByText(dialog(document), '从窗口拾取').click();
  await tick();
  closeModal(pickerDialog(document));
  closeModal(dialog(document));
  buttonByText(rowOf(document, 'scroll-canvas'), '编辑').click();
  await releasePick(1);
  assert.equal(pickerDialog(document).open, false);
  assert.match(dialog(document).textContent, /编辑滚动目标 · scroll-canvas/, 'the newer editor is untouched');
});

test('a scroll editor shows what the entry would replace before applying', async t => {
  const { document, state } = await bootPage(t);

  buttonByText(rowOf(document, 'scroll-canvas'), '编辑').click();
  assert.match(dialog(document).textContent, /编辑滚动目标 · scroll-canvas/);
  buttonByText(dialog(document), '从窗口拾取').click();
  await tick();
  assert.match(pickerDialog(document).textContent, /回到编辑框点「应用」才保存/);

  const chooser = pickerDialog(document).querySelectorAll('select')[0];
  chooser.value = '0';
  await submitPicker(document);
  assert.deepEqual((await state()).v2.flow.steps.find(item => item.id === 'scroll-canvas').target,
    { kind: 'element', role: 'group' }, 'the picker alone writes nothing');

  await submitDialog(document);
  const session = await state();
  const step = session.v2.flow.steps.find(item => item.id === 'scroll-canvas');
  assert.deepEqual(step.target, candidates[0].locator);
  assert.match(rowOf(document, 'scroll-canvas').textContent, /滚轮 刷新/);
});
