import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Keep the real input sources and the native identity helper out of tests: a
// developer machine's Chinese IME must never be switched by the suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
process.env.CUEKEEPER_IME = '/nonexistent/cuekeeper-ime';
import { parseFlow } from '../dist/flow.js';
import {
  InputSourceManager, chooseAsciiSource, isAsciiText, looksImeAltered, nativeImeBackend,
  physicalAsciiKey, readImeLock, readImeRecord, releaseImeLock, restoreImeRecord,
} from '../dist/ime.js';
import { parseSnapshot } from '../dist/locator.js';
import { runFlow } from '../dist/run.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const snapshot = parseSnapshot(fixture.data, fixture.target);

const SOGOU = { id: 'com.sogou.inputmethod.sogou.pinyin', name: '搜狗拼音', ascii: false };
const PINYIN = { id: 'com.apple.inputmethod.SCIM.ITABC', name: '简体拼音', ascii: false };
const ABC = { id: 'com.apple.keylayout.ABC', name: 'ABC', ascii: true };
const US = { id: 'com.apple.keylayout.US', name: 'U.S.', ascii: true };
const EMOJI = { id: 'com.apple.CharacterPaletteIM', name: 'Emoji & Symbols', ascii: true };
const allSources = () => [{ ...ABC }, { ...US }, { ...SOGOU }];

/**
 * Fake TIS: `select` updates the current source unless a case overrides it.
 * The state is exposed so a test can act like the user changing sources.
 */
function fakeBackend({ current = SOGOU, sources = allSources(), select } = {}) {
  const state = { current: { ...current }, sources, selects: [], currentCalls: 0 };
  const backend = {
    available: async () => true,
    list: async () => state.sources.map(source => ({ ...source })),
    current: async () => {
      state.currentCalls += 1;
      return { ...state.current };
    },
    select: async id => {
      state.selects.push(id);
      if (select) return select(id, state);
      const source = state.sources.find(item => item.id === id);
      if (!source) throw new Error(`missing input source ${id}`);
      state.current = { ...source };
    },
  };
  return { backend, state };
}

function managerFor(t, fake, options = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'cuekeeper-ime-'));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const runId = options.runId ?? 'run-test';
  return {
    baseDir,
    runId,
    manager: new InputSourceManager({ backend: fake.backend, baseDir, runId, ...options }),
  };
}

async function capture(fn) {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// --- pure helpers ---------------------------------------------------------

test('ASCII detection and IME separator detection match what replay assumes', () => {
  assert.equal(isAsciiText('cue keeper\t\n'), true);
  assert.equal(isAsciiText('cue 中'), false);
  assert.equal(isAsciiText(''), true);

  assert.equal(physicalAsciiKey('a', []), true);
  assert.equal(physicalAsciiKey('s', ['shift']), true);
  assert.equal(physicalAsciiKey('s', ['meta']), false);
  assert.equal(physicalAsciiKey('return', []), false);
  assert.equal(physicalAsciiKey('tab', ['ctrl']), false);

  // Sogou's syllable separator is the typographic apostrophe; a plain English
  // contraction only counts when the source is not ASCII.
  assert.equal(looksImeAltered('cu’e'), true);
  assert.equal(looksImeAltered('cu`e'), true);
  assert.equal(looksImeAltered("don't", false), false);
  assert.equal(looksImeAltered("don't"), true);  assert.equal(looksImeAltered('cue'), false);
});

test('target selection prefers the configured ID, then ABC, then U.S.', () => {
  assert.equal(chooseAsciiSource(allSources(), US.id).id, US.id);
  assert.equal(chooseAsciiSource(allSources(), 'missing').id, ABC.id);
  assert.equal(chooseAsciiSource([{ ...US }, { ...SOGOU }]).id, US.id);
  assert.equal(chooseAsciiSource([{ ...SOGOU }]), undefined);
  // Never pick an unrelated ASCII-capable source, and never a non-ASCII one
  // just because it was configured.
  assert.equal(chooseAsciiSource([{ ...EMOJI }, { ...SOGOU }]), undefined);
  assert.equal(chooseAsciiSource([{ ...SOGOU }], SOGOU.id), undefined);
  // A non-selectable source is not a target even when it is ABC.
  assert.equal(chooseAsciiSource([{ ...ABC, selectable: false }, { ...US }]).id, US.id);
});

test('the native backend parses TIS envelopes and maps helper failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-ime-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  const helper = join(dir, 'cuekeeper-ime');
  writeFileSync(helper, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args }) + '\\n');
