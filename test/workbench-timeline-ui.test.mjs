import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// The workbench page is plain ES modules, so the real `app.js` can run against
// a small DOM stand-in: the clicks below go through the same handlers the
// browser uses, and the assertions read the same nodes the operator sees.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

/** A v2 recording with enough steps that the timeline can scroll. */
async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  const template = flow.steps.find(step => step.kind === 'type');
  const steps = [flow.steps[0]];
  for (let index = 1; index <= 20; index += 1) {
    const step = structuredClone(template);
    step.id = `s${index}`;
    step.target.name = `地址栏 ${index}`;
    step.atMs = index * 500;
    steps.push(step);
  }
  flow.id = 'timeline-ui';
  flow.name = '时间线夹具';
  flow.steps = steps;
  delete flow.appPaths;
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return directory;
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-timeline-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await recording(root);
  const cancellation = new AbortController();
  // Live replay stays enabled so the page's own button opens the dialog; the
  // dirty flow below means confirming it never starts a desktop run.
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: true,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  // Make one real edit through the server's editor, so the diff the page
  // renders is the one a delete actually produces.
  const call = async (route, body) => {
    const response = await fetch(`${started.url}/api/${route}`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };
  const before = await call('state', {});
  const edited = await call('v2/edit', { session: before.session.id, op: { kind: 'delete', id: 's6' } });
  assert.equal(edited.dirty, true);
  assert.deepEqual(edited.diff.removed.map(item => item.id), ['s6']);
  assert.ok(edited.diff.moved.some(move => move.id === 's7' && move.from === 7 && move.to === 6),
    'the delete reports the later steps as zero-based moves');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, {
      ...init, headers: { ...(init.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();

  await import('../workbench/app.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  return { document };
}

const tick = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll the page instead of guessing how long a save or a dialog load takes. */
const waitFor = async (predicate, message, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(25);
  }
  throw new Error(message);
};

const v2Header = document => document.getElementById('v2-editor').querySelector('.v2-header');
const liveButton = document => v2Header(document).children
  .find(node => node.textContent === '实时回放' || node.textContent === '回放中');

const actionRows = document =>
  document.getElementById('timeline').children.filter(node => node.classList.contains('row'));

const v2RowBox = document => document.querySelector('.v2-rows');

test('the workbench page selects a clicked timeline step and keeps the list in place', async t => {
  const { document } = await bootPage(t);

  await t.test('clicking the Nth action row shows that step in the inspector', () => {
    const rows = actionRows(document);
    assert.ok(rows.length > 3, `timeline rows: ${rows.length}`);
    const inspector = document.getElementById('inspector');
    assert.doesNotMatch(inspector.textContent, /s2 · 输入/);

    rows[2].click();

    const selected = actionRows(document).find(row => row.classList.contains('active'));
    assert.ok(selected, 'the clicked row is marked active');
    assert.match(selected.children[0].textContent, /s2/, 'row 2 (third) is the selected one');
    assert.match(inspector.textContent, /s2/, 'the inspector names the clicked step');
    assert.match(inspector.textContent, /地址栏 2/, 'the inspector shows that step\'s own target');
  });

  await t.test('clicking the last action row shows the last step, not the first', () => {
    const rows = actionRows(document);
    rows.at(-1).click();
    const inspector = document.getElementById('inspector');
    assert.match(inspector.textContent, /s20/, 'the last step is displayed');
    assert.doesNotMatch(inspector.textContent, /会话构成/, 'the default overview is gone');

    // Selecting an action re-renders every pane; the chosen step must survive
    // that redraw instead of falling back to the default overview.
    const checkbox = rows[0].children[0].children[0];
    checkbox.checked = true;
    checkbox.onchange({ target: { checked: true } });
    assert.match(document.getElementById('inspector').textContent, /s20/, 'still shown after a redraw');
    const active = actionRows(document).find(row => row.classList.contains('active'));
    assert.ok(active, 'the step stays selected after a redraw');
    assert.match(active.textContent, /s20/);
  });

  await t.test('clicking a step deep in the v2 timeline keeps the list scrolled to it', () => {
    const box = v2RowBox(document);
    assert.ok(box, 'v2 timeline renders');
    box.scrollTop = 600;
    const rows = box.children.filter(node => node.classList.contains('v2-row'));
    assert.ok(rows.length > 10, `v2 rows: ${rows.length}`);
    const stepId = rows[14].querySelector('.step-id').textContent;
    rows[14].click();

    const after = v2RowBox(document);
    assert.equal(after.scrollTop, 600, 'the list kept its scroll position');
    const selected = after.children.find(node => node.classList.contains('selected'));
    assert.ok(selected, 'the clicked step stays selected');
    assert.equal(selected.querySelector('.step-id').textContent, stepId, 'the selected step is the clicked one');
  });

  await t.test('the diff footer drops the summary sentence and lists the real difference', () => {
    const footer = document.getElementById('v2-editor').querySelector('.v2-footer');
    assert.ok(footer, 'v2 footer renders');
    assert.doesNotMatch(footer.textContent, /与录制相比：/, 'the recap sentence is gone');
    assert.doesNotMatch(footer.textContent, /删除 s6；移动 s7/);
    const list = footer.querySelector('.v2-diff-list');
    assert.ok(list, 'the difference list still renders');
    const items = list.children.map(node => node.textContent);
    assert.ok(items.includes('删除步骤 s6'), items.join(' | '));
    // The editor stores zero-based positions; the timeline numbers steps from
    // one, so a delete of the 7th step moves s7 from 8 to 7 and never 7 to 6.
    assert.ok(items.includes('移动步骤 s7：第 8 步 → 第 7 步'), items.join(' | '));
    assert.ok(items.includes('移动步骤 s8：第 9 步 → 第 8 步'), items.join(' | '));
    assert.equal(items.some(item => item.includes('第 7 步 → 第 6 步')), false, 'no off-by-one step numbers');
  });

  await t.test('an unsaved edit asks for the workflow before a live replay', async () => {
    const button = liveButton(document);
    assert.ok(button, 'live replay button renders');
    assert.equal(button.disabled, false, 'the button is enabled, so this goes through the real entry');
    button.click();

    const dialog = document.getElementById('dialog');
    assert.match(dialog.textContent, /请先保存工作流/);
    assert.doesNotMatch(dialog.textContent, /revision|version/i);

    // Confirm the desktop takeover and submit: the page refuses the replay and
    // names the missing action instead of starting anything.
    const confirm = dialog.querySelectorAll('input').find(node => node.getAttribute('type') === 'checkbox');
    confirm.checked = true;
    const form = dialog.children.find(node => node.tagName === 'FORM');
    await form.onsubmit({ preventDefault() {} });
    const error = dialog.querySelectorAll('p').find(node => node.classList.contains('form-error'));
    assert.match(error.textContent, /请先保存工作流/);
    assert.doesNotMatch(error.textContent, /revision|version/i);
    dialog.close();
  });

  await t.test('saving the workflow makes the replay use that saved workflow', async () => {
    const save = v2Header(document).children.find(node => node.textContent === '保存工作流');
    assert.ok(save, 'save button renders');
    save.click();
    // Wait for the save to land: the header reports it only after the API call
    // returns, and the replay target is not the revision before that.
    await waitFor(() => /已保存工作流/.test(document.getElementById('status').textContent),
      'the save did not finish');

    const button = liveButton(document);
    assert.equal(button.disabled, false);
    button.click();
    // The dialog loads the stored values before opening, so wait for it to name
    // the saved workflow instead of assuming one round trip is enough.
    await waitFor(() => {
      const panel = document.getElementById('dialog');
      return panel.open && /将回放已保存的工作流：/.test(panel.textContent);
    }, 'the replay dialog did not name the saved workflow');
    const dialog = document.getElementById('dialog');
    assert.match(dialog.textContent, /将回放已保存的工作流：/);
    assert.doesNotMatch(dialog.textContent, /revision|version/i);
  });
});
