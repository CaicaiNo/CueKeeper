import assert from 'node:assert/strict';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

const header = 'x-cuekeeper-workbench';

async function start(t, options = {}) {
  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, signal: cancellation.signal, ...options,
  });
  t.after(async () => { cancellation.abort(); await closed; });
  return url;
}

test('the workbench reports a blocked recorder before the record button is pressed', async t => {
  const blocked = {
    ok: false,
    blocking: [{ id: 'recorder', label: 'recorder', status: 'fail', detail: 'missing: /tmp/dist/cuekeeper-capture' }],
    nextSteps: ['Rebuild the recorder with `pnpm build:recorder`, or reinstall the release archive.'],
  };
  const url = await start(t, { recordHealth: async () => blocked });

  const response = await fetch(`${url}/api/record/health`, { headers: { [header]: '1' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), blocked);

  const denied = await fetch(`${url}/api/record/health`);
  assert.equal(denied.status, 403);

  const healthyUrl = await start(t, {
    recordHealth: async () => ({ ok: true, blocking: [], nextSteps: [] }),
  });
  const healthy = await fetch(`${healthyUrl}/api/record/health`, { headers: { [header]: '1' } });
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, blocking: [], nextSteps: [] });
});

test('the default health probe names a missing recorder', { skip: process.platform !== 'darwin' }, async t => {
  const saved = process.env.CUEKEEPER_RECORDER;
  process.env.CUEKEEPER_RECORDER = '/nonexistent/cuekeeper-capture';
  t.after(() => {
    if (saved === undefined) delete process.env.CUEKEEPER_RECORDER;
    else process.env.CUEKEEPER_RECORDER = saved;
  });
  const url = await start(t);
  const response = await fetch(`${url}/api/record/health`, { headers: { [header]: '1' } });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, false);
  assert.ok(health.blocking.some(check => check.id === 'recorder'));
  assert.ok(health.nextSteps.some(step => step.includes('build:recorder')));
});
