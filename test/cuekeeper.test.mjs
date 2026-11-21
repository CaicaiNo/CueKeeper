import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { unzipSync, strFromU8 } from 'fflate';
import { schemas } from '../dist/contracts.js';
import { offlineDesktop, withDesktop } from '../dist/desktop.js';
import { parseFlow, plan } from '../dist/flow.js';
import { parseSnapshot, resolve } from '../dist/locator.js';
import { Recording } from '../dist/record.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const flow = example('textedit.flow');
const snapshot = parseSnapshot(fixture.data, fixture.target);
const editor = { kind: 'element', role: 'textfield' };
const signal = new AbortController().signal;

function fakeDesktop(snap = snapshot) {
  const actions = [];
  return {
    ...offlineDesktop(fixture, fixture.target),
    actions,
    snapshot: async () => snap,
    click: async ref => { actions.push(['click', ref]); return 'delivered_unverified'; },
    type: async (ref, text) => { actions.push(['type', ref, text]); return 'delivered_verified'; },
    press: async (combo, selected) => { actions.push(['press', combo, selected.windowId]); return 'delivered_unverified'; },
  };
}

test('recording turns a click, printable keys and Cmd+S into three actions', () => {
  const recording = new Recording(fixture.target);
  for (const event of [
    { kind: 'click', t: 1, point: [135, 165] },
    { kind: 'text', t: 120, chars: 'Hello' },
    { kind: 'text', t: 250, chars: ' world' },
    { kind: 'key', t: 300, key: 's', modifiers: ['meta'] },
  ]) {
    recording.add({ event, snapshot });
  }
  const captured = recording.finish();
  assert.deepEqual(captured.steps.map(step => step.kind), ['click', 'type', 'key']);
  assert.deepEqual(captured.steps[0].target, { ...editor, name: '' });
  assert.equal(captured.steps[1].text, 'Hello world');
  assert.deepEqual(captured.steps[2].modifiers, ['meta']);
  assert.doesNotMatch(JSON.stringify(captured), /@scuekeeper/);
});

test('secure input cannot be added to a flow', () => {
  const secured = structuredClone(fixture);
  secured.data.tree.children[0].children[0].states.push('secure');
  const recording = new Recording(fixture.target);
  assert.throws(() => recording.add({
    event: { kind: 'text', t: 1, chars: 'private' },
    snapshot: parseSnapshot(secured.data, secured.target),
  }), { code: 'SECURE_INPUT' });
  assert.throws(() => recording.finish(), { code: 'EMPTY_RECORDING' });
});

// Exercise the real CLI and output writer without invoking either live macOS executable.
function recordFixture(t, events, { captureExit = 0, flags = [], seconds = 1, ready = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-record-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    recursive: true, filter: source => !source.endsWith('/cuekeeper-capture'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');
  const desktop = join(dir, 'desktop');
  writeFileSync(desktop, `#!/usr/bin/env node
const command = process.argv[2];
const snapshots = ${JSON.stringify(fixture.data)};
const data = command === 'version' ? { version: '1.3.1' } : snapshots;
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const indicator = flags.includes('--no-indicator') ? false : {
    window: 4321, display: 1, level: 25, bounds: [0, 0, 1470, 956],
  };
  const messages = ready ? [{ kind: 'ready', indicator }, ...events] : events;
  writeFileSync(join(dist, 'cuekeeper-capture'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
assert.deepEqual(process.argv.slice(2), ${JSON.stringify([fixture.target.app, '1234', String(seconds), ...flags])});
const seen = Date.now();
const messages = ${JSON.stringify(messages)};
writeFileSync(1, messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n') + '\\n');
process.exitCode = ${captureExit};
`, { mode: 0o700 });
  const path = join(dir, 'recorded.flow.json');
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record',
    '--app', fixture.target.app, '--window', fixture.target.window, '--out', path, '--seconds', String(seconds),
    '--json', ...flags], { env: { ...process.env, CUEKEEPER_AGENT_DESKTOP: desktop }, encoding: 'utf8', timeout: 10000 });
  return { code: result.status, response: JSON.parse(result.stdout), stderr: result.stderr,
    recorded: existsSync(path) ? parseFlow(JSON.parse(readFileSync(path, 'utf8'))) : undefined };
}

