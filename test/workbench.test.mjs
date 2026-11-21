import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { offlineDesktop } from '../dist/desktop.js';
import { plan } from '../dist/flow.js';
import { crop, encodePng } from '../dist/png.js';
import { runFlow } from '../dist/run.js';
import { parseTestItem, resolveSecrets } from '../dist/test-item.js';
import { loadSession } from '../dist/workbench-session.js';
import { startWorkbench } from '../dist/workbench.js';
import {
  KIND_LABELS, actionKind, changeTarget, compileDraft, dragSummary, makeBehavior, scrollLabel, shellDraft,
  shellSummary, visibleRows,
} from '../workbench/model.js';

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
const signal = new AbortController().signal;

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

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
  assert.match(await (await fetch(`${url}/dom.js`)).text(), /export function createDom/);
  assert.match(await (await fetch(`${url}/picker.js`)).text(), /export function createAppPicker/);
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

test('the workbench saves a cropped baseline and refuses flows without one', async t => {
  const { root, directory, flow } = await fixture(t);
  const full = { width: 4, height: 4, data: new Uint8Array(4 * 4 * 4) };
  for (let index = 0; index < 16; index++) full.data.set([10 + index, 20, 30, 255], index * 4);
  await writeFile(join(directory, 'window.png'), encodePng(full));
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
  const region = { x: 1, y: 1, width: 2, height: 2 };
  const saved = await post('baseline', { session: session.id, source: 'window.png', region }, 201);
  assert.equal(saved.frameWidth, 4);
  assert.equal(saved.frameHeight, 4);
  assert.deepEqual(saved.region, region);
  const written = await readFile(join(directory, 'baselines', `${saved.sha256}.png`));
  assert.ok(Buffer.from(written).equals(Buffer.from(encodePng(crop(full, 1, 1, 2, 2)))));

  // Region bounds and symlinked sources are rejected before anything is written.
  await post('baseline', { session: session.id, source: 'window.png', region: { x: 3, y: 0, width: 2, height: 2 } }, 400);
  await post('baseline', { session: session.id, source: 'missing.png', region }, 400);

  const check = {
    target: { kind: 'window', app: flow.target.app, window: flow.target.window },
    expect: {
      property: 'screenshot', region,
      baseline: { sha256: saved.sha256, frameWidth: 4, frameHeight: 4 },
      maxDiffRatio: 0.01,
    },
  };
  const test = {
    version: 1, id: 'shot', name: 'Screenshot', target: flow.target,
    steps: [{ id: 'shot', kind: 'assert', check }],
  };
  const generated = await post('save', { session: session.id, test }, 201);
  const savedFlow = JSON.parse(await readFile(generated.output, 'utf8'));
  assert.deepEqual(savedFlow.steps[0].check, check);

  const missing = structuredClone(test);
  missing.steps[0].check.expect.baseline.sha256 = 'f'.repeat(64);
  await post('save', { session: session.id, test: missing }, 400);
  await post('baseline', { session: session.id, source: 'window.png', region: { x: 0, y: 0, width: 1, height: 1 } }, 201);
});

async function shellFixture(t, { secret = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-workbench-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const marker = join(directory, 'prepared.txt');
  const later = join(directory, 'later.txt');
  const flow = {
    version: 1, id: 'shell-run', name: 'Shell run',
    target: { app: 'com.example.Shell', window: 'Fixture' },
    behaviors: [{
      id: 'later', name: 'Later',
      steps: [{ id: 'cleanup', kind: 'shell', argv: ['/bin/true'] }],
    }],
    steps: [
      { id: 'prepare', kind: 'shell', shell: true, command: `touch '${marker}'`,
        ...(secret ? { env: { TOKEN: { secretEnv: 'CUEKEEPER_SECRET_FIXTURE' } } } : {}) },
      { id: 'slow', kind: 'shell', shell: true, command: `sleep 2; touch '${later}'`, timeoutMs: 8000 },
    ],
  };
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow));
  return { root, directory, flow, marker, later };
}

