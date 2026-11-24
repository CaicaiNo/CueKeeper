import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startReplayIndicator } from '../dist/indicator.js';

async function helper(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-indicator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fake-capture.mjs');
  await writeFile(path, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test('a cancellation line from the overlay aborts the replay', async t => {
  const saved = process.env.CUEKEEPER_NO_INDICATOR;
  process.env.CUEKEEPER_NO_INDICATOR = '0';
  t.after(() => {
    if (saved === undefined) delete process.env.CUEKEEPER_NO_INDICATOR;
    else process.env.CUEKEEPER_NO_INDICATOR = saved;
  });
  const path = await helper(t, `
console.log(JSON.stringify({ event: 'ready', hotkey: true }));
setTimeout(() => {
  process.stdout.write('{"event":"ca');
  setTimeout(() => {
    process.stdout.write('ncel"}\\n');
  }, 20);
}, 30);
`);
  const events = [];
  const indicator = startReplayIndicator({ helper: path, onCancel: () => events.push('cancel') });
  t.after(() => indicator.stop());
  const deadline = Date.now() + 2000;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(events, ['cancel']);
});

test('a disabled overlay never starts a helper', async t => {
  const path = await helper(t, 'process.exit(0);');
  const indicator = startReplayIndicator({
    helper: path,
    enabled: false,
    onCancel: () => assert.fail('must not cancel'),
  });
  indicator.stop();
  indicator.stop();
});