const captureClick = { kind: 'click', point: [135, 165] };
const captureSave = { kind: 'key', key: 's', modifiers: ['meta'] };

test('record CLI saves click, type and save after leaving and returning to the target app',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      captureClick, { kind: 'text', chars: 'Cuekeeper' }, { kind: 'text', chars: ' M1' },
      { kind: 'focus', active: false }, { kind: 'text', chars: 'Other app' },
      { kind: 'focus', active: true }, { kind: 'boundary' }, captureSave,
    ], { seconds: 90 });
    assert.match(stderr, /^INDICATOR_READY window=4321 display=1 level=25 bounds=0,0,1470,956\nRecording for up to 90 seconds/m);
    assert.equal(code, 0);
    assert.equal(response.ok, true);
    assert.equal(response.data.actions, 3);
    assert.equal(response.data.partial, undefined);
    assert.deepEqual(response.data.warnings.map(warning => warning.code), ['FOCUS_CHANGED']);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click', 'type', 'key']);
    assert.equal(recorded.steps[1].text, 'Cuekeeper M1');
    assert.deepEqual(recorded.steps[2].modifiers, ['meta']);
    assert.equal(recorded.steps[2].key, 's');
  });

test('record CLI stops without a flow when the primary indicator is missing',
  { skip: process.platform !== 'darwin' }, t => {
    const detail = 'Primary panel is missing from the Window Server on-screen list';
    const { code, response, recorded, stderr } = recordFixture(t, [
      { kind: 'error', code: 'INDICATOR_NOT_VISIBLE', detail },
    ], { ready: false, captureExit: 1 });
    assert.equal(code, 1);
    assert.equal(response.error.code, 'INDICATOR_NOT_VISIBLE');
    assert.ok(response.error.message.includes(detail));
    assert.equal(recorded, undefined);
    assert.equal(stderr, '');
  });

test('record CLI rejects a helper that announces ready without indicator verification',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      { kind: 'ready' }, captureClick,
    ], { ready: false });
    assert.equal(code, 2);
    assert.equal(response.error.code, 'INDICATOR_UNCONFIRMED');
    assert.equal(recorded, undefined);
    assert.equal(stderr, '');
  });

test('record CLI saves buffered text and reports partial capture after input permission loss',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      captureClick, { kind: 'text', chars: 'Already captured' },
      { kind: 'error', code: 'INPUT_MONITORING_LOST' },
    ], { captureExit: 1, flags: ['--no-indicator', '--sound'] });
    assert.match(stderr, /^Recording for up to 1 seconds/);
    assert.doesNotMatch(stderr, /INDICATOR_READY/);
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'INPUT_MONITORING_LOST');
    assert.equal(response.data.partial, true);
    assert.equal(response.data.flowId, recorded.id);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click', 'type']);
    assert.equal(recorded.steps[1].text, 'Already captured');
  });

test('record CLI flags skipped input and still writes actions received afterward',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded } = recordFixture(t, [
      captureClick, { kind: 'warning', code: 'UNSUPPORTED_EVENT' },
      { kind: 'key', key: 'unknown', modifiers: [] },
      { kind: 'text', chars: 'After warning' }, captureSave,
    ]);
    assert.equal(code, 1);
    assert.equal(response.error.code, 'PARTIAL_RECORDING');
    assert.equal(response.data.partial, true);
    assert.deepEqual(response.data.warnings.map(warning => warning.code),
      ['UNSUPPORTED_EVENT', 'UNREPRESENTABLE_ACTION']);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click', 'type', 'key']);
    assert.equal(recorded.steps[1].text, 'After warning');
  });

