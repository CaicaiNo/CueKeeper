import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportV2Check } from '../dist/contracts-v2.js';

// End-to-end CLI wiring for a live v2 replay: the desktop driver and the app
// identity helper are both stubs, so this test never launches, focuses or
// captures a real window. The pinned copy is the real TextEdit bundle, which
// only has its bundle ID read during preflight.

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const app = 'com.apple.TextEdit';
const appPath = '/System/Applications/TextEdit.app';
const windowTitle = 'CLI Notes';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-v2-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const driverLog = join(dir, 'driver.jsonl');
  const statePath = join(dir, 'identity-state.json');
  writeFileSync(statePath, JSON.stringify({ opened: false, pid: 901, startedAt: '901.1' }));

  const driver = join(dir, 'agent-desktop');
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(driverLog)}, JSON.stringify({ command, args, input }) + '\\n');
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'list-windows') data = [{
  id: 'w-31', title: ${JSON.stringify(windowTitle)}, process_instance: 901, pid: 901, is_focused: true,
}];
else if (command === 'snapshot') data = {
  complete: true,
  window: { id: 'w-31', title: ${JSON.stringify(windowTitle)} },
  tree: {
    role: 'window', name: ${JSON.stringify(windowTitle)},
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    children: [{
      role: 'scrollarea',
      children: [{
        role: 'textfield', name: 'notes', ref_id: '@cli:e1',
        bounds: { x: 120, y: 150, width: 600, height: 40 }, states: ['focused'],
      }],
    }],
  },
};
else if (command === 'focus-window') data = { focused: { id: args[1] } };
else if (command === 'type') data = { disposition: { delivery: 'delivered_verified' } };
else if (command === 'press') data = { disposition: { delivery: 'delivered_verified' } };
else data = { disposition: { delivery: 'delivered_verified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const identity = join(dir, 'cuekeeper-identity');
  writeFileSync(identity, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const instance = { pid: state.pid, startedAt: state.startedAt, bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(appPath)} };
const value = flag => args[args.indexOf(flag) + 1];
let data = null;
if (command === 'open') {
  state.opened = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  data = {};
} else if (command === 'instances') {
  data = { instances: state.opened ? [instance] : [] };
} else if (command === 'describe') {
  data = state.opened && Number(value('--pid')) === state.pid ? instance : null;
} else if (command === 'windows') {
  data = state.opened ? [{ number: 31, ownerPid: state.pid, title: ${JSON.stringify(windowTitle)} }] : [];
}
console.log(JSON.stringify({ version: '1', command, ok: true, data }));
`, { mode: 0o700 });

  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify({
    version: 2,
    id: 'cli-cross-app',
    name: 'CLI cross app',
    appPaths: { [app]: appPath },
    inputs: ['note'],
    steps: [
      {
        id: 'launch',
        kind: 'launch_app',
        scope: { kind: 'app', app },
        focusAfter: { kind: 'window', app, windowKey: 'notes', windowTitle },
      },
      {
        id: 'type-note',
        kind: 'type',
        scope: { kind: 'window', app, windowKey: 'notes', windowTitle },
        target: { kind: 'element', role: 'textfield', name: 'notes' },
        input: 'note',
      },
    ],
  }));
  const valuesPath = join(dir, 'values.json');
  writeFileSync(valuesPath, JSON.stringify({ note: 'hello from cli' }));

  const checkpointFlowPath = join(dir, 'flow-checkpoint.json');
  writeFileSync(checkpointFlowPath, JSON.stringify({
    version: 2,
    id: 'cli-checkpoint',
    name: 'CLI checkpoint',
    appPaths: { [app]: appPath },
    inputs: ['note'],
    steps: [
      {
        id: 'launch', kind: 'launch_app', scope: { kind: 'app', app },
        focusAfter: { kind: 'window', app, windowKey: 'notes', windowTitle },
      },
      {
        id: 'type-note', kind: 'type',
        scope: { kind: 'window', app, windowKey: 'notes', windowTitle },
        target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
      },
      {
        id: 'auth', kind: 'manual_checkpoint',
        scope: { kind: 'window', app, windowKey: 'notes', windowTitle },
        triggerStepId: 'type-note', reason: 'secure_input',
        resume: {
          scope: { kind: 'window', app, windowKey: 'notes', windowTitle },
          check: { kind: 'window_exists', equals: true },
        },
        timeoutMs: 120_000,
      },
      {
        id: 'type-after', kind: 'type',
        scope: { kind: 'window', app, windowKey: 'notes', windowTitle },
        target: { kind: 'element', role: 'textfield', name: 'notes' }, input: 'note',
      },
    ],
  }));

  // The secure state probe is a stub helper: no tap, AX read or TCC prompt.
  const probeLog = join(dir, 'secure-probe.log');
  writeFileSync(probeLog, '');
  const recorder = join(dir, 'cuekeeper-capture');
  writeFileSync(recorder, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(probeLog)}, process.argv.slice(2).join(' ') + '\\n');
console.log(JSON.stringify({ secure: false }));
`, { mode: 0o700 });

  const env = {
    ...process.env,
    CUEKEEPER_AGENT_DESKTOP: driver,
    CUEKEEPER_APP_IDENTITY: identity,
    CUEKEEPER_RECORDER: recorder,
    CUEKEEPER_STATE_DIR: join(dir, 'state'),
  };
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      env, encoding: 'utf8', timeout: 30_000, ...(input === undefined ? {} : { input }),
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const calls = () => existsSync(driverLog)
    ? readFileSync(driverLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const probes = () => existsSync(probeLog)
    ? readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { dir, flowPath, checkpointFlowPath, valuesPath, run, calls, probes };
}

test('CLI: a v2 flow replays through the window-bound driver and writes a v2 report',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run([
      'run', cli.flowPath, '--foreground', '--inputs', cli.valuesPath, '--report', reportPath, '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.ok(reportV2Check.Check(report), JSON.stringify(report, null, 2));
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.entries.map(entry => [entry.id, entry.status]), [
      ['launch', 'passed'], ['type-note', 'passed'],
    ]);
    assert.deepEqual(report.entries[0].focusAfter, {
      kind: 'window', app, windowKey: 'notes', windowTitle,
    });

    const calls = cli.calls();
    // The pinned copy is opened through the identity helper, not the driver, and
    // every later window call names --window-id.
    assert.equal(calls.filter(call => call.command === 'focus-window').length, 1);
    assert.equal(calls.find(call => call.command === 'focus-window').args[1], 'w-31');
    const snapshot = calls.find(call => call.command === 'snapshot');
    assert.ok(snapshot.args.includes('--window-id'));
    assert.equal(snapshot.args[snapshot.args.indexOf('--window-id') + 1], 'w-31');
    const type = calls.find(call => call.command === 'type');
    assert.equal(type.args[0], '@cli:e1');
    assert.equal(type.input, 'hello from cli');
    // The foreground lease is released when the run ends.
    assert.equal(existsSync(join(cli.dir, 'state', 'run.lock')), false);
  });

/** The sidecar the recorder would have written next to `flow.json`. */
function writeSidecar(cli, values, overrides = {}) {
  const path = join(cli.dir, 'flow.values.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    flowId: 'cli-cross-app',
    updatedAt: '2026-11-26T08:00:00.000Z',
    values,
    ...overrides,
  }), { mode: 0o600 });
  return path;
}

