import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Recording } from '../dist/record.js';
import { parseSnapshot } from '../dist/locator.js';
import { loadSession } from '../dist/workbench-session.js';
import { compileDraft, setupDraft } from '../workbench/model.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = example('textedit.snapshot');
const flow = example('textedit.flow');
const app = flow.target.app;
const title = flow.target.window;
const snapshot = parseSnapshot(fixture.data, fixture.target);

test('a path-fixed recording keeps only element locators and persists the path', () => {
  const target = { app, window: title, appPath: '/Applications/B copy.app' };
  const recording = new Recording(target, { requireElementLocator: true });
  // A click inside the window but on no control cannot be replayed against one copy.
  assert.equal(recording.add({ event: { kind: 'click', t: 1, point: [105, 510] }, snapshot }), 'UNTARGETED_POINT');
  assert.equal(recording.add({
    event: { kind: 'click', t: 2, point: [135, 165] }, snapshot,
  }), undefined);
  const captured = recording.finish();
  assert.equal(captured.target.appPath, '/Applications/B copy.app');
  assert.deepEqual(captured.steps.map(step => step.kind), ['click']);
  assert.deepEqual(captured.steps[0].target, { kind: 'element', role: 'textfield', name: '' });

  // An old flow still records a point click when no path was selected.
  const legacy = new Recording(flow.target);
  assert.equal(legacy.add({ event: { kind: 'click', t: 1, point: [105, 510] }, snapshot }), undefined);
  const legacyFlow = legacy.finish();
  assert.deepEqual(legacyFlow.steps[0].target, { kind: 'point', point: [105, 510] });
  assert.equal('appPath' in legacyFlow.target, false);
});

function recordWorkspace(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-capture-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    recursive: true, filter: source => !source.endsWith('/cuekeeper-capture'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(root, 'node_modules'), 'dir');

  const requested = join(root, 'Link.app');
  const canonical = join(root, 'B 副本.app');
  mkdirSync(join(canonical, 'Contents'), { recursive: true });
  writeFileSync(join(canonical, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string></dict></plist>
`);
  symlinkSync(canonical, requested);
  const resolved = realpathSync(canonical);

  const helper = join(root, 'identity.cjs');
  writeFileSync(helper, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const instances = [{ pid: 501, startedAt: '501.10', bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(resolved)} }];
const data = command === 'describe' ? instances[0] :
  command === 'instances' ? { instances } :
  command === 'windows' ? [{ number: 1234, ownerPid: 501, title: ${JSON.stringify(title)} }] :
  command === 'validate' ? { bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(resolved)} } :
  null;
console.log(JSON.stringify({ ok: true, data }));
`, { mode: 0o700 });

  const driver = join(root, 'desktop.cjs');
  const driverLog = join(root, 'driver.log');
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(driverLog)}, JSON.stringify({ command, args }) + '\\n');
const data = command === 'version' ? { version: '1.3.1' }
  : command === 'list-windows' ? [{ id: 'w-1234', title: ${JSON.stringify(title)}, process_instance: 501 }]
  : ${JSON.stringify(fixture.data)};
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const capture = join(dist, 'cuekeeper-capture');
  const captureLog = join(root, 'capture.log');
  const identityLine = options.identityOverride
    ? { pid: 999, bundlePath: resolved, windowOwnerPid: 501 }
    : { pid: 501, bundlePath: resolved, windowOwnerPid: 501 };
  const messages = options.ready === false ? [] : [
    { kind: 'ready', indicator: false, hotkeysFiltered: true, identity: identityLine },
    ...(options.events ?? []),
  ];
  writeFileSync(capture, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(captureLog)}, JSON.stringify(process.argv.slice(2)));
