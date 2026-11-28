import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { unzipSync, strFromU8 } from 'fflate';
import { discoverAssets } from '../dist/assets.js';
import { schemas } from '../dist/contracts.js';
import { offlineDesktop, withDesktop } from '../dist/desktop.js';
import { parseFlow, plan } from '../dist/flow.js';
import { parseSnapshot, resolve } from '../dist/locator.js';
import { Recording } from '../dist/record.js';
import { recordingFileName } from '../dist/recording-output.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const flow = example('textedit.flow');
const snapshot = parseSnapshot(fixture.data, fixture.target);
const editor = {
  kind: 'element', role: 'textfield', path: ['window', 'scrollarea', 'textfield'],
};
const signal = new AbortController().signal;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

const asciiSource = { id: 'com.apple.keylayout.ABC', name: 'ABC', ascii: true, selectable: true };
const sogouSource = { id: 'com.sogou.inputmethod.sogou.pinyin', name: '搜狗拼音', ascii: false, selectable: true };

/**
 * A stub TIS helper. The recorder reads the active input source before capture,
 * so a locally built `cuekeeper-ime` plus a Chinese IME on the host would add
 * `IME_ACTIVE` warnings and a stderr prompt to every assertion below. Injecting
 * the stub keeps the recording tests independent of the host's input source.
 */
function imeStub(dir, source) {
  const helper = join(dir, 'cuekeeper-ime');
  writeFileSync(helper, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const source = ${JSON.stringify(source)};
const reply = data => console.log(JSON.stringify({ ok: true, data }));
if (command === 'version') reply({ helper: 'cuekeeper-ime', version: 1 });
else if (command === 'list') reply({ sources: [source] });
else if (command === 'current') reply({ source });
else {
  console.log(JSON.stringify({ ok: false, error: { code: 'INPUT_ERROR', message: 'unknown command' } }));
  process.exit(1);
}
`, { mode: 0o700 });
  return helper;
}

// Exercise the real CLI and output writer without invoking either live macOS executable.
// The driver resolves a window by title only when asked to; otherwise it
// snapshots whichever window the app has in front. `frontWindow` models a
// second app window that is in front of the target, and `windows` replaces the
// whole inventory (for a title that is absent). `imeSource` is what the stubbed
// input-source helper reports as the active source. `apps` is the `list-apps`
// inventory used by one-key recording, and `args` replaces the recording flags.
function recordFixture(t, events, { captureExit = 0, flags = [], seconds = 1, ready = true,
  missingWindowAtSnapshot, frontWindow, windows, imeSource = asciiSource, apps = [], args, home } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-record-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  cpSync(new URL('../dist/', import.meta.url), dist, {
    // Never inherit the capture binary or a locally built input-source helper.
    recursive: true, filter: source =>
      !source.endsWith('/cuekeeper-capture') && !source.endsWith('/cuekeeper-ime'),
  });
  cpSync(new URL('../package.json', import.meta.url), join(dir, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(dir, 'node_modules'), 'dir');
  const desktop = join(dir, 'desktop');
  const snapshotsLog = join(dir, 'snapshots.log');
  const commandsLog = join(dir, 'commands.log');
  writeFileSync(snapshotsLog, '');
  writeFileSync(commandsLog, '');
  const inventory = windows ?? [
    ...(frontWindow ? [{ id: 'w-2000', title: frontWindow }] : []),
    { id: fixture.data.window.id, title: fixture.target.window },
  ];
  writeFileSync(desktop, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandsLog)}, command + '\\n');
const snapshot = ${JSON.stringify(fixture.data)};
const windows = ${JSON.stringify(inventory)};
const apps = ${JSON.stringify(apps)};
function frontSnapshot() {
  if (windows.length <= 1) return snapshot;
  const doc = JSON.parse(${JSON.stringify(JSON.stringify(fixture.data))});
  doc.window.id = windows[0].id;
  doc.window.title = windows[0].title;
  return doc;
}
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'list-windows') data = windows;
else if (command === 'list-apps') data = { apps };
else if (command === 'snapshot') {
  const windowArg = args.indexOf('--window-id');
  const windowId = windowArg < 0 ? null : args[windowArg + 1];
  appendFileSync(${JSON.stringify(snapshotsLog)}, JSON.stringify(windowId) + '\\n');
  const snapshotNumber = readFileSync(${JSON.stringify(snapshotsLog)}, 'utf8').trimEnd().split('\\n').length;
  if (snapshotNumber === ${JSON.stringify(missingWindowAtSnapshot)}) {
    console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'WINDOW_NOT_FOUND' } }));
    process.exit(1);
  }
  data = windowId === null || windowId === windows[0].id ? frontSnapshot() : snapshot;
} else data = snapshot;
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
  const indicator = flags.includes('--no-indicator') ? false : {
    window: 4321, display: 1, level: 25, bounds: [0, 0, 1470, 956],
  };
  const messages = ready ? [{ kind: 'ready', indicator, hotkeysFiltered: true }, ...events] : events;
  writeFileSync(join(dist, 'cuekeeper-capture'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
assert.deepEqual(process.argv.slice(2), ${JSON.stringify([fixture.target.app, '1234', String(seconds), ...flags])});
const seen = Date.now();
const messages = ${JSON.stringify(messages)};
writeFileSync(1, messages.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n') + '\\n');
process.exitCode = ${captureExit};
`, { mode: 0o700 });
  const path = join(dir, 'recorded.flow.json');
  const cliArgs = args ?? ['--app', fixture.target.app, '--window', fixture.target.window, '--out', path];
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), 'record',
    ...cliArgs, '--seconds', String(seconds), '--json', ...flags], {
    env: {
      ...process.env,
      ...(home ? { HOME: home } : {}),
      CUEKEEPER_AGENT_DESKTOP: desktop,
      CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      CUEKEEPER_IME: imeStub(dir, imeSource),
      CUEKEEPER_IME_DIR: join(dir, 'ime-root'),
    },
    encoding: 'utf8', timeout: 15000,
  });
  const response = JSON.parse(result.stdout);
  const written = response?.data?.output ?? path;
  return { code: result.status, response, stderr: result.stderr, output: written, dir,
    snapshotWindows: readFileSync(snapshotsLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    commands: readFileSync(commandsLog, 'utf8').trim().split('\n').filter(Boolean),
    recorded: existsSync(written) ? parseFlow(JSON.parse(readFileSync(written, 'utf8'))) : undefined };
}

