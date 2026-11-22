import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportV2Check } from '../dist/contracts-v2.js';
import { hashFlow } from '../dist/flow.js';
import {
  dryRunFlowV2, hashFlowV2, parseFlowV2, planFlowV2, scopeLabel,
} from '../dist/flow-v2.js';
import { loadSession } from '../dist/workbench-session.js';
import { startWorkbench } from '../dist/workbench.js';
import { scopeDescription } from '../workbench/model.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const schema = name => JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20_000,
  });
  return { code: result.status, stderr: result.stderr, ...(result.stdout ? JSON.parse(result.stdout) : {}) };
}

/** Same object, different key insertion order; the canonical hash must not care. */
function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorderKeys(value[key])]));
  }
  return value;
}

const crossApp = () => example('cross-app.flow');
const globalFlow = () => example('global-two-apps.flow');

test('v1 fixtures keep their parser, hash and dry run', () => {
  const flow = example('textedit.flow');
  // Captured from the shipped v1 implementation; a change here means a v1 file
  // would no longer be recognised as the same flow.
  assert.equal(hashFlow(flow), 'e283c7bcbff38770232a414069365a22423ebecab6b7d6328ab30b75c99288e8');
  const dry = cli(['run', 'examples/textedit.flow.json', '--dry-run', '--snapshot', 'examples/textedit.snapshot.json']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(dry.data.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['type', 'resolved'], ['key', 'resolved'],
  ]);
  assert.deepEqual(cli(['flow', 'validate', 'examples/textedit.flow.json']).data, {
    flowId: 'textedit-save', actions: 3,
  });
  // The v1 schema files are untouched by the v2 contract.
  assert.equal(schema('flow').title, 'Cuekeeper flow v1');
  assert.equal(schema('report').title, 'Cuekeeper report v1');
});

test('v2 schemas are published as closed objects', () => {
  const flow = schema('flow-v2');
  assert.equal(flow.title, 'Cuekeeper flow-v2 v2');
  assert.equal(flow.additionalProperties, false);
  assert.equal(flow.properties.version.const, 2);
  assert.equal(flow.properties.target, undefined);
  const report = schema('report-v2');
  assert.equal(report.title, 'Cuekeeper report-v2 v2');
  assert.equal(report.additionalProperties, false);
  assert.equal(report.properties.version.const, 2);
  assert.ok(report.properties.entries.items.properties.textMode);
  assert.ok(report.properties.entries.items.properties.input);
  assert.ok(report.properties.entries.items.properties.checkpoint);
  assert.ok(report.properties.entries.items.properties.focusAfter);
});

test('report v2 describes text mode and checkpoints without carrying text', () => {
  const base = {
    version: 2,
    flowId: 'metadata-smoke',
    flowSha256: 'a'.repeat(64),
    startedAt: '2026-11-22T04:30:00.000Z',
    mode: 'replay',
    status: 'passed',
  };
  const inputEntry = {
    id: 's1', kind: 'type', status: 'passed', atMs: 0, durationMs: 10,
    textMode: 'input', input: 'login_url',
  };
  const literalEntry = {
    id: 's2', kind: 'type', status: 'passed', atMs: 10, durationMs: 10,
    textMode: 'literal',
  };
  const checkpointEntry = {
    id: 's3', kind: 'manual_checkpoint', status: 'passed', atMs: 20, durationMs: 30,
    checkpoint: {
      reason: 'secure_input', triggerStepId: 's2', confirmedBy: 'operator', timeoutMs: 120_000,
    },
  };
  assert.ok(reportV2Check.Check({ ...base, entries: [inputEntry, literalEntry, checkpointEntry] }));

  // The report never accepts the typed characters; only safe metadata.
  assert.equal(reportV2Check.Check({
    ...base, entries: [{ ...inputEntry, text: 'secret' }],
  }), false);
  assert.equal(reportV2Check.Check({
    ...base, entries: [{ id: 's3', kind: 'manual_checkpoint', status: 'passed',
      atMs: 0, durationMs: 1, checkpoint: { reason: 'secure_input' } }],
  }), false);
});

