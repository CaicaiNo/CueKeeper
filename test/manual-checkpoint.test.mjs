import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  CheckpointFault, nativeSecureInputProbe, nativeSystemDialogProbe, runHandOff, terminalCheckpointChannel,
} from '../dist/manual-checkpoint.js';

// Checkpoints are driven by fake channels and probes: no terminal, app or system
// secure-input prompt is involved.

const scope = {
  kind: 'window', app: 'com.apple.installer', windowKey: 'installer', windowTitle: 'Install Test App',
};
const request = {
  stepId: 's3', triggerStepId: 's2', scope, timeoutMs: 120_000, reason: 'secure_input',
};

function channel(answer, log = []) {
  return {
    async announce(entry) { log.push(['announce', entry.stepId]); },
    async confirm() {
      log.push(['confirm']);
      if (answer === 'never') return new Promise(() => {});
      return answer;
    },
  };
}

function probe(sequence) {
  const state = { secure: [...sequence.secure], resume: [...sequence.resume], secureReads: 0, resumeReads: 0 };
  return {
    state,
    probe: {
      async secureInput() {
        state.secureReads += 1;
        return state.secure.length > 1 ? state.secure.shift() : state.secure[0];
      },
      async resume() {
        state.resumeReads += 1;
        return state.resume.length > 1 ? state.resume.shift() : state.resume[0];
      },
    },
  };
}

/** Fake clock so a timeout test never sleeps in wall time. */
function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async ms => { at += ms; },
  };
}

test('an operator confirmation plus a cleared secure state resumes the run', async () => {
  const log = [];
  const result = await runHandOff({
    request,
    channel: channel('continue', log),
    probe: probe({ secure: [true, false], resume: [true] }).probe,
    signal: new AbortController().signal,
    ...clock(),
  });
  assert.deepEqual(result, {
    reason: 'secure_input', triggerStepId: 's2', timeoutMs: 120_000, confirmedBy: 'operator',
  });
  assert.deepEqual(log, [['announce', 's3'], ['confirm']]);
  // The checkpoint metadata carries no content, only why and who confirmed.
  assert.deepEqual(Object.keys(result).sort(), ['confirmedBy', 'reason', 'timeoutMs', 'triggerStepId']);
});

test('an expected system dialog must appear before the operator can confirm', async () => {
  const log = [];
  await assert.rejects(runHandOff({
    request: { ...request, reason: 'system_dialog' },
    channel: channel('continue', log),
    probe: {
      async systemDialogVisible() { log.push(['read-dialog']); return false; },
      async secureInput() { assert.fail('no resume checks before the dialog appears'); },
      async resume() { assert.fail('no resume checks before the dialog appears'); },
    },
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 100,
    ...clock(),
  }), { code: 'MANUAL_CHECKPOINT_TIMEOUT', message: /dialog did not appear/ });
  assert.deepEqual(log, [['announce', 's3'], ['read-dialog'], ['read-dialog'], ['read-dialog']]);
});

test('confirmation cannot resume while the detected system dialog stays visible', async () => {
  const log = [];
  await assert.rejects(runHandOff({
    request: { ...request, reason: 'system_dialog' },
    channel: channel('continue', log),
    probe: {
      async systemDialogVisible() { return true; },
      async secureInput() { return false; },
      async resume() { assert.fail('no window resume check while the dialog is visible'); },
    },
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 100,
    ...clock(),
  }), { code: 'MANUAL_CHECKPOINT_TIMEOUT', message: /dialog is still visible/ });
  assert.deepEqual(log, [['announce', 's3'], ['confirm']]);
});

test('a cancel stops at the checkpoint with safe metadata', async () => {
  const abort = new AbortController();
  await assert.rejects(runHandOff({
    request,
    channel: channel('cancel'),
    probe: probe({ secure: [false], resume: [true] }).probe,
    signal: abort.signal,
    ...clock(),
  }), error => {
    assert.ok(error instanceof CheckpointFault);
    assert.equal(error.code, 'MANUAL_CHECKPOINT_CANCELLED');
    assert.deepEqual(error.checkpoint, { reason: 'secure_input', triggerStepId: 's2', timeoutMs: 120_000 });
    return true;
  });
});

test('a confirmation without a cleared secure state times out instead of resuming', async () => {
  const fake = clock();
  const world = probe({ secure: [true], resume: [true] });
  await assert.rejects(runHandOff({
    request,
    channel: channel('continue'),
    probe: world.probe,
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 100,
    ...fake,
  }), error => error instanceof CheckpointFault && error.code === 'MANUAL_CHECKPOINT_TIMEOUT');
  assert.ok(world.state.secureReads > 1);
  // A secure run never evaluates the resume condition.
  assert.equal(world.state.resumeReads, 0);
});

