import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { offlineDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { Fault, parseSnapshot } from '../dist/locator.js';
import { Recording } from '../dist/record.js';
import { runFlow } from '../dist/run.js';
import { inferSetup, keepConfirmedSetup } from '../dist/setup.js';
import { startWorkbench } from '../dist/workbench.js';
import {
  canUndo, compileDraft, confirmCondition, confirmedSetup, deleteCondition, retargetCondition,
  setupDraft, undoCondition,
} from '../workbench/model.js';

const example = async name => JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const signal = new AbortController().signal;

test('an analyzed recording suggests inferred app and window conditions that the schema accepts', async () => {
  const flow = await example('textedit.flow');
  const inferred = inferSetup(flow.target);
  assert.deepEqual(inferred.map(condition => [condition.state, condition.ensure.kind]), [
    ['inferred', 'app_running'], ['inferred', 'window_ready'],
  ]);
  assert.deepEqual(inferred[0].ensure, { kind: 'app_running', app: flow.target.app });
  assert.deepEqual(inferred[1].ensure, { kind: 'window_ready', app: flow.target.app, window: flow.target.window });
  assert.deepEqual(inferred[1].check, {
    target: { kind: 'element', role: 'window', name: flow.target.window },
    expect: { property: 'exists', equals: true },
  });
  assert.equal(new Set(inferred.map(condition => condition.id)).size, 2);
  assert.deepEqual(parseFlow({ ...flow, setup: inferred }).setup, inferred);

  // The recorder compiles the same suggestions into the captured flow.
  const fixture = await example('textedit.snapshot');
  const snapshot = parseSnapshot(fixture.data, fixture.target);
  const recording = new Recording(fixture.target);
  for (const event of [
    { kind: 'click', t: 1, point: [135, 165] },
    { kind: 'text', t: 120, chars: 'Hello' },
    { kind: 'key', t: 300, key: 's', modifiers: ['meta'] },
  ]) recording.add({ event, snapshot });
  const captured = recording.finish();
  assert.deepEqual(captured.steps.map(step => step.kind), ['click', 'type', 'key']);
  assert.deepEqual(captured.setup, inferred);
});

test('analysis keeps settled conditions, honors deletions, and covers extra windows and long titles', async () => {
  const flow = await example('textedit.flow');
  const [app, ready] = inferSetup(flow.target);
  const steps = [
    { id: 'step-1', app: flow.target.app, window: flow.target.window },
    { id: 'step-2', app: 'com.apple.Notes', window: 'Notes' },
    { id: 'step-3', app: 'com.apple.Notes', window: 'Notes' },
  ];
  const deleted = {
    id: 'window-com-apple-notes-notes', name: 'Notes window', state: 'deleted',
    check: { target: { kind: 'element', role: 'window', name: 'Notes' }, expect: { property: 'exists', equals: true } },
    ensure: { kind: 'window_ready', app: 'com.apple.Notes', window: 'Notes' },
  };
  const settled = inferSetup(flow.target, steps, [{ ...app, state: 'confirmed' }, deleted]);
  assert.deepEqual(settled.map(condition => [condition.ensure.kind, condition.ensure.app]), [
    ['window_ready', flow.target.app], ['app_running', 'com.apple.Notes'],
  ]);
  assert.equal(settled.some(condition => condition.ensure.kind === 'window_ready' && condition.ensure.window === 'Notes'), false);

  const fresh = inferSetup(flow.target, steps);
  assert.deepEqual(fresh.map(condition => [condition.ensure.kind, condition.ensure.app]), [
    ['app_running', flow.target.app], ['window_ready', flow.target.app],
    ['app_running', 'com.apple.Notes'], ['window_ready', 'com.apple.Notes'],
  ]);
  assert.deepEqual(parseFlow({ ...flow, setup: fresh }).setup, fresh);

  const title = 'x'.repeat(256);
  const long = inferSetup({ app: flow.target.app, window: title });
  assert.ok(long.every(condition => condition.id.length <= 64 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(condition.id)));
  assert.deepEqual(parseFlow({ ...flow, target: { app: flow.target.app, window: title }, setup: long }).setup, long);
  assert.equal(ready.ensure.kind, 'window_ready');
});

test('the workbench draft confirms, retargets, deletes, and undoes preconditions', async () => {
  const flow = await example('textedit.flow');
  const conditions = inferSetup(flow.target);
  const draft = setupDraft(conditions);
  assert.equal(canUndo(draft, conditions[0].id), false);

  const confirmed = confirmCondition(draft, conditions[0].id);
  assert.equal(confirmed.state, 'confirmed');
  assert.deepEqual(confirmedSetup(draft.conditions).map(condition => condition.id), [conditions[0].id]);
  const entries = [{ id: 'click-body', action: flow.steps[0] }];
  let test = compileDraft({ target: flow.target, setup: draft.conditions }, 'Preconditions', entries);
  assert.deepEqual(test.setup, [confirmed]);
  assert.deepEqual(test.setup[0].ensure, { kind: 'app_running', app: flow.target.app });

  deleteCondition(draft, conditions[0].id);
  test = compileDraft({ target: flow.target, setup: draft.conditions }, 'Preconditions', entries);
  assert.equal('setup' in test, false);

  const retargeted = retargetCondition(draft, conditions[1].id, { app: 'com.apple.Notes', window: 'Notes' });
  assert.deepEqual(retargeted.ensure, { kind: 'window_ready', app: 'com.apple.Notes', window: 'Notes' });
  assert.deepEqual(retargeted.check.target, { kind: 'element', role: 'window', name: 'Notes' });
  assert.equal(retargeted.state, 'inferred');
  assert.match(retargeted.name, /Notes/);
  assert.throws(() => retargetCondition(draft, conditions[1].id, { app: ' ', window: 'Notes' }), /应用标识/);

  undoCondition(draft, conditions[1].id);
  assert.deepEqual(draft.conditions[1], conditions[1]);
  undoCondition(draft, conditions[0].id);
  assert.equal(draft.conditions[0].state, 'confirmed');
  assert.equal(canUndo(draft, conditions[0].id), true);
  undoCondition(draft, conditions[0].id);
  assert.equal(draft.conditions[0].state, 'inferred');
  assert.equal(canUndo(draft, conditions[0].id), false);
});

test('saving drops inferred, invalid, and deleted conditions from both document shapes', async () => {
  const flow = await example('textedit.flow');
  const [app, ready] = inferSetup(flow.target);
  const confirmed = { ...ready, state: 'confirmed' };
  const kept = keepConfirmedSetup({ ...flow, setup: [app, confirmed, { ...app, state: 'invalid' }] });
  assert.deepEqual(kept.setup, [confirmed]);
  assert.equal('setup' in keepConfirmedSetup({ ...flow, setup: [app] }), false);
  assert.equal(keepConfirmedSetup(flow), flow);

  const wrapped = { format: 'cuekeeper-test', version: 1, flow: { ...flow, setup: [app, confirmed] }, secrets: [] };
  const keptWrapped = keepConfirmedSetup(wrapped);
  assert.deepEqual(keptWrapped.flow.setup, [confirmed]);
  assert.equal(keptWrapped.secrets, wrapped.secrets);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-preconditions-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const [flow, snapshot] = await Promise.all([example('textedit.flow'), example('textedit.snapshot')]);
  const report = await runFlow(flow, offlineDesktop(snapshot, flow.target), { dryRun: true, signal });
  await Promise.all([
    writeFile(join(directory, 'flow.json'), JSON.stringify(flow)),
    writeFile(join(directory, 'report.json'), JSON.stringify(report)),
    writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot)),
  ]);
  return { root, directory, flow };
}

