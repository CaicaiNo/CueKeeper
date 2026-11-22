import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCaptureEvent } from '../dist/capture-protocol.js';
import { flowV2Check } from '../dist/contracts-v2.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { GlobalRecording } from '../dist/record-v2.js';

// The engine is exercised offline: events and window trees come from fixtures,
// no helper is spawned and no accessibility tree is read from the desktop.
const NOW = 1_700_000_000_000;
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}.json`, import.meta.url), 'utf8'));
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function readerFor(data, { failWindow } = {}) {
  return async window => {
    if (failWindow === window.windowNumber) throw new Error('snapshot unavailable');
    const snapshot = data.snapshots[String(window.windowNumber)];
    if (!snapshot) throw new Error(`fixture has no snapshot for window ${window.windowNumber}`);
    return structuredClone(snapshot);
  };
}

async function recordFixture(name, { now = () => NOW, options = {} } = {}) {
  const data = fixture(name);
  const recording = new GlobalRecording(readerFor(data), { now, ...options });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  return recording;
}

test('one recording spans two apps and three windows with one scope per step', async () => {
  const flow = (await recordFixture('two-apps-three-windows')).finish();
  assert.equal(flow.version, 2);
  assert.equal(flowV2Check.Check(flow), true);
  assert.deepEqual(flow.steps.map(step => step.kind), [
    'click', 'type', 'activate_app', 'type', 'focus_window', 'type', 'activate_app', 'key',
  ]);
  assert.deepEqual(flow.steps[0].scope, {
    kind: 'window', app: 'com.apple.finder', windowKey: 'finder-1', windowTitle: 'Downloads',
  });
  // Two keystrokes in the same field are one text step, stored as a parameter.
  assert.equal(flow.steps[1].kind, 'type');
  assert.equal(flow.steps[1].input, 'input_1');
  assert.equal(flow.steps[2].scope.app, 'com.apple.TextEdit');
  assert.equal(flow.steps[2].focusAfter.windowKey, 'textedit-1');
  assert.equal(flow.steps[3].input, 'input_2');
  // The second window of the same process gets its own window key.
  assert.equal(flow.steps[4].kind, 'focus_window');
  assert.equal(flow.steps[4].scope.windowKey, 'textedit-2');
  assert.equal(flow.steps[5].input, 'input_3');
  assert.equal(flow.steps[6].focusAfter.windowKey, 'finder-1');
  assert.equal(flow.steps[7].scope.windowKey, 'finder-1');
  assert.deepEqual(flow.inputs, ['input_1', 'input_2', 'input_3']);
  // Text is never stored: only parameter names appear in the flow.
  const json = JSON.stringify(flow);
  assert.ok(!json.includes('Zq-file'));
  assert.ok(!json.includes('Zq-one'));
  assert.ok(!json.includes('Zq-two'));
});

test('same-title windows stay distinct and a retitled window keeps its key', async () => {
  const flow = (await recordFixture('same-title-windows')).finish();
  const keys = flow.steps
    .filter(step => step.scope?.kind === 'window')
    .map(step => step.scope.windowKey);
  assert.deepEqual(keys, ['textedit-1', 'textedit-2', 'textedit-2', 'textedit-1', 'textedit-1']);
  // The surviving window follows its new title without taking over the new window's key.
  assert.equal(flow.steps[4].scope.windowTitle, 'Draft 2');
  assert.equal(flow.steps[4].scope.windowKey, 'textedit-1');
});

test('a late focus notification cannot move the flow back to a window it left', async () => {
  const flow = (await recordFixture('late-focus')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), [
    'type', 'activate_app', 'type', 'activate_app', 'type',
  ]);
  const activations = flow.steps.filter(step => step.kind === 'activate_app');
  assert.equal(activations.length, 2);
  assert.equal(flow.steps.at(-1).scope.windowKey, 'finder-1');
});

test('a queue gap splits a text burst and blocks replay until resolved', async () => {
  const flow = (await recordFixture('queue-overflow')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'gap', 'type']);
  assert.equal(flow.steps[1].code, 'CAPTURE_GAP');
  assert.notEqual(flow.steps[0].input, flow.steps[2].input);
  assert.throws(() => parseFlowV2(flow), { code: 'CAPTURE_GAP' });
});

test('a secure interval becomes one manual checkpoint and never carries content', async () => {
  const data = fixture('secure-input');
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const original of data.events) {
    const event = structuredClone(original);
    if (event.secure) event.chars = secret;
    await recording.add(parseCaptureEvent(event));
  }
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  const checkpoint = flow.steps[1];
  assert.equal(checkpoint.reason, 'secure_input');
  assert.equal(checkpoint.triggerStepId, 's1');
  assert.deepEqual(checkpoint.scope, flow.steps[0].scope);
  assert.deepEqual(checkpoint.resume, {
    scope: flow.steps[0].scope, check: { kind: 'window_exists', equals: true },
  });
  assert.equal(checkpoint.timeoutMs, 120_000);
  // The checkpoint is a normal, replayable step: no content gap remains.
  assert.equal(flowV2Check.Check(flow), true);
  assert.equal(parseFlowV2(flow).steps.length, 3);
  // Only the two non-secure text events read a window tree.
  assert.equal(reads, 2);
  const output = JSON.stringify(flow) + JSON.stringify(recording.captureWarnings);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes('"chars"'));
});

test('consecutive secure intervals fold into one checkpoint', async () => {
  const data = fixture('secure-input');
  const [first, ...rest] = data.events;
  // A focus notification ends the first interval but records no step; the next
  // secure event starts a second interval for the same window.
  const focus = {
    kind: 'focus', t: 210, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
    owner: { app: 'com.apple.finder', pid: 100, processInstance: 1_700_000_000_000, windowNumber: 11, windowTitle: 'Downloads' },
  };
  const events = [first, rest[0], focus, ...rest.slice(1)];
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  assert.equal(flow.steps.filter(step => step.kind === 'manual_checkpoint').length, 1);
});

test('a secure interval with no window-scoped trigger stays a SECURE_INPUT gap', async () => {
  const data = fixture('secure-input');
  const secure = data.events.filter(event => event.secure);
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW });
  for (const event of secure) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'SECURE_INPUT');
});

test('a Security Agent window never becomes a scope, even before the secure flag', async () => {
  const data = fixture('secure-input');
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  const agent = 'com.apple.SecurityAgent';
  const owner = (app, number) => ({
    app, pid: app === agent ? 900 : 100, processInstance: 1_700_000_000_000,
    windowNumber: number, windowTitle: app === agent ? 'Install Test App' : 'Downloads',
  });
  const events = [
    data.events[0],
    {
      kind: 'focus', t: 220, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
      owner: { ...owner(agent, 77), securityAgent: true },
    },
    {
      kind: 'text', t: 240, seen: 1_700_000_000_000, focusGeneration: 2, secure: false,
      chars: secret, owner: { ...owner(agent, 77), securityAgent: true },
    },
    {
      kind: 'text', t: 400, seen: 1_700_000_000_000, focusGeneration: 3, secure: false,
      owner: owner('com.apple.finder', 11),
    },
  ];
  let reads = 0;
  const recording = new GlobalRecording(async window => {
    reads += 1;
    return structuredClone(data.snapshots[String(window.windowNumber)]);
  }, { now: () => NOW });
  for (const event of events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['type', 'manual_checkpoint', 'type']);
  assert.equal(flow.steps.some(step => step.scope?.app === agent), false);
  assert.equal(flow.steps[1].scope.app, 'com.apple.finder');
  assert.equal(reads, 2);
  assert.ok(recording.captureWarnings.some(warning => warning.code === 'SECURE_AUTHORIZATION'));
  assert.ok(!JSON.stringify(flow).includes(secret));
});

test('occluded and first-mouse clicks become gaps; activation-only clicks navigate', async () => {
  const flow = (await recordFixture('unprovable-clicks')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'gap', 'activate_app', 'gap']);
  assert.equal(flow.steps[1].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps[3].code, 'CAPTURE_SCOPE_UNVERIFIED');
  assert.equal(flow.steps[2].scope.app, 'com.apple.TextEdit');
  assert.equal(flow.steps.filter(step => step.kind === 'click').length, 1);
});

test('a drag that crosses a window boundary leaves CROSS_SCOPE_GESTURE', async () => {
  const flow = (await recordFixture('cross-window-drag')).finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'CROSS_SCOPE_GESTURE');
});

test('an event whose snapshot missed its budget leaves STALE_CAPTURE', async () => {
  const data = fixture('queue-overflow');
  const recording = new GlobalRecording(readerFor(data), { now: () => NOW + 5000 });
  await recording.add(parseCaptureEvent(data.events[0]));
  const flow = recording.finish();
  assert.deepEqual(flow.steps.map(step => step.kind), ['gap']);
  assert.equal(flow.steps[0].code, 'STALE_CAPTURE');
});

test('an unreadable window snapshot becomes a gap instead of a guessed step', async () => {
  const data = fixture('queue-overflow');
  const recording = new GlobalRecording(readerFor(data, { failWindow: 11 }), { now: () => NOW });
  for (const event of data.events) await recording.add(parseCaptureEvent(event));
  const flow = recording.finish();
  assert.ok(flow.steps.some(step => step.kind === 'gap' && step.code === 'STALE_CAPTURE'));
});

test('excluded apps are dropped before their window is read', async () => {
  const data = fixture('queue-overflow');
  let reads = 0;
  const recording = new GlobalRecording(async () => {
    reads += 1;
    throw new Error('excluded app must not be read');
  }, { now: () => NOW, exclude: ['com.apple.finder'] });
  for (const event of data.events.filter(entry => entry.kind !== 'gap')) {
    await recording.add(parseCaptureEvent(event));
  }
  assert.equal(reads, 0);
  assert.throws(() => recording.finish(), { code: 'EMPTY_RECORDING' });
});

test('capture protocol rejects a malformed global event', () => {
  assert.throws(() => parseCaptureEvent({ kind: 'click' }), { code: 'CAPTURE_PROTOCOL' });
  assert.throws(() => parseCaptureEvent({
    kind: 'gap', t: 1, seen: 1, focusGeneration: 0, secure: false, gapCode: 'NOPE',
  }), { code: 'CAPTURE_PROTOCOL' });
  const valid = parseCaptureEvent({
    kind: 'click', t: 1, seen: 1, focusGeneration: 2, secure: false,
    point: [10, 20], decision: 'record', owner: { app: 'com.apple.TextEdit', pid: 7, windowNumber: 3 },
  });
  assert.equal(valid.kind, 'click');
  assert.equal(valid.point[0], 10);
  // Secure evidence names why an event was refused, without carrying content.
  const secure = parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: true,
    secureEvidence: ['system_secure_input', 'secure_control'],
    owner: { app: 'com.apple.SecurityAgent', pid: 8, securityAgent: true },
  });
  assert.deepEqual(secure.secureEvidence, ['system_secure_input', 'secure_control']);
  assert.equal(secure.owner.securityAgent, true);
  assert.throws(() => parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: true, secureEvidence: ['nope'],
  }), { code: 'CAPTURE_PROTOCOL' });
  assert.throws(() => parseCaptureEvent({
    kind: 'text', t: 2, seen: 2, focusGeneration: 3, secure: false,
    secureEvidence: ['secure_control'],
  }), { code: 'CAPTURE_PROTOCOL' });
});

test('record --global is an explicit mode that rejects target flags', { skip: process.platform !== 'darwin' }, () => {
  for (const args of [
    ['record', '--global', '--app', 'com.apple.TextEdit'],
    ['record', '--global', '--window', 'Notes'],
    ['record', '--global', '--app-path', '/Applications/TextEdit.app'],
    ['record', '--global', '--seconds', '5'],
    ['record', '--global', '--max-seconds', '0'],
    ['record', '--global', '--max-seconds', '3601'],
    ['record', '--global', '--exclude', 'not-a-bundle-id'],
    ['record', '--global', '--clipboard'],
    ['record', '--exclude', 'com.apple.TextEdit'],
  ]) {
    const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: process.env.HOME },
    });
    const response = JSON.parse(result.stdout);
    assert.equal(result.status, 2, `${args.join(' ')} should be invalid input`);
    assert.equal(response.ok, false);
  }
});

/**
 * Runs the real CLI against stub helper and desktop executables. The helper
 * emits a ready line and the events; the desktop only serves the fixture trees.
 * No GUI, accessibility API or capture tap is involved.
 */
function globalCliFixture(t, { events, snapshots, cliArgs = [], seconds = 2, exit = 0, ready }) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-global-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    recursive: true,
    filter: source => !source.endsWith('/cuekeeper-capture') && !source.endsWith('/cuekeeper-ime'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');

  const desktop = join(dir, 'desktop');
  const commandsLog = join(dir, 'desktop-commands.log');
  writeFileSync(commandsLog, '');
  const trees = Object.fromEntries(Object.entries(snapshots).map(([number, snapshot]) => {
    const convert = node => ({
      role: node.role,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...(node.ref === undefined ? {} : { ref_id: node.ref }),
      ...(node.bounds === undefined ? {} : { bounds: node.bounds }),
      states: node.states ?? [],
      secure: node.secure ?? false,
      children: (node.children ?? []).map(convert),
    });
    return [number, { id: snapshot.windowId, title: snapshot.tree.name, tree: convert(snapshot.tree) }];
  }));
  writeFileSync(desktop, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandsLog)}, command + ' ' + args.join(' ') + '\\n');
const windows = ${JSON.stringify(trees)};
if (command === 'version') {
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: { version: '1.3.1' } }));
  process.exit(0);
}
if (command === 'snapshot') {
  const index = args.indexOf('--window-id');
  const id = index < 0 ? '' : args[index + 1];
  const entry = Object.entries(windows).find(([, window]) => window.id === id);
  if (!entry) {
    console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'WINDOW_NOT_FOUND' } }));
    process.exit(1);
  }
  const [, window] = entry;
  console.log(JSON.stringify({ version: '2.6', command, ok: true, data: {
    complete: true, truncated: false,
    window: { id: window.id, title: window.title }, tree: window.tree,
  } }));
  process.exit(0);
}
console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'UNSUPPORTED' } }));
process.exit(1);
`, { mode: 0o700 });

  const capture = join(dir, 'cuekeeper-capture');
  const captureArgs = join(dir, 'capture-args.json');
  writeFileSync(capture, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(captureArgs)}, JSON.stringify(args));
