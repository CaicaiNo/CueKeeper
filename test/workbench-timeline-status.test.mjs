import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// The workbench page is plain ES modules, so the real `app.js` runs against the
// small DOM stand-in: the statuses below come out of the same render path the
// browser uses, and the column rules are read from the real stylesheet.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A run report in the shape the server writes back and `statusMap` reads. */
const runReport = entries => ({
  version: 2, mode: 'dry-run', flowId: 'timeline-status', flowSha256: 'fixture', status: 'failed',
  entries,
});

async function bootPage(t, report) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-timeline-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'timeline-status';
  flow.name = '状态列夹具';
  delete flow.appPaths;
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));

  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // A live replay needs a desktop and macOS permissions; the report the page
    // would receive from the server is handed over directly. Every other
    // request still reaches the real workbench server.
    if (url === '/api/run') return { ok: true, status: 200, json: async () => report };
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, {
      ...init, headers: { ...(init.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();
  await import('../workbench/app.js');
  await sleep(30);
  return { document };
}

const actionRows = document =>
  document.getElementById('timeline').children.filter(node => node.classList.contains('row'));

const stepRow = (document, id) => actionRows(document)
  .find(row => row.querySelector('.step-id')?.textContent === id);

const v2Header = document => document.getElementById('v2-editor').querySelector('.v2-header');

test('a timeline status is one icon in a fixed narrow column, never a text badge', async t => {
  const { document } = await bootPage(t, runReport([
    { id: 'launch-browser', kind: 'launch_app', status: 'passed', message: '目标窗口已就绪', durationMs: 12 },
    { id: 'type-address', kind: 'type', status: 'failed', code: 'TARGET_MISSING', message: '找不到输入框', durationMs: 8 },
    { id: 'copy-address', kind: 'key', status: 'blocked', code: 'SECURE_INPUT', durationMs: 4 },
    { id: 'switch-notes', kind: 'activate_app', status: 'skipped', code: 'STEP_SKIPPED', message: '上游步骤失败', durationMs: 0 },
    { id: 'paste-address', kind: 'paste', status: 'resolved', code: 'TARGET_RESOLVED', durationMs: 0 },
  ]));

  const dry = v2Header(document).children.find(node => node.textContent === 'dry-run');
  assert.ok(dry, 'the dry-run button renders');
  dry.click();
  await sleep(50);

  const expected = {
    'launch-browser': { status: 'passed', label: '通过', icon: 'checkCircle' },
    'type-address': { status: 'failed', label: '失败', icon: 'xCircle' },
    'copy-address': { status: 'blocked', label: '阻塞', icon: 'alertTriangle' },
    'switch-notes': { status: 'skipped', label: '跳过', icon: 'minusCircle' },
    'paste-address': { status: 'resolved', label: '已解析', icon: 'infoCircle' },
  };
  const glyphs = new Set();
  for (const [id, want] of Object.entries(expected)) {
    const row = stepRow(document, id);
    assert.ok(row, `timeline row ${id} renders`);
    const cell = row.querySelector('.row-status');
    assert.ok(cell, `row ${id} has a status cell`);
    assert.equal(cell, cell.parentNode.children.at(-1), `${id} status sits in the rightmost column`);
    assert.ok(cell.classList.contains(`status-${want.status}`), `${id} carries its own status class`);
    assert.equal(cell.textContent, '', `${id} status renders no text`);
    assert.equal(cell.getAttribute('aria-label'), want.label, `${id} names its status for screen readers`);
    // Only the states an operator investigates keep the code/message in the
    // tooltip; the rest read as the plain Chinese word.
    const title = cell.getAttribute('title');
    if (want.status === 'failed') assert.equal(title, '失败 · TARGET_MISSING · 找不到输入框');
    else if (want.status === 'blocked') assert.equal(title, '阻塞 · SECURE_INPUT');
    else assert.equal(title, want.label, `${id} tooltip is only the Chinese label`);
    const svg = cell.children[0];
    assert.equal(svg?.tagName, 'SVG', `${id} status is an icon`);
    assert.equal(svg.getAttribute('data-icon'), want.icon);
    assert.equal(svg.getAttribute('width'), '16', `${id} icon is 16px`);
    glyphs.add(svg.getAttribute('data-icon'));
    // The old soft badge is gone, and the row's visible words never spell the
    // status out again.
    assert.equal(row.descendants().some(node => node.classList?.contains('run-status')), false);
    assert.doesNotMatch(row.textContent, new RegExp(want.label));
    // The status no longer lives inside the action description, so a long
    // action name cannot be squeezed by it.
    assert.equal(row.querySelector('.row-description').children.length, 2,
      `${id} description holds only the name and scope`);
  }
  assert.deepEqual([...glyphs].sort(),
    ['alertTriangle', 'checkCircle', 'infoCircle', 'minusCircle', 'xCircle'],
    'each status has its own glyph, and passed/resolved never share a check shape');

  // The status column is one fixed narrow track at the right edge, in the header
  // and in every row.
  const css = await readFile(new URL('../workbench/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.row-focus \{[^}]*grid-template-columns: 84px 68px minmax\(0, 1fr\) 64px 28px;/,
    'the action row reserves a 28px status track at the right edge');
  assert.match(css, /\.timeline-columns \{[^}]*grid-template-columns: 18px 84px 68px minmax\(0, 1fr\) 64px 28px;/,
    'the column header matches the row grid');
  const statusBox = /\.row-status \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(statusBox, /width: 28px/);
  assert.match(statusBox, /height: 28px/);
  // Colors come from theme tokens, one per status.
  assert.match(css, /\.row-status\.status-passed \{ color: var\(--color-success\); \}/);
  assert.match(css, /\.row-status\.status-failed \{ color: var\(--color-error\); \}/);
  assert.match(css, /\.row-status\.status-blocked \{ color: var\(--color-warning\); \}/);
  assert.match(css, /\.row-status\.status-skipped \{ color: color-mix\(in oklab, var\(--color-base-content\) 50%/);
  assert.match(css, /\.row-status\.status-resolved \{ color: var\(--color-info\); \}/);

  const html = await readFile(new URL('../workbench/index.html', import.meta.url), 'utf8');
  const columns = /<div class="timeline-columns"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.equal((columns.match(/<span/g) ?? []).length, 6, 'the header declares the status column');
  assert.match(columns, /class="col-duration">耗时</, 'the duration column keeps its label');
  assert.match(columns, /<span class="col-status"><\/span>/, 'the rightmost header cell stays empty');

  // The v2 timeline reads the same statuses; it keeps the same narrow track, so
  // both lists stay aligned whether or not a step has run yet.
  const v2Rows = document.querySelector('.v2-rows').children
    .filter(node => node.classList.contains('v2-row'));
  assert.ok(v2Rows.length > 4, `v2 rows: ${v2Rows.length}`);
  assert.equal(v2Rows.every(row => row.querySelector('.row-status')), true,
    'every v2 row keeps the status track, filled or not');
  const passed = v2Rows.find(row => row.querySelector('.step-id')?.textContent === 'launch-browser');
  const passedCell = passed.querySelector('.row-status');
  assert.equal(passedCell.textContent, '', 'the v2 timeline uses the same icon-only cell');
  assert.equal(passedCell.getAttribute('aria-label'), '通过');
  assert.equal(passedCell.children[0].getAttribute('data-icon'), 'checkCircle');
  assert.match(css, /\.v2-row \{[^}]*grid-template-columns: 40px 72px minmax\(0, 1fr\) 28px auto;/,
    'the v2 row reserves the same narrow status track');
});
