import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

  const env = {
    ...process.env,
    CUEKEEPER_AGENT_DESKTOP: driver,
    CUEKEEPER_APP_IDENTITY: identity,
    CUEKEEPER_STATE_DIR: join(dir, 'state'),
  };
  const run = args => {
    const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const calls = () => existsSync(driverLog)
    ? readFileSync(driverLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { dir, flowPath, valuesPath, run, calls };
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

test('CLI: a v2 live run refuses to start without --foreground',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = fixture(t);
    const result = cli.run(['run', cli.flowPath, '--json']);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'FOREGROUND_REQUIRED');
    assert.deepEqual(cli.calls(), []);
  });