test('ambiguous locators require an explicit index, and partial trees are rejected', () => {
  const twins = structuredClone(fixture);
  const [one] = twins.data.tree.children[0].children;
  twins.data.tree.children[0].children.push({ ...one, ref_id: '@scuekeeper:e2' });
  const current = parseSnapshot(twins.data, twins.target);
  assert.throws(() => resolve(current, editor), { code: 'AMBIGUOUS' });
  assert.equal(resolve(current, { ...editor, index: 1 }).node.ref, '@scuekeeper:e2');
  twins.data.complete = false;
  assert.throws(() => parseSnapshot(twins.data, twins.target), { code: 'INCOMPLETE_TREE' });
});

test('named behavior parameters are bound and standalone examples match their schemas', () => {
  const { version, ...behavior } = example('type.behavior');
  assert.ok(TypeCompiler.Compile(schemas.behavior).Check({ version, ...behavior }));
  assert.ok(TypeCompiler.Compile(schemas.setup).Check(example('editor.setup')));
  const authored = { ...flow, behaviors: [behavior], steps: [
    { id: 'note', kind: 'behavior', behavior: behavior.id, args: { note: 'Parameterized text' } },
  ] };
  assert.equal(plan(parseFlow(authored))[0].action.text, 'Parameterized text');
  assert.equal(plan(parseFlow(authored))[0].id, 'note/write');
  authored.steps[0].args = { typo: 'unbound' };
  assert.throws(() => parseFlow(authored), /must match parameters/);
});

test('two setup scopes have different blocking semantics', async () => {
  const condition = {
    id: 'blocked', name: 'Empty field', state: 'confirmed',
    check: { target: editor, expect: { property: 'value', equals: 'Different content' } },
  };
  const blocked = fakeDesktop();
  const global = await runFlow(parseFlow({ ...flow, setup: [condition] }), blocked, { dryRun: false, signal });
  assert.equal(global.status, 'blocked');
  assert.deepEqual(blocked.actions, []);
  assert.deepEqual(global.entries.map(entry => entry.status), ['blocked', 'blocked', 'blocked', 'blocked']);

  const local = fakeDesktop();
  const steps = [{ ...flow.steps[0], setup: [condition] }, ...flow.steps.slice(1)];
  const report = await runFlow(parseFlow({ ...flow, steps }), local, { dryRun: false, signal });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(local.actions, [
    ['type', '@scuekeeper:e1', 'Cuekeeper M1'], ['press', 'meta+s', 'w-1234'],
  ]);
  assert.deepEqual(report.entries.map(entry => entry.status), ['blocked', 'blocked', 'passed', 'passed']);
  assert.ok(report.entries.every((entry, i, all) => i === 0 || all[i - 1].atMs <= entry.atMs));
});

test('replay uses scoped refs and surfaces unverified delivery; assertion failure halts', async () => {
  const desktop = fakeDesktop();
  const steps = [flow.steps[0], {
    id: 'assert-text', kind: 'assert',
    check: { target: editor, expect: { property: 'text', equals: 'Expected text' } },
  }, ...flow.steps.slice(1)];
  const report = await runFlow(parseFlow({ ...flow, steps }), desktop, { dryRun: false, signal });
  assert.equal(report.status, 'failed');
  assert.deepEqual(desktop.actions, [['click', '@scuekeeper:e1']]);
  assert.deepEqual(report.entries.map(entry => entry.status), ['passed', 'failed', 'skipped', 'skipped']);
  assert.equal(report.entries[0].delivery, 'delivered_unverified');
  assert.equal(report.entries[1].code, 'ASSERTION_FALSE');
});

test('a window replacement between actions stops input', async () => {
  const desktop = fakeDesktop();
  let reads = 0;
  desktop.snapshot = async () => ({ ...snapshot, windowId: ++reads > 1 ? 'w-replaced' : 'w-1234' });
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.equal(report.entries[1].code, 'WINDOW_CHANGED');
  assert.deepEqual(desktop.actions, [['click', '@scuekeeper:e1']]);
});