test('a resume condition that never holds times out after the confirmation', async () => {
  const world = probe({ secure: [false], resume: [false] });
  await assert.rejects(runHandOff({
    request,
    channel: channel('continue'),
    probe: world.probe,
    signal: new AbortController().signal,
    timeoutMs: 300,
    pollMs: 100,
    ...clock(),
  }), error => error instanceof CheckpointFault && error.code === 'MANUAL_CHECKPOINT_TIMEOUT');
  assert.ok(world.state.resumeReads > 1);
});

test('a reused system authorization still needs the operator confirmation', async () => {
  const world = probe({ secure: [false], resume: [true] });
  await assert.rejects(runHandOff({
    request,
    channel: channel('never'),
    probe: world.probe,
    signal: new AbortController().signal,
    timeoutMs: 40,
    ...clock(),
  }), error => error instanceof CheckpointFault && error.code === 'MANUAL_CHECKPOINT_TIMEOUT');
  // Nothing was verified before the operator answered.
  assert.equal(world.state.secureReads, 0);
  assert.equal(world.state.resumeReads, 0);
});

test('an unverifiable secure state is never treated as cleared', async () => {
  const world = probe({ secure: [false], resume: [true] });
  world.probe.secureInput = async () => { throw new Error('probe failed'); };
  await assert.rejects(runHandOff({
    request,
    channel: channel('continue'),
    probe: world.probe,
    signal: new AbortController().signal,
    timeoutMs: 200,
    pollMs: 50,
    ...clock(),
  }), error => error instanceof CheckpointFault && error.code === 'MANUAL_CHECKPOINT_TIMEOUT');
});

test('an aborted run leaves the checkpoint without a prompt', async () => {
  const abort = new AbortController();
  abort.abort(new Error('stopped'));
  await assert.rejects(runHandOff({
    request,
    channel: channel('continue'),
    probe: probe({ secure: [false], resume: [true] }).probe,
    signal: abort.signal,
    ...clock(),
  }), /stopped/);
});

test('the terminal channel confirms only an explicit continue', async () => {
  const input = Readable.from(['maybe\ncontinue\n']);
  const written = [];
  const output = new Writable({ write(chunk, _encoding, done) { written.push(String(chunk)); done(); } });
  const reply = await terminalCheckpointChannel({ input, output })
    .confirm(request, new AbortController().signal);
  assert.equal(reply, 'continue');
  const text = written.join('');
  assert.match(text, /continue/);
  assert.doesNotMatch(text, /password=/);
});

test('the terminal channel treats cancel and a closed input as refusal', async () => {
  const cancel = Readable.from(['cancel\n']);
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  assert.equal(await terminalCheckpointChannel({ input: cancel, output: sink })
    .confirm(request, new AbortController().signal), 'cancel');
  const closed = Readable.from([]);
  assert.equal(await terminalCheckpointChannel({ input: closed, output: sink })
    .confirm(request, new AbortController().signal), 'cancel');
});

test('the native secure probe reads one boolean line and rejects garbage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-secure-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, 'good');
  writeFileSync(good, '#!/bin/sh\nprintf \'{"secure":true}\\n\'\n');
  chmodSync(good, 0o700);
  assert.equal(await nativeSecureInputProbe(good)(), true);
  const bad = join(dir, 'bad');
  writeFileSync(bad, '#!/bin/sh\nprintf \'not json\\n\'\n');
  chmodSync(bad, 0o700);
  await assert.rejects(nativeSecureInputProbe(bad)(), { code: 'SECURE_STATE_UNAVAILABLE' });
});

test('the native dialog probe passes the read-only flag and requires a visibility boolean', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-dialog-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, 'helper');
  writeFileSync(executable, '#!/bin/sh\n[ "$1" = --system-dialog-state ] || exit 2\nprintf \'{"visible":true}\\n\'\n');
  chmodSync(executable, 0o700);
  assert.equal(await nativeSystemDialogProbe(executable)(), true);
  writeFileSync(executable, '#!/bin/sh\nprintf \'{"secure":false}\\n\'\n');
  await assert.rejects(nativeSystemDialogProbe(executable)(), { code: 'SYSTEM_DIALOG_STATE_UNAVAILABLE' });
});
