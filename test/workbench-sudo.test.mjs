import assert from 'node:assert/strict';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

function fakeStore() {
  const calls = [];
  let configured = false;
  const service = 'com.cuekeeper.sudo';
  return {
    calls,
    async set() { throw new Error('not used'); },
    async setWithPassword(password) {
      calls.push({ kind: 'set', password });
      configured = true;
      return { account: 'tester', service };
    },
    async status() {
      return { account: 'tester', service, configured };
    },
    async clear() {
      calls.push({ kind: 'clear' });
      const removed = configured;
      configured = false;
      return { account: 'tester', service, removed };
    },
  };
}

async function server(t, { allowSudo = true } = {}) {
  const store = fakeStore();
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, allowLive: false, allowSudo, signal: cancellation.signal, sudoStore: store,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });
  async function post(route, payload = {}) {
    const response = await fetch(`${started.url}/api/${route}`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }
  return { post, store };
}

test('the page can store an administrator password without it being echoed back', async t => {
  const { post, store } = await server(t);
  assert.deepEqual((await post('sudo/status')).body, {
    account: 'tester', service: 'com.cuekeeper.sudo', configured: false,
  });

  const refused = await post('sudo/set', { password: 'secret-123' });
  assert.equal(refused.status, 400);
  assert.equal(store.calls.length, 0, 'an unconfirmed write never reaches the store');

  const empty = await post('sudo/set', { password: '', confirm: true });
  assert.equal(empty.status, 400);
  const newline = await post('sudo/set', { password: 'two\nlines', confirm: true });
  assert.equal(newline.status, 400);
  assert.equal(store.calls.length, 0);

  const stored = await post('sudo/set', { password: 'secret-123', confirm: true });
  assert.equal(stored.status, 201);
  assert.equal(stored.body.configured, true);
  assert.deepEqual(store.calls, [{ kind: 'set', password: 'secret-123' }]);
  assert.doesNotMatch(JSON.stringify(stored.body), /secret-123/);

  assert.equal((await post('sudo/status')).body.configured, true);

  const unconfirmed = await post('sudo/clear');
  assert.equal(unconfirmed.status, 400);
  const cleared = await post('sudo/clear', { confirm: true });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, {
    account: 'tester', service: 'com.cuekeeper.sudo', removed: true,
  });
  assert.equal((await post('sudo/status')).body.configured, false);
});

test('storing a password needs the workbench to be started with --allow-sudo', async t => {
  const { post, store } = await server(t, { allowSudo: false });
  const refused = await post('sudo/set', { password: 'secret-123', confirm: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /--allow-sudo/);
  assert.equal(store.calls.length, 0);
});