const captureClick = { kind: 'click', point: [135, 165] };
const captureSave = { kind: 'key', key: 's', modifiers: ['meta'] };

test('record CLI records under the stubbed ASCII source without IME noise',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, stderr } = recordFixture(t, [captureClick]);
    assert.equal(code, 0, stderr);
    assert.deepEqual(response.data.inputSource, asciiSource);
    assert.equal(response.data.warnings, undefined);
    assert.doesNotMatch(stderr, /输入法/);
  });

test('record CLI warns IME_ACTIVE for a stubbed Chinese source and stays quiet once it reports ASCII',
  { skip: process.platform !== 'darwin' }, t => {
    const chinese = recordFixture(t, [captureClick], { imeSource: sogouSource });
    assert.equal(chinese.code, 0, chinese.stderr);
    assert.deepEqual(chinese.response.data.inputSource, sogouSource);
    assert.deepEqual(chinese.response.data.warnings.map(warning => warning.code), ['IME_ACTIVE']);
    assert.match(chinese.stderr, /输入法处于中文状态：当前输入源「搜狗拼音」/);

    // Back on the default stub the warning and the prompt must both disappear:
    // the failure was the host source leaking in, not a real capture difference.
    const restored = recordFixture(t, [captureClick]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.deepEqual(restored.response.data.inputSource, asciiSource);
    assert.equal(restored.response.data.warnings, undefined);
    assert.doesNotMatch(restored.stderr, /输入法/);
  });

test('record CLI saves three clicks and exits zero with an unsupported input warning',
  { skip: process.platform !== 'darwin' }, t => {
    for (const warning of ['UNSUPPORTED_EVENT', 'UNSUPPORTED_CLICK']) {
      const { code, response, recorded } = recordFixture(t, [
        captureClick, { kind: 'warning', code: warning }, captureClick, captureClick,
      ]);
      const result = { exitCode: code, ok: response.ok, actions: response.data.actions,
        flow: recorded.steps.map(step => step.kind), warnings: response.data.warnings.map(entry => entry.code) };
      t.diagnostic(JSON.stringify(result));
      assert.deepEqual(result, {
        exitCode: 0, ok: true, actions: 3, flow: ['click', 'click', 'click'], warnings: [warning],
      });
      assert.equal(response.data.partial, undefined);
    }
  });

test('record CLI returns EMPTY_RECORDING when only unsupported input arrives',
  { skip: process.platform !== 'darwin' }, t => {
    for (const warning of ['UNSUPPORTED_EVENT', 'DRAG_MODIFIERS_SKIPPED']) {
      const { code, response, recorded } = recordFixture(t, [{ kind: 'warning', code: warning }]);
      assert.equal(code, 1);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'EMPTY_RECORDING');
      assert.ok(response.error.message.includes(warning));
      assert.equal(recorded, undefined);
    }
  });