if (args[0] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
assert.equal(args[0], '--global');
const seen = Date.now();
const messages = [
  ${JSON.stringify(ready ?? { kind: 'ready', global: true, hotkeysFiltered: true, indicator: false })},
  ...${JSON.stringify(events)},
];
writeFileSync(1, messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n') + '\\n');
process.exitCode = ${exit};
`, { mode: 0o700 });

  const output = join(dir, 'global.flow.json');
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record', '--global',
    '--countdown', '0', '--no-indicator', '--max-seconds', String(seconds),
    '--out', output, '--json', ...cliArgs], {
    env: {
      ...process.env,
      CUEKEEPER_AGENT_DESKTOP: desktop,
      CUEKEEPER_RECORDER: capture,
      CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      CUEKEEPER_IME_DIR: join(dir, 'ime-root'),
    },
    encoding: 'utf8', timeout: 20_000,
  });
  const response = JSON.parse(result.stdout);
  const written = existsSync(output) ? readFileSync(output, 'utf8') : undefined;
  return {
    code: result.status, response, stderr: result.stderr, output, written,
    captureArgs: JSON.parse(readFileSync(captureArgs, 'utf8')),
    commands: readFileSync(commandsLog, 'utf8').trim().split('\n').filter(Boolean),
  };
}

test('record --global writes a v2 flow with scopes and no typed content', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  // Only the first three windows' earliest events are needed for the CLI pass.
  const secret = `Zq${randomUUID().slice(0, 8)}`;
  const events = [
    data.events[0],
    { ...data.events[1], chars: secret },
    data.events[3],
    { ...data.events[4], chars: secret },
  ];
  const run = globalCliFixture(t, {
    events, snapshots: data.snapshots, cliArgs: ['--exclude', 'com.apple.mail'],
  });
  assert.equal(run.code, 0, (run.stderr || '') + JSON.stringify(run.response));
  assert.deepEqual(run.captureArgs.slice(0, 2), ['--global', '2']);
  assert.deepEqual(run.captureArgs.slice(-2), ['--exclude', 'com.apple.mail']);
  assert.ok(run.written, 'the CLI must write the flow');
  const flow = JSON.parse(run.written);
  assert.equal(flow.version, 2);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click', 'type', 'activate_app', 'type']);
  assert.equal(flow.steps[1].input, 'input_1');
  assert.equal(flow.steps[3].scope.app, 'com.apple.TextEdit');
  assert.ok(!run.written.includes(secret));
  assert.ok(!run.stderr.includes(secret));
  assert.ok(!JSON.stringify(run.response).includes(secret));
  assert.equal(run.commands.filter(command => command.startsWith('snapshot')).length, 3);
});

test('record --global keeps a partial flow when the helper stops after an event', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    seconds: 1,
    exit: 1,
  });
  assert.equal(run.code, 1);
  assert.equal(run.response.ok, false);
  assert.equal(run.response.error.code, 'CAPTURE_FAILED');
  assert.equal(run.response.data.partial, true);
  const flow = JSON.parse(run.written);
  assert.deepEqual(flow.steps.map(step => step.kind), ['click']);
});

test('a helper that does not confirm global mode is refused', { skip: process.platform !== 'darwin' }, t => {
  const data = fixture('two-apps-three-windows');
  const run = globalCliFixture(t, {
    events: [data.events[0]],
    snapshots: data.snapshots,
    ready: { kind: 'ready', hotkeysFiltered: true, indicator: false },
  });
  assert.equal(run.code, 2);
  assert.equal(run.response.ok, false);
  assert.equal(run.response.error.code, 'CAPTURE_PROTOCOL');
  assert.equal(run.written, undefined);
});
