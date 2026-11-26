import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// Two delayed-answer cases for the gap dialog: the conversion submit and the
// confirmed removal share one in-flight state, and a late answer may only close
// the dialog that asked for it. The page is the real `app.js` on the shared DOM
// stand-in; only the delivery of one response is held back.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

const WINDOW = { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'Notes' };

function gapFlow() {
  return {
    version: 2, id: 'gap-submit', name: '缺口提交夹具',
    steps: [
      {
        id: 's1', atMs: 0, kind: 'activate_app', scope: { kind: 'app', app: 'com.apple.TextEdit' },
        focusAfter: { ...WINDOW },
      },
      { id: 's2', atMs: 100, kind: 'gap', code: 'STALE_CAPTURE' },
      { id: 's3', atMs: 200, kind: 'gap', code: 'CAPTURE_SCOPE_UNVERIFIED' },
    ],
  };
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-gap-submit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  await writeFile(join(directory, 'flow.json'), JSON.stringify(gapFlow(), null, 2));
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'),
    allowLive: false, allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, { ...init, headers: { ...(init.headers ?? {}), origin: started.url } });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();
  await import('../workbench/app.js');
  await tick(30);

  const post = async (route, body = {}) => {
    const response = await fetch(`/api/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { document, post };
}

/**
 * Send the request now but hold its answer until `release()`, so the test can
 * act while the server has committed the edit and the page is still waiting.
 */
function holdRoute(fragment) {
  const previous = globalThis.fetch;
  const held = [];
  let received;
  const responseReady = new Promise(resolve => { received = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes(fragment)) return previous(url, init);
    held.push(String(url));
    const response = await previous(url, init);
    received(response.status);
    await gate;
    return response;
  };
  return {
    calls: () => held.length,
    responseReady,
    release: async () => { release(); await tick(80); },
    restore: () => { globalThis.fetch = previous; },
  };
}

const rows = document => document.querySelector('.v2-rows').children
  .filter(node => node.classList.contains('v2-row'));
const dialog = document => document.getElementById('dialog');
const buttons = document => dialog(document).querySelectorAll('button');
const removeButton = document => buttons(document)
  .find(node => node.textContent.includes('确认没有需要重放的操作并移除'));
const confirmBox = document => dialog(document)
  .querySelectorAll('input').find(node => node.getAttribute('type') === 'checkbox');
const dismissButton = document => buttons(document)
  .find(node => node.getAttribute('title') === '关闭');
const form = document => dialog(document).children.find(node => node.tagName === 'FORM');
const inputs = document => dialog(document).querySelectorAll('input');

function useBrowserChildLookup(document) {
  // Element.children is an HTMLCollection in the browser. The stand-in's
  // array otherwise lets production code accidentally use Array.includes().
  Object.defineProperty(dialog(document).children, 'includes', { value: undefined });
}

function openGapDialog(document, id) {
  const row = rows(document).find(entry => entry.querySelector('.step-id')?.textContent === id);
  assert.ok(row, `row ${id} is on the timeline`);
  row.querySelectorAll('button').find(node => node.textContent.includes('处理缺口')).click();
}

/** Check the confirmation so the removal button is otherwise usable. */
function confirmRemoval(document) {
  const box = confirmBox(document);
  box.checked = true;
  box.onchange({ target: { checked: true } });
}

/**
 * Choose the conversion explicitly: the DOM stand-in does not give a <select>
 * the first option's value the way a browser does.
 */
function fillWindowScope(document) {
  const kind = dialog(document).querySelectorAll('select')[0];
  assert.ok(kind, 'the dialog asks how to convert the gap');
  kind.value = 'wait';
  const app = inputs(document).find(node => node.getAttribute('placeholder') === 'com.apple.TextEdit');
  assert.ok(app, 'the dialog asks for the app identifier');
  app.value = 'com.apple.TextEdit';
  const title = inputs(document).find(node => !node.getAttribute('placeholder') && node.getAttribute('type') !== 'checkbox' && node.getAttribute('type') !== 'number' && node !== app);
  title.value = 'Notes';
  const key = inputs(document).find(node => node.getAttribute('placeholder') === '留空自动生成');
  key.value = 'notes';
}

test('the gap dialog serializes its two actions and binds its close to itself', async t => {
  const { document, post } = await bootPage(t);

  await t.test('a conversion in flight blocks removal, and Enter queues no second edit', async () => {
    openGapDialog(document, 's2');
    fillWindowScope(document);
    confirmRemoval(document);
    assert.equal(removeButton(document).disabled, false, 'the confirmation unlocks removal');

    const replace = holdRoute('/api/v2/replace');
    t.after(() => replace.restore());
    useBrowserChildLookup(document);
    const submitting = form(document).onsubmit({ preventDefault() {} });
    assert.equal(await replace.responseReady, 200, 'the server committed the conversion');

    // The conversion is in flight: removal is disabled and, even when clicked
    // or submitted again, neither a second conversion nor a delete is sent.
    assert.equal(removeButton(document).disabled, true, 'the pending submit disables removal');
    removeButton(document).click();
    await form(document).onsubmit({ preventDefault() {} });
    await tick(20);
    assert.equal(replace.calls(), 1, 'Enter while pending does not send a second conversion');

    await replace.release();
    await submitting;
    const state = await post('state');
    const s2 = state.body.session.v2.flow.steps.find(step => step.id === 's2');
    assert.equal(s2?.kind, 'wait', 'the conversion is the only edit that landed');
    assert.equal(dialog(document).open, false, 'the dialog closes once its own submit finishes');
  });

  await t.test('a removal answered late closes only the gap dialog that asked', async () => {
    openGapDialog(document, 's3');
    confirmRemoval(document);

    const edit = holdRoute('/api/v2/edit');
    t.after(() => edit.restore());
    removeButton(document).click();
    assert.equal(await edit.responseReady, 200, 'the server committed the removal');
    assert.equal(edit.calls(), 1, 'the removal was sent');

    assert.equal(dismissButton(document).disabled, true, 'the dialog cannot be dismissed during removal');
    let escapeBlocked = false;
    dialog(document).oncancel({ preventDefault() { escapeBlocked = true; } });
    assert.equal(escapeBlocked, true, 'Escape cannot dismiss the dialog during removal');

    // Simulate a programmatic close and reuse of the shared dialog node.
    dialog(document).close();
    document.getElementById('import-button').click();
    useBrowserChildLookup(document);
    assert.equal(dialog(document).open, true);
    assert.match(dialog(document).textContent, /导入工作流/);

    await edit.release();
    assert.equal(dialog(document).open, true, 'the late answer must not close the import dialog');
    assert.match(dialog(document).textContent, /导入工作流/);

    const state = await post('state');
    assert.equal(state.body.session.v2.flow.steps.some(step => step.id === 's3'), false,
      'the removal still landed on the server');
    assert.equal(state.body.session.v2.flow.steps.find(step => step.id === 's2')?.kind, 'wait',
      'the earlier conversion stays in place');
  });
});