test('record CLI preserves the captured prefix when the target window is lost',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, snapshotWindows } = recordFixture(t, [
      captureClick, captureClick, captureClick,
    ], { missingWindowAtSnapshot: 3 });
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'WINDOW_NOT_FOUND');
    assert.equal(response.data.partial, true);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click']);
    assert.deepEqual(snapshotWindows, [fixture.data.window.id, fixture.data.window.id, fixture.data.window.id]);
  });

test('record CLI resolves the target window by exact title when another window is in front',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, snapshotWindows } = recordFixture(t, [
      captureClick, captureClick,
    ], { frontWindow: 'Safari Start Page' });
    assert.equal(code, 0, JSON.stringify(response));
    assert.equal(response.ok, true);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click', 'click']);
    // Every read goes to the window whose title matched, never to the front one.
    assert.deepEqual(snapshotWindows,
      [fixture.data.window.id, fixture.data.window.id, fixture.data.window.id]);
  });

test('record CLI reports WINDOW_NOT_FOUND and reads no window when the title is absent',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, snapshotWindows } = recordFixture(t, [captureClick], {
      windows: [{ id: 'w-2000', title: 'Safari Start Page' }],
    });
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'WINDOW_NOT_FOUND');
    assert.equal(recorded, undefined);
    // The missing title must not fall back to snapshotting another window.
    assert.deepEqual(snapshotWindows, []);
  });

// One-key recording: the fake driver inventories a front window whose owner PID
// joins to the running TextEdit app, exactly as agent-desktop reports it.
const frontWindowInventory = [
  { id: 'w-2000', title: 'Safari Start Page', pid: 9999, is_focused: false },
  { id: fixture.data.window.id, title: fixture.target.window, pid: 4321, is_focused: true },
];
const runningApps = [{ name: 'TextEdit', bundle_id: fixture.target.app, pid: 4321 }];

function recordingHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'cuekeeper-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('record CLI records the front window into the default recordings directory',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const { code, response, recorded, output, stderr, commands } = recordFixture(t, [captureClick], {
      windows: frontWindowInventory, apps: runningApps, args: ['--countdown', '0'], home,
    });
    assert.equal(code, 0, stderr);
    assert.equal(response.ok, true);
    assert.equal(response.data.actions, 1);
    // The target is the front window's exact title and its owner's bundle ID.
    assert.deepEqual(recorded.target, { app: fixture.target.app, window: fixture.target.window });
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click']);
    assert.equal(dirname(output), join(home, '.cuekeeper', 'recordings'));
    assert.match(basename(output), /^recording-\d{8}T\d{6}Z\.flow\.json$/);
    assert.equal(response.data.workbench, 'cuekeeper workbench ~/.cuekeeper/recordings');
    assert.match(stderr, /立即读取当前前台窗口/);
    assert.match(stderr, /开始录制前台窗口：com\.apple\.TextEdit · Cuekeeper-M1\.txt/);
    assert.equal(commands.filter(command => command === 'list-apps').length, 1);
  });

test('record CLI waits for the countdown before reading the front window',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const started = Date.now();
    const { code, stderr } = recordFixture(t, [captureClick], {
      windows: frontWindowInventory, apps: runningApps, args: ['--countdown', '1'], home,
    });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /1 秒后开始录制，请切换到要录制的 App 窗口。/);
    assert.ok(Date.now() - started >= 950, 'the countdown must actually wait');
  });