test('wait re-observes the window, then visible and negative existence assertions read the result', async () => {
  const desktop = fakeDesktop();
  let reads = 0;
  desktop.snapshot = async () => {
    const latest = structuredClone(fixture);
    const field = latest.data.tree.children[0].children[0];
    field.value = ++reads >= 2 ? 'Saved' : '';
    field.states.push('visible');
    return parseSnapshot(latest.data, fixture.target);
  };
  const steps = [
    { id: 'wait-value', kind: 'wait', timeoutMs: 500,
      check: { target: editor, expect: { property: 'value', equals: 'Saved' } } },
    { id: 'editor-visible', kind: 'assert',
      check: { target: editor, expect: { property: 'visible', equals: true } } },
    { id: 'error-absent', kind: 'assert',
      check: { target: { kind: 'element', role: 'alert' }, expect: { property: 'exists', equals: false } } },
  ];
  const report = await runFlow(parseFlow({ ...flow, steps }), desktop, { dryRun: false, signal });
  assert.equal(reads, 4);
  assert.deepEqual(report.entries.map(entry => entry.status), ['passed', 'passed', 'passed']);
  assert.deepEqual(desktop.actions, []);
});

test('adapter scopes commands and sends unlogged text on stdin', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-adapter-test-'));
  const stub = join(dir, 'desktop');
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  process.env.CUEKEEPER_AGENT_DESKTOP = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const log = join(dir, 'calls');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, input }) + String.fromCharCode(10));
const data = command === 'version' ? { version: '1.3.1' } :
  command === 'snapshot' ? ${JSON.stringify(fixture.data)} :
  { disposition: { delivery: command === 'type' ? 'delivered_verified' : 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const report = await withDesktop({ headed: true, signal },
    desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.command), ['version', 'snapshot', 'click', 'snapshot', 'type', 'snapshot', 'press']);
  assert.deepEqual(calls[1].args.slice(0, 2), ['--app', 'com.apple.TextEdit']);
  assert.deepEqual(calls[2].args, ['--headed', '@scuekeeper:e1']);
  assert.deepEqual(calls[4], { command: 'type', args: ['@scuekeeper:e1', '--stdin'], input: 'Cuekeeper M1' });
  assert.deepEqual(calls[6].args, ['--headed', 'meta+s', '--window-id', 'w-1234']);
});

test('CLI resolves three steps and packs a report with verified manifest and ordering', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.json');
  const zip = join(dir, 'report.zip');
  const run = (...args) => {
    const command = spawnSync(process.execPath, ['dist/cli.js', ...args, '--json'], { encoding: 'utf8' });
    assert.equal(command.stderr, '');
    return { code: command.status, ...JSON.parse(command.stdout) };
  };
  assert.deepEqual(run('flow', 'validate', 'examples/textedit.flow.json').data, {
    flowId: 'textedit-save', actions: 3,
  });
  const dry = run('run', 'examples/textedit.flow.json', '--dry-run',
    '--snapshot', 'examples/textedit.snapshot.json', '--report', report);
  assert.equal(dry.code, 0);
  assert.equal(dry.data.mode, 'dry-run');
  assert.deepEqual(dry.data.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['type', 'resolved'], ['key', 'resolved'],
  ]);
  assert.equal(run('report', 'pack', report, '--flow', 'examples/textedit.flow.json', '--out', zip).code, 0);
  const files = unzipSync(readFileSync(zip));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.deepEqual(Object.keys(files).sort(), ['assets/report.css', 'flow.json', 'index.html', 'manifest.json', 'report.json']);
  for (const [name, metadata] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(files[name]).digest('hex'), metadata.sha256);
    assert.equal(files[name].length, metadata.bytes);
  }
  assert.match(strFromU8(files['index.html']), /click-body[\s\S]*type-text[\s\S]*save<\/strong>/);
  assert.throws(() => packReport(dry.data, { ...flow, name: 'Different flow' }), /do not match/);
  const malformed = { ...dry.data, entries: [...dry.data.entries].reverse() };
  assert.throws(() => packReport(malformed, flow), /timeline/);
  assert.equal(run('report', 'pack', report, '--flow', 'examples/textedit.flow.json', '--out', zip).code, 2);
});