const reply = (data) => console.log(JSON.stringify({ ok: true, data }));
if (command === 'version') reply({ helper: 'cuekeeper-ime', version: 1 });
else if (command === 'list') reply({ sources: [
  { id: ${JSON.stringify(ABC.id)}, name: 'ABC', ascii: true, selectable: true },
  { id: ${JSON.stringify(SOGOU.id)}, name: '搜狗拼音', ascii: false, selectable: true },
]});
else if (command === 'current') reply({ source: { id: ${JSON.stringify(ABC.id)}, name: 'ABC', ascii: true } });
else if (command === 'select' && args[args.indexOf('--id') + 1] === ${JSON.stringify(SOGOU.id)}) {
  console.log(JSON.stringify({ ok: false, error: { code: 'IME_SOURCE_UNAVAILABLE', message: 'cannot select' } }));
  process.exit(1);
} else reply({ selected: {} });
`, { mode: 0o700 });
  const backend = nativeImeBackend(helper);
  assert.equal(await backend.available(), true);
  assert.deepEqual(await backend.list(), [
    { id: ABC.id, name: 'ABC', ascii: true, selectable: true },
    { id: SOGOU.id, name: '搜狗拼音', ascii: false, selectable: true },
  ]);
  assert.deepEqual(await backend.current(), { id: ABC.id, name: 'ABC', ascii: true });
  await backend.select(ABC.id);
  const error = await capture(() => backend.select(SOGOU.id));
  assert.equal(error?.code, 'IME_SOURCE_UNAVAILABLE');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.at(-2), { command: 'select', args: ['--id', ABC.id] });
  assert.equal((await nativeImeBackend('/nonexistent/cuekeeper-ime').available()), false);
});

// --- A: normal path -------------------------------------------------------

test('A1: an ASCII type switches to ABC, records ime.json, and restores the original', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager, baseDir } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  assert.deepEqual(fake.state.selects, [ABC.id]);
  assert.equal(fake.state.current.id, ABC.id);
  const record = JSON.parse(readFileSync(join(baseDir, 'runs', 'run-test', 'ime.json'), 'utf8'));
  assert.equal(record.original.id, SOGOU.id);
  assert.equal(record.target.id, ABC.id);
  assert.equal(record.runId, 'run-test');

  const result = await manager.restore();
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary.switched, true);
  assert.equal(result.summary.final.id, SOGOU.id);
  assert.equal(fake.state.current.id, SOGOU.id);
  assert.deepEqual(fake.state.selects, [ABC.id, SOGOU.id]);
  assert.equal(existsSync(join(baseDir, 'runs', 'run-test', 'ime.json')), false);
});

test('A2: an ASCII source already in place is used without switching or restoring', async t => {
  const fake = fakeBackend({ current: ABC });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  await manager.prepare('key', 'a', []);
  const result = await manager.restore();
  assert.deepEqual(fake.state.selects, []);
  assert.equal(result.summary.switched, false);
  assert.deepEqual(result.warnings, []);
});

test('A3: non-ASCII text is injected as Unicode and never switches the source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', '你好，世界');
  const result = await manager.restore();
  assert.deepEqual(fake.state.selects, []);
  assert.equal(fake.state.current.id, SOGOU.id);
  assert.equal(result.summary.switched, false);
  assert.deepEqual(result.warnings, []);
});

test('A4: three ASCII types switch once and restore once', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  for (const text of ['one', 'two', 'three']) await manager.prepare('type', text);
  await manager.restore();
  assert.deepEqual(fake.state.selects, [ABC.id, SOGOU.id]);
});

// --- B: the user changes the source --------------------------------------

test('B1: switching back to the IME mid-run blocks the next ASCII step and keeps the user choice', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.current = { ...SOGOU };
  const error = await capture(() => manager.prepare('type', 'keeper'));
  assert.equal(error?.code, 'IME_CHANGED_BY_USER');
  assert.equal(error.warning.original.name, 'ABC');
  assert.equal(error.warning.current.name, '搜狗拼音');
  // Never take the source back after the user moved it.
  assert.deepEqual(fake.state.selects, [ABC.id]);
  assert.equal(fake.state.current.id, SOGOU.id);
});

test('B2: another ASCII source selected by the user is accepted without forcing a switch', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.current = { ...US };
  await manager.prepare('type', 'keeper');
  assert.deepEqual(fake.state.selects, [ABC.id]);
  await manager.restore();
  // The accepted US source is restored to the run's original source.
  assert.deepEqual(fake.state.selects, [ABC.id, SOGOU.id]);
});

test('B3: a user switch after the last step is not overridden on restore', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager, baseDir } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.current = { ...SOGOU };
  const result = await manager.restore();
  assert.equal(result.warnings[0]?.code, 'IME_CHANGED_BY_USER');
  assert.equal(fake.state.current.id, SOGOU.id);
  assert.deepEqual(fake.state.selects, [ABC.id]);
  // The recovery file stays so a manual restore is still possible.
  assert.equal(existsSync(join(baseDir, 'runs', 'run-test', 'ime.json')), true);
});

// --- C and D: unavailable source, failed restore --------------------------

test('C1: no ASCII source blocks an ASCII type instead of guessing', async t => {
  const fake = fakeBackend({ current: SOGOU, sources: [{ ...SOGOU }] });
  const { manager } = managerFor(t, fake);
  const error = await capture(() => manager.prepare('type', 'cue'));
  assert.equal(error?.code, 'IME_SOURCE_UNAVAILABLE');
  assert.equal(error.warning.level, 'blocked');
  assert.deepEqual(fake.state.selects, []);
  assert.equal(fake.state.current.id, SOGOU.id);
});

test('C4: an unreadable current source blocks the step', async t => {
  const fake = fakeBackend({ current: SOGOU });
  fake.backend.current = async () => { throw new Error('TIS unavailable'); };
  const { manager } = managerFor(t, fake);
  const error = await capture(() => manager.prepare('type', 'cue'));
  assert.equal(error?.code, 'IME_SOURCE_UNAVAILABLE');
});

test('C2: an original source removed mid-run is reported, not replaced', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.sources = [{ ...ABC }, { ...US }];
  const result = await manager.restore();
  assert.equal(result.warnings[0]?.code, 'IME_RESTORE_UNAVAILABLE');
  assert.equal(result.warnings[0].original.id, SOGOU.id);
  assert.equal(fake.state.current.id, ABC.id);
  assert.deepEqual(fake.state.selects, [ABC.id]);
});

test('D1: a select that does not change the source is a failed restore', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.backend.select = async id => { fake.state.selects.push(id); };
  const result = await manager.restore();
  assert.equal(result.warnings[0]?.code, 'IME_RESTORE_FAILED');
  assert.equal(result.warnings[0].verified.id, ABC.id);
  assert.equal(fake.state.current.id, ABC.id);
});

test('D2: a throwing select is retried once before reporting a failed restore', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.selects.length = 0;
  fake.backend.select = async id => { fake.state.selects.push(id); throw new Error('TIS failure'); };
  const result = await manager.restore();
  assert.equal(result.warnings[0]?.code, 'IME_RESTORE_FAILED');
  assert.deepEqual(fake.state.selects, [SOGOU.id, SOGOU.id]);
});

test('D3: an unreadable source after restore never claims success', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.backend.current = async () => { throw new Error('TIS failure'); };
  const result = await manager.restore();
  assert.equal(result.warnings[0]?.code, 'IME_RESTORE_FAILED');
});

test('C3: a user switch plus a removed original reports both facts', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  fake.state.sources = [{ ...ABC }, { ...US }];
  fake.state.current = { ...PINYIN };
  const result = await manager.restore();
  assert.deepEqual(result.warnings.map(item => item.code), ['IME_CHANGED_BY_USER', 'IME_RESTORE_UNAVAILABLE']);
  assert.equal(fake.state.current.id, PINYIN.id);
  assert.deepEqual(fake.state.selects, [ABC.id]);
});

// --- E and F: concurrency, crash recovery, ime.json -----------------------

test('E1: a live lock held by another run returns IME_BUSY without switching', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager, baseDir } = managerFor(t, fake);
  mkdirSync(baseDir, { recursive: true });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(join(baseDir, 'ime.lock'), JSON.stringify({ runId: 'other-run', pid: process.pid, expiresAt }));
  const error = await capture(() => manager.prepare('type', 'cue'));
  assert.equal(error?.code, 'IME_BUSY');
  assert.equal(error.warning.holderRunId, 'other-run');
  assert.equal(error.warning.lockExpiresAt, expiresAt);
  assert.deepEqual(fake.state.selects, []);
});

test('E2: an expired lock is taken over instead of blocking forever', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager, baseDir } = managerFor(t, fake);
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, 'ime.lock'), JSON.stringify({
    runId: 'crashed-run', pid: 999_999, expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  await manager.prepare('type', 'cue');
  assert.equal(fake.state.current.id, ABC.id);
  const state = await readImeLock(baseDir);
  assert.equal(state.holder.runId, 'run-test');
  await manager.restore();
  assert.deepEqual(await readImeLock(baseDir), { path: join(baseDir, 'ime.lock'), stale: false });
});

test('F1/F3: ime.json written before the switch restores the source after a crash', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager, baseDir, runId } = managerFor(t, fake);
  await manager.prepare('type', 'cue');
  // Simulate SIGKILL: no restore, no lock release. A new process runs the
  // recovery command against the same run directory.
  const record = await readImeRecord(join(baseDir, 'runs', runId));
  assert.equal(record.original.id, SOGOU.id);
  const result = await restoreImeRecord(record, fake.backend);
  assert.equal(result.restored, true);
  assert.equal(fake.state.current.id, SOGOU.id);
  assert.equal(result.current.id, SOGOU.id);
});

test('F4: restoring a record whose original source is gone keeps the current source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { original } = await (async () => {
    const only = fakeBackend({ current: SOGOU });
    const parts = managerFor(t, only);
    await parts.manager.prepare('type', 'cue');
    const record = await readImeRecord(join(parts.baseDir, 'runs', 'run-test'));
    return { original: record.original };
  })();
  const state = { current: { ...ABC }, sources: [{ ...ABC }] };
  const backend = {
    available: async () => true,
    list: async () => state.sources,
    current: async () => state.current,
    select: async id => { state.current = state.sources.find(item => item.id === id); },
  };
  const result = await restoreImeRecord({ version: 1, runId: 'dead', original, switchedAt: '', pid: 1 }, backend);
  assert.equal(result.restored, false);
  assert.equal(result.warning.code, 'IME_RESTORE_UNAVAILABLE');
  assert.equal(state.current.id, ABC.id);
});

test('unlock removes only the lock owned by the named run', async t => {
  const baseDir = mkdtempSync(join(tmpdir(), 'cuekeeper-ime-lock-'));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  writeFileSync(join(baseDir, 'ime.lock'), JSON.stringify({
    runId: 'holder', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  assert.equal((await releaseImeLock('someone-else', baseDir)).released, false);
  assert.equal((await releaseImeLock('holder', baseDir)).released, true);
  assert.equal(existsSync(join(baseDir, 'ime.lock')), false);
});

// --- replay behaviour -----------------------------------------------------

function textFlow(steps) {
  return parseFlow({
    version: 1, id: 'ime-replay', name: 'IME replay',
    target: { app: fixture.target.app, window: fixture.target.window },
    steps,
  });
}

function desktopStub({ onType } = {}) {
  const calls = [];
  return {
    calls,
    snapshot: async () => snapshot,
    click: async ref => { calls.push(['click', ref]); return 'delivered_unverified'; },
    type: async (ref, text) => {
      calls.push(['type', text]);
      if (onType) await onType(text, calls);
      return 'delivered_verified';
    },
    press: async combo => { calls.push(['press', combo]); return 'delivered_unverified'; },
  };
}

const typeStep = (id, text) => ({ id, kind: 'type', target: { kind: 'element', role: 'textfield' }, text });

test('replay switches for an ASCII type and restores the source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const desktop = desktopStub();
  const report = await runFlow(textFlow([typeStep('type-one', 'cue')]), desktop,
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'passed');
  assert.equal(report.entries[0].status, 'passed');
  assert.deepEqual(desktop.calls, [['type', 'cue']]);
  assert.equal(report.ime.switched, true);
  assert.equal(report.ime.original.id, SOGOU.id);
  assert.equal(report.ime.final.id, SOGOU.id);
  assert.equal(report.warnings, undefined);
  assert.equal(fake.state.current.id, SOGOU.id);
});

test('a failed step still restores the source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const desktop = desktopStub({ onType: () => { throw new Error('app refused the text'); } });
  const report = await runFlow(textFlow([typeStep('type-one', 'cue')]), desktop,
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'ACTION_FAILED');
  assert.equal(report.ime.final.id, SOGOU.id);
  assert.equal(fake.state.current.id, SOGOU.id);
});

test('cancellation during a step still restores the source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const controller = new AbortController();
  const desktop = desktopStub({ onType: () => controller.abort(new Error('Interrupted')) });
  await assert.rejects(
    runFlow(textFlow([typeStep('type-one', 'cue')]), desktop,
      { dryRun: false, signal: controller.signal, ime: manager }),
    /Interrupted/,
  );
  assert.equal(fake.state.current.id, SOGOU.id);
  assert.deepEqual(fake.state.selects, [ABC.id, SOGOU.id]);
});

test('non-ASCII replay never touches the source', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const desktop = desktopStub();
  const report = await runFlow(textFlow([typeStep('type-one', '中文输入')]), desktop,
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'passed');
  assert.equal(report.ime.switched, false);
  assert.deepEqual(fake.state.selects, []);
  assert.deepEqual(desktop.calls, [['type', '中文输入']]);
});

test('a character key is guarded but a command chord is not', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const desktop = desktopStub();
  const report = await runFlow(textFlow([
    { id: 'type-a', kind: 'key', key: 'a' },
    { id: 'save', kind: 'key', key: 's', modifiers: ['meta'] },
  ]), desktop, { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'passed');
  assert.deepEqual(fake.state.selects, [ABC.id, SOGOU.id]);
  assert.deepEqual(desktop.calls, [['press', 'a'], ['press', 'meta+s']]);
});

test('a user switch mid-run blocks the rest of the run', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake);
  const desktop = desktopStub({ onType: () => { fake.state.current = { ...SOGOU }; } });
  const report = await runFlow(textFlow([typeStep('type-one', 'cue'), typeStep('type-two', 'keeper')]), desktop,
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'blocked');
  assert.equal(report.entries[1].code, 'IME_CHANGED_BY_USER');
  assert.equal(report.entries[1].status, 'blocked');
  assert.equal(report.warnings[0].code, 'IME_CHANGED_BY_USER');
  assert.deepEqual(desktop.calls, [['type', 'cue']]);
  assert.equal(fake.state.current.id, SOGOU.id);
});

test('--no-input-source-switch warns for text and blocks physical character keys', async t => {
  const fake = fakeBackend({ current: SOGOU });
  const { manager } = managerFor(t, fake, { switchEnabled: false });
  const desktop = desktopStub();
  const report = await runFlow(textFlow([typeStep('type-one', 'cue')]), desktop,
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(report.status, 'passed');
  assert.equal(report.warnings[0].code, 'IME_SWITCH_DISABLED');
  assert.deepEqual(fake.state.selects, []);

  const keyRun = await runFlow(textFlow([{ id: 'type-a', kind: 'key', key: 'a' }]), desktopStub(),
    { dryRun: false, signal: new AbortController().signal, ime: manager });
  assert.equal(keyRun.status, 'blocked');
  assert.equal(keyRun.entries[0].code, 'IME_PHYSICAL_KEY_BLOCKED');
  assert.deepEqual(fake.state.selects, []);
});

// --- CLI: exit codes, --json warnings and ime.json ------------------------

const runFlowDoc = {
  version: 1, id: 'ime-cli', name: 'IME CLI',
  target: { app: fixture.target.app, window: fixture.target.window },
  steps: [typeStep('type-one', 'cue'), typeStep('type-two', 'keeper')],
};

/**
 * One CLI scenario: a stubbed agent-desktop, a stubbed TIS helper backed by a
 * JSON state file, and an isolated IME state root. Nothing touches the real
 * keyboard.
 */
function cliFixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-ime-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'ime-state.json');
  const imeLog = join(dir, 'ime-calls.log');
  const desktopLog = join(dir, 'desktop-calls.log');
  const imeDir = join(dir, 'ime-root');
  writeFileSync(statePath, JSON.stringify({
    current: options.current ?? SOGOU.id,
    sources: options.sources ?? allSources(),
  }));
  writeFileSync(imeLog, '');
  writeFileSync(desktopLog, '');

  const imeHelper = join(dir, 'ime-helper');
  writeFileSync(imeHelper, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(imeLog)};
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ command, args }) + '\\n');
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = state => fs.writeFileSync(statePath, JSON.stringify(state));
const reply = (ok, data, error) => {
  console.log(JSON.stringify(ok ? { ok: true, data } : { ok: false, error }));
};
if (command === 'version') { reply(true, { helper: 'cuekeeper-ime', version: 1 }); process.exit(0); }
const state = read();
if (command === 'list') { reply(true, { sources: state.sources }); process.exit(0); }
if (command === 'current') { reply(true, { source: state.sources.find(s => s.id === state.current) }); process.exit(0); }
if (command === 'select') {
  const id = args[args.indexOf('--id') + 1];
  const source = state.sources.find(s => s.id === id);
  if (!source) { reply(false, null, { code: 'IME_SOURCE_UNAVAILABLE', message: 'missing ' + id }); process.exit(1); }
  ${options.onSelect === 'drop-original'
    ? "state.sources = state.sources.filter(s => s.id !== " + JSON.stringify(SOGOU.id) + ");"
    : ''}
  state.current = source.id;
  write(state);
  reply(true, { selected: source });
  process.exit(0);
}
reply(false, null, { code: 'INPUT_ERROR', message: 'unknown command' });
process.exit(1);
`, { mode: 0o700 });

  const desktop = join(dir, 'desktop');
  writeFileSync(desktop, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(desktopLog)}, JSON.stringify({ command, args, input }) + '\\n');
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'snapshot') data = ${JSON.stringify(fixture.data)};
else if (command === 'type') {
  ${options.failType ? "console.log(JSON.stringify({ version: '2.6', command, ok: false, error: { code: 'ACTION_FAILED', message: 'text failed' } })); process.exit(0);" : ''}
  ${options.afterType === 'switch-to-sogou'
    ? `const statePath = ${JSON.stringify(statePath)};
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.current = ${JSON.stringify(SOGOU.id)};
  fs.writeFileSync(statePath, JSON.stringify(state));`
    : ''}
  data = { disposition: { delivery: 'delivered_verified' } };
} else data = { disposition: { delivery: 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const flowPath = join(dir, 'flow.json');
  writeFileSync(flowPath, JSON.stringify(options.flow ?? runFlowDoc));
  const reads = () => readFileSync(imeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const desktopCalls = () => readFileSync(desktopLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const imeState = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const env = {
    ...process.env,
    CUEKEEPER_AGENT_DESKTOP: desktop,
    CUEKEEPER_IME: imeHelper,
    CUEKEEPER_IME_DIR: imeDir,
    CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
  };
  function run(args) {
    const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  return { dir, imeDir, flowPath, run, reads, desktopCalls, imeState, statePath };
}

test('CLI: an English type under Sogou exits 0, writes correct text, and restores Sogou',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--input-source-switch', '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.status, 'passed');
    assert.equal(report.ime.switched, true);
    assert.equal(report.ime.original.id, SOGOU.id);
    assert.equal(report.ime.final.id, SOGOU.id);
    assert.equal(report.warnings, undefined);
    const types = cli.desktopCalls().filter(call => call.command === 'type');
    assert.deepEqual(types.map(call => call.input), ['cue', 'keeper']);
    assert.equal(cli.imeState().current, SOGOU.id);
    assert.deepEqual(cli.reads().filter(call => call.command === 'select'),
      [{ command: 'select', args: ['--id', ABC.id] }, { command: 'select', args: ['--id', SOGOU.id] }]);
    assert.equal(existsSync(join(report.ime.runDir, 'ime.json')), false);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });

test('CLI: a default run never calls the input-source helper and reports no ime field',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.status, 'passed');
    // Zero TIS traffic: no version, no current, no list, no select.
    assert.deepEqual(cli.reads(), []);
    assert.equal('ime' in report, false);
    assert.equal(report.warnings, undefined);
    assert.equal(cli.imeState().current, SOGOU.id);
    assert.equal(existsSync(join(cli.imeDir, 'ime.lock')), false);
    assert.deepEqual(cli.desktopCalls().filter(call => call.command === 'type').map(call => call.input),
      ['cue', 'keeper']);
  });

