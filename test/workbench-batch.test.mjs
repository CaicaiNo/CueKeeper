import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-batch-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const template = await example('textedit.flow');
  await writeJson(join(directory, 'flow.json'), template);
  const first = { ...structuredClone(template), id: 'login-order', name: '登录并下单' };
  const second = { ...structuredClone(template), id: 'refund', name: '退款流程' };
  await writeJson(join(directory, 'test-1111.test.json'), first);
  await writeJson(join(directory, 'test-2222.test.json'), second);
  return { root, directory, first, second, template };
}

/** A replay CLI that writes a report, fails the 退款 flow and records its argv. */
async function stubCli(t, root) {
  const stub = join(root, 'stub-batch-cli.mjs');
  const log = join(root, 'runs.log');
  await writeFile(stub, [
    "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
    'const args = process.argv.slice(2);',
    'const path = args[1];',
    'const document = JSON.parse(await readFile(path, "utf8"));',
    'const flow = document.flow ?? document;',
    'const reportPath = args[args.indexOf("--report") + 1];',
    'const fail = flow.name.includes("退款");',
    'const entries = flow.steps.map((step, index) => ({',
    '  id: step.id, kind: step.kind, atMs: index * 10, durationMs: 5,',
    '  status: fail && index === 1 ? "failed" : index > 1 && fail ? "skipped" : "passed",',
    '  ...(fail && index === 1 ? { code: "ASSERTION_FALSE" } : {}),',
    '}));',
    'const report = { version: 1, flowId: flow.id, flowSha256: "a".repeat(64),',
    '  startedAt: new Date().toISOString(), mode: "replay", status: fail ? "failed" : "passed", entries };',
    'await writeFile(reportPath, JSON.stringify(report));',
    'await appendFile(process.env.CUEKEEPER_BATCH_LOG, `${flow.name}\\n`);',
    'process.stdout.write(JSON.stringify({ ok: !fail, data: report }) + "\\n", () => process.exit(fail ? 1 : 0));',
    '',
  ].join('\n'));
  process.env.CUEKEEPER_BATCH_LOG = log;
  t.after(() => { delete process.env.CUEKEEPER_BATCH_LOG; });
  return { stub, log };
}

async function server(t, { root, stub, directory }) {
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, allowLive: true, library: join(root, 'library'),
    signal: cancellation.signal, cliPath: stub, directory,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });
  async function post(route, payload) {
    const response = await fetch(`${started.url}/api/${route}`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }
  return { post, url: started.url };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(post, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await post('batch/state', {})).body;
    if (predicate(state)) return state;
    await sleep(20);
  }
  throw new Error('The batch did not reach the expected state');
}

test('a batch lists saved items, runs them serially for every round and reports each row', async t => {
  const { root, directory } = await fixture(t);
  const { stub, log } = await stubCli(t, root);
  const { post } = await server(t, { root, stub, directory });

  const listed = await post('batch/state', {});
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 2);
  assert.deepEqual(listed.body.items.map(item => item.name).sort(), ['登录并下单', '退款流程']);
  assert.ok(listed.body.items.every(item => item.selected));

  const started = await post('batch/start', {
    items: listed.body.items.map(item => item.path), rounds: 2, intervalMs: 0, continueOnFailure: true,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.running, true);

  const done = await waitFor(post, state => !state.running);
  assert.equal(done.counts.total, 4);
  assert.equal(done.counts.passed, 2);
  assert.equal(done.counts.failed, 2);
  assert.equal(done.stopReason, 'complete');

  const login = done.items.find(item => item.name === '登录并下单');
  const refund = done.items.find(item => item.name === '退款流程');
  assert.deepEqual(login.runs.map(run => run.status), ['passed', 'passed']);
  assert.deepEqual(refund.runs.map(run => run.status), ['failed', 'failed']);
  assert.equal(refund.last.code, 'ASSERTION_FALSE');
  assert.equal(refund.last.stepId, refund.last.entries[1].id);
  assert.equal(refund.runs[0].round, 1);
  assert.equal(refund.runs[1].round, 2);

  // Rounds are the outer loop: both workflows run before round two starts.
  const logged = (await readFile(log, 'utf8')).trim().split('\n');
  const queue = listed.body.items.map(item => item.name);
  assert.deepEqual(logged, [...queue, ...queue]);

  assert.equal(done.log.length, 4);
  const failedRun = done.log.find(entry => entry.name === '退款流程' && entry.round === 1);
  assert.equal(failedRun.status, 'failed');

  const summary = JSON.parse(await readFile(done.summaryPath, 'utf8'));
  assert.equal(summary.format, 'cuekeeper-workbench-batch');
  assert.equal(summary.counts.total, 4);
  assert.equal(summary.items.length, 2);
  assert.ok(summary.items.every(item => item.runs.length === 2));

  // The per-run report the CLI wrote is readable through the guarded endpoint.
  const report = await post('batch/report', { path: refund.last.reportPath });
  assert.equal(report.status, 200);
  assert.equal(report.body.status, 'failed');
  assert.equal(report.body.entries[1].code, 'ASSERTION_FALSE');

  const outside = await post('batch/report', { path: join(directory, 'flow.json') });
  assert.equal(outside.status, 400);
});