test('record CLI reports WINDOW_NOT_FOUND when no front window is focused',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const { code, response, output, stderr, snapshotWindows } = recordFixture(t, [captureClick], {
      args: ['--countdown', '0'], home,
    });
    assert.equal(code, 1, stderr);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'WINDOW_NOT_FOUND');
    assert.match(response.error.message, /前台窗口/);
    assert.deepEqual(snapshotWindows, []);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(join(home, '.cuekeeper', 'recordings')), true);
  });

test('record CLI reports APP_NOT_FOUND when the front window has no owning bundle ID',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const { code, response, recorded } = recordFixture(t, [captureClick], {
      windows: frontWindowInventory, apps: [{ name: 'Other', bundle_id: 'com.example.other', pid: 777 }],
      args: ['--countdown', '0'], home,
    });
    assert.equal(code, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'APP_NOT_FOUND');
    assert.equal(recorded, undefined);
  });

test('record CLI selects the focused window of an explicitly named app',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const { code, response, recorded, commands } = recordFixture(t, [captureClick], {
      windows: frontWindowInventory, apps: runningApps,
      args: ['--app', fixture.target.app, '--countdown', '0'], home,
    });
    assert.equal(code, 0);
    assert.deepEqual(recorded.target, { app: fixture.target.app, window: fixture.target.window });
    // The bundle ID came from the flag, so the app inventory is never read.
    assert.equal(commands.includes('list-apps'), false);

    const missing = recordFixture(t, [captureClick], {
      windows: [{ id: 'w-2000', title: 'Safari Start Page', pid: 9999 }],
      args: ['--app', fixture.target.app, '--countdown', '0'], home,
    });
    assert.equal(missing.code, 1);
    assert.equal(missing.response.error.code, 'WINDOW_NOT_FOUND');
  });

test('record CLI keeps explicit --app/--window/--out authoritative and skips detection',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const { code, response, recorded, output, stderr, commands, dir } = recordFixture(t, [captureClick], { home });
    assert.equal(code, 0);
    assert.equal(output, join(dir, 'recorded.flow.json'));
    assert.deepEqual(recorded.target, { app: fixture.target.app, window: fixture.target.window });
    assert.equal(commands.includes('list-apps'), false);
    assert.doesNotMatch(stderr, /秒后开始录制|立即读取当前前台窗口/);
    assert.equal(response.data.workbench, undefined);
    assert.equal(existsSync(join(home, '.cuekeeper')), false);
  });

test('record CLI suffixes a taken default recording name instead of overwriting',
  { skip: process.platform !== 'darwin' }, t => {
    const home = recordingHome(t);
    const directory = join(home, '.cuekeeper', 'recordings');
    mkdirSync(directory, { recursive: true });
    // Occupy the name the run may pick now or on the next few second ticks.
    for (let offset = 0; offset < 30; offset++) {
      writeFileSync(join(directory, recordingFileName(new Date(Date.now() + offset * 1000))),
        '{"taken":true}');
    }
    const { code, response, output } = recordFixture(t, [captureClick], {
      windows: frontWindowInventory, apps: runningApps, args: ['--countdown', '0'], home,
    });
    assert.equal(code, 0);
    assert.match(basename(output), /-2\.flow\.json$/);
    const occupied = join(directory, `${basename(output).replace(/-2\.flow\.json$/, '')}.flow.json`);
    assert.equal(readFileSync(occupied, 'utf8'), '{"taken":true}');
    assert.equal(response.data.actions, 1);
  });

test('record CLI keeps a single click that activates the target and saves across app switches',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr, snapshotWindows } = recordFixture(t, [
      { kind: 'focus', active: false }, { kind: 'text', chars: 'Other app' },
      captureClick, { kind: 'focus', active: true },
      { kind: 'text', chars: 'Cuekeeper' }, { kind: 'text', chars: ' M1' },
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
    assert.deepEqual(snapshotWindows, [fixture.data.window.id, fixture.data.window.id, null, null]);
    assert.equal(recorded.steps[1].text, 'Cuekeeper M1');
    assert.deepEqual(recorded.steps[2].modifiers, ['meta']);
    assert.equal(recorded.steps[2].key, 's');
  });

