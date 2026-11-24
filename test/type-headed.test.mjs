import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { withDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const flow = parseFlow(example('textedit.flow'));
const signal = new AbortController().signal;

// A stub driver records argv and stdin for every call. `failType` makes the
// text injection fail the way Chromium does on the headless path.
function stub(t, { failType = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-type-'));
  const log = join(dir, 'calls');
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  const previousIdentity = process.env.CUEKEEPER_APP_IDENTITY;
  process.env.CUEKEEPER_AGENT_DESKTOP = join(dir, 'desktop');
  process.env.CUEKEEPER_APP_IDENTITY = join(dir, 'identity');
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
    if (previousIdentity === undefined) delete process.env.CUEKEEPER_APP_IDENTITY;
    else process.env.CUEKEEPER_APP_IDENTITY = previousIdentity;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'desktop'), `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  command, args, input: fs.readFileSync(0, 'utf8'),
}) + String.fromCharCode(10));
if (${failType} && command === 'type') {
  console.log(JSON.stringify({
    version: '2.6', command, ok: false,
    error: { code: 'ACTION_FAILED', message: 'AX surface read failed' },
  }));
  process.exit(0);
}
const surface = args.includes('--surface') ? args[args.indexOf('--surface') + 1] : undefined;
const menu = { app: 'Finder', complete: true, tree: { role: 'menu', children: [
  { role: 'menuitem', name: 'Rename', ref_id: '@s123:e1', available_actions: ['Click'] },
] } };
const editor = { app: 'Finder', complete: true, tree: { role: 'textfield', states: ['focused'], value: 'old.txt' } };
const data = surface === 'menu' ? menu : surface === 'focused' ? editor : command === 'version' ? { version: '1.3.1' } :
  command === 'snapshot' ? ${JSON.stringify(fixture.data)} :
  { disposition: { delivery: command === 'type' ? 'delivered_verified' : 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  return () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('headed replay injects text through the headed path and keeps it on stdin', async t => {
  const calls = stub(t);
  const report = await withDesktop({ headed: true, signal }, desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const type = calls().filter(call => call.command === 'type');
  assert.deepEqual(type, [{
    command: 'type', args: ['--headed', '@scuekeeper:e1', '--stdin'], input: 'Cuekeeper M1',
  }]);
});

test('headless replay keeps the original element path without --headed', async t => {
  const calls = stub(t);
  const report = await withDesktop({ headed: false, signal }, desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'passed');
  const type = calls().filter(call => call.command === 'type');
  assert.deepEqual(type, [{
    command: 'type', args: ['@scuekeeper:e1', '--stdin'], input: 'Cuekeeper M1',
  }]);
});

test('a headed text failure keeps the driver code and is not retried headless', async t => {
  const calls = stub(t, { failType: true });
  const report = await withDesktop({ headed: true, signal }, desktop => runFlow(flow, desktop, { dryRun: false, signal }));
  assert.equal(report.status, 'failed');
  const entry = report.entries.find(item => item.kind === 'type');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.code, 'ACTION_FAILED');
  assert.equal(entry.message, 'agent-desktop type returned ACTION_FAILED');
  // Exactly one type call, and it stayed headed: no silent downgrade.
  assert.deepEqual(calls().filter(call => call.command === 'type').map(call => call.args),
    [['--headed', '@scuekeeper:e1', '--stdin']]);
});

test('Finder menu and editor commands stay app-scoped and preserve the foreground in headed replay', async t => {
  const calls = stub(t);
  const app = 'com.apple.finder';
  await withDesktop({ headed: true, signal }, async desktop => {
    await desktop.waitMenu(app, true);
    const menu = await desktop.snapshotSurface('menu', 2000, app);
    await desktop.clickSemantic(menu.tree.children[0].ref);
    await desktop.waitMenu(app, false);
    await desktop.snapshotSurface('focused', 2000, app);
    await desktop.press('return', { windowId: 'w-12' }, { headed: false });
  });
  assert.deepEqual(calls().slice(1).map(({ command, args }) => [command, ...args]), [
    ['wait', '--menu', '--app', app, '--timeout', '2000'],
    ['snapshot', '--surface', 'menu', '--app', app, '--include-bounds', '--max-depth', '20', '--timeout-ms', '2000'],
    ['click', '@s123:e1'],
    ['wait', '--menu-closed', '--app', app, '--timeout', '2000'],
    ['snapshot', '--surface', 'focused', '--app', app, '--include-bounds', '--max-depth', '20', '--timeout-ms', '2000'],
    ['press', 'return', '--window-id', 'w-12'],
  ]);
});
