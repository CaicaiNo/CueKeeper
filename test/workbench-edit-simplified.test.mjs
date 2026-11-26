import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { flowV2Check } from '../dist/contracts-v2.js';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// The everyday step editors show the control (role, name, replay preview) and
// hide the narrowing conditions (exact name, path, index) under 「高级定位」.
// These tests drive the real `app.js` through the DOM stand-in, so the state
// they read is the state an operator sees.

const canvasScope = {
  kind: 'window', app: 'com.apple.Safari', windowKey: 'canvas', windowTitle: 'Cuekeeper 画布',
};

/** A recording with plain and already-narrowed targets for every editor kind. */
async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'edit-simplified';
  flow.name = '编辑弹窗层级夹具';
  flow.steps.splice(3, 0,
    {
      id: 'click-plain', kind: 'click', scope: canvasScope,
      target: { kind: 'element', role: 'button', name: '保存' },
    },
    {
      id: 'scroll-plain', kind: 'scroll', scope: canvasScope,
      target: { kind: 'element', role: 'group' }, deltaX: 0, deltaY: 300,
    },
    {
      id: 'hover-plain', kind: 'hover', scope: canvasScope,
      target: { kind: 'element', role: 'button', name: '更多' }, durationMs: 120,
    },
    {
      id: 'click-advanced', kind: 'click', scope: canvasScope,
      target: { kind: 'element', role: 'button', name: '重复', path: ['window', 'toolbar', 'button'], index: 1 },
    },
    {
      id: 'type-plain', kind: 'type', scope: canvasScope,
      target: { kind: 'element', role: 'textfield', name: '地址栏' }, text: 'hello',
    },
    {
      id: 'type-advanced', kind: 'type', scope: canvasScope,
      target: { kind: 'element', role: 'textfield', name: '重复', path: ['window', 'textfield'], index: 2 },
      text: 'world',
    });
  const errors = [...flowV2Check.Errors(flow)];
  assert.deepEqual(errors, [], 'the fixture is a valid version 2 flow');
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return { directory };
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-edit-simplified-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { directory } = await recording(root);
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'),
    allowLive: false, allowShell: false, signal: cancellation.signal,
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

  return { document, state };
}

const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));

let page = 0;
const nextPage = () => (page += 1);

const dialog = document => document.getElementById('dialog');
const v2Rows = document => document.querySelector('.v2-rows').children
  .filter(node => node.classList.contains('v2-row'));
const rowOf = (document, stepId) => v2Rows(document)
  .find(row => row.querySelector('.step-id')?.textContent === stepId);