const seen = Date.now();
const messages = ${JSON.stringify(messages)};
process.stdout.write(messages.map((event, t) => JSON.stringify({ ...event, seen, t }) + '\\n').join(''));
process.exitCode = ${options.captureExit ?? 0};
`, { mode: 0o700 });

  const output = join(root, 'recorded.flow.json');
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record',
    '--app', app, '--window', title, '--app-path', requested, '--out', output,
    '--seconds', '1', '--no-indicator', '--json', ...(options.flags ?? [])], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: driver,
      CUEKEEPER_APP_IDENTITY: helper,
    },
    encoding: 'utf8', timeout: 20000,
  });
  return {
    root, canonical: resolved, requested, output, result,
    captureArgs: existsSync(captureLog) ? JSON.parse(readFileSync(captureLog, 'utf8')) : undefined,
    driverCalls: existsSync(driverLog)
      ? readFileSync(driverLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    recorded: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : undefined,
  };
}

test('recording a non-default copy confirms the instance and skips other-copy input', { skip: process.platform !== 'darwin' }, t => {
  const { canonical, requested, result, captureArgs, driverCalls, recorded } = recordWorkspace(t, {
    captureExit: 1,
    events: [
      { kind: 'click', point: [135, 165] },
      { kind: 'focus', active: false },
      { kind: 'text', chars: 'other-copy' },
      { kind: 'click', point: [105, 510] },
      { kind: 'error', code: 'IDENTITY_CHANGED', detail: 'The bound process stopped during recording' },
    ],
  });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout);
  assert.ok(response.data, result.stdout + result.stderr);
  assert.equal(response.ok, false);
  assert.equal(response.data.partial, true);
  assert.equal(response.error.code, 'IDENTITY_CHANGED');
  assert.ok(response.data.warnings.some(warning => warning.code === 'UNTARGETED_POINT'));
  assert.ok(response.data.warnings.some(warning => warning.code === 'FOCUS_CHANGED'));

  assert.deepEqual(captureArgs,
    [app, '1234', '1', '--no-indicator', '--pid', '501', '--app-path', canonical]);
  assert.equal(recorded.target.appPath, canonical, 'the proven canonical path is persisted');
  assert.equal(recorded.target.appPath === requested, false);
  assert.deepEqual(recorded.steps.map(step => [step.kind, step.target?.kind]),
    [['click', 'element']]);
  assert.doesNotMatch(JSON.stringify(recorded), /other-copy/);
  // Every snapshot stays on the selected window and skips the app-scoped path.
  const snapshots = driverCalls.filter(call => call.command === 'snapshot');
  assert.ok(snapshots.length >= 1);
  for (const call of snapshots) {
    const index = call.args.indexOf('--window-id');
    assert.equal(call.args[index + 1], 'w-1234');
    assert.equal(call.args.includes('--app'), false);
  }
});

test('recording refuses a helper that does not confirm the selected copy', { skip: process.platform !== 'darwin' }, t => {
  const { result, recorded } = recordWorkspace(t, {
    events: [{ kind: 'click', point: [135, 165] }],
    // The helper confirms a different PID, so nothing may be attributed.
    identityOverride: true,
  });
  assert.equal(result.status, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, 'IDENTITY_MISMATCH');
  assert.equal(recorded, undefined);
});

test('pick with a path returns the same target and reads only the bound window', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-pick-path-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requested = join(root, 'Link.app');
  const canonical = join(root, 'B 副本.app');
  mkdirSync(join(canonical, 'Contents'), { recursive: true });
  writeFileSync(join(canonical, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${app}</string></dict></plist>
`);
  symlinkSync(canonical, requested);
  const helper = join(root, 'identity.cjs');
  writeFileSync(helper, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const instances = [{ pid: 501, startedAt: '501.10', bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(canonical)} }];
const data = command === 'describe' ? instances[0] :
  command === 'instances' ? { instances } :
  command === 'windows' ? [{ number: 1234, ownerPid: 501, title: ${JSON.stringify(title)} }] :
  command === 'validate' ? { bundleId: ${JSON.stringify(app)}, bundlePath: ${JSON.stringify(canonical)} } : null;
