import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A hover must be read-only: these tests drive the real CLI through a stub
// driver and assert that a hover never focuses, raises or clicks, and that its
// pointer path is built from the window the driver answers at delivery time.

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const notesApp = 'com.apple.TextEdit';
const notesPath = '/System/Applications/TextEdit.app';
const finderApp = 'com.apple.finder';
const finderPath = '/System/Library/CoreServices/Finder.app';

const windowTree = (bounds, title) => ({
  complete: true,
  window: { id: 'w-31', title },
  tree: {
    role: 'window', name: title, bounds,
    children: [{
      role: 'group', name: 'canvas', ref_id: '@hover:e1',
      bounds: { x: 120, y: 150, width: 600, height: 40 }, states: [],
    }],
  },
});

function hoverFixture(t, spec) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-hover-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'driver.jsonl');
  const reads = join(dir, 'snapshot-reads');
  const focusPath = join(dir, 'focus.json');
  const statePath = join(dir, 'identity-state.json');
  writeFileSync(statePath, JSON.stringify({ opened: true, pid: 901, startedAt: '901.1' }));
  writeFileSync(focusPath, JSON.stringify({ id: spec.focusId ?? spec.windows[0].id, reads: 0 }));
  const windows = spec.windows;
  // The screen hover reads the display layout instead of a window. The default
  // is one display that holds every point the window fixtures use.
  const displays = spec.displays ?? [{
    id: '1', is_primary: true, scale: 2,
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
  }];

  const driver = join(dir, 'agent-desktop');
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, at: Date.now() }) + '\\n');
const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const windows = ${JSON.stringify(windows)};
const focusFile = ${JSON.stringify(focusPath)};
const readFocus = () => JSON.parse(fs.readFileSync(focusFile, 'utf8'));
const writeFocus = state => fs.writeFileSync(focusFile, JSON.stringify(state));
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'list-windows') {
  const only = value('--app');
  const focus = readFocus();
  data = windows.filter(window => !only || window.app === only).map(window => ({
    id: window.id, title: window.title, process_instance: 901, pid: 901,
    ...(${JSON.stringify(spec.omitFocus === true)} ? {} : { is_focused: window.id === focus.id }),
  }));
} else if (command === 'snapshot') {
  const reads = ${JSON.stringify(reads)};
  const seen = fs.existsSync(reads) ? Number(fs.readFileSync(reads, 'utf8')) : 0;
  const failures = ${JSON.stringify(spec.snapshotFailures ?? [])};
  if (failures[seen]) {
    console.log(JSON.stringify({ version: '2.6', command, ok: false,
      error: { code: failures[seen], message: 'snapshot read failed' } }));
    process.exit(1);
  }
  fs.writeFileSync(reads, String(seen + 1));
  const focus = readFocus();
  focus.reads += 1;
  ${spec.switchFocusAfter === undefined ? '' : `if (focus.reads >= ${Number(spec.switchFocusAfter)}) focus.id = ${JSON.stringify(spec.switchFocusTo)};`}
  writeFocus(focus);
  const frames = ${JSON.stringify(spec.snapshots ?? [windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes')])};
  data = frames[Math.min(seen, frames.length - 1)];
} else if (command === 'list-displays') {
  ${spec.failDisplays === true
    ? `console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'DISPLAYS_UNAVAILABLE', message: 'no display server' } })); process.exit(1);`
    : `data = ${JSON.stringify(displays)};`}
} else if (command === 'focus-window') data = { focused: { id: value('--window-id') } };
else data = { disposition: { delivery: 'delivered_verified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const identity = join(dir, 'cuekeeper-identity');
  writeFileSync(identity, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const instance = { pid: state.pid, startedAt: state.startedAt, bundleId: ${JSON.stringify(spec.app)}, bundlePath: ${JSON.stringify(spec.appPath)} };
const value = flag => args[args.indexOf(flag) + 1];
let data = null;
if (command === 'open') { state.opened = true; fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state)); data = {}; }
else if (command === 'instances') data = { instances: state.opened ? [instance] : [] };
else if (command === 'describe') data = state.opened && Number(value('--pid')) === state.pid ? instance : null;
else if (command === 'windows') data = state.opened ? ${JSON.stringify(windows)}.map(window => ({
  number: Number(window.id.slice(2)), ownerPid: state.pid, title: window.title,
})) : [];
else if (command === 'validate') data = null;
console.log(JSON.stringify({ version: '1', command, ok: true, data }));
`, { mode: 0o700 });

  // The hover path must not depend on the machine's current secure-input
  // focus, which is unrelated to the pointer proof under test.
  const recorder = join(dir, 'cuekeeper-capture');
  writeFileSync(recorder, `#!/usr/bin/env node
const command = process.argv[2];
console.log(JSON.stringify(command === '--system-dialog-state'
  ? { visible: false } : { secure: false }));
`, { mode: 0o700 });
  const env = {
    ...process.env,
    CUEKEEPER_AGENT_DESKTOP: driver,
    CUEKEEPER_APP_IDENTITY: identity,
    CUEKEEPER_RECORDER: recorder,
    CUEKEEPER_STATE_DIR: join(dir, 'state'),
  };
  const run = (flow) => {
    const flowPath = join(dir, 'flow.json');
    writeFileSync(flowPath, JSON.stringify(flow));
    return spawnSync(process.execPath, [cliPath, 'run', flowPath, '--foreground', '--headed', '--json'], {
      env, encoding: 'utf8', timeout: 30_000,
    });
  };
  const calls = () => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { dir, run, calls };
}

/** One hover in one window scope; `extra` can add the recorded point or a hand-off. */
function hoverFlow(spec) {
  return {
    version: 2, id: 'hover-cli', name: 'Hover CLI',
    appPaths: { [spec.app]: spec.appPath },
    steps: [{
      id: 'hover', kind: 'hover',
      scope: { kind: 'window', app: spec.app, windowKey: 'notes', windowTitle: spec.title },
      target: { kind: 'element', role: 'group', name: 'canvas' },
      durationMs: 0,
      ...(spec.point === undefined ? {} : { point: spec.point }),
      ...(spec.focusAfter === undefined ? {} : { focusAfter: spec.focusAfter }),
    }],
  };
}

const notesWindows = () => [
  { id: 'w-31', app: notesApp, title: 'CLI Notes' },
  { id: 'w-32', app: notesApp, title: 'Draft' },
];

/** One coordinate hover: no app, no window, only a recorded screen point. */
function screenHoverFlow(spec) {
  return {
    version: 2, id: 'hover-screen', name: 'Screen hover',
    steps: [{
      id: 'hover', kind: 'hover',
      scope: { kind: 'screen' },
      point: spec.point,
      durationMs: spec.durationMs ?? 0,
      ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    }],
  };
}

const movePoints = calls => calls
  .filter(call => call.command === 'mouse-move')
  .map(call => call.args.at(-1).replace('--xy=', '').split(',').map(Number));

test('CLI: screen hovers move to their recorded points without reading any window', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    displays: [
      { id: '1', is_primary: true, scale: 2, bounds: { x: 0, y: 0, width: 1470, height: 956 } },
      { id: '3', is_primary: false, scale: 1, bounds: { x: 0, y: -1440, width: 2560, height: 1440 } },
    ],
  });
  const result = cli.run({
    version: 2, id: 'hover-screen', name: 'Screen hovers',
    steps: [
      {
        id: 'hover-main', kind: 'hover', scope: { kind: 'screen' },
        point: [240, 380], durationMs: 0,
        hint: { app: notesApp, windowTitle: 'CLI Notes', element: { kind: 'element', role: 'group', name: '' } },
      },
      // A point on a display mounted above the main one: negative y is normal.
      { id: 'hover-second', kind: 'hover', scope: { kind: 'screen' }, point: [900, -700], durationMs: 120 },
    ],
  });
  assert.equal(result.status, 0, result.stderr);

  const calls = cli.calls();
  assert.match(result.stderr, /屏幕坐标悬停 2 条/);
  const windowCalls = calls.filter(call =>
    ['list-windows', 'snapshot', 'focus-window', 'focus', 'click', 'right-click', 'double-click'].includes(call.command));
  assert.deepEqual(windowCalls, [], 'a screen hover never proves a window or presses anything');
  const points = movePoints(calls);
  assert.ok(points.length >= 6, `only ${points.length} mouse-move commands`);
  assert.deepEqual(points.at(-1), [900, -700]);
  // Every move is inside the display that holds its recorded point.
  assert.ok(points.slice(0, 4).every(([x, y]) => x >= 0 && x < 1470 && y >= 0 && y < 956), JSON.stringify(points));
  assert.ok(points.slice(4).every(([x, y]) => y >= -1440 && y < 0), JSON.stringify(points));

  const [main, second] = JSON.parse(result.stdout).data.entries;
  for (const entry of [main, second]) {
    assert.equal(entry.status, 'passed');
    assert.deepEqual(entry.scope, { kind: 'screen' });
    assert.equal(entry.deliveredVia, 'screen_point');
    // A recorded coordinate cannot be verified against a control, so even a
    // driver that reported the move as delivered is reported as unverified.
    assert.equal(entry.delivery, 'delivered_unverified');
    assert.match(entry.message, /recorded screen point/);
    assert.ok(entry.durationMs >= 400, `the dwell was only ${entry.durationMs} ms`);
  }
});

test('CLI: a point outside every display is refused before the first move', t => {
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31' });
  const result = cli.run(screenHoverFlow({ point: [2000, 100] }));
  const entry = JSON.parse(result.stdout).data.entries[0];
  assert.equal(entry.code, 'UNSAFE_POINT');
  assert.match(entry.message, /not inside one display/);
  assert.deepEqual(cli.calls().filter(call => call.command === 'mouse-move'), []);
});

test('CLI: an unreadable display layout keeps the pointer still', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31', failDisplays: true,
  });
  const result = cli.run(screenHoverFlow({ point: [240, 380] }));
  const entry = JSON.parse(result.stdout).data.entries[0];
  assert.equal(entry.code, 'UNSAFE_POINT');
  assert.deepEqual(cli.calls().filter(call => call.command === 'mouse-move'), []);
});

test('CLI: an element hover whose window is gone falls back to its recorded point', t => {
  const cli = hoverFixture(t, {
    app: finderApp, appPath: finderPath,
    windows: [
      { id: 'w-41', app: finderApp, title: 'Downloads', focused: true },
      { id: 'w-42', app: finderApp, title: 'Documents', focused: false },
    ],
  });
  const result = cli.run(hoverFlow({ app: finderApp, appPath: finderPath, title: '最近使用', point: [300, 320] }));
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).data.entries[0];
  assert.equal(entry.status, 'passed');
  assert.equal(entry.deliveredVia, 'screen_point');
  assert.equal(entry.delivery, 'delivered_unverified');
  assert.match(entry.message, /HOVER_SCREEN_FALLBACK \(WINDOW_NOT_FOUND/);
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /click|focus|activate/.test(call.command)), []);
  assert.deepEqual(movePoints(calls).at(-1), [300, 320]);
});

test('CLI: a window re-read that answers another window still falls back before moving', t => {
  // Resolution read the bound window; the last read before the first move
  // answers a different one. Nothing has moved yet, so the recorded point is
  // still safe to deliver as a screen hover.
  const swapped = {
    complete: true,
    window: { id: 'w-32', title: 'CLI Notes' },
    tree: {
      role: 'window', name: 'CLI Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
      children: [{
        role: 'group', name: 'canvas', ref_id: '@hover:e1',
        bounds: { x: 120, y: 150, width: 600, height: 40 }, states: [],
      }],
    },
  };
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes'), swapped],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).data.entries[0];
  assert.equal(entry.status, 'passed');
  assert.equal(entry.deliveredVia, 'screen_point');
  assert.equal(entry.delivery, 'delivered_unverified');
  assert.match(entry.message, /HOVER_SCREEN_FALLBACK \(WINDOW_CHANGED/);
  const calls = cli.calls();
  assert.equal(calls.filter(call => call.command === 'list-displays').length, 1);
  assert.equal(movePoints(calls).length, 4);
  assert.deepEqual(movePoints(calls).at(-1), [180, 160]);
});

test('CLI: a failed window re-read before the first move still falls back', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshotFailures: [null, 'WINDOW_NOT_FOUND'],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).data.entries[0];
  assert.equal(entry.deliveredVia, 'screen_point');
  assert.equal(entry.delivery, 'delivered_unverified');
  assert.match(entry.message, /HOVER_SCREEN_FALLBACK \(WINDOW_NOT_FOUND/);
  const calls = cli.calls();
  assert.equal(calls.filter(call => call.command === 'list-displays').length, 1);
  assert.equal(movePoints(calls).length, 4);
  assert.deepEqual(movePoints(calls).at(-1), [180, 160]);
});


test('CLI: a hover in the front window moves only the pointer, never focus or click', t => {
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31' });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  assert.equal(result.status, 0, result.stderr);

  const calls = cli.calls();
  const moves = calls.filter(call => call.command === 'mouse-move');
  // A travel hover: three approach moves and the resting one.
  assert.equal(moves.length, 4);
  assert.deepEqual(moves.at(-1).args, ['--headed', '--xy=180,160']);
  // Every point the driver received is inside the window it answered for.
  const points = moves.map(call => call.args.at(-1).replace('--xy=', '').split(',').map(Number));
  assert.ok(points.every(([x, y]) => x >= 100 && x < 900 && y >= 100 && y < 700), JSON.stringify(points));
  // Read-only: no focus, activation or press reached the driver at all.
  assert.deepEqual(calls.filter(call => /focus|activate|click/.test(call.command)), []);
});

test('CLI: a hover in a background window stops instead of bringing it forward', t => {
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-32' });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.status, 'failed');
  assert.equal(output.data.entries[0].code, 'HOVER_NOT_FOREGROUND');
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /focus|activate|click|mouse-move/.test(call.command)), []);
});

test('CLI: a driver that never reports which window is in front sends no move', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31', omitFocus: true,
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.entries[0].code, 'HOVER_NOT_FOREGROUND');
  assert.match(output.data.entries[0].message, /Cannot prove the hover window/);
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /focus|activate|click|mouse-move/.test(call.command)), []);
});

test('CLI: focus that moves away before delivery stops the hover even after resolution', t => {
  // Resolution reads the window while w-31 is in front; the hover's own re-read
  // is the moment focus moves to w-32. The window frame is unchanged, so only
  // the fresh foreground check can catch it.
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    switchFocusAfter: 2, switchFocusTo: 'w-32',
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.entries[0].code, 'HOVER_NOT_FOREGROUND');
  assert.match(output.data.entries[0].message, /is not in front \(w-32 is\)/);
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /focus|activate|click|mouse-move/.test(call.command)), []);
});

test('CLI: a target missing from the first tree is retried read-only and dispatched once', t => {
  const big = windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes');
  const withoutTarget = structuredClone(big);
  withoutTarget.tree.children = [];
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [withoutTarget, big, big],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  assert.equal(result.status, 0, result.stderr);
  const calls = cli.calls();
  const moves = calls.filter(call => call.command === 'mouse-move');
  // One attempt resolved; the retry dispatched one complete path.
  assert.equal(moves.length, 4);
  assert.deepEqual(calls.filter(call => /focus|activate|click/.test(call.command)), []);
  // Two resolution reads (first without the target, second with it) plus the
  // hover's own fresh read.
  assert.equal(calls.filter(call => call.command === 'snapshot').length, 3);
});

test('CLI: a Finder title the run could reopen by clicking is not repaired for a hover', t => {
  const cli = hoverFixture(t, {
    app: finderApp, appPath: finderPath,
    windows: [
      { id: 'w-41', app: finderApp, title: 'Downloads', focused: true },
      { id: 'w-42', app: finderApp, title: 'Documents', focused: false },
    ],
  });
  const result = cli.run(hoverFlow({ app: finderApp, appPath: finderPath, title: '最近使用' }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.status, 'blocked');
  assert.equal(output.data.entries[0].code, 'WINDOW_NOT_FOUND');
  const calls = cli.calls();
  // The repair path would have read the Finder tree and pressed the sidebar;
  // a hover must fail closed instead of clicking anything.
  assert.deepEqual(calls.filter(call => /click|focus|activate/.test(call.command)), []);
  assert.deepEqual(calls.filter(call => call.command === 'snapshot'), []);
});

test('CLI: a hover ignores a declared focusAfter and stays read-only', t => {
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31' });
  const result = cli.run(hoverFlow({
    app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160],
    focusAfter: { kind: 'window', app: notesApp, windowKey: 'draft', windowTitle: 'Draft' },
  }));
  assert.equal(result.status, 0, result.stderr);
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /focus|activate|click/.test(call.command)), []);
  assert.equal(calls.filter(call => call.command === 'mouse-move').length, 4);
});

test('CLI: a path is built from the window the driver answers at delivery time', t => {
  // The window resolves with a wide frame, then reports a 20×50 frame when the
  // hover re-reads it. The resting point is inside both; a path computed from
  // the old frame would send points outside the new one.
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [
      windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes'),
      {
        complete: true,
        window: { id: 'w-31', title: 'CLI Notes' },
        tree: {
          role: 'window', name: 'CLI Notes', bounds: { x: 165, y: 150, width: 20, height: 50 },
          children: [],
        },
      },
    ],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  assert.equal(result.status, 0, result.stderr);
  const moves = cli.calls().filter(call => call.command === 'mouse-move');
  assert.ok(moves.length >= 3, `only ${moves.length} mouse-move commands`);
  const points = moves.map(call => call.args.at(-1).replace('--xy=', '').split(',').map(Number));
  assert.ok(points.every(([x, y]) => x >= 165 && x < 185 && y >= 150 && y < 200),
    `a move left the shrunken window: ${JSON.stringify(points)}`);
  assert.deepEqual(points.at(-1), [180, 160]);
});

test('CLI: a left-edge resting point is refused before the driver pre-moves outside', t => {
  // agent-desktop 1.3.1 posts (x - 1, y) before the requested point. On the
  // window's left edge that pre-move lands in the neighbouring window, so the
  // hover must stop before its first command even though x itself is inside.
  const edge = {
    complete: true,
    window: { id: 'w-31', title: 'CLI Notes' },
    tree: {
      role: 'window', name: 'CLI Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
      children: [{
        role: 'group', name: 'canvas', ref_id: '@hover:e1',
        bounds: { x: 100, y: 150, width: 600, height: 40 }, states: [],
      }],
    },
  };
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [edge],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [100, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.entries[0].code, 'UNSAFE_POINT');
  assert.match(output.data.entries[0].message, /first posts 99,160/);
  assert.deepEqual(cli.calls().filter(call => call.command === 'mouse-move'), []);
});

test('CLI: a resting point one pixel inside the left edge is delivered in full', t => {
  const edge = {
    complete: true,
    window: { id: 'w-31', title: 'CLI Notes' },
    tree: {
      role: 'window', name: 'CLI Notes', bounds: { x: 100, y: 100, width: 800, height: 600 },
      children: [{
        role: 'group', name: 'canvas', ref_id: '@hover:e1',
        bounds: { x: 100, y: 150, width: 600, height: 40 }, states: [],
      }],
    },
  };
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [edge],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [101, 160] }));
  assert.equal(result.status, 0, result.stderr);
  const points = cli.calls()
    .filter(call => call.command === 'mouse-move')
    .map(call => call.args.at(-1).replace('--xy=', '').split(',').map(Number));
  assert.equal(points.length, 4);
  assert.deepEqual(points.at(-1), [101, 160]);
  // Every pre-move the driver posts before those points stays inside.
  assert.ok(points.every(([x, y]) => x - 1 >= 100 && y >= 100 && y < 700), JSON.stringify(points));
});

test('CLI: a resting point the fresh read cannot prove stops before the first move', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(), focusId: 'w-31',
    snapshots: [
      windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes'),
      {
        complete: true,
        window: { id: 'w-31', title: 'CLI Notes' },
        tree: {
          role: 'window', name: 'CLI Notes', bounds: { x: 165, y: 150, width: 20, height: 50 },
          children: [],
        },
      },
    ],
  });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [400, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.entries[0].code, 'UNSAFE_POINT');
  assert.deepEqual(cli.calls().filter(call => call.command === 'mouse-move'), []);
});