test('the workbench analyzes an imported recording, saves confirmed conditions, and skips the rest', async t => {
  const { root, directory, flow } = await fixture(t);
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
  assert.deepEqual(session.setup.map(condition => [condition.state, condition.ensure.kind]), [
    ['inferred', 'app_running'], ['inferred', 'window_ready'],
  ]);

  // The served page carries the precondition panel the analysis feeds.
  const page = await (await fetch(url)).text();
  assert.match(page, /id="setup" class="setup-list"/);
  assert.match(await (await fetch(`${url}/app.js`)).text(), /function renderSetup\(/);

  const draft = setupDraft(session.setup);
  const entries = session.timeline.map(row => ({ id: row.id, action: row.action }));
  // A test item may still carry unconfirmed suggestions from an older build.
  const pending = {
    ...compileDraft({ ...session, setup: draft.conditions }, '推断条件', entries), setup: session.setup,
  };
  const skipped = await post('run', { session: session.id, test: pending, mode: 'offline' });
  assert.equal(skipped.status, 'passed');
  assert.deepEqual(skipped.entries.filter(entry => entry.kind === 'setup')
    .map(entry => [entry.status, entry.message]), [
    ['skipped', 'Setup state is inferred'], ['skipped', 'Setup state is inferred'],
  ]);

  const confirmed = confirmCondition(draft, session.setup[1].id);
  const test = compileDraft({ ...session, setup: draft.conditions }, '确认条件', entries);
  assert.deepEqual(test.setup, [confirmed]);
  const { output } = await post('save', { session: session.id, test }, 201);
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(saved.setup, [confirmed]);
  assert.deepEqual(saved.setup[0].ensure, { kind: 'window_ready', app: flow.target.app, window: flow.target.window });

  // A hand-built test that still carries inferred conditions loses them on save.
  const onlyConfirmed = { ...session.setup[0], id: 'only-confirmed', state: 'confirmed' };
  const mixed = { ...flow, setup: [...session.setup, onlyConfirmed] };
  const { output: second } = await post('save', { session: session.id, test: mixed }, 201);
  const kept = JSON.parse(await readFile(second, 'utf8'));
  assert.deepEqual(kept.setup.map(condition => [condition.id, condition.state]), [['only-confirmed', 'confirmed']]);

  const run = await post('run', { session: session.id, test, mode: 'offline' });
  assert.deepEqual(run.entries.map(entry => [entry.kind, entry.status]),
    [['setup', 'resolved'], ['click', 'resolved'], ['type', 'resolved'], ['key', 'resolved']]);

  const cli = spawnSync(process.execPath, [cliPath, 'run', output, '--dry-run',
    '--snapshot', join(directory, 'snapshot.json'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).data.entries.map(entry => entry.status),
    ['resolved', 'resolved', 'resolved', 'resolved']);
});

test('a confirmed window condition runs its ensure before the check and blocks when repair fails', async () => {
  const flow = await example('textedit.flow');
  const fixture = await example('textedit.snapshot');
  const snapshot = parseSnapshot(fixture.data, fixture.target);
  const [app, ready] = inferSetup(flow.target);
  const confirmed = { ...ready, state: 'confirmed' };
  const step = flow.steps[0];

  const ensured = [];
  let open = false;
  const repairing = {
    ...offlineDesktop(fixture, flow.target),
    async snapshot(...args) {
      if (!open) throw new Fault('WINDOW_NOT_FOUND', 'The target window is not open');
      return offlineDesktop(fixture, flow.target).snapshot(...args);
    },
    async ensure(action) { ensured.push(action); open = true; return snapshot.windowId; },
    click: async () => 'delivered_verified',
  };
  const repaired = await runFlow(parseFlow({ ...flow, setup: [confirmed], steps: [step] }), repairing,
    { dryRun: false, signal });
  assert.equal(repaired.status, 'passed');
  assert.deepEqual(ensured, [{ kind: 'window_ready', app: flow.target.app, window: flow.target.window }]);
  assert.deepEqual(repaired.entries.map(entry => [entry.kind, entry.status]), [['setup', 'passed'], ['click', 'passed']]);
  assert.deepEqual(repaired.entries[0].repair, { attempted: true, kind: 'window_ready', result: 'passed' });

  // An inferred suggestion is skipped and never starts a repair.
  const untouched = [];
  const skipped = await runFlow(parseFlow({ ...flow, setup: [app, ready], steps: [step] }), {
    ...offlineDesktop(fixture, flow.target),
    async ensure(action) { untouched.push(action); },
    click: async () => 'delivered_verified',
  }, { dryRun: false, signal });
  assert.deepEqual(untouched, []);
  assert.deepEqual(skipped.entries.map(entry => [entry.kind, entry.status]), [
    ['setup', 'skipped'], ['setup', 'skipped'], ['click', 'passed'],
  ]);

  // A repair that returns without the window blocks input with the existing codes.
  const broken = {
    ...offlineDesktop(fixture, flow.target),
    async snapshot() { throw new Fault('WINDOW_NOT_FOUND', 'The target window is not open'); },
    async ensure() { return 'w-9999'; },
    click: async () => 'delivered_verified',
  };
  const failed = await runFlow(parseFlow({ ...flow, setup: [confirmed], steps: [step] }), broken,
    { dryRun: false, signal });
  assert.equal(failed.status, 'blocked');
  assert.deepEqual(failed.entries.map(entry => [entry.kind, entry.status, entry.code]), [
    ['setup', 'blocked', 'ENSURE_FAILED'], ['click', 'blocked', undefined],
  ]);
  assert.deepEqual(failed.entries[0].repair,
    { attempted: true, kind: 'window_ready', result: 'failed', code: 'WINDOW_NOT_FOUND' });
});

test('a confirmed app condition for another app reads and repairs that app window', async () => {
  const flow = await example('textedit.flow');
  const fixture = await example('textedit.snapshot');
  const notes = {
    id: 'app-notes', name: '应用已启动 · com.apple.Notes', state: 'confirmed',
    check: { target: { kind: 'element', role: 'window', name: 'Notes' }, expect: { property: 'exists', equals: true } },
    ensure: { kind: 'app_running', app: 'com.apple.Notes' },
  };
  const notesTree = { windowId: 'w-notes', tree: { role: 'window', name: 'Notes', states: [], secure: false, children: [] } };
  const targets = [];
  const ensured = [];
  let running = false;
  const desktop = {
    ...offlineDesktop(fixture, flow.target),
    async snapshot(target, ...rest) {
      targets.push(target);
      if (target.app === 'com.apple.Notes') {
        if (!running) throw new Fault('APP_NOT_FOUND', 'Notes is not running');
        return notesTree;
      }
      return offlineDesktop(fixture, flow.target).snapshot(target, ...rest);
    },
    async ensure(action) { ensured.push(action); running = true; return 'w-notes'; },
    click: async () => 'delivered_verified',
  };
  const report = await runFlow(parseFlow({ ...flow, setup: [notes], steps: [flow.steps[0]] }), desktop,
    { dryRun: false, signal });
  assert.equal(report.status, 'passed');
  assert.deepEqual(ensured, [{ kind: 'app_running', app: 'com.apple.Notes' }]);
  assert.deepEqual(targets.map(target => target.app),
    ['com.apple.Notes', 'com.apple.Notes', flow.target.app]);
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [['setup', 'passed'], ['click', 'passed']]);
});
