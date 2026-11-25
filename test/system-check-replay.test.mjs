import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reportV2Check } from '../dist/contracts-v2.js';
import { parseFlowV2 } from '../dist/flow-v2.js';
import { Fault } from '../dist/locator.js';
import { runFlowV2 } from '../dist/run-v2.js';

// A v2 flow made only of system checks: no window, no app identity, no
// desktop driver call. Each run is proven against the fake seams below, so
// the assertions are about the reported result, not about a scaffold.

const fileStep = (id, path, equals = true) => ({
  id, kind: 'assert', scope: { kind: 'file', path }, check: { kind: 'file_exists', equals },
});
const processStep = (id, scope, equals = true) => ({
  id, kind: 'assert', scope, check: { kind: 'process_running', equals },
});

function parse(steps) {
  return parseFlowV2({ version: 2, id: 'system-checks', name: 'System checks', steps });
}

/**
 * Runs the flow with a desktop that fails on any use and an identity factory
 * that fails on any probe: a system check that touched either would show up.
 */
async function run(t, steps, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cuekeeper-system-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const desktopCalls = [];
  const desktop = new Proxy({}, {
    get(_target, property) {
      return (..._args) => {
        desktopCalls.push(String(property));
        throw new Error(`desktop ${String(property)} was used by a system check`);
      };
    },
  });
  const controller = new AbortController();
  const report = await runFlowV2(parse(steps), {
    desktop,
    signal: controller.signal,
    leaseDirectory: directory,
    identityFor: () => { throw new Error('a system check started an app identity session'); },
    ...(options.systemCheckDeps === undefined ? {} : { systemCheckDeps: options.systemCheckDeps }),
  });
  return { report, desktopCalls };
}

const entryOf = (report, id) => report.entries.find(entry => entry.id === id);

test('a passing file check reports the expected and actual value', async t => {
  const { report, desktopCalls } = await run(t, [fileStep('file', '/tmp/report.pdf')], {
    systemCheckDeps: { stat: async () => ({ isFile: () => true }) },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entryOf(report, 'file').stateCheck,
    { kind: 'file_exists', expected: true, actual: true });
  // No desktop driver call and no app identity probe happened.
  assert.deepEqual(desktopCalls, []);
  assert.equal(reportV2Check.Check(report), true);
});

test('a file check fails with ASSERTION_FALSE and stops later steps', async t => {
  const { report } = await run(t, [
    fileStep('file', '/tmp/report.pdf', true),
    fileStep('after', '/tmp/never-checked', false),
  ], {
    systemCheckDeps: { stat: async () => ({ isFile: () => false }) },
  });
  assert.equal(report.status, 'failed');
  const failed = entryOf(report, 'file');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'ASSERTION_FALSE');
  assert.deepEqual(failed.stateCheck, { kind: 'file_exists', expected: true, actual: false });
  assert.match(failed.message, /does not exist/);
  // The later step was skipped and carries no invented observation.
  const skipped = entryOf(report, 'after');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.stateCheck, undefined);
});