test('CLI: --no-input-source-switch is accepted as the same default',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--report', reportPath, '--no-input-source-switch', '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.status, 'passed');
    assert.deepEqual(cli.reads(), []);
    assert.equal('ime' in report, false);
    assert.equal(report.warnings, undefined);
    assert.equal(cli.imeState().current, SOGOU.id);
  });

test('CLI: a default run executes a physical character key without reading TIS',
  { skip: process.platform !== 'darwin' }, t => {
    const flow = { ...runFlowDoc, steps: [{ id: 'key-a', kind: 'key', key: 'a' }] };
    const cli = cliFixture(t, { flow });
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.status, 'passed');
    assert.deepEqual(cli.reads(), []);
    assert.equal('ime' in report, false);
    const presses = cli.desktopCalls().filter(call => call.command === 'press');
    assert.equal(presses.length, 1);
    assert.equal(presses[0].args[0], 'a');
  });

test('CLI: --input-source-switch is refused for a batch run',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const result = cli.run(['run', cli.flowPath, '--data', join(cli.dir, 'rows.json'),
      '--input-source-switch', '--json']);
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.stdout).error.message, /Batch runs do not support --input-source-switch/);
    assert.deepEqual(cli.reads(), []);
  });

test('CLI: --input-source-switch and --no-input-source-switch cannot be combined',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const result = cli.run(['run', cli.flowPath, '--input-source-switch', '--no-input-source-switch', '--json']);
    assert.equal(result.code, 2);
    assert.match(JSON.parse(result.stdout).error.message, /--input-source-switch/);
    assert.deepEqual(cli.reads(), []);
  });

