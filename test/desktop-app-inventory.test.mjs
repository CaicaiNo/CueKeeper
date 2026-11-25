import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The production adapter is exercised against a stub executable, so the
// inventory parsing is tested where it happens. Nothing reads the desktop.
import { withDesktop } from '../dist/desktop.js';

const signal = new AbortController().signal;

/** Run one listApps call against a driver that answers with `inventory`. */
function readInventory(t, inventory) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-app-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, 'desktop');
  writeFileSync(stub, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const payload = command === 'version' ? { version: '1.3.1' } : ${JSON.stringify(inventory)};
console.log(JSON.stringify({ version: '2.6', command, ok: true, data: payload }));
`, { mode: 0o700 });
  const previous = process.env.CUEKEEPER_AGENT_DESKTOP;
  process.env.CUEKEEPER_AGENT_DESKTOP = stub;
  t.after(() => {
    if (previous === undefined) delete process.env.CUEKEEPER_AGENT_DESKTOP;
    else process.env.CUEKEEPER_AGENT_DESKTOP = previous;
  });
  return withDesktop({ headed: false, signal, workRoot: join(root, 'work') },
    desktop => desktop.listApps());
}

test('a complete application inventory is joined by process ID', async t => {
  const apps = await readInventory(t, {
    complete: true,
    apps: [
      { pid: 601, name: 'Finder', bundle_id: 'com.apple.finder' },
      { pid: 999, name: 'Other', bundle_id: 'com.example.other' },
    ],
  });
  assert.deepEqual(apps, [
    { pid: 601, bundleId: 'com.apple.finder', name: 'Finder' },
    { pid: 999, bundleId: 'com.example.other', name: 'Other' },
  ]);
});

test('an inventory the driver marked incomplete is refused, not narrowed', async t => {
  // The driver answered with the only process it happened to see. Treating the
  // rest as absent would let a surface be attributed to that one process.
  await assert.rejects(readInventory(t, {
    complete: false,
    apps: [{ pid: 601, name: 'Finder', bundle_id: 'com.apple.finder' }],
  }), error => {
    assert.equal(error.code, 'APP_INVENTORY_INCOMPLETE');
    return true;
  });
});

test('a record without a process ID refuses the whole inventory', async t => {
  await assert.rejects(readInventory(t, {
    complete: true,
    apps: [
      { pid: 601, name: 'Finder', bundle_id: 'com.apple.finder' },
      { name: 'Unattributed', bundle_id: 'com.example.other' },
    ],
  }), error => {
    assert.equal(error.code, 'APP_INVENTORY_INCOMPLETE');
    return true;
  });
});