test('CLI: a v2 run types the sidecar value verbatim and prints only its name',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    writeSidecar(cli, {
      note: { value: '  padded note  ', complete: true, steps: ['type-note'] },
    });
    const reportPath = join(cli.dir, 'sidecar-report.json');
    const result = cli.run(['run', cli.flowPath, '--foreground', '--report', reportPath, '--json']);
    assert.equal(result.code, 0, result.stderr);

    // The driver received the exact stored text, including its padding.
    const type = cli.calls().find(call => call.command === 'type');
    assert.equal(type.input, '  padded note  ');
    // stderr names the file and the parameter, never the value.
    assert.match(result.stderr, /inputs from .*flow\.values\.json: note/);
    assert.ok(!result.stderr.includes('padded note'));
    assert.ok(!result.stdout.includes('padded note'));
    // The report carries the outcome, not the text of the step.
    assert.ok(!readFileSync(reportPath, 'utf8').includes('padded note'));
  });

test('CLI: a broken sidecar warning never echoes the value it could not read',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const secret = `Zq${randomUUID().slice(0, 8)}`;
    // Both a schema error (an unknown issue names its own string) and a JSON
    // error (the parser quotes the offending text) can carry the raw value.
    for (const contents of [
      JSON.stringify({
        version: 1, flowId: 'cli-cross-app', updatedAt: '2026-11-26T08:00:00.000Z',
        values: { note: { value: 'ok', complete: true, issues: [secret] } },
      }),
      `{"version":1,"flowId":"cli-cross-app","updatedAt":"x","values":{"note":{"value":${secret}}}}`,
    ]) {
      writeFileSync(join(cli.dir, 'flow.values.json'), contents);
      const result = cli.run(['run', cli.flowPath, '--foreground', '--json']);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /flow\.values\.json.*无效/);
      assert.ok(!result.stderr.includes(secret), `stderr must not carry the value: ${result.stderr}`);
      assert.ok(!result.stdout.includes(secret), 'the envelope must not carry the value');
      assert.equal(cli.calls().filter(call => call.command === 'type').length, 0);
    }
  });