test('CLI: --input-source is inert without --input-source-switch',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t);
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--input-source', US.id, '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(report.status, 'passed');
    assert.deepEqual(cli.reads(), []);
    assert.equal('ime' in report, false);
    assert.equal(cli.imeState().current, SOGOU.id);
  });

test('CLI: an installation without ABC/U.S. blocks with IME_SOURCE_UNAVAILABLE and exit 1',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t, { sources: [{ ...SOGOU }] });
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--input-source-switch', '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 1);
    assert.equal(report.status, 'blocked');
    const type = report.entries.find(entry => entry.id === 'type-one');
    assert.equal(type.status, 'blocked');
    assert.equal(type.code, 'IME_SOURCE_UNAVAILABLE');
    assert.equal(report.entries.find(entry => entry.id === 'type-two').status, 'skipped');
    assert.equal(cli.desktopCalls().filter(call => call.command === 'type').length, 0);
  });

test('CLI: a user switch mid-run blocks the run with IME_CHANGED_BY_USER and exit 1',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t, { afterType: 'switch-to-sogou' });
    const reportPath = join(cli.dir, 'report.json');
    const result = cli.run(['run', cli.flowPath, '--input-source-switch', '--report', reportPath, '--json']);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(result.code, 1);
    assert.equal(report.status, 'blocked');
    const second = report.entries.find(entry => entry.id === 'type-two');
    assert.equal(second.code, 'IME_CHANGED_BY_USER');
    assert.equal(report.warnings[0].code, 'IME_CHANGED_BY_USER');
    assert.equal(report.warnings[0].original.id, ABC.id);
    assert.equal(report.warnings[0].current.id, SOGOU.id);
    assert.equal(cli.desktopCalls().filter(call => call.command === 'type').length, 1);
    assert.equal(cli.imeState().current, SOGOU.id);
  });