test('the shell workbench reports definitions on import, previews without side effects, and enforces one-shot confirmation', async t => {
  const { root, directory, flow, marker, later } = await shellFixture(t);
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: true, allowShell: true, allowSudo: false,
    library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  const state = await post('state', {});
  assert.equal(state.allowShell, true);
  assert.equal(state.allowSudo, false);

  const session = await post('import', { directory });
  // Both reachable steps and the uncalled behavior definition are counted.
  assert.deepEqual(session.shell, { reachable: 2, definitions: 1, privileged: 0 });

  const plan = await post('plan', { session: session.id, test: flow, captureOutput: false });
  assert.equal(plan.shell.reachable, 2);
  assert.equal(plan.captureAllowed, true);
  assert.equal(typeof plan.token, 'string');
  assert.deepEqual(plan.steps.map(step => step.id), ['prepare', 'slow']);
  const prepare = plan.steps[0];
  assert.equal(prepare.kind, 'shell');
  assert.equal(prepare.mode, 'shell');
  assert.equal(prepare.privilege, 'user');
  assert.equal(prepare.program, '/bin/sh');
  assert.deepEqual(prepare.args, ['-c', `touch '${marker}'`]);
  assert.equal(prepare.cwd, await realpath(directory));
  assert.equal(prepare.timeoutMs, 30000);
  // The preview shows environment names, never resolved values.
  assert.deepEqual(prepare.envKeys, []);

  const offline = await post('run', { session: session.id, test: flow, mode: 'offline', captureOutput: false });
  assert.deepEqual(offline.entries.map(entry => [entry.status, entry.shell.execution]),
    [['resolved', 'preview'], ['resolved', 'preview']]);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(later), false);

  // Live runs need a plan token; the preview is consumed before execution.
  if (!state.allowLive) return t.skip('live shell replay requires macOS');
  await post('run', { session: session.id, test: flow, mode: 'live', confirm: true }, 400);
  await post('run', {
    session: session.id, test: flow, mode: 'live', confirm: true, token: plan.token, captureOutput: true,
  }, 400);
  const executed = await post('run', {
    session: session.id, test: flow, mode: 'live', confirm: true, token: plan.token, captureOutput: false,
  });
  assert.equal(executed.status, 'passed');
  assert.deepEqual(executed.entries.map(entry => entry.status), ['passed', 'passed']);
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(later), true);
  // Replaying the same token fails closed.
  await post('run', { session: session.id, test: flow, mode: 'live', confirm: true, token: plan.token }, 400);

  // A token belongs to the session that produced it.
  const token = (await post('plan', { session: session.id, test: flow, captureOutput: false })).token;
  const reopened = await post('import', { directory });
  await post('run', { session: reopened.id, test: flow, mode: 'live', confirm: true, token }, 400);
  await post('run', { session: reopened.id, test: flow, mode: 'live', confirm: true, token }, 400);

  // A changed test invalidates the confirmed plan.
  const changed = structuredClone(flow);
  changed.steps[0].command = `touch '${join(directory, 'tampered.txt')}'`;
  const altered = (await post('plan', { session: reopened.id, test: flow, captureOutput: false })).token;
  await post('run', { session: reopened.id, test: changed, mode: 'live', confirm: true, token: altered }, 400);
  assert.equal(existsSync(join(directory, 'tampered.txt')), false);
});

test('the workbench refuses capture while secrets are present and stops a running shell plan', async t => {
  const { root, directory, flow, marker, later } = await shellFixture(t, { secret: true });
  process.env.CUEKEEPER_SECRET_FIXTURE = 'workbench-secret';
  t.after(() => { delete process.env.CUEKEEPER_SECRET_FIXTURE; });
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: true, allowShell: true, allowSudo: false,
    library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  const state = await post('state', {});
  const session = await post('import', { directory });
  const plan = await post('plan', { session: session.id, test: flow, captureOutput: true });
  assert.equal(plan.captureAllowed, false);
  assert.deepEqual(plan.steps[0].envKeys, ['TOKEN']);
  if (!state.allowLive) return t.skip('live shell replay requires macOS');

  await post('run', {
    session: session.id, test: flow, mode: 'live', confirm: true, token: plan.token, captureOutput: true,
  }, 400);

  const stopPlan = await post('plan', { session: session.id, test: flow, captureOutput: false });
  const running = post('run', {
    session: session.id, test: flow, mode: 'live', confirm: true, token: stopPlan.token,
  });
  assert.equal(await waitFor(() => existsSync(marker), 3000), true);
  const stopped = await post('stop', {});
  assert.equal(stopped.stopped, true);
  const report = await running;
  assert.equal(report.stopped, true);
  assert.equal(report.entries[0].status, 'passed');
  assert.equal(report.entries[1].code, 'SHELL_CANCELLED');
  assert.equal(report.status, 'failed');
  assert.equal(existsSync(later), false, 'the later output is not produced after stopping');
  assert.deepEqual(await post('stop', {}), { stopped: false });
});

