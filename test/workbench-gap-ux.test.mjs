import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';
import { GAP_REASONS, gapReason, v2StepLabel } from '../workbench/model.js';

// The page is plain ES modules, so the real `app.js` runs against the shared
// DOM stand-in: every click below goes through the handler the browser uses and
// every assertion reads the node the operator sees.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

const WINDOW = { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'Notes' };

/**
 * Two capture gaps and nothing else wrong: removing one gap still leaves the
 * other blocking, removing both makes the flow validate and dry-run again.
 */
function gapFlow() {
  return {
    version: 2, id: 'gap-ux', name: '缺口处理夹具',
    steps: [
      {
        id: 's1', atMs: 0, kind: 'activate_app', scope: { kind: 'app', app: 'com.apple.TextEdit' },
        focusAfter: { ...WINDOW },
      },
      { id: 's2', atMs: 100, kind: 'gap', code: 'STALE_CAPTURE' },
      { id: 's3', atMs: 200, kind: 'gap', code: 'CAPTURE_SCOPE_UNVERIFIED' },
      {
        id: 's4', atMs: 300, kind: 'type', scope: { ...WINDOW },
        target: { kind: 'element', role: 'textfield', name: '正文' }, text: 'hello',
      },
    ],
  };
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-gap-ux-'));
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

  // The page talks to the server through the intercepted fetch, so these calls
  // read the same session the timeline below is drawn from.
  const post = async (route, body = {}) => {
    const response = await fetch(`/api/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const sessionId = async () => (await post('state')).body.session.id;
  return { document, post, sessionId };
}

const rows = document => document.querySelector('.v2-rows').children
  .filter(node => node.classList.contains('v2-row'));
const rowFor = (document, id) => rows(document)
  .find(row => row.querySelector('.step-id')?.textContent === id);
const dialog = document => document.getElementById('dialog');
const dialogButtons = document => dialog(document).querySelectorAll('button');
const dismissButton = document => dialogButtons(document)
  .find(node => node.getAttribute('title') === '关闭');
const removeButton = document => dialogButtons(document)
  .find(node => node.textContent.includes('确认没有需要重放的操作并移除'));
const confirmBox = document => dialog(document)
  .querySelectorAll('input').find(node => node.getAttribute('type') === 'checkbox');

/** Open a gap's dialog the way the timeline does: the row's own 处理缺口 button. */
function openGapDialog(document, id) {
  const row = rowFor(document, id);
  // The DOM stand-in resolves one simple selector at a time, so filter the
  // row's own buttons instead of asking for a descendant combinator.
  const open = row.querySelectorAll('button')
    .find(node => node.textContent.includes('处理缺口'));
  assert.ok(open, `row ${id} has the gap action`);
  open.click();
}

test('every gap code has a plain-language sentence, never just the enum', () => {
  for (const code of Object.keys(GAP_REASONS)) {
    const reason = gapReason(code);
    assert.ok(reason.length > 8, `${code}: ${reason}`);
    assert.notEqual(reason, code);
    assert.doesNotMatch(reason, /CAPTURE_|STALE_CAPTURE|CROSS_SCOPE|PRIVACY_REDACTED|SECURE_INPUT|IME_/);
  }
  // An unknown code still explains what a gap is instead of printing the enum.
  assert.match(gapReason('SOMETHING_NEW'), /未知缺口/);
  // The timeline keeps the code as the step's identity; the sentence rides beside it.
  assert.equal(v2StepLabel({ kind: 'gap', code: 'STALE_CAPTURE' }), '缺口 · STALE_CAPTURE');
});

test('a gap row names its real code and says what happened, and only a confirmed removal deletes it', async t => {
  const { document, post, sessionId } = await bootPage(t);

  await t.test('both gap rows show their own code and sentence', () => {
    const stale = rowFor(document, 's2');
    const scope = rowFor(document, 's3');
    assert.ok(stale && scope, 'both gaps are on the timeline');
    assert.match(stale.textContent, /缺口 · STALE_CAPTURE/);
    assert.match(stale.querySelector('small').textContent, /事件采集短暂中断或延迟/);
    assert.match(scope.textContent, /缺口 · CAPTURE_SCOPE_UNVERIFIED/);
    assert.match(scope.querySelector('small').textContent, /找不到归属窗口/);
    assert.doesNotMatch(scope.querySelector('small').textContent, /^缺口$/, 'the small line is no longer a bare label');
  });

  await t.test('the row delete opens the gap dialog instead of deleting silently', async () => {
    const s2 = await sessionId();
    const trash = rowFor(document, 's2').querySelectorAll('button')
      .find(node => node.getAttribute('title') === '删除缺口需先确认');
    assert.ok(trash, 'a gap row keeps a delete entry');
    trash.click();
    assert.equal(dialog(document).open, true, 'the delete entry opens the confirmation dialog');
    assert.match(dialog(document).textContent, /事件采集短暂中断或延迟/);
    assert.match(dialog(document).textContent, /我确认这段缺口期间没有需要重放的操作/);
    assert.ok(rowFor(document, 's2'), 'nothing was deleted by opening the dialog');

    const run = await post('run', { session: s2, mode: 'dry-run' });
    assert.equal(run.status, 400);
    assert.equal(run.body.error, 'GAP_UNRESOLVED');
    dismissButton(document).click();
  });

  await t.test('without the checkbox the removal button stays disabled and cancel keeps the gap', async () => {
    const s2 = await sessionId();
    openGapDialog(document, 's2');
    const remove = removeButton(document);
    assert.ok(remove, 'the dialog offers removal');
    assert.equal(remove.disabled, true, 'unchecked confirmation cannot remove');

    confirmBox(document).checked = false;
    remove.click();
    await tick();
    assert.equal(dialog(document).open, true, 'an unchecked click does not submit');
    assert.ok(rowFor(document, 's2'), 'the gap is still there');

    dismissButton(document).click();
    assert.equal(dialog(document).open, false);
    assert.ok(rowFor(document, 's2'), 'cancelling keeps the gap');
    const state = await post('state');
    assert.equal(state.body.session.v2.validation.ok, false, 'the flow is still refused');
    const run = await post('run', { session: s2, mode: 'dry-run' });
    assert.equal(run.status, 400);
    assert.equal(run.body.error, 'GAP_UNRESOLVED');
  });

  await t.test('confirming one gap removes only it, and the other one still blocks', async () => {
    const s2 = await sessionId();
    openGapDialog(document, 's2');
    const box = confirmBox(document);
    box.checked = true;
    box.onchange({ target: { checked: true } });
    const remove = removeButton(document);
    assert.equal(remove.disabled, false, 'the confirmation unlocks removal');
    remove.click();
    await tick();

    assert.equal(dialog(document).open, false, 'the dialog closes after the removal');
    assert.equal(rowFor(document, 's2'), undefined, 's2 is gone');
    assert.ok(rowFor(document, 's3'), 's3 is untouched');
    assert.deepEqual(rows(document).map(row => row.querySelector('.step-id').textContent), ['s1', 's3', 's4']);
    assert.match(document.getElementById('status').textContent, /已移除缺口 s2/);

    const run = await post('run', { session: s2, mode: 'dry-run' });
    assert.equal(run.status, 400, 'the remaining gap still refuses the run');
    assert.equal(run.body.detail.stepId, 's3');
  });

  await t.test('removing the last gap validates the flow and lets the dry run through', async () => {
    const s2 = await sessionId();
    openGapDialog(document, 's3');
    const box = confirmBox(document);
    box.checked = true;
    box.onchange({ target: { checked: true } });
    removeButton(document).click();
    await tick();

    assert.deepEqual(rows(document).map(row => row.querySelector('.step-id').textContent), ['s1', 's4']);
    const state = await post('state');
    assert.equal(state.body.session.v2.validation.ok, true, 'no unresolved gap is left');
    const run = await post('run', { session: s2, mode: 'dry-run' });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.status, 'passed');
    assert.deepEqual(run.body.entries.filter(entry => entry.status !== 'resolved'), []);

    // The removals stay auditable through the edit history and the diff the
    // footer already renders; nothing new is persisted for them.
    const diff = document.getElementById('v2-editor').querySelector('.v2-diff-list');
    assert.ok(diff, 'the difference list renders after the removals');
    const items = diff.children.map(node => node.textContent);
    assert.ok(items.includes('删除步骤 s2'), items.join(' | '));
    assert.ok(items.includes('删除步骤 s3'), items.join(' | '));
    const undo = document.getElementById('v2-editor').querySelectorAll('button')
      .find(node => node.textContent.trim() === '撤销');
    assert.equal(undo.disabled, false, 'the removal is undoable');

    undo.click();
    await tick();
    assert.ok(rowFor(document, 's3'), 'undo brings the gap back');
    const blocked = await post('run', { session: s2, mode: 'dry-run' });
    assert.equal(blocked.status, 400, 'the restored gap blocks again');
  });
});