test('CLI: a failed step still restores the source', { skip: process.platform !== 'darwin' }, t => {
  const cli = cliFixture(t, { failType: true });
  const reportPath = join(cli.dir, 'report.json');
  const result = cli.run(['run', cli.flowPath, '--input-source-switch', '--report', reportPath, '--json']);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(result.code, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.entries[0].code, 'ACTION_FAILED');
  assert.equal(report.ime.final.id, SOGOU.id);
  assert.equal(cli.imeState().current, SOGOU.id);
});

test('CLI: a vanished original source warns and only --strict-ime changes the exit code',
  { skip: process.platform !== 'darwin' }, t => {
    const first = cliFixture(t, { onSelect: 'drop-original' });
    const firstReport = join(first.dir, 'report.json');
    const lenient = first.run(['run', first.flowPath, '--input-source-switch', '--report', firstReport, '--json']);
    const report = JSON.parse(readFileSync(firstReport, 'utf8'));
    assert.equal(lenient.code, 0, lenient.stderr);
    assert.equal(report.status, 'passed');
    assert.equal(report.warnings[0].code, 'IME_RESTORE_UNAVAILABLE');
    assert.equal(report.warnings[0].level, 'warning');

    const second = cliFixture(t, { onSelect: 'drop-original' });
    const strictReport = join(second.dir, 'report.json');
    const strict = second.run(['run', second.flowPath, '--input-source-switch',
      '--report', strictReport, '--strict-ime', '--json']);
    assert.equal(strict.code, 1);
    assert.equal(JSON.parse(readFileSync(strictReport, 'utf8')).warnings[0].code, 'IME_RESTORE_UNAVAILABLE');
  });