test('record CLI binds a drag from the tree read at pickup and saves one drag step',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, snapshotWindows } = recordFixture(t, [
      { kind: 'drag_start' },
      { kind: 'drag', from: [135, 165], to: [420, 330], path: [[220, 240], [330, 300]],
        durationMs: 480, button: 'left', modifiers: [] },
    ]);
    assert.equal(code, 0);
    assert.equal(response.ok, true);
    assert.equal(response.data.warnings, undefined);
    assert.deepEqual(recorded.steps, [{
      id: 'step-1', kind: 'drag',
      from: { kind: 'point', point: [135, 165] },
      to: { kind: 'point', point: [420, 330] },
      durationMs: 480, path: [[220, 240], [330, 300]],
    }]);
    // One read for the initial window and one at pickup; the drop itself reuses
    // the pickup tree so a moved file cannot be bound twice.
    assert.deepEqual(snapshotWindows, [fixture.data.window.id, fixture.data.window.id]);
  });

test('record CLI refuses a modifier drag instead of replaying it as a plain drag',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded } = recordFixture(t, [
      { kind: 'drag_start' },
      { kind: 'drag', from: [135, 165], to: [420, 330], path: [], durationMs: 200, button: 'left', modifiers: ['alt'] },
      { kind: 'click', point: [135, 165] },
    ]);
    assert.equal(code, 0);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click']);
    assert.deepEqual(response.data.warnings.map(warning => warning.code), ['DRAG_MODIFIERS_SKIPPED']);
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

test('record CLI traces mouse events before readiness and maps accepted clicks to the flow',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      { kind: 'click_trace', stage: 'native', event: 'down', id: '100:1', decision: 'filtered', reason: 'before_ready' },
      { kind: 'ready', indicator: false, hotkeysFiltered: true },
      { kind: 'click_trace', stage: 'native', event: 'down', id: '200:2', decision: 'observed', scope: 'activation',
        reason: 'awaiting_release', eventNumber: 2, clickState: 1, suppressed: false },
      { kind: 'click_trace', stage: 'native', event: 'up', id: '250:2', downId: '200:2', decision: 'accepted' },
      { ...captureClick, traceId: '200:2' },
      { kind: 'click_trace', stage: 'native', event: 'down', id: '270:5', decision: 'filtered',
        reason: 'duplicate_down', eventNumber: 5, clickState: 1, suppressed: true },
      { kind: 'click_trace', stage: 'native', event: 'down', id: '290:6', decision: 'observed',
        reason: 'awaiting_release', eventNumber: 6, clickState: 2, suppressed: false },
      { kind: 'click_trace', stage: 'native', event: 'up', id: '295:6', downId: '290:6', decision: 'accepted' },
      { kind: 'click', point: [135, 165], count: 2, traceId: '290:6' },
      { kind: 'click_trace', stage: 'native', event: 'down', id: '300:3', decision: 'filtered', reason: 'overlay' },
      { kind: 'click_trace', stage: 'native', event: 'down', id: '400:4', decision: 'observed', scope: 'content',
        reason: 'awaiting_release' },
      { kind: 'click_trace', stage: 'native', event: 'up', id: '450:4', downId: '400:4', decision: 'accepted' },
      { kind: 'click', point: [1, 1], traceId: '400:4' },
      { kind: 'text', chars: 'Cuekeeper M1' }, captureSave,
    ], { ready: false, flags: ['--no-indicator', '--trace-clicks'] });
    const lines = stderr.trimEnd().split('\n');
    assert.match(lines[0], /before_ready/);
    assert.match(lines[1], /^Recording for up to/);
    const trace = lines.filter(line => line.startsWith('CLICK_TRACE ')).map(line => JSON.parse(line.slice(12)));
    assert.deepEqual(trace.filter(row => row.suppressed).map(({ reason, eventNumber, clickState }) =>
      [reason, eventNumber, clickState]), [['duplicate_down', 5, 1]]);
    assert.deepEqual(trace.filter(row => row.stage === 'flow'), [
      { stage: 'flow', id: '200:2', decision: 'collected', windowId: fixture.data.window.id },
      { stage: 'flow', id: '290:6', decision: 'collected', windowId: fixture.data.window.id },
      { stage: 'flow', id: '400:4', decision: 'filtered', reason: 'OUTSIDE_WINDOW' },
    ]);
    assert.equal(code, 0);
    assert.equal(response.ok, true);
    assert.equal(response.data.partial, undefined);
    assert.deepEqual(response.data.warnings.map(warning => warning.code), ['OUTSIDE_WINDOW']);
    assert.match(response.data.warnings[0].message, /outside the requested window/);
    assert.deepEqual(recorded.steps.map(step => step.kind), ['click', 'type', 'key']);
    assert.equal(recorded.steps[0].count, 2);
  });

