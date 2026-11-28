import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// The workbench page is plain ES modules, so the real `app.js` runs against the
// small DOM stand-in: the clicks below go through the same handlers the browser
// uses, and both timelines are read from the real render path.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
let page = 0;
const nextPage = () => (page += 1);

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-point-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'point-confirm';
  flow.name = '坐标步骤夹具';
  delete flow.appPaths;
  // Two recorded point clicks, the s9 / s13 shape the user hit. They sit after
  // the launch step, inside the same Safari window scope.
  const scope = flow.steps.find(step => step.id === 'type-address').scope;
  flow.steps.splice(1, 0,
    { id: 'click-a', kind: 'click', scope, target: { kind: 'point', point: [120, 80] } },
    { id: 'click-b', kind: 'click', scope, target: { kind: 'point', point: [220, 180] } });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));

  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  // The page asks with relative URLs; point them at this test's server. The dry
  // run itself is the real endpoint, so its report is the one production makes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, {
      ...init, headers: { ...(init?.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();
  // A fresh module per page: the app reads its DOM once at import time.
  await import(`../workbench/app.js?page=${nextPage()}`);
  await tick(30);
  return { document, started };
}

const v2Row = (document, id) => document.querySelector('.v2-rows').children
  .find(row => row.classList.contains('v2-row') && row.querySelector('.step-id')?.textContent === id);

const actionRow = (document, id) => document.getElementById('timeline').children
  .find(row => row.classList.contains('row') && row.querySelector('.step-id')?.textContent === id);

const dialog = document => document.getElementById('dialog');
const buttonByText = (node, text) => node.querySelectorAll('button').find(candidate =>
  [candidate.textContent.trim(), candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
    .includes(text));

async function submitDialog(document) {
  const form = dialog(document).children.find(node => node.tagName === 'FORM');
  await form.onsubmit({ preventDefault() {} });
  await tick();
}

/** Open a click step's editor and turn the coordinate into an element target. */
async function turnIntoElement(document, id, role, name) {
  buttonByText(v2Row(document, id), '编辑').click();
  await tick();
  assert.equal(dialog(document).open, true, `${id} editor opens`);
  const inputs = dialog(document).querySelectorAll('input');
  const roleInput = inputs.find(input => input.getAttribute('placeholder') === '例如 button');
  const nameInput = inputs.find(input => input.getAttribute('placeholder') === '例如 保存');
  roleInput.value = role;
  nameInput.value = name;
  await submitDialog(document);
  await tick();
}

const statusBar = document => document.getElementById('status');

test('two coordinate clicks stay yellow until they are edited, through dry-run → edit → dry-run', async t => {
  const { document } = await bootPage(t);

  // Before any run, both coordinate steps say they need confirmation, in the v2
  // timeline and in the action timeline.
  for (const id of ['click-a', 'click-b']) {
    const v2Chip = v2Row(document, id).querySelector('.point-confirm');
    assert.ok(v2Chip, `${id} carries a static 需确认 marker in the v2 timeline`);
    assert.ok(v2Chip.classList.contains('badge-warning'), `${id} marker is yellow`);
    assert.equal(v2Chip.textContent, '需确认');
    assert.match(v2Chip.getAttribute('title'), /元素目标/);
    const rowChip = actionRow(document, id).querySelector('.point-confirm');
    assert.ok(rowChip, `${id} carries the same marker in the action timeline`);
    assert.ok(rowChip.classList.contains('badge-warning'));
  }
  assert.equal(actionRow(document, 'wait-browser').querySelector('.point-confirm'), null,
    'an element step carries no 需确认 marker');

  // First dry run: both steps are blocked in yellow, the report is blocked, and
  // the top bar counts them instead of showing a red error.
  buttonByText(document.querySelector('.v2-header'), 'dry-run').click();
  await tick(200);
  assert.ok(statusBar(document).classList.contains('warning'), statusBar(document).className);
  assert.equal(statusBar(document).classList.contains('error'), false);
  assert.match(statusBar(document).textContent, /dry-run 阻塞/);
  assert.match(statusBar(document).textContent, /2 步需确认/);
  for (const id of ['click-a', 'click-b']) {
    const v2Cell = v2Row(document, id).querySelector('.row-status');
    assert.ok(v2Cell.classList.contains('status-blocked'), `${id} is blocked in the v2 timeline`);
    assert.equal(v2Cell.children[0].getAttribute('data-icon'), 'alertTriangle');
    assert.match(v2Cell.getAttribute('title'), /UNSAFE_POINT/);
    assert.match(v2Cell.getAttribute('title'), /元素目标/);
    assert.ok(actionRow(document, id).querySelector('.row-status').classList.contains('status-blocked'),
      `${id} is blocked in the action timeline too`);
  }

  // The detail panel is opened before the edit; it must follow the workflow
  // change without another click on the action row.
  document.getElementById('inspect-click-a').click();
  await tick();
  const inspector = document.getElementById('inspector');
  assert.match(inspector.textContent, /坐标回放 · 需确认 \(120, 80\)/,
    'the open inspector starts from the recorded point');
  // Editing invalidates the report: the first step's marker and blocked state
  // disappear from both timelines, and the top bar stops claiming the old
  // "2 步需确认" result.
  await turnIntoElement(document, 'click-a', 'button', '保存');
  assert.equal(v2Row(document, 'click-a').querySelector('.point-confirm'), null,
    'the edited step loses its marker in the v2 timeline');
  assert.equal(actionRow(document, 'click-a').querySelector('.point-confirm'), null,
    'the edited step loses its marker in the action timeline');
  assert.doesNotMatch(actionRow(document, 'click-a').textContent, /坐标回放/,
    'the action timeline shows the step the workflow now holds');
  assert.match(inspector.textContent, /保存/,
    'the already-open inspector names the current element target');
  assert.doesNotMatch(inspector.textContent, /坐标回放|需确认|120, 80/,
    'the already-open inspector does not keep the recorded point after the target became an element');
  assert.equal(statusBar(document).classList.contains('warning'), false,
    'the stale dry-run notice is retired');
  assert.doesNotMatch(statusBar(document).textContent, /步需确认/);
  assert.match(statusBar(document).textContent, /dry-run 结果已失效/);
  // The second step is still a coordinate, so it keeps its marker until edited.
  assert.ok(v2Row(document, 'click-b').querySelector('.point-confirm'));
  assert.ok(actionRow(document, 'click-b').querySelector('.point-confirm'));

  await turnIntoElement(document, 'click-b', 'button', '取消');
  for (const [timeline, rowOf] of [['v2', v2Row], ['actions', actionRow]]) {
    for (const id of ['click-a', 'click-b']) {
      assert.equal(rowOf(document, id).querySelector('.point-confirm'), null,
        `${id} has no marker in the ${timeline} timeline after editing`);
      assert.doesNotMatch(rowOf(document, id).textContent, /需确认/,
        `${id} no longer reads as needing confirmation in the ${timeline} timeline`);
    }
  }

  // Second dry run: the same two steps now resolve, and nothing is yellow.
  buttonByText(document.querySelector('.v2-header'), 'dry-run').click();
  await tick(200);
  assert.ok(statusBar(document).classList.contains('success'), statusBar(document).className);
  assert.match(statusBar(document).textContent, /dry-run 通过/);
  assert.doesNotMatch(statusBar(document).textContent, /需确认/);
  for (const id of ['click-a', 'click-b']) {
    assert.ok(v2Row(document, id).querySelector('.row-status').classList.contains('status-resolved'),
      `${id} resolves after the edit`);
    assert.ok(actionRow(document, id).querySelector('.row-status').classList.contains('status-resolved'),
      `${id} resolves in the action timeline too`);
  }

  // Deleting a step from the workflow leaves its recording row in the action
  // timeline, but that row is history now: it must not regain the live yellow
  // marker, and its detail must stay the recorded point.
  buttonByText(v2Row(document, 'click-a'), '删除步骤').click();
  await tick(200);
  assert.equal(v2Row(document, 'click-a'), undefined, 'the deleted step leaves the v2 timeline');
  const historyRow = actionRow(document, 'click-a');
  assert.ok(historyRow, 'the recording snapshot stays in the action timeline');
  assert.equal(historyRow.querySelector('.point-confirm'), null, 'the history row is not yellow');
  assert.doesNotMatch(historyRow.textContent, /需确认/, 'the history row does not ask for confirmation');
  assert.match(historyRow.textContent, /历史/, 'the history row is labelled as history');
  const historyInspector = document.getElementById('inspector');
  assert.match(historyInspector.textContent, /历史|已从当前工作流删除/,
    'the already-open detail panel explains that the step is history');
  assert.doesNotMatch(historyInspector.textContent, /需确认/,
    'the already-open history detail does not keep the live confirmation marker');
  assert.match(historyInspector.textContent, /坐标回放 \(120, 80\)/,
    'the already-open history detail shows the recorded point without the live marker');

  // A later dry run passes on the remaining workflow and still leaves the
  // deleted row as plain history.
  buttonByText(document.querySelector('.v2-header'), 'dry-run').click();
  await tick(200);
  assert.ok(statusBar(document).classList.contains('success'), statusBar(document).className);
  assert.match(statusBar(document).textContent, /dry-run 通过/);
  assert.equal(actionRow(document, 'click-a').querySelector('.point-confirm'), null,
    'the deleted step stays non-yellow after a later dry run');
  assert.doesNotMatch(actionRow(document, 'click-a').textContent, /需确认/);
});