test('CLI: ime status, set, restore and unlock drive the same helper',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t, { current: SOGOU.id });
    const status = cli.run(['ime', 'status', '--json']);
    assert.equal(status.code, 0, status.stderr);
    const statusData = JSON.parse(status.stdout).data;
    assert.equal(statusData.current.id, SOGOU.id);
    assert.equal(statusData.target.id, ABC.id);

    const set = cli.run(['ime', 'set', ABC.id, '--json']);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(cli.imeState().current, ABC.id);

    // Recovery after a crash: a run directory with ime.json pointing at Sogou.
    const runDir = join(cli.imeDir, 'runs', 'crashed');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'ime.json'), JSON.stringify({
      version: 1, runId: 'crashed', original: SOGOU, target: ABC,
      switchedAt: new Date().toISOString(), pid: 1,
    }));
    const restore = cli.run(['ime', 'restore', '--run', runDir, '--json']);
    assert.equal(restore.code, 0, restore.stderr);
    assert.equal(JSON.parse(restore.stdout).data.restored, true);
    assert.equal(cli.imeState().current, SOGOU.id);
    assert.equal(existsSync(join(runDir, 'ime.json')), false);

    const lockPath = join(cli.imeDir, 'ime.lock');
    writeFileSync(lockPath, JSON.stringify({
      runId: 'holder', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(cli.run(['ime', 'unlock', '--run', 'someone-else', '--json']).code, 1);
    assert.equal(cli.run(['ime', 'unlock', '--run', 'holder', '--json']).code, 0);
    assert.equal(existsSync(lockPath), false);
  });

test('CLI: ime restore reports an unavailable original and honours --strict-ime',
  { skip: process.platform !== 'darwin' }, t => {
    const cli = cliFixture(t, { current: ABC.id, sources: [{ ...ABC }] });
    const runDir = join(cli.imeDir, 'runs', 'gone');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'ime.json'), JSON.stringify({
      version: 1, runId: 'gone', original: SOGOU, switchedAt: new Date().toISOString(), pid: 1,
    }));
    const lenient = cli.run(['ime', 'restore', '--run', runDir, '--json']);
    assert.equal(lenient.code, 0, lenient.stderr);
    assert.equal(JSON.parse(lenient.stdout).data.warnings[0].code, 'IME_RESTORE_UNAVAILABLE');
    const strict = cli.run(['ime', 'restore', '--run', runDir, '--strict-ime', '--json']);
    assert.equal(strict.code, 1);
    assert.equal(cli.imeState().current, ABC.id);
  });

