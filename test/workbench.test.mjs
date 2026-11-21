import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { offlineDesktop } from '../dist/desktop.js';
import { plan } from '../dist/flow.js';
import { runFlow } from '../dist/run.js';
import { parseTestItem, resolveSecrets } from '../dist/test-item.js';
import { loadSession } from '../dist/workbench-session.js';
import { startWorkbench } from '../dist/workbench.js';
import { changeTarget, compileDraft, makeBehavior, visibleRows } from '../workbench/model.js';

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
const signal = new AbortController().signal;

async function fixture(t, { other = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const [flow, snapshot] = await Promise.all([example('textedit.flow'), example('textedit.snapshot')]);
  if (other) flow.steps.push({ id: 'other-step', kind: 'key', key: 'tab' });
  const report = await runFlow(flow, offlineDesktop(snapshot, flow.target), { dryRun: true, signal });
  await Promise.all([
    writeJson(join(directory, 'flow.json'), flow),
    writeJson(join(directory, 'report.json'), report),
    writeJson(join(directory, 'snapshot.json'), snapshot),
  ]);
  return { root, directory, flow, snapshot };
}

test('workbench imports timeline metadata, reuses the library, and runs a saved v1 test from the CLI', async t => {
  const { root, directory, flow } = await fixture(t, { other: true });
  const planned = plan(flow);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/HF0AAAAASUVORK5CYII=', 'base64');
  await writeFile(join(directory, 'step.png'), png);
  await writeJson(join(directory, 'actions.json'), {
    version: 1, flowId: flow.id, durationMs: 1800,
    actions: planned.map(({ id }, index) => ({
      id, atMs: 100 + index * 100, durationMs: 15,
      ...(index === 0 ? { thumbnail: 'step.png' } : {}),
      ...(index === planned.length - 1 ? { app: 'com.example.Other', window: 'Other window' } : {}),
    })),
  });
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  function request(route, payload, origin = url) {
    return fetch(`${url}/api/${route}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
  }
  async function post(route, payload, status = 200) {
    const response = await request(route, payload);
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  assert.match(await (await fetch(url)).text(), /动作时间线/);
  assert.equal((await request('import', { directory }, 'https://another-origin.invalid')).status, 403);
  const session = await post('import', { directory });
  assert.deepEqual(session.timeline.map(row => row.action.kind), planned.map(step => step.action.kind));
  assert.equal(session.durationMs, 1800);
  assert.equal(session.timeline[0].atMs, 100);
  assert.equal(session.timeline[0].durationMs, 15);
  const thumbnail = await fetch(url + session.timeline[0].thumbnail);
  assert.equal(thumbnail.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()), png);

  const first = session.timeline[0];
  const ignored = new Set([first.id]);
  assert.deepEqual(visibleRows(session.timeline, 'com.example.Other', ignored, false).map(row => row.window), ['Other window']);
  const retained = visibleRows(session.timeline, flow.target.app, ignored, false);
  assert.equal(retained.length, planned.length - 2);
  assert.equal(visibleRows(session.timeline, flow.target.app, ignored, true)[0].id, first.id);

  assert.throws(() => makeBehavior(session.timeline, 'Mixed target', new Map(), flow.target), /目标窗口/);
  const three = session.timeline.slice(0, 3);
  const type = three.find(row => row.action.kind === 'type');
  const picked = session.candidates.find(candidate => candidate.locator.role === 'textfield').locator;
  assert.equal(changeTarget(type.action, picked).text, type.action.text);
  const before = { ...type.action, target: { kind: 'element', role: 'stale-role' } };
  type.action = changeTarget(before, picked);
  assert.notDeepEqual(type.action.target, before.target);
  assert.deepEqual(type.action.target, picked);
  const { item, defaults } = makeBehavior(three, '登录', new Map([[type.id, { param: 'text', type: 'string' }]]), flow.target);
  const saved = await post('library', { session: session.id, item }, 201);
  assert.deepEqual((await post('state', {})).library, [saved]);
  assert.deepEqual(saved.behavior.steps[1].text, { param: 'text' });

  const test = compileDraft(session, 'TextEdit 测试', [{ id: 'first', item: saved, args: defaults }]);
  const payload = { session: session.id, test };
  assert.equal((await request('run', { ...payload, mode: 'live', confirm: true })).status, 400);
  const result = await post('run', { ...payload, mode: 'offline' });
  assert.deepEqual(result.entries.filter(entry => entry.kind !== 'setup').map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['type', 'resolved'], ['key', 'resolved'],
  ]);
  const { output } = await post('save', payload, 201);
  assert.match(basename(output), /^test-.*\.flow\.json$/);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), JSON.parse(JSON.stringify(test)));
  const cli = spawnSync(process.execPath, [cliPath, 'run', output, '--dry-run',
    '--snapshot', join(directory, 'snapshot.json'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const withoutTiming = ({ atMs, durationMs, ...entry }) => entry;
  assert.deepEqual(JSON.parse(cli.stdout).data.entries.map(withoutTiming), result.entries.map(withoutTiming));

  await post('import', { directory });
  assert.equal((await request('save', payload)).status, 409);
});

test('legacy recordings import with no timestamps; foreign reports and action indexes fail closed', async t => {
  const { root, directory, flow } = await fixture(t);
  const legacy = join(root, 'legacy');
  await mkdir(legacy);
  await writeJson(join(legacy, 'recorded.flow.json'), flow);
  const session = await loadSession(legacy);
  assert.deepEqual(session.view.timeline.map(row => row.action.kind), plan(flow).map(step => step.action.kind));
  assert.equal(session.view.durationMs, undefined);
  assert.equal(session.view.timeline[0].atMs, undefined);
  assert.equal(session.view.hasSnapshot, false);

  const foreign = await loadSession(directory);
  const changed = { ...foreign.flow, name: 'Different recording' };
  await writeJson(join(directory, 'flow.json'), changed);
  await assert.rejects(loadSession(directory), /report\.json does not match/);
  await writeJson(join(directory, 'flow.json'), flow);
  await writeJson(join(directory, 'actions.json'), { version: 1, flowId: 'wrong-flow', actions: [] });
  await assert.rejects(loadSession(directory), /current flowId/);
});

test('repicking in the workbench writes a snapshot locator that the saved test replays', async t => {
  const { root, directory } = await fixture(t);
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  const session = await post('import', { directory });
  assert.equal(session.candidates.length, 1);
  const [candidate] = session.candidates;
  assert.equal(candidate.ref, '@scuekeeper:e1');
  assert.equal(candidate.interactive, true);
  assert.deepEqual(candidate.point, [419, 319]);
  assert.deepEqual(candidate.bounds, { x: 112, y: 130, width: 615, height: 378 });
  assert.deepEqual(candidate.locator, { kind: 'element', role: 'textfield', name: '' });

  // Same write-back the 重新拾取 dialog performs on the selected timeline action.
  const row = session.timeline.find(entry => entry.action.kind === 'click');
  row.action = changeTarget(row.action, candidate.locator);
  assert.deepEqual(row.action.target, candidate.locator);
  const test = compileDraft(session, 'Repicked replay', [{ id: 'repicked', action: row.action }]);
  const { output } = await post('save', { session: session.id, test }, 201);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.steps[0].target, candidate.locator);

  const validate = spawnSync(process.execPath, [cliPath, 'flow', 'validate', output, '--json'],
    { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  const replay = spawnSync(process.execPath, [cliPath, 'run', output, '--dry-run',
    '--snapshot', join(directory, 'snapshot.json'), '--json'], { encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout).data.entries.map(entry => [entry.kind, entry.status]),
    [['click', 'resolved']]);

  const offline = await post('run', { session: session.id, test, mode: 'offline' });
  assert.equal(offline.status, 'passed');
  assert.deepEqual(offline.entries.filter(entry => entry.kind !== 'setup').map(entry => entry.status),
    ['resolved']);
});

test('a secret binding stores an environment variable name and passes only the resolved value to desktop input', async t => {
  const { directory, flow, snapshot } = await fixture(t);
  const session = (await loadSession(directory)).view;
  const rows = session.timeline.slice(0, 3);
  const typed = rows.find(row => row.action.kind === 'type');
  const binding = new Map([[typed.id, { param: 'text', type: 'secret' }]]);
  const { item, defaults } = makeBehavior(rows, 'Secret input', binding, flow.target);
  const test = compileDraft(session, 'Secrets', [{ id: 'secret-call', item, args: defaults }]);
  const savedText = JSON.stringify(test);
  assert.doesNotMatch(savedText, new RegExp(typed.action.text));
  assert.match(savedText, /CUEKEEPER_SECRET_TEXT/);
  const output = join(directory, 'secret.test.json');
  await writeFile(output, savedText);
  const cli = spawnSync(process.execPath, [cliPath, 'run', output, '--dry-run',
    '--snapshot', join(directory, 'snapshot.json'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).data.entries.map(entry => entry.status), ['resolved', 'resolved', 'resolved']);
  const parsed = parseTestItem(test);
  assert.throws(() => resolveSecrets(parsed.secrets, {}), /Provide CUEKEEPER_SECRET_TEXT/);
  const value = 'only-in-memory-42';
  const actual = [];
  const desktop = {
    ...offlineDesktop(snapshot, flow.target),
    click: async () => 'delivered_verified',
    type: async (_ref, text) => { actual.push(text); return 'delivered_verified'; },
    press: async () => 'delivered_verified',
  };
  const report = await runFlow(parsed.flow, desktop, {
    dryRun: false, signal, secretTexts: resolveSecrets(parsed.secrets, { CUEKEEPER_SECRET_TEXT: value }),
  });
  assert.deepEqual(actual, [value]);
  assert.equal(report.status, 'passed');
  assert.doesNotMatch(JSON.stringify(report), /only-in-memory-42/);
});
