import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const buttonByText = (node, text) => node.querySelectorAll('button').find(candidate =>
  [candidate.textContent.trim(), candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
    .includes(text));

async function bootPage(t, health) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-guide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  flow.id = 'guide-fixture';
  flow.name = '引导夹具';
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));

  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  let healthCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    if (String(target).endsWith('/api/record/health')) {
      healthCalls += 1;
      return { ok: true, status: 200, json: async () => health };
    }
    return realFetch(target, {
      ...init, headers: { ...(init.headers ?? {}), origin: started.url },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  // Suppress the first-visit auto-open so this test can exercise the header
  // button explicitly.
  globalThis.localStorage = { getItem: () => 'seen', setItem() {} };

  const document = installWorkbenchPage();
  await import(`../workbench/app.js?guide=${Date.now()}`);
  await sleep(30);
  return { document, flow, healthCalls: () => healthCalls };
}

test('the header guide explains the four steps and shows recorder health', async t => {
  const blocked = {
    ok: false,
    blocking: [
      { id: 'accessibility', label: 'accessibility', status: 'fail', detail: 'not granted for the recorder' },
      { id: 'input-monitoring', label: 'input monitoring', status: 'fail', detail: 'not granted for the recorder' },
    ],
    nextSteps: ['Open System Settings and enable cuekeeper-capture.'],
  };
  const { document, healthCalls } = await bootPage(t, blocked);
  const guideButton = document.getElementById('guide-button');
  assert.ok(guideButton, 'the guide button is in the header');
  guideButton.click();
  await sleep(50);

  const dialog = document.getElementById('guide-dialog');
  assert.equal(dialog.open, true, 'the guide opens');
  assert.match(dialog.textContent, /4 步开始使用 CueKeeper/);
  assert.match(dialog.textContent, /先授权录制器/);
  assert.match(dialog.textContent, /录制真实操作/);
  assert.match(dialog.textContent, /检查并编辑流程/);
  assert.match(dialog.textContent, /回放并查看报告/);
  assert.match(dialog.textContent, /录制环境未就绪/);
  assert.match(dialog.textContent, /not granted for the recorder/);
  assert.match(dialog.textContent, /cuekeeper-capture/);
  assert.equal(buttonByText(dialog, '开始录制').disabled, true,
    'the guide does not offer recording while health is blocked');

  const before = healthCalls();
  buttonByText(dialog, '重新检查环境').click();
  await sleep(50);
  assert.ok(healthCalls() > before, 'recheck probes the recorder again');
});

test('the guide offers recording when health is ready and closes cleanly', async t => {
  const { document } = await bootPage(t, { ok: true });
  document.getElementById('guide-button').click();
  await sleep(50);
  const dialog = document.getElementById('guide-dialog');
  assert.match(dialog.textContent, /录制环境已就绪/);
  assert.equal(buttonByText(dialog, '开始录制').disabled, false);
  buttonByText(dialog, '关闭').click();
  assert.equal(dialog.open, false);
});