// --- viewer ---------------------------------------------------------------

test('a packed report shows the same IME warning in the viewer and report.json', async t => {
  const { strFromU8, unzipSync } = await import('fflate');
  const { hashFlow } = await import('../dist/flow.js');
  const { packReport } = await import('../dist/report.js');
  const flow = textFlow([typeStep('type-one', 'cue')]);
  const report = {
    version: 1, flowId: flow.id, flowSha256: hashFlow(flow), startedAt: new Date().toISOString(),
    mode: 'replay', status: 'blocked',
    ime: { switched: true, original: SOGOU, target: ABC, final: SOGOU, runDir: '/tmp/run' },
    warnings: [{
      code: 'IME_CHANGED_BY_USER', level: 'blocked', title: '输入法被手动切换',
      message: '运行中检测到输入源从「ABC」变为「搜狗拼音」。',
      action: '切回 ABC 后重新运行。', original: ABC, current: SOGOU, runId: 'run-1',
    }],
    entries: [{
      id: 'type-one', kind: 'type', status: 'blocked', atMs: 0, durationMs: 1,
      code: 'IME_CHANGED_BY_USER', message: '运行中检测到输入源从「ABC」变为「搜狗拼音」。',
    }],
  };
  const archive = unzipSync(packReport(report, flow));
  const html = strFromU8(archive['index.html']);
  assert.ok(html.includes('输入法被手动切换'));
  assert.ok(html.includes('IME_CHANGED_BY_USER'));
  assert.ok(html.includes('下一步：切回 ABC 后重新运行。'));
  assert.deepEqual(JSON.parse(strFromU8(archive['report.json'])).warnings, report.warnings);
});

