import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// Hover records a dwell on one control, so its editor keeps only the target
// summary, the pick entry and the dwell. These tests drive the real `app.js`
// through the DOM stand-in and read back the flow the server actually holds.

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
    ref: '@fake:e2', interactive: false, role: 'group',
    locator: { kind: 'element', role: 'group', name: '', path: ['window', 'webarea', 'group'] },
    path: ['window', 'webarea', 'group'],
  },
];

async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'hover-dialog';
  flow.name = '悬停编辑弹窗夹具';
  flow.steps.splice(3, 0,
    {
      id: 'hover-group', kind: 'hover', scope: canvasScope,
      target: hoverTarget, durationMs: 405,
    },
    {
      id: 'click-plain', kind: 'click', scope: canvasScope,
      target: { kind: 'element', role: 'button', name: '保存' },
    });
  const errors = [...flowV2Check.Errors(flow)];
  assert.deepEqual(errors, [], 'the fixture is a valid version 2 flow');
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return { directory };
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-hover-dialog-'));
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
const appLabelOf = async state => {
  const session = await state();
  return session.apps['com.apple.Safari']?.label ?? 'com.apple.Safari';
};

async function openHoverEditor(document, stepId = 'hover-group') {
  buttonByText(rowOf(document, stepId), '编辑').click();
  assert.equal(dialog(document).open, true);
  return dialog(document);
}

test('悬停弹窗只有目标摘要、拾取入口与悬停时长', async t => {
  const { document, state } = await bootPage(t);
  const app = await appLabelOf(state);
  const editor = await openHoverEditor(document);

  assert.match(editor.textContent, /编辑悬停目标 · hover-group/);
  assert.match(editor.textContent, new RegExp(`group（无名称）· ${app}`),
    'the summary names the control and its app, without a raw role/name form');
  assert.match(editor.textContent, /悬停时长（毫秒）/);
  const duration = durationInput(editor);
  assert.ok(duration, 'the dwell is editable');
  assert.equal(duration.value, '405', 'the recorded dwell is the default');
  assert.ok(buttonByText(editor, '从窗口拾取'), 'picking is the only way to change the target');

  // None of the click/scroll locator fields survive here.
  assert.equal(editor.querySelectorAll('details').length, 0, 'no 「高级定位」 block');
  assert.doesNotMatch(editor.textContent, /高级定位/);
  assert.doesNotMatch(editor.textContent, /按这些值回放会找/);
  assert.doesNotMatch(editor.textContent, /要求名称完全一致/);
  assert.doesNotMatch(editor.textContent, /webarea/);
  const placeholders = editor.querySelectorAll('input').map(input => input.getAttribute('placeholder'));
  assert.deepEqual(placeholders, [null], 'the dwell is the only input on the form');
  assert.equal(editor.querySelectorAll('textarea').length, 0);
  assert.equal(editor.querySelectorAll('select').length, 0, 'no snapshot-candidate dropdown');

  // Click keeps its full locator editor; only hover was simplified.
  buttonByText(editor, '关闭').click();
  buttonByText(rowOf(document, 'click-plain'), '编辑').click();
  const clickEditor = dialog(document);
  assert.ok(clickEditor.querySelectorAll('details').length, 'click still has its advanced block');
  assert.match(clickEditor.textContent, /按这些值回放会找：/);
});

test('改悬停时长后应用，写回 durationMs 且目标不变', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openHoverEditor(document);

  durationInput(editor).value = '650';
  await submitDialog(document);

  assert.equal(dialog(document).open, false, 'applying closes the editor');
  const step = await stepOf('hover-group');
  assert.equal(step.durationMs, 650);
  assert.deepEqual(step.target, hoverTarget, 'a dwell edit never rewrites the locator');
});

test('从窗口拾取后摘要带尺寸，应用时目标与时长一起写回', async t => {
  const { document, state, stepOf } = await bootPage(t);
  const app = await appLabelOf(state);
  const editor = await openHoverEditor(document);

  buttonByText(editor, '从窗口拾取').click();
  await tick();
  assert.equal(pickerDialog(document).open, true);
  assert.match(pickerDialog(document).textContent, /2 个控件/);
  assert.match(pickerDialog(document).textContent, /回到编辑框点「应用」才保存/);

  pickerDialog(document).querySelectorAll('select')[0].value = '0';
  await submitPicker(document);
  assert.equal(pickerDialog(document).open, false);

  // The pick lands in the editor only: nothing is saved before 应用.
  assert.equal(editor.open, true, 'the hover editor stays open behind the picker');
  assert.match(editor.textContent, new RegExp(`button（刷新）· ${app} · 60 × 30`));
  assert.deepEqual((await stepOf('hover-group')).target, hoverTarget,
    'a confirmed pick alone does not write the step');

  durationInput(editor).value = '700';
  await submitDialog(document);
  const step = await stepOf('hover-group');
  assert.deepEqual(step.target, candidates[0].locator);
  assert.equal(step.durationMs, 700);
});

test('拾取到没有 bounds 的控件时报 HOVER_UNRESOLVED，且不落盘', async t => {
  const { document, state, stepOf } = await bootPage(t);
  const app = await appLabelOf(state);
  const editor = await openHoverEditor(document);

  buttonByText(editor, '从窗口拾取').click();
  await tick();
  pickerDialog(document).querySelectorAll('select')[0].value = '1';
  await submitPicker(document);

  assert.match(editor.textContent, /group（无名称）/);
  assert.match(editor.textContent, /HOVER_UNRESOLVED/,
    'a control the snapshot cannot place is named as the replay error it becomes');
  assert.doesNotMatch(editor.textContent, /· \d+ × \d+/, 'no invented size');
  assert.ok(!editor.textContent.includes(app + ' · '), 'the summary stops at the app');

  durationInput(editor).value = '900';
  await submitDialog(document);
  assert.equal(editor.open, true, 'the refused apply keeps the editor open');
  assert.match(editor.textContent, /HOVER_UNRESOLVED/, 'the form error explains the refusal');

  const step = await stepOf('hover-group');
  assert.deepEqual(step.target, hoverTarget, 'nothing was saved');
  assert.equal(step.durationMs, 405, 'the dwell was not saved either');
});

test('时长越界或留空时不写回', async t => {
  const { document, stepOf } = await bootPage(t);
  const editor = await openHoverEditor(document);

  for (const bad of ['', '70000', '-5', '12.5']) {
    durationInput(editor).value = bad;
    await submitDialog(document);
    assert.equal(editor.open, true, `"${bad}" is refused`);
    assert.match(editor.textContent, /悬停时长填 0–60000 之间的整数毫秒/);
  }
  assert.equal((await stepOf('hover-group')).durationMs, 405);
});