test('the v2 example validates and reports its scopes', () => {
  const flow = parseFlowV2(crossApp());
  assert.equal(planFlowV2(flow).length, 3);
  assert.equal(scopeLabel(flow.steps[0].scope), 'com.apple.TextEdit · QA Notes (editor)');
  const validated = cli(['flow', 'validate', 'examples/cross-app.flow.json']);
  assert.equal(validated.code, 0, validated.stderr);
  assert.deepEqual(validated.data, { flowId: 'cross-app-smoke', actions: 3, version: 2 });

  const global = parseFlowV2(globalFlow());
  assert.equal(planFlowV2(global).length, 8);
  assert.deepEqual(
    planFlowV2(parseFlowV2(example('global-two-apps.flow'))).map(step => step.id),
    ['launch-browser', 'wait-browser', 'type-address', 'copy-address',
      'switch-notes', 'paste-address', 'type-note', 'assert-editor'],
  );

  // The contract is closed: an unknown top-level key is not silently accepted.
  assert.throws(() => parseFlowV2({ ...crossApp(), target: { app: 'com.apple.TextEdit', window: 'x' } }),
    /Invalid flow version 2/);

  // A bound window key follows its window after a title change; the title is a
  // display label, the app binding is what keeps the steps on the same window.
  const retitled = globalFlow();
  retitled.steps.find(step => step.id === 'type-note').scope.windowKey = 'notes';
  assert.equal(parseFlowV2(retitled).steps[6].scope.windowTitle, 'QA Draft');
});

