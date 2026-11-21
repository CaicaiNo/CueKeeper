import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { strFromU8, unzipSync } from 'fflate';
import { reportCheck, schemas } from '../dist/contracts.js';
import { offlineDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const base = example('textedit.flow');
const fixture = example('textedit.snapshot');
const [click, , save] = base.steps;
const target = base.target;
const condition = {
  id: 'ready', name: 'Editor ready', state: 'confirmed',
  check: { target: click.target, expect: { property: 'exists', equals: true } },
  ensure: { kind: 'app_running', app: target.app },
};
const windowCondition = { ...condition, ensure: { kind: 'window_ready', app: target.app, window: target.window } };

// Run the production CLI and adapter against a stateful executable that never uses the desktop.
function replay(t, flow, options = {}, flags = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-setup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'desktop.cjs');
  const log = join(dir, 'calls.jsonl');
  const source = join(dir, 'flow.json');
  const output = join(dir, 'report.json');
  writeFileSync(source, JSON.stringify(flow));
  writeFileSync(log, '');
  writeFileSync(stub, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const history = fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
fs.appendFileSync(log, JSON.stringify({ command, args }) + '\\n');
const seen = name => history.some(call => call.command === name);
const { running, hasWindow = running, readyAfter, launchError, focusError, neverOpen, secondaryWindow } = ${JSON.stringify(options)};
const data = ${JSON.stringify(fixture.data)};
const app = ${JSON.stringify(target.app)};
const opened = seen('launch') && !neverOpen;
const failure = code => {
  console.log(JSON.stringify({ version: '2.6', ok: false, command, error: { code } }));
  process.exit(1);
};
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
let result;
switch (command) {
  case 'version': result = { version: '1.3.1' }; break;
  case 'list-windows':
    assert.equal(flag('--app'), app);
    if (!running && !opened) failure('APP_NOT_FOUND');
    result = [{ id: 'w-other', title: 'Unrelated window' }];
    if (hasWindow || opened) result.push(data.window);
    if (secondaryWindow && opened) result.push(secondaryWindow);
    break;
  case 'list-apps':
    assert.equal(flag('--app'), app);
    result = { apps: running ? [{ name: 'TextEdit', bundle_id: app, pid: 1234 }] : [] };
    break;
  case 'launch':
    assert.deepEqual(args.slice(-2), ['--', app]);
    if (launchError) failure(launchError);
    result = { pid: 1234, app: 'TextEdit' };
    break;
  case 'focus-window':
    assert.equal(flag('--app'), app);
    const focused = secondaryWindow ?? data.window;
    assert.equal(flag('--window-id'), focused.id);
    if (focusError) failure(focusError);
    result = { focused };
    break;
  case 'snapshot':
    assert.equal(flag('--app'), app);
    if (!(hasWindow || opened)) failure(running ? 'WINDOW_NOT_FOUND' : 'APP_NOT_FOUND');
    if (secondaryWindow && flag('--window-id') === secondaryWindow.id) {
      assert.ok(opened);
      data.window = secondaryWindow;
    } else if (opened || seen('focus-window') || seen('list-apps')) {
      assert.equal(flag('--window-id'), data.window.id);
      data.tree.children[0].children[0].ref_id = '@sfresh:e1';
    }
    if (readyAfter && !seen(readyAfter)) data.tree.children = [];
    result = data;
    break;
  case 'click':
  case 'press': result = { disposition: { delivery: 'delivered_verified' } }; break;
  default: assert.fail('Unexpected command: ' + command);
}
console.log(JSON.stringify({ version: '2.6', ok: true, command, data: result }));
`, { mode: 0o700 });
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'run', source, '--report', output, '--json', ...flags], {
    env: { ...process.env, CUEKEEPER_AGENT_DESKTOP: stub },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, '');
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout).data, report);
  assert.equal(result.status, report.status === 'passed' ? 0 : 1);
  assert.equal(reportCheck.Check(report), true);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  return { report, calls, commands: calls.map(call => call.command) };
}

const mac = { skip: process.platform !== 'darwin' };

test('setup accepts omitted or bounded timeouts in v1 without materializing a default', () => {
  const flow = { ...base, setup: [structuredClone(condition)] };
  assert.deepEqual(parseFlow(flow).setup[0].ensure, condition.ensure);
  for (const timeout_ms of [1000, 120_000, 999, 120_001, 1500.1]) {
    flow.setup[0].ensure.timeout_ms = timeout_ms;
    if (timeout_ms === 1000 || timeout_ms === 120_000) {
      assert.equal(parseFlow(flow).setup[0].ensure.timeout_ms, timeout_ms);
    } else {
      assert.throws(() => parseFlow(flow), /Invalid flow/);
    }
  }
});

test('window_ready requires an explicit nonempty title in flow and standalone setup', () => {
  const setupCheck = TypeCompiler.Compile(schemas.setup);
  assert.equal(setupCheck.Check({ ...windowCondition, version: 1 }), true);
  assert.deepEqual(parseFlow({ ...base, setup: [windowCondition] }).setup, [windowCondition]);
  for (const ensure of [
    { kind: 'window_ready', app: target.app },
    { kind: 'window_ready', app: target.app, window: '' },
    { kind: 'app_running', app: target.app, window: target.window },
  ]) {
    const setup = { ...windowCondition, ensure };
    assert.equal(setupCheck.Check({ ...setup, version: 1 }), false);
    assert.throws(() => parseFlow({ ...base, setup: [setup] }), /Invalid flow/);
  }
});

test('report rejects repair metadata on every non-setup entry kind', () => {
  const report = example('textedit.report');
  const repair = { attempted: true, kind: 'window_ready', result: 'passed' };
  const entry = { ...report.entries[0], repair };
  assert.equal(reportCheck.Check({ ...report, entries: [{ ...entry, kind: 'setup' }] }), true);
  for (const kind of ['click', 'type', 'key', 'wait', 'assert']) {
    assert.equal(reportCheck.Check({ ...report, entries: [{ ...entry, kind }] }), false, kind);
  }
  const altered = { ...report, entries: [entry, ...report.entries.slice(1)] };
  assert.throws(() => packReport(altered, parseFlow(base)), /Invalid v1 report/);
});

test('app_running starts a missing app once and the next action uses a fresh ref', mac, t => {
  const authored = { ...base, setup: [condition], steps: [click] };
  const { report, calls, commands } = replay(t, authored);
  assert.equal(report.status, 'passed');
  assert.deepEqual(commands, ['version', 'list-windows', 'list-apps', 'launch',
    'list-windows', 'snapshot', 'snapshot', 'click']);
  const launchArgs = calls[3].args;
  assert.equal(launchArgs[0], '--timeout');
  assert.ok(Number(launchArgs[1]) > 12_000 && Number(launchArgs[1]) <= 15_000);
  assert.equal(launchArgs.includes('--activate'), false);
  assert.deepEqual(calls.at(-1).args, ['@sfresh:e1']);
  assert.equal(report.entries[0].id, 'global/setup/ready');
  assert.deepEqual(report.entries[0].repair, { attempted: true, kind: 'app_running', result: 'passed' });
  assert.equal(report.entries[1].delivery, 'delivered_verified');
});

test('app_running reuses a running app when the first check is false', mac, t => {
  const { report, calls, commands } = replay(t, { ...base, setup: [condition], steps: [click] }, {
    running: true, readyAfter: 'list-apps',
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(commands, ['version', 'list-windows', 'snapshot', 'list-apps', 'snapshot', 'snapshot', 'click']);
  assert.deepEqual(calls.at(-1).args, ['@sfresh:e1']);
  assert.equal(report.entries[0].repair.result, 'passed');
});

test('window_ready opens and focuses the exact window for an action inside a behavior', mac, t => {
  const flow = {
    ...base,
    setup: [{ ...condition, state: 'inferred' }],
    behaviors: [{ id: 'edit', name: 'Edit', steps: [{ ...click, setup: [{ ...windowCondition, name: 'Behavior window' }] }] }],
    steps: [{ id: 'call', kind: 'behavior', behavior: 'edit' }],
  };
  const { report, calls, commands } = replay(t, flow, { running: true, hasWindow: false });
  assert.equal(report.status, 'passed');
  assert.deepEqual(commands, ['version', 'list-windows', 'list-windows', 'launch',
    'list-windows', 'focus-window', 'snapshot', 'snapshot', 'click']);
  assert.ok(calls[3].args.includes('--activate'));
  assert.deepEqual(report.entries.map(entry => [entry.id, entry.status]), [
    ['global/setup/ready', 'skipped'],
    ['call/click-body/setup/ready', 'passed'],
    ['call/click-body', 'passed'],
  ]);
  assert.deepEqual(report.entries[1].repair, { attempted: true, kind: 'window_ready', result: 'passed' });
  const viewer = strFromU8(unzipSync(packReport(report, parseFlow(flow)))['index.html']);
  assert.match(viewer, /前置条件 · Editor ready/);
  assert.match(viewer, /前置条件 · Behavior window/);
  assert.match(viewer, /打开或聚焦窗口 · 通过/);
});

test('window_ready focuses an existing window without reopening the app', mac, t => {
  const { report, commands } = replay(t, { ...base, setup: [windowCondition], steps: [click] }, {
    running: true, readyAfter: 'focus-window',
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(commands, ['version', 'list-windows', 'snapshot', 'list-windows',
    'focus-window', 'snapshot', 'snapshot', 'click']);
});

test('window_ready repairs a named secondary window while the next action stays on the replay window', mac, t => {
  const secondaryWindow = { id: 'w-settings', title: 'Settings' };
  const setup = { ...windowCondition, ensure: { ...windowCondition.ensure, window: secondaryWindow.title } };
  const flow = { ...base, setup: [condition], steps: [{ ...click, setup: [setup] }] };
  const { report, calls } = replay(t, flow, { running: true, secondaryWindow });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.entries[1].repair, { attempted: true, kind: 'window_ready', result: 'passed' });
  assert.deepEqual(calls.find(call => call.command === 'focus-window').args,
    ['--app', target.app, '--window-id', secondaryWindow.id]);
  assert.deepEqual(calls.filter(call => call.command === 'snapshot').map(({ args }) => args[args.indexOf('--window-id') + 1]),
    [fixture.data.window.id, secondaryWindow.id, fixture.data.window.id]);
});

test('offline dry-run rejects a setup window outside the supplied snapshot', async () => {
  const setup = { ...windowCondition, ensure: { ...windowCondition.ensure, window: 'Settings' } };
  const flow = parseFlow({ ...base, setup: [setup] });
  const desktop = offlineDesktop(fixture, target);
  await assert.rejects(runFlow(flow, desktop, { dryRun: true, signal: new AbortController().signal }),
    { code: 'WINDOW_MISMATCH' });
});

test('an unopened window reports WINDOW_NOT_FOUND after one activation request', mac, t => {
  const ensure = { ...windowCondition.ensure, timeout_ms: 1000 };
  const { report, commands } = replay(t, { ...base, setup: [{ ...windowCondition, ensure }], steps: [click] }, {
    running: true, hasWindow: false, neverOpen: true,
  });
  assert.deepEqual(report.entries.map(entry => [entry.status, entry.code]), [
    ['blocked', 'ENSURE_FAILED'], ['blocked', undefined],
  ]);
  assert.deepEqual(report.entries[0].repair, {
    attempted: true, kind: 'window_ready', result: 'failed', code: 'WINDOW_NOT_FOUND',
  });
  assert.equal(commands.filter(command => command === 'launch').length, 1);
  assert.equal(commands.includes('focus-window'), false);
  assert.equal(commands.includes('click'), false);
});

for (const [launchError, code] of [['APP_NOT_FOUND', 'APP_NOT_FOUND'], ['TIMEOUT', 'LAUNCH_TIMEOUT']]) {
  test(`launch failure ${launchError} is reported without another attempt`, mac, t => {
    const { report, commands } = replay(t, { ...base, setup: [condition], steps: [click] }, { launchError });
    assert.equal(report.status, 'blocked');
    assert.equal(report.entries[0].code, 'ENSURE_FAILED');
    assert.equal(report.entries[0].repair.code, code);
    assert.deepEqual(commands, ['version', 'list-windows', 'list-apps', 'launch']);
  });
}

test('a local permission failure is reported once and leaves later actions runnable', mac, t => {
  const { report, commands } = replay(t, { ...base, steps: [{ ...click, setup: [windowCondition] }, save] }, {
    running: true, readyAfter: 'focus-window', focusError: 'PERMISSION_DENIED',
  });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.entries.map(entry => [entry.id, entry.status, entry.code]), [
    ['click-body/setup/ready', 'blocked', 'ENSURE_FAILED'],
    ['click-body', 'blocked', 'LOCAL_SETUP'],
    ['save', 'passed', undefined],
  ]);
  assert.equal(report.entries[0].repair.code, 'PERMISSION_DENIED');
  assert.deepEqual(commands, ['version', 'list-windows', 'snapshot', 'list-windows', 'focus-window', 'snapshot', 'press']);
});

test('a repair with an unmet check returns PRECONDITION_FALSE and blocks input', mac, t => {
  const { report, commands } = replay(t, { ...base, setup: [condition], steps: [click] }, {
    running: true, readyAfter: 'click',
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[0].code, 'PRECONDITION_FALSE');
  assert.equal(report.entries[0].repair.result, 'failed');
  assert.equal(commands.includes('launch') || commands.includes('click'), false);
});

test('a matched setup and dry-run both omit repair actions', mac, t => {
  const flow = { ...base, setup: [windowCondition], steps: [click] };
  const matched = replay(t, flow, { running: true });
  assert.deepEqual(matched.commands, ['version', 'list-windows', 'snapshot', 'snapshot', 'click']);
  assert.equal(matched.report.entries[0].status, 'passed');
  assert.equal(matched.report.entries[0].repair, undefined);
  const dry = replay(t, flow, { running: true }, ['--dry-run']);
  assert.deepEqual(dry.commands, ['version', 'snapshot']);
  assert.deepEqual(dry.report.entries.map(entry => entry.status), ['resolved', 'resolved']);
  assert.equal(dry.report.entries[0].repair, undefined);
});
