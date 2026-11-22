import assert from 'node:assert/strict';
import test from 'node:test';
import { Fault } from '../dist/locator.js';
import { assertWaitCheckSupported, waitFor } from '../dist/wait.js';

// The wait engine is exercised with no desktop and no timer longer than a few
// milliseconds: a monotonic clock, a deadline, notifications and cancellation.

const never = () => ({ matched: false, detail: 'not yet' });

test('an already satisfied wait costs one read and no timer', async () => {
  let observations = 0;
  const outcome = await waitFor({
    describe: () => 'window_exists',
    observe: async () => {
      observations += 1;
      return { matched: true };
    },
  }, { timeoutMs: 15_000 });

  assert.equal(observations, 1);
  assert.equal(outcome.polls, 1);
  assert.ok(outcome.durationMs >= 0 && outcome.durationMs < 1000);
});

test('the deadline is measured on the monotonic clock and reports WAIT_TIMEOUT', async () => {
  let clock = 1_000_000;
  let observations = 0;
  const started = performance.now();
  await assert.rejects(waitFor({
    describe: () => 'app_installed = true',
    observe: async () => {
      observations += 1;
      clock += 40;
      return { matched: false, detail: 'app_installed=false evidence=none' };
    },
  }, { timeoutMs: 200, now: () => clock, pollMs: 100, maxPollMs: 100 }), error => {
    assert.ok(error instanceof Fault);
    assert.equal(error.code, 'WAIT_TIMEOUT');
    assert.match(error.message, /app_installed = true/);
    assert.match(error.message, /last observation: app_installed=false evidence=none/);
    return true;
  });
  // The final observation past the deadline is still made before stopping.
  assert.ok(observations >= 5);
  // Real time stays far below the injected clock's budget: the deadline came
  // from the monotonic clock, not from real elapsed time.
  assert.ok(performance.now() - started < 1000);
});

test('a notification wakes the wait instead of a full poll interval', async () => {
  let notify;
  let observations = 0;
  const outcome = await waitFor({
    describe: () => 'element_enabled',
    observe: async () => {
      observations += 1;
      return { matched: observations >= 2 };
    },
  }, {
    timeoutMs: 5_000,
    pollMs: 5_000,
    maxPollMs: 5_000,
    subscribe(handler) {
      notify = handler;
      // The state changes between the first observation and the pause.
      setTimeout(handler, 5);
      return () => { notify = undefined; };
    },
  });

  assert.equal(outcome.polls, 2);
  assert.equal(notify, undefined, 'the subscription is released');
});

test('transient observation errors are retried, other faults keep their code', async () => {
  let attempts = 0;
  await waitFor({
    describe: () => 'window_exists',
    observe: async () => {
      attempts += 1;
      if (attempts < 3) throw new Fault('WINDOW_NOT_FOUND', 'no window yet');
      return { matched: true };
    },
  }, {
    timeoutMs: 5_000, pollMs: 5, maxPollMs: 10,
    transient: error => error instanceof Fault && error.code === 'WINDOW_NOT_FOUND',
  });
  assert.equal(attempts, 3);

  await assert.rejects(waitFor({
    describe: () => 'app_installed = true',
    observe: async () => { throw new Fault('APP_AMBIGUOUS', 'identity changed'); },
  }, { timeoutMs: 5_000 }), error => {
    assert.equal(error.code, 'APP_AMBIGUOUS');
    return true;
  });

  await assert.rejects(waitFor({
    describe: () => 'window_exists',
    observe: async () => { throw new Error('driver exploded'); },
  }, { timeoutMs: 5_000 }), error => {
    assert.equal(error.code, 'WAIT_OBSERVER_FAILED');
    assert.match(error.message, /driver exploded/);
    return true;
  });
});

test('cancellation is a distinct WAIT_CANCELLED fault that keeps the abort reason', async () => {
  const before = new AbortController();
  before.abort(new Error('Interrupted'));
  await assert.rejects(waitFor({
    describe: () => 'window_exists',
    observe: async () => ({ matched: false }),
  }, { timeoutMs: 5_000, signal: before.signal }), error => {
    assert.equal(error.code, 'WAIT_CANCELLED');
    assert.match(error.message, /Interrupted/);
    return true;
  });

  const during = new AbortController();
  const started = performance.now();
  setTimeout(() => during.abort(new Error('Stopped from the workbench')), 20);
  await assert.rejects(waitFor({
    describe: () => 'app_running = true',
    observe: async () => ({ matched: false }),
  }, { timeoutMs: 10_000, signal: during.signal, pollMs: 2_000 }), error => {
    assert.equal(error.code, 'WAIT_CANCELLED');
    assert.match(error.message, /Stopped from the workbench/);
    return true;
  });
  // The abort interrupts the pause instead of waiting for the deadline.
  assert.ok(performance.now() - started < 1_000);
});

test('timeouts are bounded and an unknown condition kind is refused', async () => {
  await assert.rejects(waitFor({
    describe: () => 'bad', observe: never,
  }, { timeoutMs: 0 }), error => {
    assert.equal(error.code, 'WAIT_TIMEOUT_INVALID');
    return true;
  });
  await assert.rejects(waitFor({
    describe: () => 'bad', observe: never,
  }, { timeoutMs: 1_800_001 }), error => {
    assert.equal(error.code, 'WAIT_TIMEOUT_INVALID');
    return true;
  });

  assert.doesNotThrow(() => assertWaitCheckSupported('app_installed'));
  assert.doesNotThrow(() => assertWaitCheckSupported('element_enabled'));
  assert.throws(() => assertWaitCheckSupported('process_exit'), error => {
    assert.equal(error.code, 'WAIT_UNSUPPORTED');
    return true;
  });
});