test('CLI: --no-stored-inputs refuses, and explicit --inputs wins over the sidecar',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    writeSidecar(cli, { note: { value: 'stored note', complete: true } });

    // Opting out leaves the parameter without a value: the run fails with
    // INPUT_MISSING before typing anything.
    const refused = cli.run(['run', cli.flowPath, '--foreground', '--no-stored-inputs', '--json']);
    assert.equal(refused.code, 1, refused.stderr);
    const envelope = JSON.parse(refused.stdout);
    assert.notEqual(envelope.data.status, 'passed');
    assert.ok(envelope.data.entries.some(entry => entry.code === 'INPUT_MISSING'));
    assert.equal(cli.calls().filter(call => call.command === 'type').length, 0);

    // An explicit file is never overridden by the sidecar.
    const explicit = cli.run([
      'run', cli.flowPath, '--foreground', '--inputs', cli.valuesPath, '--json',
    ]);
    assert.equal(explicit.code, 0, explicit.stderr);
    const type = cli.calls().find(call => call.command === 'type');
    assert.equal(type.input, 'hello from cli');
  });

test('CLI: a corrupt sidecar is a warning, and an explicit --inputs run still works',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    writeFileSync(join(cli.dir, 'flow.values.json'), '{ broken');

    // Automatic loading reports the unusable file and falls back to "no value",
    // which blocks on the missing parameter exactly like a flow with no file.
    const automatic = cli.run(['run', cli.flowPath, '--foreground', '--json']);
    assert.equal(automatic.code, 1, automatic.stderr);
    assert.match(automatic.stderr, /flow\.values\.json.*已忽略/);
    assert.ok(JSON.parse(automatic.stdout).data.entries.some(entry => entry.code === 'INPUT_MISSING'));

    // The file never blocks the replay the operator asked for.
    const result = cli.run([
      'run', cli.flowPath, '--foreground', '--inputs', cli.valuesPath, '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const type = cli.calls().find(call => call.command === 'type');
    assert.equal(type.input, 'hello from cli');
  });

test('CLI: a v2 live run refuses to start without --foreground',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const result = cli.run(['run', cli.flowPath, '--json']);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'FOREGROUND_REQUIRED');
    assert.deepEqual(cli.calls(), []);
  });

test('CLI: a checkpoint flow refuses --json before any desktop call',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const result = cli.run([
      'run', cli.checkpointFlowPath, '--foreground', '--inputs', cli.valuesPath, '--json',
    ]);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'MANUAL_CHECKPOINT_REQUIRED');
    assert.deepEqual(cli.calls(), []);
    assert.deepEqual(cli.probes(), []);
  });