test('record CLI stores double clicks, right clicks and one coalesced scroll step',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded } = recordFixture(t, [
      { kind: 'click', point: [135, 165], count: 1 },
      { kind: 'click', point: [135, 165], count: 2 },
      { kind: 'click', point: [135, 165], count: 3 },
      { kind: 'click', point: [105, 110], button: 'right' },
      { kind: 'scroll', point: [135, 165], deltaX: 0, deltaY: -3, phase: 'began' },
      { kind: 'scroll', point: [135, 165], deltaX: 0, deltaY: -4, phase: 'changed' },
      { kind: 'scroll', point: [135, 165], deltaX: 0, deltaY: 1, phase: 'ended' },
    ]);
    assert.equal(code, 0);
    assert.equal(response.ok, true);
    assert.deepEqual(response.data.warnings, undefined);
    const [triple, right, scroll] = recorded.steps;
    assert.equal(recorded.steps.length, 3);
    assert.deepEqual(triple, {
      id: 'step-1', kind: 'click',
      target: { kind: 'element', role: 'textfield', name: '', path: ['window', 'scrollarea', 'textfield'] },
      count: 3,
    });
    assert.deepEqual(right, {
      id: 'step-2', kind: 'click', target: { kind: 'point', point: [105, 110] }, button: 'right',
    });
    assert.equal(scroll.kind, 'scroll');
    assert.deepEqual(scroll.target, {
      kind: 'element', role: 'textfield', name: '', path: ['window', 'scrollarea', 'textfield'],
    });
    assert.equal(scroll.deltaX, 0);
    assert.equal(scroll.deltaY, -6);
    assert.equal(typeof scroll.durationMs, 'number');
  });

test('record CLI rejects helper input with an unsupported click count or mouse button',
  { skip: process.platform !== 'darwin' }, t => {
    for (const event of [
      { kind: 'click', point: [135, 165], count: 4 },
      { kind: 'click', point: [135, 165], button: 'middle' },
      { kind: 'scroll', point: [135, 165], deltaX: 0, deltaY: 0 },
    ]) {
      const { code, response, recorded } = recordFixture(t, [event]);
      assert.equal(code, 1);
      assert.equal(response.error.code, 'CAPTURE_PROTOCOL');
      assert.equal(recorded, undefined);
    }
  });

test('record CLI rejects a helper that announces ready without indicator verification',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      { kind: 'ready', hotkeysFiltered: true }, captureClick,
    ], { ready: false });
    assert.equal(code, 2);
    assert.equal(response.error.code, 'INDICATOR_UNCONFIRMED');
    assert.equal(recorded, undefined);
    assert.equal(stderr, '');
  });

test('record CLI rejects readiness from a helper missing hotkey filtering',
  { skip: process.platform !== 'darwin' }, t => {
    const { code, response, recorded, stderr } = recordFixture(t, [
      { kind: 'ready', indicator: { window: 4321, display: 1, level: 25, bounds: [0, 0, 1470, 956] } },
      captureClick,
    ], { ready: false });
    assert.equal(code, 2);
    assert.equal(response.error.code, 'HOTKEY_FILTER_UNCONFIRMED');
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
    assert.equal(code, 0);
    assert.equal(response.ok, true);
    assert.equal(response.data.partial, undefined);
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
  const previousIdentity = process.env.CUEKEEPER_APP_IDENTITY;
  process.env.CUEKEEPER_AGENT_DESKTOP = stub;
  // No native identity probe: this test asserts the legacy app-scoped route.
  process.env.CUEKEEPER_APP_IDENTITY = join(dir, 'identity');
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
    if (previousIdentity === undefined) delete process.env.CUEKEEPER_APP_IDENTITY;
    else process.env.CUEKEEPER_APP_IDENTITY = previousIdentity;
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
  // Headed replay injects text through the headed path; the text still only
  // travels on stdin.
  assert.deepEqual(calls[4], { command: 'type', args: ['--headed', '@scuekeeper:e1', '--stdin'], input: 'Cuekeeper M1' });
  assert.deepEqual(calls[6].args, ['--headed', 'meta+s', '--window-id', 'w-1234']);
});