test('the workbench refuses live shell runs without --allow-shell', async t => {
  const { root, directory, flow } = await shellFixture(t);
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: true, allowShell: false, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }
  const session = await post('import', { directory });
  const plan = await post('plan', { session: session.id, test: flow, captureOutput: false });
  assert.equal(plan.allowShell, false);
  await post('run', {
    session: session.id, test: flow, mode: 'live', confirm: true, token: plan.token,
  }, 400);
});

test('the timeline labels distinguish double, triple, right clicks and scroll direction', () => {
  assert.equal(KIND_LABELS[actionKind({ kind: 'click' })], '点击');
  assert.equal(KIND_LABELS[actionKind({ kind: 'click', count: 2 })], '双击');
  assert.equal(KIND_LABELS[actionKind({ kind: 'click', count: 3 })], '三击');
  assert.equal(KIND_LABELS[actionKind({ kind: 'click', button: 'right' })], '右键');
  assert.equal(KIND_LABELS[actionKind({ kind: 'scroll', deltaY: -5 })], '滚轮');
  assert.equal(KIND_LABELS[actionKind({ kind: 'drag' })], '拖拽');
  assert.equal(dragSummary({
    from: { kind: 'point', point: [135, 165] },
    to: { kind: 'element', role: 'textfield' },
  }), '拖拽 坐标 (135, 165) → textfield');
  assert.equal(dragSummary({
    from: { kind: 'element', role: 'row', name: 'Report.txt' },
    to: { kind: 'element', role: 'row', name: 'Archive' },
  }), '拖拽 row “Report.txt” → row “Archive”');
  assert.equal(scrollLabel({ kind: 'scroll', deltaX: 0, deltaY: -5 }), '滚轮 ↓ 5 行');
  assert.equal(scrollLabel({ kind: 'scroll', deltaX: 0, deltaY: 4 }), '滚轮 ↑ 4 行');
  assert.equal(scrollLabel({ kind: 'scroll', deltaX: 0, deltaY: 0 }), '滚轮 ← 1 行');
  assert.equal(scrollLabel({ kind: 'scroll', direction: 'left', amount: 2 }), '滚轮 ← 2 行');
  // Repointing a scroll keeps its deltas; the locator is the only edit.
  assert.deepEqual(
    changeTarget({ kind: 'scroll', target: { kind: 'element', role: 'scrollarea', name: '' }, deltaX: 0, deltaY: -2 },
      { kind: 'element', role: 'scrollarea', name: 'Body' }),
    { kind: 'scroll', target: { kind: 'element', role: 'scrollarea', name: 'Body' }, deltaX: 0, deltaY: -2 },
  );
});