test('a v2 dry run resolves every scope without starting the desktop driver', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-v2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'desktop-called');
  const stub = join(dir, 'desktop');
  writeFileSync(stub, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');
console.log(JSON.stringify({ version: '2.6', command: process.argv[2], ok: true, data: {} }));
`, { mode: 0o700 });
  const env = { CUEKEEPER_AGENT_DESKTOP: stub };

  const reportPath = join(dir, 'report.json');
  const dry = cli(['run', 'examples/global-two-apps.flow.json', '--dry-run', '--report', reportPath], env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.data.mode, 'dry-run');
  assert.equal(dry.data.status, 'passed');
  assert.equal(dry.data.version, 2);
  assert.equal(dry.data.flowSha256, hashFlowV2(parseFlowV2(globalFlow())));
  assert.deepEqual(dry.data.entries.map(entry => [entry.id, entry.kind, entry.status]), [
    ['launch-browser', 'launch_app', 'resolved'],
    ['wait-browser', 'wait', 'resolved'],
    ['type-address', 'type', 'resolved'],
    ['copy-address', 'key', 'resolved'],
    ['switch-notes', 'activate_app', 'resolved'],
    ['paste-address', 'paste', 'resolved'],
    ['type-note', 'type', 'resolved'],
    ['assert-editor', 'assert', 'resolved'],
  ]);
  assert.deepEqual(dry.data.entries[1].scope, {
    kind: 'window', app: 'com.apple.Safari', windowKey: 'browser', windowTitle: 'Cuekeeper 测试页',
  });
  assert.ok(reportV2Check.Check(JSON.parse(readFileSync(reportPath, 'utf8'))));

  // A capture gap is refused before any desktop call, at both entry points.
  const gapFlow = crossApp();
  gapFlow.steps.push({ id: 'gap-1', kind: 'gap', code: 'CAPTURE_SCOPE_UNVERIFIED' });
  const gapPath = join(dir, 'gap.flow.json');
  writeFileSync(gapPath, JSON.stringify(gapFlow));
  const gapRun = cli(['run', gapPath, '--dry-run'], env);
  assert.equal(gapRun.code, 1);
  assert.equal(gapRun.error.code, 'CAPTURE_GAP');
  const gapValidate = cli(['flow', 'validate', gapPath], env);
  assert.equal(gapValidate.code, 1);
  assert.equal(gapValidate.error.code, 'CAPTURE_GAP');

  assert.equal(existsSync(marker), false, 'no desktop driver may run for validate, dry-run or a gap');
});

test('v2 rejects missing scope, bound window keys, app paths, surfaces, IDs and references', () => {
  const missingScope = crossApp();
  delete missingScope.steps[0].scope;
  assert.throws(() => parseFlowV2(missingScope), /Invalid flow version 2/);

  const rebound = crossApp();
  rebound.steps.push({
    id: 'rebind', kind: 'assert',
    scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'files', windowTitle: 'QA Files' },
    check: { target: { kind: 'window' }, expect: { property: 'exists', equals: true } },
  });
  assert.throws(() => parseFlowV2(rebound), /windowKey files is already bound to com.apple.finder/);

  const unusedPath = crossApp();
  unusedPath.appPaths['com.example.unused'] = '/Applications/Unused.app';
  assert.throws(() => parseFlowV2(unusedPath), /not referenced by any step/);

  const relativePath = crossApp();
  relativePath.appPaths['com.apple.TextEdit'] = 'Applications/TextEdit.app';
  assert.throws(() => parseFlowV2(relativePath), /Invalid flow version 2/);

  const notBundle = crossApp();
  notBundle.appPaths['com.apple.TextEdit'] = '/Applications/TextEdit';
  assert.throws(() => parseFlowV2(notBundle), /expected a \.app bundle path/);

  const unknownSurface = globalFlow();
  unknownSurface.steps.push({
    id: 'bad-surface', kind: 'open_system_surface',
    scope: { kind: 'surface', surface: 'taskbar' },
  });
  assert.throws(() => parseFlowV2(unknownSurface), /Invalid flow version 2/);

  const duplicate = crossApp();
  duplicate.steps.push(structuredClone(duplicate.steps[0]));
  assert.throws(() => parseFlowV2(duplicate), /duplicate id s1/);

  const undeclared = globalFlow();
  undeclared.steps[2].input = 'unknownInput';
  assert.throws(() => parseFlowV2(undeclared), /input unknownInput is not declared/);

  const badCopy = globalFlow();
  badCopy.steps.find(step => step.id === 'copy-address').key = 'v';
  assert.throws(() => parseFlowV2(badCopy), /is not a Cmd\+C step/);

  const forwardCopy = globalFlow();
  forwardCopy.steps.find(step => step.id === 'paste-address').source.stepId = 'type-note';
  assert.throws(() => parseFlowV2(forwardCopy), /copy source type-note/);

  const orphanCheckpoint = crossApp();
  orphanCheckpoint.steps.push({
    id: 'checkpoint', kind: 'manual_checkpoint',
    scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'editor', windowTitle: 'QA Notes' },
    triggerStepId: 's1', reason: 'secure_input',
    resume: {
      scope: { kind: 'window', app: 'com.apple.TextEdit', windowKey: 'editor', windowTitle: 'QA Notes' },
      check: { kind: 'window_exists', equals: true },
    },
  });
  // s1 is not adjacent: s2 and s3 sit between the trigger and the checkpoint.
  assert.throws(() => parseFlowV2(orphanCheckpoint), /must name the immediately preceding step/);
});

test('v2 intents are contiguous, non-overlapping and carried by the hash', () => {
  const intent = (id, sourceStepIds, extra = {}) => ({
    id, action: 'open_file', params: {}, sourceStepIds, equivalence: 'same_ui',
    observableEffects: [{
      kind: 'window_present',
      scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'files', windowTitle: 'QA Files' },
      check: { kind: 'window_exists', equals: true },
    }],
    ...extra,
  });
  const withIntent = crossApp();
  withIntent.intents = [intent('open-notes', ['s1'])];
  const flow = parseFlowV2(withIntent);
  assert.equal(flow.intents.length, 1);
  assert.notEqual(hashFlowV2(flow), hashFlowV2(parseFlowV2(crossApp())));

  const nonContiguous = crossApp();
  nonContiguous.intents = [intent('jump', ['s1', 's3'])];
  assert.throws(() => parseFlowV2(nonContiguous), /contiguous run/);

  const overlapping = crossApp();
  overlapping.intents = [intent('first', ['s2']), intent('second', ['s2', 's3'])];
  assert.throws(() => parseFlowV2(overlapping), /claimed by another intent/);

  const duplicateIntent = crossApp();
  duplicateIntent.intents = [intent('same', ['s1']), intent('same', ['s2'])];
  assert.throws(() => parseFlowV2(duplicateIntent), /duplicate intent id/);

  const skipped = crossApp();
  skipped.intents = [intent('narrow', ['s1'], { skippedUiStepIds: ['s3'] })];
  assert.throws(() => parseFlowV2(skipped), /not an ordered subset/);

  const surfaceEffect = crossApp();
  surfaceEffect.intents = [intent('dock', ['s1'], {
    observableEffects: [{
      kind: 'dock_icon', scope: { kind: 'surface', surface: 'dock' },
      check: { kind: 'window_exists', equals: true },
    }],
  })];
  assert.throws(() => parseFlowV2(surfaceEffect), /cannot observe a system surface/);
});

test('the v2 canonical hash ignores key order and tracks scope, order and intents', () => {
  const flow = parseFlowV2(crossApp());
  const reordered = parseFlowV2(reorderKeys(crossApp()));
  assert.equal(hashFlowV2(reordered), hashFlowV2(flow));

  const changedScope = crossApp();
  changedScope.steps[0].scope.windowKey = 'editor-2';
  assert.notEqual(hashFlowV2(parseFlowV2(changedScope)), hashFlowV2(flow));

  const reorderedSteps = crossApp();
  reorderedSteps.steps = [reorderedSteps.steps[1], reorderedSteps.steps[0], reorderedSteps.steps[2]];
  assert.notEqual(hashFlowV2(parseFlowV2(reorderedSteps)), hashFlowV2(flow));

  const withIntent = crossApp();
  withIntent.intents = [{
    id: 'switch', action: 'switch_app', params: {}, sourceStepIds: ['s2'],
    equivalence: 'same_ui',
    observableEffects: [{
      kind: 'finder_front', scope: { kind: 'app', app: 'com.apple.finder' },
      check: { kind: 'app_running', equals: true },
    }],
  }];
  assert.notEqual(hashFlowV2(parseFlowV2(withIntent)), hashFlowV2(flow));
});

test('v2 live replay needs --foreground; batch, snapshots and packing still refuse v2', t => {
  const live = cli(['run', 'examples/global-two-apps.flow.json']);
  assert.equal(live.code, 2);
  assert.equal(live.error.code, 'FOREGROUND_REQUIRED');

  const batch = cli(['run', 'examples/global-two-apps.flow.json', '--dry-run', '--data', 'rows.json']);
  assert.equal(batch.code, 2);
  assert.equal(batch.error.code, 'UNSUPPORTED_FLOW_VERSION');

  const snapshot = cli(['run', 'examples/global-two-apps.flow.json', '--dry-run',
    '--snapshot', 'examples/textedit.snapshot.json']);
  assert.equal(snapshot.code, 2);
  assert.equal(snapshot.error.code, 'UNSUPPORTED_FLOW_VERSION');

  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-v2-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flowPath = join(dir, 'flow.json');
  const reportPath = join(dir, 'report.json');
  writeFileSync(flowPath, JSON.stringify(globalFlow()));
  writeFileSync(reportPath, JSON.stringify(dryRunFlowV2(parseFlowV2(globalFlow()))));
  const pack = cli(['report', 'pack', reportPath, '--flow', flowPath, '--out', join(dir, 'report.zip'), '--no-upload']);
  assert.equal(pack.code, 2);
  assert.equal(pack.error.code, 'UNSUPPORTED_FLOW_VERSION');
});

test('the workbench labels every v2 scope kind for the timeline', () => {
  const name = id => ({ 'com.apple.TextEdit': 'TextEdit', 'com.apple.finder': 'Finder' })[id] ?? id;
  assert.equal(scopeDescription({
    kind: 'window', app: 'com.apple.TextEdit', windowKey: 'editor', windowTitle: 'QA Notes',
  }, name), 'TextEdit · QA Notes');
  assert.equal(scopeDescription({ kind: 'app', app: 'com.apple.finder' }, name), 'Finder · 应用');
  assert.equal(scopeDescription({ kind: 'surface', surface: 'dock' }, name), 'Dock');
  assert.equal(scopeDescription({ kind: 'surface', surface: 'spotlight' }, name), 'Spotlight');
  assert.equal(scopeDescription({
    kind: 'surface', surface: 'app_context_menu', app: 'com.apple.finder',
    windowKey: 'files', windowTitle: 'QA Files',
  }, name), '上下文菜单 · Finder · QA Files');
  assert.equal(scopeDescription(undefined, name), '缺口');
});

test('the workbench loads a v2 timeline by scope and stays read-only', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-v2-workbench-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  mkdirSync(directory);
  const flow = parseFlowV2(globalFlow());
  const report = dryRunFlowV2(flow);
  writeFileSync(join(directory, 'flow.json'), JSON.stringify(flow));
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
  writeFileSync(join(directory, 'actions.json'), JSON.stringify({
    version: 2, flowId: flow.id, durationMs: 2400,
    actions: [
      { id: 'wait-browser', atMs: 500, durationMs: 20 },
      { id: 'type-address', atMs: 600, durationMs: 30 },
    ],
  }));

  const session = await loadSession(directory);
  assert.equal(session.view.version, 2);
  assert.equal(session.view.target, undefined);
  assert.deepEqual(session.view.timeline.map(row => row.id), flow.steps.map(step => step.id));
  assert.deepEqual(session.view.scopeGroups.map(group => [group.kind, group.stepIds.length]), [
    ['app', 1], ['window', 3], ['app', 1], ['window', 1], ['window', 2],
  ]);
  assert.deepEqual(session.view.timeline.map(row => row.groupStart),
    [true, true, false, false, true, true, true, false]);
  assert.equal(session.view.timeline[0].scope.app, 'com.apple.Safari');
  assert.equal(session.view.timeline[1].atMs, 500);
  assert.equal(session.view.durationMs, 2400);
  assert.equal(session.view.timingSource, 'capture');

  // A report for a different flow cannot be attached to this session.
  const foreign = join(root, 'run-foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'flow.json'), JSON.stringify(flow));
  writeFileSync(join(foreign, 'report.json'), JSON.stringify({ ...report, flowSha256: '0'.repeat(64) }));
  await assert.rejects(loadSession(foreign), /does not match the selected version 2 flow/);

  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, library: join(root, 'library'), signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  async function post(route, payload) {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }
  const imported = await post('import', { directory });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.version, 2);
  assert.equal(imported.body.scopeGroups.length, 5);

  const state = await post('state', {});
  assert.equal(state.body.session.version, 2);
  for (const route of ['plan', 'save', 'run']) {
    const rejected = await post(route, { session: imported.body.id, test: {}, mode: 'offline' });
    assert.equal(rejected.status, 400, `${route}: ${JSON.stringify(rejected.body)}`);
    assert.match(rejected.body.error, /UNSUPPORTED_FLOW_VERSION/);
  }
});
