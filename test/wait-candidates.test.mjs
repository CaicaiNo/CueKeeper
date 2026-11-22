import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFlowV2 } from '../dist/flow-v2.js';
import {
  confirmWaitCandidate, parseLifecycleDocument, proposeWaitCandidates,
} from '../dist/wait-candidates.js';
import { loadSession } from '../dist/workbench-session.js';
import { startWorkbench } from '../dist/workbench.js';

const web = 'com.example.Web';
const targetApp = 'com.example.CuekeeperTest';
const uninstaller = 'com.example.Uninstaller';

const browserWindow = { kind: 'window', app: web, windowKey: 'browser', windowTitle: 'Downloads' };
const targetWindow = { kind: 'window', app: targetApp, windowKey: 'app', windowTitle: 'CuekeeperTest' };

function candidateFlow() {
  return parseFlowV2({
    version: 2,
    id: 'wait-candidates',
    name: 'Wait candidates',
    appPaths: {
      [web]: '/Applications/Web.app',
      [targetApp]: '/Applications/CuekeeperTest.app',
    },
    steps: [
      { id: 'launch-browser', kind: 'launch_app', scope: { kind: 'app', app: web }, focusAfter: browserWindow },
      { id: 'wait-page', kind: 'wait', scope: browserWindow, check: { kind: 'window_exists', equals: true } },
      {
        id: 'download', kind: 'click', scope: browserWindow,
        target: { kind: 'element', role: 'button', name: 'Download' },
      },
      {
        id: 'type-name', kind: 'type', scope: targetWindow,
        target: { kind: 'element', role: 'textfield', name: 'Name' }, text: 'hello',
      },
    ],
  });
}

const events = [
  { at: 10, kind: 'download_completed', app: web, path: '/Users/qa/Downloads/CuekeeperTest.pkg', afterStepId: 'download' },
  { at: 20, kind: 'install_completed', app: targetApp, afterStepId: 'download' },
  { at: 30, kind: 'app_appeared', app: targetApp, windowTitle: 'CuekeeperTest', afterStepId: 'download' },
  { at: 40, kind: 'uninstaller_shown', app: uninstaller, afterStepId: 'type-name' },
  { at: 50, kind: 'app_disappeared', app: targetApp, afterStepId: 'type-name' },
];

test('lifecycle events become confirmed waits; a named download waits on its file', () => {
  const flow = candidateFlow();
  const candidates = proposeWaitCandidates(flow, parseLifecycleDocument({ version: 1, events }));

  assert.deepEqual(candidates.map(candidate => [candidate.eventKind, candidate.afterStepId, candidate.ready, candidate.step?.kind]), [
    ['download_completed', 'download', true, 'wait'],
    ['install_completed', 'download', true, 'wait'],
    ['app_appeared', 'download', true, 'wait'],
    ['uninstaller_shown', 'type-name', true, 'wait'],
    ['app_disappeared', 'type-name', true, 'wait'],
  ]);

  // A completed download names its file, so the candidate waits on the file
  // itself: no download-UI element and no hand-written condition.
  assert.deepEqual(candidates[0].step.scope, {
    kind: 'file', directory: '/Users/qa/Downloads', name: 'CuekeeperTest.pkg',
  });
  assert.deepEqual(candidates[0].step.check, { kind: 'file_stable' });

  const installed = candidates[1].step;
  assert.deepEqual(installed.scope, { kind: 'app', app: targetApp });
  assert.deepEqual(installed.check, { kind: 'app_installed', equals: true });
  // An app appearance reuses the recorded window scope instead of inventing one.
  assert.deepEqual(candidates[2].step.scope, targetWindow);
  assert.deepEqual(candidates[2].step.check, { kind: 'window_exists', equals: true });
  // No window was recorded for the uninstaller, so the candidate waits for the app.
  assert.deepEqual(candidates[3].step.scope, { kind: 'app', app: uninstaller });
  assert.deepEqual(candidates[3].step.check, { kind: 'app_running', equals: true });
  assert.deepEqual(candidates[4].step.check, { kind: 'app_installed', equals: false });
  assert.match(candidates[0].reason, /下载完成/);

  // A download event without the finished file has no evidence to wait on: the
  // candidate stays open instead of guessing a UI condition.
  const withoutPath = proposeWaitCandidates(flow, [
    { at: 10, kind: 'download_completed', app: web, afterStepId: 'download' },
  ]);
  assert.equal(withoutPath[0].ready, false);
  assert.equal(withoutPath[0].step, undefined);
});