const buttonByText = (node, text) => node.querySelectorAll('button').find(candidate =>
  [candidate.textContent.trim(), candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
    .includes(text));
const submitDialog = async document => {
  const form = dialog(document).children.find(node => node.tagName === 'FORM');
  await form.onsubmit({ preventDefault() {} });
  await tick();
};
const closeDialog = document => buttonByText(dialog(document), '关闭').click();

/** The `<details>` block is the only place the narrowing fields may live. */
const advancedBlock = node => node.querySelectorAll('details')
  .find(details => details.classList.contains('locator-advanced'));
const fieldInput = (node, placeholder) => node.querySelectorAll('input')
  .find(input => input.getAttribute('placeholder') === placeholder);
const byPlaceholder = {
  role: '例如 textfield',
  name: '例如 保存',
  path: '例如 window / toolbar / button',
};

test('点击、滚动、悬停编辑默认只露出控件类型、名称与回放预览', async t => {
  const { document } = await bootPage(t);

  for (const [stepId, expectedRole] of [['click-plain', 'button'], ['scroll-plain', 'group'],
    ['hover-plain', 'button']]) {
    buttonByText(rowOf(document, stepId), '编辑').click();
    const editor = dialog(document);
    assert.equal(editor.open, true, `${stepId} editor opens`);

    // The key fields are visible outside the advanced block.
    const role = fieldInput(editor, byPlaceholder.role);
    const name = fieldInput(editor, byPlaceholder.name);
    assert.ok(role, `${stepId} shows the control role field`);
    assert.ok(name, `${stepId} shows the control name field`);
    assert.equal(role.value, expectedRole);
    assert.ok(buttonByText(editor, '从窗口拾取'), `${stepId} keeps the pick entry`);
    assert.match(editor.textContent, /按这些值回放会找：/, `${stepId} shows the replay preview`);

    // The narrowing conditions are inside one closed block.
    const advanced = advancedBlock(editor);
    assert.ok(advanced, `${stepId} has an advanced locator block`);
    assert.equal(advanced.open, false, `${stepId} opens with the advanced block collapsed`);
    assert.equal(advanced.textContent.includes('高级定位'), true);
    assert.equal(fieldInput(advanced, byPlaceholder.path), fieldInput(editor, byPlaceholder.path),
      `${stepId} path field lives in the advanced block`);
    assert.ok(advanced.querySelectorAll('input')
      .some(input => input.value === '' && input.getAttribute('type') === 'number'), `${stepId} index field is inside`);
    const exact = advanced.querySelectorAll('label')
      .find(label => label.textContent.includes('要求名称完全一致'));
    assert.ok(exact, `${stepId} exact-name choice is inside the advanced block`);

    // Nothing from the block leaked into the key area.
    assert.equal(role.closest('.locator-advanced'), null);
    assert.equal(name.closest('.locator-advanced'), null);

    closeDialog(document);
    assert.equal(dialog(document).open, false);
  }
});

test('展开高级定位后可编辑 path/index，应用时按原规则写回', async t => {
  const { document, state } = await bootPage(t);

  buttonByText(rowOf(document, 'click-plain'), '编辑').click();
  const editor = dialog(document);
  const advanced = advancedBlock(editor);
  assert.equal(advanced.open, false);

  // Opening the block reveals the same fields; editing them is what applies.
  advanced.open = true;
  const path = fieldInput(editor, byPlaceholder.path);
  const index = editor.querySelectorAll('input').find(input => input.getAttribute('type') === 'number');
  path.value = 'window / toolbar / button';
  index.value = '2';
  path.oninput();
  index.oninput();
  await submitDialog(document);

  const step = (await state()).v2.flow.steps.find(item => item.id === 'click-plain');
  assert.deepEqual(step.target, {
    kind: 'element', role: 'button', name: '保存', path: ['window', 'toolbar', 'button'], index: 2,
  });
});

test('已带 path/index 的步骤打开时自动展开高级定位', async t => {
  const { document, state } = await bootPage(t);

  buttonByText(rowOf(document, 'click-advanced'), '编辑').click();
  const editor = dialog(document);
  const advanced = advancedBlock(editor);
  assert.equal(advanced.open, true, 'an active narrowing condition is never hidden');
  assert.equal(fieldInput(editor, byPlaceholder.path).value, 'window / toolbar / button');
  assert.equal(String(editor.querySelectorAll('input')
    .find(input => input.getAttribute('type') === 'number').value), '1');

  // Applying without touching anything keeps the recorded condition.
  await submitDialog(document);
  const step = (await state()).v2.flow.steps.find(item => item.id === 'click-advanced');
  assert.deepEqual(step.target,
    { kind: 'element', role: 'button', name: '重复', path: ['window', 'toolbar', 'button'], index: 1 });

  // The same rule applies to the type editor.
  buttonByText(rowOf(document, 'type-advanced'), '编辑').click();
  const typeEditor = dialog(document);
  assert.equal(advancedBlock(typeEditor).open, true);
  assert.equal(fieldInput(typeEditor, byPlaceholder.path).value, 'window / textfield');
});

test('输入步骤默认露出目标关键项与内容来源，定位高级项仍收起', async t => {
  const { document, state } = await bootPage(t);

  buttonByText(rowOf(document, 'type-plain'), '编辑').click();
  const editor = dialog(document);
  assert.match(editor.textContent, /编辑输入步骤 · type-plain/);
  assert.equal(fieldInput(editor, byPlaceholder.role).value, 'textfield');
  assert.equal(fieldInput(editor, byPlaceholder.name).value, '地址栏');
  assert.ok(buttonByText(editor, '从窗口拾取'), 'the type editor keeps the pick entry');

  // Content source and the text it currently uses stay in the key area.
  const mode = editor.querySelectorAll('select')
    .find(select => select.querySelectorAll('option').some(option => option.value === 'input'));
  assert.ok(mode, 'content source is visible');
  const text = editor.querySelectorAll('textarea')[0];
  assert.ok(text, 'the text field is visible');
  assert.equal(text.hidden, false);
  assert.equal(text.value, 'hello');
  assert.equal(text.closest('.locator-advanced'), null);
  assert.equal(mode.closest('.locator-advanced'), null);

  const advanced = advancedBlock(editor);
  assert.equal(advanced.open, false, 'a plain target starts with the block collapsed');
  assert.equal(fieldInput(editor, byPlaceholder.path).closest('.locator-advanced'), advanced);

  // Narrowing the target from the block still submits the same patch.
  advanced.open = true;
  const path = fieldInput(editor, byPlaceholder.path);
  path.value = 'window / textfield';
  path.oninput();
  await submitDialog(document);

  const step = (await state()).v2.flow.steps.find(item => item.id === 'type-plain');
  assert.deepEqual(step.target, { kind: 'element', role: 'textfield', name: '地址栏', path: ['window', 'textfield'] });
  assert.equal(step.text, 'hello', 'the content source value is untouched');
});
