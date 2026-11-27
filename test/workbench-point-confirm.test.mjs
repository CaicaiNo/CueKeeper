import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// The workbench page is plain ES modules, so the real `app.js` runs against the
// small DOM stand-in: the marker and status cells below come out of the same
// render path the browser uses.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The blocked report a dry run of a flow with one recorded point returns. */
const blockedReport = message => ({
  version: 2, mode: 'dry-run', flowId: 'point-confirm', flowSha256: 'fixture', status: 'blocked',
  entries: [
    { id: 'type-address', kind: 'click', status: 'blocked', code: 'UNSAFE_POINT', message, atMs: 0, durationMs: 0 },
    { id: 'wait-browser', kind: 'wait', status: 'resolved', atMs: 0, durationMs: 0 },
  ],
});

async function bootPage(t, report) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-point-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'point-confirm';
  flow.name = '坐标步骤夹具';
  delete flow.appPaths;
  // The fixture has no click; turn its type step into the recorded point the
  // operator is asked to confirm, keeping the same window scope.
  const step = flow.steps.find(item => item.id === 'type-address');
  step.kind = 'click';
  step.target = { kind: 'point', point: [420, 300] };
  delete step.input;
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));

  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // The dry run needs no desktop, so the report the page would receive from
    // the server is handed over directly. Every other request still reaches the
    // real workbench server.
    if (url === '/api/run') return { ok: true, status: 200, json: async () => report };
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, {
      ...init, headers: { ...(init?.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = installWorkbenchPage();
  await import('../workbench/app.js');
  await sleep(30);
  return { document };
}

const v2Row = (document, id) => document.querySelector('.v2-rows').children
  .find(row => row.classList.contains('v2-row') && row.querySelector('.step-id')?.textContent === id);

const actionRow = (document, id) => document.getElementById('timeline').children
  .find(row => row.classList.contains('row') && row.querySelector('.step-id')?.textContent === id);

test('a recorded point click is yellow: 需确认 before the run, blocked after it', async t => {
  const message = '坐标 (420,300) 需改成元素目标才能通过 dry-run；实时回放仍会点窗口内坐标';
  const { document } = await bootPage(t, blockedReport(message));

  // Before any run, the coordinate step already says it needs confirmation.
  const staticChip = v2Row(document, 'type-address').querySelector('.point-confirm');
  assert.ok(staticChip, 'the coordinate step carries a static 需确认 marker');
  assert.ok(staticChip.classList.contains('badge-warning'), 'the static marker is yellow');
  assert.equal(staticChip.textContent, '需确认');
  assert.match(staticChip.getAttribute('title'), /元素目标/);
  assert.ok(actionRow(document, 'type-address').querySelector('.point-confirm'),
    'the action timeline marks the same step');
  assert.equal(v2Row(document, 'wait-browser').querySelector('.point-confirm'), null,
    'an element step carries no 需确认 marker');
  assert.equal(v2Row(document, 'type-address').querySelector('.row-status').textContent, '',
    'no run has marked the step yet');

  const dry = document.querySelector('.v2-header').children
    .find(node => node.textContent === 'dry-run');
  assert.ok(dry, 'the dry-run button renders');
  dry.click();
  await sleep(50);

  // The whole report is yellow: the status bar warns and counts the step,
  // instead of showing the red error a refused request used to produce.
  const bar = document.getElementById('status');
  assert.ok(bar.classList.contains('warning'), `status bar is warning: ${bar.className}`);
  assert.equal(bar.classList.contains('error'), false, 'a blocked dry run is not an error');
  assert.match(bar.textContent, /dry-run 阻塞/);
  assert.match(bar.textContent, /1 步需确认/);

  // The step itself uses the existing warning status, with the code and reason
  // in its tooltip.
  const cell = v2Row(document, 'type-address').querySelector('.row-status');
  assert.ok(cell.classList.contains('status-blocked'), 'the step is blocked');
  assert.equal(cell.getAttribute('aria-label'), '阻塞');
  assert.equal(cell.children[0].getAttribute('data-icon'), 'alertTriangle');
  const title = cell.getAttribute('title');
  assert.match(title, /UNSAFE_POINT/);
  assert.match(title, /元素目标/);
  const timelineCell = actionRow(document, 'type-address').querySelector('.row-status');
  assert.ok(timelineCell.classList.contains('status-blocked'), 'the action timeline agrees');

  // A step that resolved keeps the neutral info state.
  const resolved = v2Row(document, 'wait-browser').querySelector('.row-status');
  assert.ok(resolved.classList.contains('status-resolved'));
  assert.equal(resolved.getAttribute('aria-label'), '已解析');
});