console.log(JSON.stringify({ ok: true, data }));
`, { mode: 0o700 });
  const driver = join(root, 'desktop.cjs');
  const log = join(root, 'calls.jsonl');
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
const data = command === 'version' ? { version: '1.3.1' }
  : command === 'list-windows' ? [{ id: 'w-1234', title: ${JSON.stringify(title)}, process_instance: 501 }]
  : ${JSON.stringify(fixture.data)};
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [cliPath, 'pick', '--app', app, '--window', title,
    '--app-path', requested, '--select', 'e1', '--json'], {
    env: { ...process.env, CUEKEEPER_AGENT_DESKTOP: driver, CUEKEEPER_APP_IDENTITY: helper },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout);
  assert.deepEqual(response.data.target, { app, window: title, appPath: realpathSync(canonical) });
  assert.equal(response.data.ref, '@scuekeeper:e1');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(call => call.command === 'snapshot' && !call.args.includes('--window-id')), false);
  const snapshotCall = calls.find(call => call.command === 'snapshot');
  assert.equal(snapshotCall.args[snapshotCall.args.indexOf('--window-id') + 1], 'w-1234');
  assert.equal(snapshotCall.args.includes('--app'), false);

  // An offline snapshot from another path cannot answer for the selected copy.
  const fixtureWithPath = structuredClone(fixture);
  fixtureWithPath.target.appPath = '/Applications/A.app';
  const snapshotPath = join(root, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(fixtureWithPath));
  const conflict = spawnSync(process.execPath, [cliPath, 'pick', '--app', app, '--window', title,
    '--app-path', requested, '--snapshot', snapshotPath, '--json'], { encoding: 'utf8' });
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(conflict.stdout).error.code, 'APP_AMBIGUOUS');

  // The same snapshot is accepted when the flow carries no path.
  const legacy = spawnSync(process.execPath, [cliPath, 'pick', '--app', app, '--window', title,
    '--snapshot', snapshotPath, '--select', 'e1', '--json'], { encoding: 'utf8' });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.deepEqual(JSON.parse(legacy.stdout).data.target,
    { app, window: title, appPath: '/Applications/A.app' });
});

test('the workbench loads old sessions and an explicit path reselect replaces the target path', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-session-path-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  async function sessionFor(directory, targetPath) {
    mkdirSync(directory, { recursive: true });
    const target = { app, window: title, ...(targetPath ? { appPath: targetPath } : {}) };
    writeFileSync(join(directory, 'flow.json'), JSON.stringify({ ...flow, target }));
    const envelope = structuredClone(fixture);
    envelope.target = target;
    writeFileSync(join(directory, 'snapshot.json'), JSON.stringify(envelope));
    return loadSession(directory);
  }

  const plain = await sessionFor(join(root, 'plain'));
  assert.equal(plain.view.target.appPath, undefined);
  assert.equal(plain.view.pathConflict, false);
  assert.equal(plain.view.snapshotAppPath, undefined);

  const matching = await sessionFor(join(root, 'matching'), '/Applications/B.app');
  assert.equal(matching.view.target.appPath, '/Applications/B.app');
  assert.equal(matching.view.snapshotAppPath, '/Applications/B.app');
  assert.equal(matching.view.pathConflict, false);

  const conflicting = await sessionFor(join(root, 'conflicting'), '/Applications/B.app');
  const conflictingEnvelope = structuredClone(fixture);
  conflictingEnvelope.target = { app, window: title, appPath: '/Applications/A.app' };
  writeFileSync(join(root, 'conflicting', 'snapshot.json'), JSON.stringify(conflictingEnvelope));
  const conflicted = await loadSession(join(root, 'conflicting'));
  assert.equal(conflicted.view.pathConflict, true);
  assert.equal(conflicted.view.snapshotAppPath, '/Applications/A.app');

  // A saved test item takes the explicitly selected copy, not the old path.
  const draft = setupDraft(conflicted.view.setup);
  const test = compileDraft({ ...conflicted.view, setup: draft.conditions }, '重新选择副本',
    conflicted.view.timeline.map(row => ({ id: row.id, action: row.action })),
    { [app]: '/Applications/C.app' });
  assert.equal(test.target.appPath, '/Applications/C.app');
  assert.equal(test.target.window, title);
  const old = compileDraft({ ...conflicted.view, setup: draft.conditions }, '保留旧路径',
    conflicted.view.timeline.map(row => ({ id: row.id, action: row.action })));
  assert.equal(old.target.appPath, '/Applications/B.app');
});
