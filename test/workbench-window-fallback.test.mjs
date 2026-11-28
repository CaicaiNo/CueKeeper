import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';
import { windowFallbackCount } from '../workbench/model.js';

// The real `workbench/app.js` runs against the small DOM stand-in, so a fallback
// entry is read through the same render path the browser uses.
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The two steps below are the ones the mocked report says ran in a fallback. */
const fallbackEntry = {
  id: 'type-address', kind: 'type', status: 'passed', durationMs: 12,
  windowFallback: {
    reason: 'focused', recordedTitle: 'Cuekeeper 测试页', actualTitle: '新标签页',
    actualWindowId: 'w-31',
  },
  message: 'window fallback: window "Cuekeeper 测试页" is gone; continued in the app\'s focused window "新标签页"',
};

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-window-fallback-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'window-fallback-ui';
  flow.name = '窗口回退夹具';
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));

  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const report = {
    version: 2, mode: 'dry-run', flowId: 'window-fallback-ui', flowSha256: 'fixture', status: 'passed',
    entries: [
      fallbackEntry,
      { id: 'copy-address', kind: 'key', status: 'passed', durationMs: 4 },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
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
  return { document, flow };
}

const stepRow = (document, id) => document.getElementById('timeline').children
  .filter(node => node.classList.contains('row'))
  .find(row => row.querySelector('.step-id')?.textContent === id);

test('a fallback result is a yellow marker with a recorded → actual tooltip, not a failure', async t => {
  const { document, flow } = await bootPage(t);
  const dry = document.getElementById('v2-editor').querySelector('.v2-header').children
    .find(node => node.textContent === 'dry-run');
  assert.ok(dry, 'the dry-run button renders');
  dry.click();
  await sleep(50);

  const fallbackRow = stepRow(document, 'type-address');
  assert.ok(fallbackRow, 'the fallback step renders');
  const chip = fallbackRow.querySelector('.window-fallback');
  assert.ok(chip, 'the fallback step carries a marker');
  assert.ok(chip.classList.contains('badge-warning'), 'the marker is yellow');
  assert.equal(chip.textContent, '窗口回退');
  assert.equal(chip.getAttribute('title'),
    '窗口回退 · 记录窗口「Cuekeeper 测试页」 → 实际窗口「新标签页」');
  // The step still passed: the marker never turns it into a failure.
  const status = fallbackRow.querySelector('.row-status');
  assert.ok(status.classList.contains('status-passed'));
  assert.equal(status.getAttribute('aria-label'), '通过');

  const plainRow = stepRow(document, 'copy-address');
  assert.ok(plainRow, 'the ordinary step renders');
  assert.equal(plainRow.querySelector('.window-fallback'), null,
    'a step without a fallback is unchanged');

  // The dry run announces the count once, from the same rule the CLI uses.
  const count = windowFallbackCount(flow);
  assert.ok(count > 0, `the fixture has fallback-capable steps (${count})`);
  const statusText = document.getElementById('status').textContent;
  const sentence = `${count} 个窗口步骤在记录窗口不存在时会尝试退回该 App 的前台窗口（需目标唯一）`;
  assert.equal(statusText.split(sentence).length - 1, 1, statusText);
});
