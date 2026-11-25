import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { flowV2Check, reportV2Check } from '../dist/contracts-v2.js';
import { hashFlow } from '../dist/flow.js';
import {
  dryRunFlowV2, hashFlowV2, parseFlowV2, planFlowV2, pointTargetSteps, scopeKey, scopeLabel,
} from '../dist/flow-v2.js';
import { loadSession } from '../dist/workbench-session.js';
import { startWorkbench } from '../dist/workbench.js';
import { scopeDescription, sessionDurationLabel } from '../workbench/model.js';

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

test('a step time is optional, never negative, and leaves older flows valid', () => {
  const untimed = crossApp();
  assert.equal(untimed.steps.some(step => 'atMs' in step), false);
  assert.equal(flowV2Check.Check(untimed), true);

  const timed = structuredClone(untimed);
  timed.steps.forEach((step, index) => { step.atMs = index * 620; });
  assert.equal(flowV2Check.Check(timed), true);
  assert.deepEqual(parseFlowV2(timed).steps.map(step => step.atMs), [0, 620, 1240]);
  // The published schema carries the field, so a hand-written flow is not a
  // special case the workbench has to guess at.
  assert.equal(schema('flow-v2').properties.steps.items.anyOf[0].properties.atMs.minimum, 0);

  const negative = structuredClone(timed);
  negative.steps[1].atMs = -1;
  assert.equal(flowV2Check.Check(negative), false);
  const fraction = structuredClone(timed);
  fraction.steps[1].atMs = 12.5;
  assert.equal(flowV2Check.Check(fraction), false);
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

test('a flow that kept a recorded screen point is refused by the dry run', t => {
  const flow = {
    version: 2, id: 'point-flow', name: '坐标点击',
    steps: [{
      id: 'click-1', kind: 'click',
      scope: { kind: 'window', app: 'com.apple.finder', windowKey: 'files', windowTitle: 'Downloads' },
      target: { kind: 'point', point: [420, 300] },
    }],
  };
  const parsed = parseFlowV2(flow);
  // The point is a legal v2 click target: it is recorded, and the timeline says
  // it needs confirmation. It is not a legal dry-run step.
  assert.deepEqual(pointTargetSteps(parsed).map(step => step.id), ['click-1']);
  assert.throws(() => dryRunFlowV2(parsed), error =>
    error.code === 'UNSAFE_POINT' && /click-1/.test(error.message));

  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-point-dry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'flow.json');
  writeFileSync(path, JSON.stringify(flow));
  const run = cli(['run', path, '--dry-run']);
  assert.equal(run.code, 1);
  assert.equal(run.error.code, 'UNSAFE_POINT');
  assert.match(run.error.message, /click-1/);
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
  assert.equal(scopeDescription({
    kind: 'file', directory: '/Users/qa/Downloads', name: 'App.pkg',
  }, name), '文件 · App.pkg（/Users/qa/Downloads）');
  assert.equal(scopeDescription({
    kind: 'file', directory: '/Users/qa/Downloads', suffix: '.pkg',
  }, name), '文件 · *.pkg（/Users/qa/Downloads）');
  assert.equal(scopeDescription(undefined, name), '缺口');
});

test('a v2 file wait is a closed contract that only a wait may use', () => {
  const withWait = step => parseFlowV2({
    version: 2, id: 'file-wait', name: 'File wait', steps: [step],
  });
  const fileWaits = [
    {
      id: 'wait-file', kind: 'wait', timeoutMs: 5000,
      scope: { kind: 'file', directory: '/Users/qa/Downloads', name: 'App.pkg' },
      check: { kind: 'file_stable', quietMs: 500 },
    },
    {
      id: 'wait-file', kind: 'wait', timeoutMs: 5000,
      scope: { kind: 'file', directory: '/Users/qa/Downloads', suffix: '.pkg' },
      check: { kind: 'file_exists', equals: true },
    },
  ];
  for (const step of fileWaits) assert.deepEqual(withWait(step).steps[0], step);

  // Name and suffix are alternatives, a file check needs a file scope, and the
  // quiet window stays inside its published bounds.
  for (const step of [
    { ...fileWaits[0], scope: { kind: 'file', directory: '/Users/qa/Downloads', name: 'a.pkg', suffix: '.pkg' } },
    { ...fileWaits[0], scope: { kind: 'file', directory: '/Users/qa/Downloads' } },
    { ...fileWaits[0], check: { kind: 'file_stable', quietMs: 50 } },
    { ...fileWaits[0], check: { kind: 'app_installed', equals: true } },
    { ...fileWaits[0], kind: 'click', target: { kind: 'element', role: 'button' } },
    { ...fileWaits[0], scope: { kind: 'file', directory: '/Users/qa/Downloads', name: 'a/b.pkg' } },
  ]) {
    assert.throws(() => withWait(step), /Invalid flow version 2/);
  }

  // The dry run and the published schema both carry the file scope.
  const flow = withWait(fileWaits[0]);
  assert.deepEqual(planFlowV2(flow)[0].scope, fileWaits[0].scope);
  assert.match(scopeLabel(fileWaits[0].scope), /App\.pkg/);
  const published = JSON.stringify(schema('flow-v2'));
  assert.match(published, /"file_stable"/);
  assert.match(published, /"file_exists"/);
});

test('the workbench shows a recording net of its pauses and keeps older flows valid', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-paused-workbench-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const paused = join(root, 'paused');
  mkdirSync(paused);
  const flow = parseFlowV2(globalFlow());
  flow.startedAt = '2026-11-22T10:00:00.000Z';
  flow.pausedMs = 5000;
  flow.steps.forEach((step, index) => { step.atMs = index * 620; });
  writeFileSync(join(paused, 'flow.json'), JSON.stringify(flow));

  const session = await loadSession(paused);
  // The step times are the recording's own, so the summary can name when it
  // started and how long it was paused.
  assert.equal(session.view.timingSource, 'capture');
  assert.equal(session.view.startedAt, '2026-11-22T10:00:00.000Z');
  assert.equal(session.view.pausedMs, 5000);
  // The duration is the net time; the paused span is called out beside it.
  assert.equal(session.view.durationMs, flow.steps.at(-1).atMs);
  assert.equal(sessionDurationLabel(session.view.durationMs, session.view.pausedMs), '4.34 s · 含暂停 5.00 s');

  // A flow recorded before these fields existed still opens, with no pause claim.
  const legacy = join(root, 'legacy');
  mkdirSync(legacy);
  const untimed = parseFlowV2(globalFlow());
  writeFileSync(join(legacy, 'flow.json'), JSON.stringify(untimed));
  const old = await loadSession(legacy);
  assert.equal(old.view.startedAt, undefined);
  assert.equal(old.view.pausedMs, undefined);
  assert.equal(sessionDurationLabel(old.view.durationMs, old.view.pausedMs), '—');
});