test('CLI resolves three steps and packs a report with verified manifest and ordering', async t => {
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
  const packed = run('report', 'pack', report, '--flow', 'examples/textedit.flow.json', '--out', zip);
  assert.equal(packed.code, 0);
  assert.equal(packed.data.assets, 0);
  const files = unzipSync(readFileSync(zip));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.deepEqual(Object.keys(files).sort(),
    ['flow.json', 'index.html', 'manifest.json', 'report.json']);
  assert.deepEqual(manifest.assets, []);
  for (const [name, metadata] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(files[name]).digest('hex'), metadata.sha256);
    assert.equal(files[name].length, metadata.bytes);
  }
  const html = strFromU8(files['index.html']);
  assert.match(html, /data-step="click-body"/);
  assert.match(html, /data-step="type-text"/);
  assert.match(html, /data-step="save"/);
  assert.match(html, /click-body[\s\S]*type-text[\s\S]*save/);
  assert.match(html, /Save a TextEdit document/);
  assert.match(html, /只看失败/);
  assert.match(html, /断流预览/);
  assert.match(html, /<style>/);
  // The page is self-contained: no external viewer assets are needed.
  assert.doesNotMatch(html, /assets\/report\.(css|js)/);
  assert.match(html, /报告未包含该步截图/);
  // The pre-rendered page is readable without JavaScript, and the inline script parses.
  assert.match(html, /<article class="detail-step" data-detail="click-body" data-index="0">/);
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript[1]));
  assert.deepEqual(Buffer.from(packReport(dry.data, flow)), Buffer.from(packReport(dry.data, flow)));

  // A sibling assets directory is picked up without an extra flag, and --assets is explicit.
  const assetsDir = join(dir, 'assets');
  mkdirSync(join(assetsDir, 'click-body'), { recursive: true });
  mkdirSync(join(assetsDir, 'logs'), { recursive: true });
  writeFileSync(join(assetsDir, 'click-body', 'before.png'), png);
  writeFileSync(join(assetsDir, 'click-body', 'step.log'), 'resolved textfield\n');
  writeFileSync(join(assetsDir, 'logs', 'run.log'), 'run complete\n');
  const discovered = await discoverAssets(report);
  assert.deepEqual(discovered.map(asset => asset.path),
    ['click-body/before.png', 'click-body/step.log', 'logs/run.log']);
  const autoZip = join(dir, 'auto.zip');
  assert.equal(run('report', 'pack', report, '--flow', 'examples/textedit.flow.json', '--out', autoZip).code, 0);
  const autoFiles = unzipSync(readFileSync(autoZip));
  assert.ok(autoFiles['assets/click-body/before.png']);
  assert.ok(autoFiles['assets/logs/run.log']);
  assert.match(strFromU8(autoFiles['index.html']), /src="assets\/click-body\/before\.png"/);
  const explicitZip = join(dir, 'explicit.zip');
  const explicit = run('report', 'pack', report, '--flow', 'examples/textedit.flow.json',
    '--assets', assetsDir, '--out', explicitZip);
  assert.equal(explicit.code, 0);
  assert.equal(explicit.data.assets, 3);
  assert.ok(unzipSync(readFileSync(explicitZip))['assets/click-body/step.log']);

  assert.throws(() => packReport(dry.data, { ...flow, name: 'Different flow' }), /do not match/);
  const malformed = { ...dry.data, entries: [...dry.data.entries].reverse() };
  assert.throws(() => packReport(malformed, flow), /timeline/);
  assert.equal(run('report', 'pack', report, '--flow', 'examples/textedit.flow.json', '--out', zip).code, 2);
});