test('CLI: a checkpoint resumes after the operator types continue and reports metadata',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const reportPath = join(cli.dir, 'checkpoint-report.json');
    const result = cli.run([
      'run', cli.checkpointFlowPath, '--foreground', '--inputs', cli.valuesPath, '--report', reportPath,
    ], 'continue\n');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /人工检查点 auth/);
    assert.match(result.stderr, /continue/);

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.ok(reportV2Check.Check(report), JSON.stringify(report, null, 2));
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.entries.map(entry => [entry.id, entry.status]), [
      ['launch', 'passed'], ['type-note', 'passed'], ['auth', 'passed'], ['type-after', 'passed'],
    ]);
    assert.deepEqual(report.entries[2].checkpoint, {
      reason: 'secure_input', triggerStepId: 'type-note', timeoutMs: 120_000, confirmedBy: 'operator',
    });
    assert.equal('input' in report.entries[2], false);
    // The secure probe ran before every automatic input step and at the hand-off.
    assert.ok(cli.probes().length >= 3);
    assert.ok(cli.probes().every(line => line === '--secure-state'));
    assert.equal(cli.calls().filter(call => call.command === 'type').length, 2);
  });

test('CLI: --checkpoint-events announces the wait on stderr and continues from stdin',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const result = cli.run([
      'run', cli.checkpointFlowPath, '--foreground', '--inputs', cli.valuesPath,
      '--json', '--checkpoint-events',
    ], 'continue\n');
    assert.equal(result.code, 0, result.stderr);
    // The parent reads exactly this marker; the report stays pure JSON on stdout.
    assert.match(result.stderr, /^CHECKPOINT_WAIT auth type-note 120000$/m);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.status, 'passed');
    assert.deepEqual(envelope.data.entries.map(entry => [entry.id, entry.status]), [
      ['launch', 'passed'], ['type-note', 'passed'], ['auth', 'passed'], ['type-after', 'passed'],
    ]);
    assert.deepEqual(envelope.data.entries[2].checkpoint, {
      reason: 'secure_input', triggerStepId: 'type-note', timeoutMs: 120_000, confirmedBy: 'operator',
    });
  });

test('CLI: --checkpoint-events cancel fails at the checkpoint and skips later steps',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const result = cli.run([
      'run', cli.checkpointFlowPath, '--foreground', '--inputs', cli.valuesPath,
      '--json', '--checkpoint-events',
    ], 'cancel\n');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^CHECKPOINT_WAIT auth type-note 120000$/m);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.data.status, 'blocked');
    assert.equal(envelope.data.entries[2].code, 'MANUAL_CHECKPOINT_CANCELLED');
    assert.equal(envelope.data.entries[3].status, 'skipped');
    assert.equal(cli.calls().filter(call => call.command === 'type').length, 1);
  });

test('CLI: --checkpoint-events needs --json and stays a v2 flag',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const withoutJson = cli.run([
      'run', cli.checkpointFlowPath, '--foreground', '--inputs', cli.valuesPath, '--checkpoint-events',
    ]);
    assert.equal(withoutJson.code, 2);
    assert.match(withoutJson.stderr, /combine it with --json/);
    // A v1 flow has no checkpoint channel; the flag stays a v2-only spelling.
    const v1Flow = join(cli.dir, 'v1-flow.json');
    writeFileSync(v1Flow, JSON.stringify({
      version: 1, id: 'v1-flag', name: 'v1 flag',
      target: { app, window: windowTitle },
      steps: [{ id: 'type-1', kind: 'type', target: { kind: 'element', role: 'textfield' }, text: 'x' }],
    }));
    const v1 = cli.run(['run', v1Flow, '--checkpoint-events', '--json']);
    assert.equal(v1.code, 2);
    assert.equal(JSON.parse(v1.stdout).error.code, 'UNSUPPORTED_FLAG');
    assert.deepEqual(cli.calls(), []);
  });