test('the shell editor builds closed steps and refuses reserved or mixed input', () => {
  const argv = shellDraft({
    argv: ['/bin/echo', 'a b', ''], cwd: './fixtures', timeoutMs: '1500', expectedExitCode: '0',
    env: [['FIXTURE', 'value', false], ['TOKEN', 'CUEKEEPER_SECRET_TOKEN', true], ['', '', false]],
  });
  assert.deepEqual(argv, {
    kind: 'shell', argv: ['/bin/echo', 'a b', ''], cwd: './fixtures', timeoutMs: 1500,
    env: { FIXTURE: 'value', TOKEN: { secretEnv: 'CUEKEEPER_SECRET_TOKEN' } },
  });
  assert.deepEqual(shellSummary(argv), {
    command: '/bin/echo "a b" ', cwd: './fixtures', privilege: '用户态',
  });
  const script = shellDraft({ mode: 'script', command: 'echo hi', expectedExitCode: '3' });
  assert.deepEqual(script, { kind: 'shell', shell: true, command: 'echo hi', expectedExitCode: 3 });
  const sudo = shellDraft({ privilege: 'sudo', argv: ['/Library/CueKeeper/privileged/reset-fixture'] });
  assert.deepEqual(sudo, { kind: 'shell', argv: ['/Library/CueKeeper/privileged/reset-fixture'], privilege: 'sudo' });
  assert.equal(shellSummary(sudo).privilege, '需管理员预配置');
  const root = shellDraft({ privilege: 'root', argv: ['/usr/bin/whoami'] });
  assert.deepEqual(root, { kind: 'shell', argv: ['/usr/bin/whoami'], privilege: 'root' });
  assert.equal(shellSummary(root).privilege, 'Root · 密码授权');
  const sudoers = shellDraft({
    privilege: 'root', privilegeMode: 'sudoers', argv: ['/usr/bin/whoami'], cwd: './fixtures', timeoutMs: '4000',
  });
  assert.deepEqual(sudoers, {
    kind: 'shell', argv: ['/usr/bin/whoami'], privilege: 'root', privilegeMode: 'sudoers',
    cwd: './fixtures', timeoutMs: 4000,
  });
  assert.equal(shellSummary(sudoers).privilege, 'Root · sudoers 免密');

  const invalid = [
    { argv: [] },
    { argv: [''] },
    { argv: ['/bin/echo'], command: 'echo' },
    { mode: 'script', command: '' },
    { argv: ['/bin/echo'], timeoutMs: '0' },
    { argv: ['/bin/echo'], expectedExitCode: '256' },
    { argv: ['/bin/echo'], env: [['HOME', '/tmp', false]] },
    { argv: ['/bin/echo'], env: [['DYLD_X', '1', false]] },
    { argv: ['/bin/echo'], env: [['1BAD', 'x', false]] },
    { argv: ['/bin/echo'], env: [['TOKEN', 'plain', true]] },
    { privilege: 'sudo', argv: ['/Library/CueKeeper/privileged/task'], cwd: '.' },
    { privilege: 'sudo', argv: ['/Library/CueKeeper/privileged/task'], mode: 'script' },
    { privilege: 'sudo', argv: ['Library/CueKeeper/privileged/task'] },
    { privilege: 'sudo', argv: ['/Library/CueKeeper/privileged/first', '/second'] },
    { privilege: 'root', argv: ['/bin/sh'], mode: 'script', command: 'true' },
    { privilege: 'root', argv: ['/bin/echo'], env: [['FIXTURE', 'x', false]] },
    { privilege: 'root', argv: ['/bin/echo'], timeoutMs: '0' },
    { argv: Array.from({ length: 66 }, (_, i) => `arg-${i}`) },
  ];
  for (const [index, input] of invalid.entries()) {
    assert.throws(() => shellDraft(input), Error, `invalid editor case ${index}`);
  }
});

test('the workbench imports a shell report, saves a replayable shell test, and flags library shell steps', async t => {
  const { root, directory, flow } = await shellFixture(t);
  const report = await runFlow(flow, undefined, {
    dryRun: true, signal,
    shell: { allowShell: true, allowSudo: false, baseDir: directory, captureOutput: false },
  });
  await writeJson(join(directory, 'report.json'), report);
  const loaded = await loadSession(directory);
  assert.deepEqual(loaded.view.timeline.map(row => row.action.kind), ['shell', 'shell']);
  assert.equal(loaded.view.timingSource, 'dry-run');

  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: true, allowShell: true, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }

  const session = await post('import', { directory });
  assert.equal(session.timeline.length, 2);
  const saved = await post('save', { session: session.id, test: flow }, 201);
  assert.match(basename(saved.output), /\.flow\.json$/);
  const written = JSON.parse(await readFile(saved.output, 'utf8'));
  assert.deepEqual(written.steps.map(step => step.kind), ['shell', 'shell']);

  const cli = spawnSync(process.execPath, [cliPath, 'run', saved.output, '--dry-run', '--json'],
    { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).data.entries.map(entry => entry.shell.execution),
    ['preview', 'preview']);

  const { item } = makeBehavior(session.timeline, 'Shell behavior', new Map(), flow.target);
  const libraryItem = await post('library', { session: session.id, item }, 201);
  assert.deepEqual(libraryItem.shell, { steps: 2, privileged: 0 });
  assert.deepEqual((await post('state', {})).library[0].shell, { steps: 2, privileged: 0 });
});