test('an uninstall_completed event becomes the same removal wait as app_disappeared', () => {
  const flow = candidateFlow();
  const candidates = proposeWaitCandidates(flow, parseLifecycleDocument({
    version: 1,
    events: [{ at: 10, kind: 'uninstall_completed', app: targetApp, afterStepId: 'type-name' }],
  }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ready, true);
  assert.deepEqual(candidates[0].step.check, { kind: 'app_installed', equals: false });
  assert.match(candidates[0].reason, /卸载完成/);
});

test('an idle stretch and an unplaceable event never become a candidate', () => {
  const flow = candidateFlow();
  // Events without a step time or explicit position cannot be placed safely.
  const unplaced = proposeWaitCandidates(flow, [
    { at: 500, kind: 'install_completed', app: targetApp },
  ]);
  assert.deepEqual(unplaced, []);

  // Step times place an event after the last recorded step, not in the idle gap.
  const timed = proposeWaitCandidates(flow, [
    { at: 150, kind: 'install_completed', app: targetApp },
  ], { stepTimes: new Map([['launch-browser', 0], ['wait-page', 100], ['download', 200]]) });
  assert.deepEqual(timed.map(candidate => candidate.afterStepId), ['wait-page']);

  // An event that only names a time before the first step has no position.
  assert.deepEqual(proposeWaitCandidates(flow, [
    { at: 0, kind: 'install_completed', app: targetApp },
  ], { stepTimes: new Map([['download', 100]]) }), []);

  // The same wait already sits after the step: no duplicate candidate.
  const duplicated = parseFlowV2({
    ...structuredClone(candidateFlow()),
    appPaths: { [web]: '/Applications/Web.app', [targetApp]: '/Applications/CuekeeperTest.app' },
    steps: [
      { id: 'launch-browser', kind: 'launch_app', scope: { kind: 'app', app: web }, focusAfter: browserWindow },
      {
        id: 'wait-installed', kind: 'wait', scope: { kind: 'app', app: targetApp },
        check: { kind: 'app_installed', equals: true },
      },
      {
        id: 'type-name', kind: 'type', scope: targetWindow,
        target: { kind: 'element', role: 'textfield', name: 'Name' }, text: 'hello',
      },
    ],
  });
  assert.deepEqual(proposeWaitCandidates(duplicated, [
    { at: 10, kind: 'install_completed', app: targetApp, afterStepId: 'launch-browser' },
  ]), []);
});

test('lifecycle documents are closed and validated', () => {
  assert.throws(() => parseLifecycleDocument({ version: 2, events: [] }), error => {
    assert.equal(error.code, 'WAIT_EVENT_INVALID');
    return true;
  });
  assert.throws(() => parseLifecycleDocument({
    version: 1, events: [{ at: 1, kind: 'teleported', app: targetApp }],
  }), /kind is unknown/);
  assert.throws(() => parseLifecycleDocument({
    version: 1, events: [{ at: -1, kind: 'install_completed', app: targetApp }],
  }), /at must be a nonnegative integer/);
  assert.throws(() => parseLifecycleDocument({
    version: 1, events: [{ at: 1, kind: 'install_completed', app: 'not a bundle id' }],
  }), /app must be a bundle ID/);
});

test('confirming a candidate inserts one validated wait after the named step', () => {
  const flow = candidateFlow();
  const candidates = proposeWaitCandidates(flow, parseLifecycleDocument({ version: 1, events }));

  const next = confirmWaitCandidate(flow, candidates[1]);
  assert.deepEqual(next.steps.map(step => step.id), ['launch-browser', 'wait-page', 'download', 'wait-install-completed-1', 'type-name']);
  assert.deepEqual(next.steps[3].scope, { kind: 'app', app: targetApp });
  // The original document is untouched: the workbench never edits flow.json.
  assert.deepEqual(flow.steps.map(step => step.id), ['launch-browser', 'wait-page', 'download', 'type-name']);

  // A second confirmation on the confirmed copy appends after its own step.
  const withExisting = confirmWaitCandidate(next, candidates[4]);
  assert.deepEqual(withExisting.steps.map(step => step.id).slice(-2),
    ['type-name', 'wait-app-disappeared-1']);

  assert.throws(() => confirmWaitCandidate(flow, { ...candidates[1], afterStepId: 'gone' }), error => {
    assert.equal(error.code, 'WAIT_CANDIDATE_STALE');
    return true;
  });
  // A download whose finished file is unknown cannot be inserted: the wait has
  // no evidence yet, so confirming it is refused instead of guessed.
  const open = proposeWaitCandidates(flow, [
    { at: 10, kind: 'download_completed', afterStepId: 'download' },
  ])[0];
  assert.throws(() => confirmWaitCandidate(flow, open), error => {
    assert.equal(error.code, 'WAIT_CANDIDATE_INCOMPLETE');
    return true;
  });
  // The confirmed download candidate's file wait validates against the contract.
  const withFile = confirmWaitCandidate(flow, candidates[0]);
  assert.deepEqual(withFile.steps[3].scope,
    { kind: 'file', directory: '/Users/qa/Downloads', name: 'CuekeeperTest.pkg' });
});

test('the workbench exposes lifecycle candidates and writes a confirmed copy without replaying', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-wait-candidates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  mkdirSync(directory);
  writeFileSync(join(directory, 'flow.json'), JSON.stringify(candidateFlow()));
  // The last event names no finished file, so its candidate still needs a
  // user-chosen condition; every other event is ready to confirm.
  writeFileSync(join(directory, 'lifecycle.json'), JSON.stringify({
    version: 1,
    events: [...events, { at: 60, kind: 'download_completed', app: web, afterStepId: 'type-name' }],
  }));

  const session = await loadSession(directory);
  assert.equal(session.view.version, 2);
  assert.deepEqual(session.view.waitCandidates.map(candidate => candidate.eventKind), [
    'download_completed', 'install_completed', 'app_appeared', 'uninstaller_shown',
    'app_disappeared', 'download_completed',
  ]);

  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }

  const imported = await post('import', { directory });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const ready = imported.body.waitCandidates.find(candidate => candidate.eventKind === 'install_completed');
  const download = imported.body.waitCandidates.find(candidate =>
    candidate.eventKind === 'download_completed' && candidate.ready);
  const pending = imported.body.waitCandidates.filter(candidate =>
    candidate.eventKind === 'download_completed' && !candidate.ready);

  assert.equal(pending.length, 1);
  const incomplete = await post('wait-candidate', { session: imported.body.id, candidate: pending[0].id });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /WAIT_CANDIDATE_INCOMPLETE/);

  // A recorded download becomes a file wait without any hand-written condition.
  const withFile = await post('wait-candidate', { session: imported.body.id, candidate: download.id });
  assert.equal(withFile.status, 201, JSON.stringify(withFile.body));
  const fileFlow = JSON.parse(readFileSync(withFile.body.output, 'utf8'));
  const inserted = fileFlow.steps.find(step => step.scope?.kind === 'file');
  assert.deepEqual(inserted.scope, { kind: 'file', directory: '/Users/qa/Downloads', name: 'CuekeeperTest.pkg' });
  assert.deepEqual(inserted.check, { kind: 'file_stable' });

  const confirmed = await post('wait-candidate', { session: imported.body.id, candidate: ready.id });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.steps, 5);
  const written = JSON.parse(readFileSync(confirmed.body.output, 'utf8'));
  assert.deepEqual(written.steps.map(step => step.kind), ['launch_app', 'wait', 'click', 'wait', 'type']);
  assert.deepEqual(written.steps[3].check, { kind: 'app_installed', equals: true });
  // The reviewed flow.json is not rewritten; the confirmed copy is a sibling.
  const original = JSON.parse(readFileSync(join(directory, 'flow.json'), 'utf8'));
  assert.equal(original.steps.length, 4);
  assert.ok(confirmed.body.output.endsWith('flow.with-waits-2.json'));
});