test('stopping a batch keeps finished rows and never starts another round', async t => {
  const { root, directory } = await fixture(t);
  const { stub } = await stubCli(t, root);
  const { post } = await server(t, { root, stub, directory });
  const listed = await post('batch/state', {});
  await post('batch/start', {
    items: listed.body.items.map(item => item.path), rounds: 10, intervalMs: 150, continueOnFailure: true,
  });
  const stopped = await post('batch/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stopped, true);

  const done = await waitFor(post, state => !state.running);
  assert.equal(done.stopReason, 'operator');
  assert.ok(done.counts.total < 20, 'the stop ends the queue instead of finishing every round');
  assert.ok(done.items.every(item => item.runs.length <= 10));
});

test('a failing row stops the batch when the operator chose that policy', async t => {
  const { root, directory } = await fixture(t);
  const { stub } = await stubCli(t, root);
  const { post } = await server(t, { root, stub, directory });
  const listed = await post('batch/state', {});
  const refund = listed.body.items.find(item => item.name === '退款流程');
  const login = listed.body.items.find(item => item.name === '登录并下单');
  const started = await post('batch/start', {
    items: [refund.path, login.path], rounds: 5, intervalMs: 0, continueOnFailure: false,
  });
  assert.equal(started.status, 202);

  const done = await waitFor(post, state => !state.running);
  assert.equal(done.stopReason, 'failure');
  assert.equal(done.counts.total, 1, 'the failing row ends the queue before the next item starts');
  assert.equal(done.items.find(item => item.name === '登录并下单').runs.length, 0);
});

test('an unattended batch refuses a manual checkpoint and an unknown path', async t => {
  const { root, directory } = await fixture(t);
  const { stub } = await stubCli(t, root);
  // A saved v2 revision whose step list waits for a person.
  const scope = { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'notes', windowTitle: 'QA Notes' };
  await writeJson(join(directory, 'flow.edited-checkpoint.json'), {
    version: 2, id: 'checkpoint-flow', name: '人工检查点流程',
    steps: [
      { id: 'wait-start', kind: 'wait', scope, check: { kind: 'window_exists', equals: true }, timeoutMs: 15000 },
      {
        id: 'auth', kind: 'manual_checkpoint', scope, triggerStepId: 'wait-start', reason: 'secure_input',
        resume: { scope, check: { kind: 'window_exists', equals: true } }, timeoutMs: 60000,
      },
    ],
  });
  const { post } = await server(t, { root, stub, directory });
  const listed = await post('batch/state', {});
  const checkpoint = listed.body.items.find(item => item.name === '人工检查点流程');
  assert.ok(checkpoint, 'the v2 revision is visible in the queue');
  assert.equal(checkpoint.checkpoint, true);
  assert.equal(checkpoint.version, 2);

  const refused = await post('batch/start', { items: [checkpoint.path], rounds: 1, intervalMs: 0 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'CHECKPOINT_ITEM');

  const unknown = await post('batch/start', { items: [join(directory, 'nope.json')], rounds: 1, intervalMs: 0 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'UNKNOWN_ITEM');

  const empty = await post('batch/start', { items: [], rounds: 1, intervalMs: 0 });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'NO_SELECTION');
});

test('the batch view is served with the workbench assets', async t => {
  const { root, directory } = await fixture(t);
  const { stub } = await stubCli(t, root);
  const { post, url } = await server(t, { root, stub, directory });
  assert.equal((await post('batch/state', {})).status, 200);
  const page = await (await fetch(`${url}/`)).text();
  assert.match(page, /批量运行/);
  const script = await fetch(`${url}/batch.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /createBatchView/);
});