test('the workbench loads a v2 timeline by scope and exposes the v2 editor contract', async t => {
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
  assert.equal(state.body.session.v2.diff.changed, false);
  assert.equal(state.body.session.v2.flow.id, flow.id);
  // The v1-only plan endpoint stays closed for a v2 session.
  const planned = await post('plan', { session: imported.body.id, test: {}, mode: 'offline' });
  assert.equal(planned.status, 400, JSON.stringify(planned.body));
  assert.match(planned.body.error, /UNSUPPORTED_FLOW_VERSION/);
  // A v2 run accepts a dry run and refuses the v1 offline mode.
  const offline = await post('run', { session: imported.body.id, test: {}, mode: 'offline' });
  assert.equal(offline.status, 400);
  const dry = await post('run', { session: imported.body.id, mode: 'dry-run' });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.mode, 'dry-run');
  assert.equal(dry.body.entries.length, flow.steps.length);
  // Saving writes a sibling revision through the P2 engine.
  const saved = await post('save', { session: imported.body.id });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.match(saved.body.output, /flow\.edited-.+\.json$/);
  assert.equal(saved.body.v2.saved.length, 1);
});

test('system file and process checks are closed, app-free v2 contracts', () => {
  const steps = [
    {
      id: 'check-file', kind: 'assert',
      scope: { kind: 'file', path: '/tmp/报告 (final).pdf' },
      check: { kind: 'file_exists', equals: false },
    },
    {
      id: 'check-process', kind: 'assert',
      scope: { kind: 'process', name: 'Google Chrome' },
      check: { kind: 'process_running', equals: true },
    },
    {
      id: 'check-process-path', kind: 'assert',
      scope: { kind: 'process', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      check: { kind: 'process_running', equals: false },
    },
    {
      id: 'check-process-args', kind: 'assert',
      scope: { kind: 'process', name: 'controlled sleeper' },
      check: {
        kind: 'process_running', equals: true,
        // 1400 CJK characters are 4200 UTF-8 bytes: the save limit is in code
        // units, the probe must carry the whole value.
        args: ['--profile', 'a b', '"quoted"', '汉'.repeat(1400)],
      },
    },
  ];
  const flow = parseFlowV2({ version: 2, id: 'system-checks', name: 'System checks', steps });
  assert.deepEqual(flow.steps, steps);

  // Scope identity and labels never pretend a system check belongs to an app.
  assert.equal(scopeKey(steps[0].scope), 'file:/tmp/报告 (final).pdf');
  assert.equal(scopeLabel(steps[0].scope), '文件 · /tmp/报告 (final).pdf');
  assert.equal(scopeKey(steps[1].scope), 'process:name:Google Chrome');
  assert.equal(scopeLabel(steps[1].scope), '进程 · Google Chrome');
  // Arguments refine the name check without entering its scope or label.
  assert.equal(scopeKey(steps[3].scope), 'process:name:controlled sleeper');
  assert.equal(scopeLabel(steps[3].scope), '进程 · controlled sleeper');
  assert.deepEqual(steps[3].check.args, ['--profile', 'a b', '"quoted"', '汉'.repeat(1400)]);
  assert.equal(Buffer.byteLength(steps[3].check.args[3], 'utf8'), 4200);
  assert.equal(scopeKey(steps[2].scope),
    'process:path:/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

  // A dry run resolves the steps without any desktop plan and never invents
  // a value for a check it did not run.
  const dry = dryRunFlowV2(flow);
  assert.equal(dry.status, 'passed');
  assert.deepEqual(dry.entries.map(entry => [entry.id, entry.status, entry.stateCheck]),
    [['check-file', 'resolved', undefined], ['check-process', 'resolved', undefined],
      ['check-process-path', 'resolved', undefined], ['check-process-args', 'resolved', undefined]]);
  assert.deepEqual(planFlowV2(flow).map(step => step.scope), flow.steps.map(step => step.scope));

  // The published schemas carry both check kinds and the structured result.
  assert.match(JSON.stringify(schema('flow-v2')), /"process_running"/);
  assert.match(JSON.stringify(schema('report-v2')), /"stateCheck"/);
  const report = {
    version: 2, flowId: 'system-checks', flowSha256: 'a'.repeat(64),
    startedAt: '2026-11-25T00:00:00.000Z', mode: 'replay', status: 'failed',
    entries: [{
      id: 'check-process', kind: 'assert', scope: steps[1].scope, status: 'failed',
      atMs: 0, durationMs: 3, code: 'SYSTEM_CHECK_FAILED',
      stateCheck: { kind: 'process_running', expected: true, actual: null },
    }],
  };
  assert.equal(reportV2Check.Check(report), true);
  assert.equal(reportV2Check.Check({
    ...report,
    entries: [{ ...report.entries[0], stateCheck: { kind: 'process_running', expected: true, actual: 'yes' } }],
  }), false);
});

test('a system check refuses a path, a process name or a check/scope pairing it cannot honour', () => {
  const withStep = step => () => parseFlowV2({
    version: 2, id: 'system-check-bad', name: 'Bad system check', steps: [step],
  });
  const fileCheck = {
    id: 'bad', kind: 'assert', scope: { kind: 'file', path: '/tmp/a.txt' },
    check: { kind: 'file_exists', equals: true },
  };
  const processCheck = {
    id: 'bad', kind: 'assert', scope: { kind: 'process', name: 'Safari' },
    check: { kind: 'process_running', equals: true },
  };
  const invalid = [
    { ...fileCheck, scope: { kind: 'file', path: 'relative/a.txt' } },
    { ...fileCheck, scope: { kind: 'file', path: '/tmp/../etc/passwd' } },
    { ...fileCheck, scope: { kind: 'file', path: '/tmp/a\nb.txt' } },
    { ...fileCheck, scope: { kind: 'file', path: '/tmp/a.txt', name: 'a.txt' } },
    { ...processCheck, scope: { kind: 'process', name: 'Safari/Contents/MacOS/Safari' } },
    { ...processCheck, scope: { kind: 'process', name: 'Safari', path: '/Applications/Safari.app' } },
    { ...processCheck, scope: { kind: 'process', path: 'relative/Safari' } },
    // Arguments belong to a name check only, and stay non-empty and bounded.
    { ...processCheck, scope: { kind: 'process', path: '/usr/bin/Safari' },
      check: { kind: 'process_running', equals: true, args: ['--profile'] } },
    { ...processCheck, check: { kind: 'process_running', equals: true, args: [] } },
    { ...processCheck, check: { kind: 'process_running', equals: true, args: [''] } },
    { ...processCheck, check: { kind: 'process_running', equals: true, args: ['a\nb'] } },
    { ...processCheck, check: { kind: 'process_running', equals: true,
      args: Array.from({ length: 33 }, () => 'x') } },
    // Legal scope shapes, illegal pairings.
    { ...fileCheck, check: { kind: 'process_running', equals: true } },
    { ...processCheck, check: { kind: 'file_exists', equals: true } },
    { kind: 'wait', id: 'bad', scope: { kind: 'file', path: '/tmp/a.txt' },
      check: { kind: 'file_exists', equals: true }, timeoutMs: 1000 },
    { kind: 'wait', id: 'bad', scope: { kind: 'process', name: 'Safari' },
      check: { kind: 'app_running', equals: true }, timeoutMs: 1000 },
    { kind: 'assert', id: 'bad', scope: { kind: 'window', app: 'com.apple.Safari',
      windowKey: 'browser', windowTitle: 'Browser' }, check: { kind: 'file_exists', equals: true } },
  ];
  for (const step of invalid) assert.throws(withStep(step), /Invalid flow version 2/, JSON.stringify(step));
});
