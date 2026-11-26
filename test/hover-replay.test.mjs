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
  const statePath = join(dir, 'identity-state.json');
  writeFileSync(statePath, JSON.stringify({ opened: true, pid: 901, startedAt: '901.1' }));
  const windows = spec.windows;

  const driver = join(dir, 'agent-desktop');
  writeFileSync(driver, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, at: Date.now() }) + '\\n');
const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const windows = ${JSON.stringify(windows)};
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'list-windows') {
  const only = value('--app');
  data = windows.filter(window => !only || window.app === only).map(window => ({
    id: window.id, title: window.title, process_instance: 901, pid: 901,
    is_focused: window.focused === true,
  }));
} else if (command === 'snapshot') {
  const reads = ${JSON.stringify(reads)};
  const seen = fs.existsSync(reads) ? Number(fs.readFileSync(reads, 'utf8')) : 0;
  fs.writeFileSync(reads, String(seen + 1));
  const frames = ${JSON.stringify(spec.snapshots ?? [windowTree({ x: 100, y: 100, width: 800, height: 600 }, 'CLI Notes')])};
  data = frames[Math.min(seen, frames.length - 1)];
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

  const env = {
    ...process.env,
    CUEKEEPER_AGENT_DESKTOP: driver,
    CUEKEEPER_APP_IDENTITY: identity,
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

const notesWindows = (focused = true) => [
  { id: 'w-31', app: notesApp, title: 'CLI Notes', focused },
  { id: 'w-32', app: notesApp, title: 'Draft', focused: !focused },
];

test('CLI: a hover in the front window moves only the pointer, never focus or click', t => {
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(true) });
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
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(false) });
  const result = cli.run(hoverFlow({ app: notesApp, appPath: notesPath, title: 'CLI Notes', point: [180, 160] }));
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.status, 'failed');
  assert.equal(output.data.entries[0].code, 'HOVER_NOT_FOREGROUND');
  const calls = cli.calls();
  assert.deepEqual(calls.filter(call => /focus|activate|click|mouse-move/.test(call.command)), []);
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
  const cli = hoverFixture(t, { app: notesApp, appPath: notesPath, windows: notesWindows(true) });
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
    app: notesApp, appPath: notesPath, windows: notesWindows(true),
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

test('CLI: a resting point the fresh read cannot prove stops before the first move', t => {
  const cli = hoverFixture(t, {
    app: notesApp, appPath: notesPath, windows: notesWindows(true),
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