test('a reverse check passes when the file is absent', async t => {
  const { report } = await run(t, [fileStep('absent', '/tmp/missing', false)], {
    systemCheckDeps: {
      stat: async () => {
        const error = new Error('gone');
        error.code = 'ENOENT';
        throw error;
      },
    },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entryOf(report, 'absent').stateCheck,
    { kind: 'file_exists', expected: false, actual: false });
});

const processIdentity = (pid, executable, options = {}) => ({
  pid, uid: options.uid ?? 501, executable, live: options.live ?? true,
  ...(options.startedAt === null ? {} : { startedAt: options.startedAt ?? `1.${pid}` }),
});

/** A probe whose identities and argument answer are fixed per test. */
function processProbe(identities, match = async () => 'unmatched') {
  return {
    async identities() { return identities; },
    async matchArgs(candidate, args) { return match(candidate, [...args]); },
  };
}

test('process checks match the real executable basename and an exact path with spaces', async t => {
  const probe = processProbe([
    processIdentity(501, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    processIdentity(502, '/usr/bin/sleep'),
  ]);
  const byName = await run(t, [processStep('chrome', { kind: 'process', name: 'Google Chrome' })], {
    systemCheckDeps: { probe },
  });
  assert.equal(byName.report.status, 'passed');
  assert.deepEqual(entryOf(byName.report, 'chrome').stateCheck,
    { kind: 'process_running', expected: true, actual: true });

  const byPath = await run(t, [processStep('sleep', {
    kind: 'process', path: '/usr/bin/sleep',
  })], { systemCheckDeps: { probe } });
  assert.equal(byPath.report.status, 'passed');

  const wrongPath = await run(t, [processStep('wrong', {
    kind: 'process', path: '/usr/local/bin/sleep',
  }, false)], { systemCheckDeps: { probe } });
  assert.equal(wrongPath.report.status, 'passed');
});

test('a zombie is not running, so a reverse process check passes', async t => {
  const probe = processProbe([processIdentity(7, '/usr/bin/sleep', { live: false })]);
  const { report } = await run(t, [processStep('sleep', { kind: 'process', name: 'sleep' }, false)], {
    systemCheckDeps: { probe },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entryOf(report, 'sleep').stateCheck,
    { kind: 'process_running', expected: false, actual: false });
});

const processArgsStep = (id, args, equals = true) => ({
  id, kind: 'assert',
  scope: { kind: 'process', name: 'controlled sleeper' },
  check: { kind: 'process_running', equals, args },
});

test('a process argument check reports only its expected and actual value', async t => {
  const probe = processProbe([processIdentity(601, '/tmp/controlled sleeper')],
    async (_candidate, args) => (args.length === 2 && args[1] === 'a b' ? 'matched' : 'unmatched'));
  const { report } = await run(t, [processArgsStep('args', ['--profile', 'a b'])], {
    systemCheckDeps: { probe },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entryOf(report, 'args').stateCheck,
    { kind: 'process_running', expected: true, actual: true });
  // The literal arguments stay out of the report entirely.
  assert.equal(JSON.stringify(report).includes('a b'), false);
  assert.equal(JSON.stringify(report).includes('--profile'), false);
});

test('split or reordered arguments do not match, and a reverse check passes', async t => {
  const probe = processProbe([processIdentity(602, '/tmp/controlled sleeper')],
    async (_candidate, args) => (args[0] === '--profile' && args.length === 3 ? 'matched' : 'unmatched'));
  const { report } = await run(t, [processArgsStep('reverse', ['--profile', 'a b'], false)], {
    systemCheckDeps: { probe },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(entryOf(report, 'reverse').stateCheck,
    { kind: 'process_running', expected: false, actual: false });
});

test('an unreadable candidate is unknown, so even a reverse argument check fails', async t => {
  const probe = processProbe([processIdentity(603, '/tmp/controlled sleeper')],
    async () => 'unknown');
  const { report } = await run(t, [
    processArgsStep('unknown', ['--profile', 'a b'], false),
    fileStep('later', '/tmp/x', true),
  ], { systemCheckDeps: { probe } });
  assert.equal(report.status, 'failed');
  const failed = entryOf(report, 'unknown');
  assert.equal(failed.code, 'SYSTEM_CHECK_FAILED');
  assert.deepEqual(failed.stateCheck,
    { kind: 'process_running', expected: false, actual: null });
  assert.equal(JSON.stringify(report).includes('a b'), false);
  assert.equal(JSON.stringify(report).includes('--profile'), false);
  assert.equal(entryOf(report, 'later').status, 'skipped');
});

test('a failed probe is an unknown and makes even a reverse check fail', async t => {
  for (const [id, step, deps] of [
    ['file', fileStep('file', '/private/secret', false), {
      stat: async () => {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    }],
    ['process', processStep('process', { kind: 'process', name: 'Safari' }, false), {
      probe: {
        async identities() { throw new Fault('SYSTEM_CHECK_FAILED', 'The process probe failed: EACCES'); },
        async matchArgs() { return 'unknown'; },
      },
    }],
  ]) {
    const { report } = await run(t, [step, fileStep('later', '/tmp/x', true)], {
      systemCheckDeps: deps,
    });
    assert.equal(report.status, 'failed', id);
    const failed = entryOf(report, id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'SYSTEM_CHECK_FAILED');
    assert.deepEqual(failed.stateCheck,
      { kind: id === 'file' ? 'file_exists' : 'process_running', expected: false, actual: null });
    assert.equal(entryOf(report, 'later').status, 'skipped');
  }
});