test('packed viewer expands the failed step with its error code and expectation', async () => {
  const steps = [flow.steps[0], {
    id: 'assert-text', kind: 'assert',
    check: { target: editor, expect: { property: 'text', equals: 'Expected text' } },
  }, ...flow.steps.slice(1)];
  const failing = parseFlow({ ...flow, steps });
  const report = await runFlow(failing, fakeDesktop(), { dryRun: false, signal });
  assert.equal(report.status, 'failed');
  const files = unzipSync(packReport(report, failing));
  const html = strFromU8(files['index.html']);
  assert.match(html, /class="run-state state-failed"/);
  assert.match(html, /<li class="entry status-failed is-failed is-failed-assert selected" data-step="assert-text"/);
  assert.match(html, /<article class="detail-step" data-detail="assert-text" data-index="1">/);
  assert.match(html, /<article class="detail-step" data-detail="save" data-index="3" hidden>/);
  assert.match(html, /ASSERTION_FALSE/);
  assert.match(html, /元素文本等于 &quot;Expected text&quot;/);
  assert.match(html, /失败信息/);
  assert.match(html, /报告未记录重试/);
  assert.match(html, /断言/);
});

test('packed viewer exposes a disconnected banner and last-known markers', () => {
  const broken = structuredClone(example('textedit.report'));
  broken.status = 'failed';
  const last = broken.entries[broken.entries.length - 1];
  last.status = 'failed';
  last.code = 'INTERRUPTED';
  last.message = 'Recording stream ended before the result was observed';
  const files = unzipSync(packReport(broken, flow));
  const html = strFromU8(files['index.html']);
  assert.match(html, /<body class="disconnected"/);
  assert.match(html, /data-stream="disconnected"/);
  assert.match(html, /<div class="banner" id="banner">/);
  assert.match(html, /事件流已断开/);
  assert.match(html, /最后已知/);
  assert.match(html, /退出断流预览/);
  assert.match(html, /INTERRUPTED/);
  assert.match(html, /已断开 · 止于第 03 步/);
});

test('assets are attached to their step, previewed, and hashed in the manifest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportPath = join(dir, 'report.json');
  const report = example('textedit.report');
  writeFileSync(reportPath, JSON.stringify(report));
  const assetsDir = join(dir, 'assets');
  mkdirSync(join(assetsDir, 'click-body'), { recursive: true });
  mkdirSync(join(assetsDir, 'logs'), { recursive: true });
  writeFileSync(join(assetsDir, 'click-body', 'before.png'), png);
  writeFileSync(join(assetsDir, 'click-body', 'after.png'), png);
  writeFileSync(join(assetsDir, 'click-body', 'step.log'), '12:06:08  snapshot  refs=14\n');
  writeFileSync(join(assetsDir, 'click-body', 'ax.json'), '{"role":"textfield"}\n');
  writeFileSync(join(assetsDir, 'logs', 'run.log'), 'run complete\n');
  const assets = await discoverAssets(reportPath);
  const files = unzipSync(packReport(report, flow, { assets }));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.deepEqual(manifest.assets.map(asset => [asset.path, asset.entryId, asset.role]), [
    ['assets/click-body/after.png', 'click-body', 'screenshot-after'],
    ['assets/click-body/ax.json', 'click-body', 'snapshot'],
    ['assets/click-body/before.png', 'click-body', 'screenshot-before'],
    ['assets/click-body/step.log', 'click-body', 'log'],
    ['assets/logs/run.log', undefined, 'log'],
  ]);
  const html = strFromU8(files['index.html']);
  assert.match(html, /操作前截图/);
  assert.match(html, /操作后截图/);
  assert.match(html, /src="assets\/click-body\/before\.png"/);
  assert.match(html, /snapshot {2}refs=14/);
  assert.match(html, /&quot;role&quot;:&quot;textfield&quot;/);
  assert.match(html, /运行产物/);
  assert.match(html, /assets\/logs\/run\.log/);
  assert.throws(() => packReport(report, flow, { assets: [{ path: '../escape.png', bytes: png }] }),
    /Invalid asset path/);
  assert.throws(() => packReport(report, flow, { assets: [
    { path: 'click-body/a.log', bytes: png }, { path: 'click-body/a.log', bytes: png },
  ] }), /Duplicate asset path/);
});