// --- recording ------------------------------------------------------------

test('record detects a Chinese source and flags separator text before saving',
  { skip: process.platform !== 'darwin' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'cuekeeper-ime-record-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const imeHelper = join(dir, 'ime-helper');
    writeFileSync(imeHelper, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const source = ${JSON.stringify(SOGOU)};
if (command === 'version') console.log(JSON.stringify({ ok: true, data: { helper: 'cuekeeper-ime', version: 1 } }));
else if (command === 'list') console.log(JSON.stringify({ ok: true, data: { sources: [source] } }));
else console.log(JSON.stringify({ ok: true, data: { source } }));
`, { mode: 0o700 });
    const desktop = join(dir, 'desktop');
    writeFileSync(desktop, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
const data = command === 'version' ? { version: '1.3.1' }
  : command === 'list-windows' ? [{ id: ${JSON.stringify(fixture.data.window.id)}, title: ${JSON.stringify(fixture.target.window)} }]
  : command === 'snapshot' ? ${JSON.stringify(fixture.data)}
  : { disposition: { delivery: 'delivered_unverified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });
    const capture = join(dir, 'cuekeeper-capture');
    writeFileSync(capture, `#!/usr/bin/env node
if (process.argv[2] === '--permissions') {
  console.log(JSON.stringify({ accessibility: true, inputMonitoring: true }));
  process.exit(0);
}
const seen = Date.now();
const events = [
  { kind: 'ready', indicator: false, hotkeysFiltered: true },
  { kind: 'click', point: [135, 165] },
  { kind: 'text', chars: 'cu’e' },
];
process.stdout.write(events.map((event, t) => JSON.stringify({ ...event, seen, t })).join('\\n') + '\\n');
`, { mode: 0o700 });
    const output = join(dir, 'recorded.flow.json');
    const result = spawnSync(process.execPath, [cliPath, 'record', '--app', fixture.target.app,
      '--window', fixture.target.window, '--out', output, '--seconds', '1', '--no-indicator', '--json'], {
      env: {
        ...process.env, CUEKEEPER_AGENT_DESKTOP: desktop, CUEKEEPER_IME: imeHelper,
        CUEKEEPER_RECORDER: capture, CUEKEEPER_APP_IDENTITY: join(dir, 'identity'),
      },
      encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.data.inputSource.id, SOGOU.id);
    const codes = response.data.warnings.map(warning => warning.code);
    assert.ok(codes.includes('IME_ACTIVE'), codes.join(','));
    assert.ok(codes.includes('IME_UNCOMMITTED'), codes.join(','));
    assert.ok(result.stderr.includes('中文状态'), result.stderr);
    const recorded = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(recorded.steps.find(step => step.kind === 'type').text, 'cu’e');
  });
