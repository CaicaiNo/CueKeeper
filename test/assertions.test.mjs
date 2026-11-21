import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { unzipSync, strFromU8 } from 'fflate';
import { discoverAssets } from '../dist/assets.js';
import { schemas } from '../dist/contracts.js';
import { offlineDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { Fault, parseSnapshot } from '../dist/locator.js';
import { encodePng } from '../dist/png.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const editor = { kind: 'element', role: 'textfield' };
const signal = new AbortController().signal;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const flowCheck = TypeCompiler.Compile(schemas.flow);

function elementDesktop({ value, missing = false, states = ['visible'], windows, screenshot, screenshotError } = {}) {
  const snapshot = structuredClone(fixture);
  const node = snapshot.data.tree.children[0].children[0];
  if (value !== undefined) node.value = value;
  node.states = states;
  if (missing) snapshot.data.tree.children[0].children = [];
  const parsed = parseSnapshot(snapshot.data, fixture.target);
  const base = offlineDesktop(fixture, fixture.target);
  const actions = [];
  return {
    actions,
    snapshot: async () => parsed,
    property: base.property,
    async listWindows(app) {
      if (windows instanceof Error) throw windows;
      if (windows !== undefined) return windows;
      return base.listWindows(app);
    },
    async screenshot() {
      if (screenshotError) throw screenshotError;
      if (!screenshot) throw new Fault('ASSERTION_CAPTURE_FAILED', 'No screenshot fixture');
      return screenshot;
    },
    click: async ref => { actions.push(['click', ref]); return 'delivered_verified'; },
    clickPoint: async () => 'delivered_verified',
    type: async (ref, text) => { actions.push(['type', ref, text]); return 'delivered_verified'; },
    press: async () => 'delivered_verified',
    ensure: async () => undefined,
  };
}

function flowWith(steps, target = fixture.target) {
  return { version: 1, id: 'assert-flow', name: 'Assertion coverage', target, steps };
}

async function runCheck(check, desktop, options = {}) {
  const flow = parseFlow(flowWith([{ id: 'check', kind: 'assert', check }]));
  const report = await runFlow(flow, desktop, { dryRun: false, signal, ...options });
  return { flow, report, entry: report.entries[0] };
}

const pixel = (r, g, b, a = 255) => [r, g, b, a];
const red = pixel(255, 0, 0);
const blue = pixel(0, 0, 255);

function image(width, height, colors, overrides = {}) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) data.set(colors[index] ?? colors[0], index * 4);
  for (const [index, color] of Object.entries(overrides)) data.set(color, Number(index) * 4);
  return { width, height, data };
}

function savedBaseline(t, bytes) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-assert-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'baselines'));
  const sha = sha256(bytes);
  writeFileSync(join(root, 'baselines', `${sha}.png`), bytes);
  return { root, sha, directory: join(root, 'baselines') };
}

function screenshotCheck(sha, region, frame, maxDiffRatio = 0) {
  return {
    target: { kind: 'window', app: 'com.example.App', window: 'Doc' },
    expect: {
      property: 'screenshot', region,
      baseline: { sha256: sha, frameWidth: frame.width, frameHeight: frame.height },
      maxDiffRatio,
    },
  };
}

const docWindows = [{ id: 'w-doc', title: 'Doc' }];

test('element assertions keep the four v1 properties and record expected and actual', async () => {
  const cases = [
    [{ property: 'exists', equals: true }, {}, 'passed', true],
    [{ property: 'exists', equals: false }, {}, 'failed', true],
    [{ property: 'exists', equals: false }, { role: 'alert' }, 'passed', false],
    [{ property: 'visible', equals: true }, { states: ['visible'] }, 'passed', true],
    [{ property: 'visible', equals: true }, { states: ['hidden'] }, 'failed', false],
    [{ property: 'text', equals: '' }, {}, 'passed', ''],
    [{ property: 'value', equals: '' }, {}, 'passed', ''],
    [{ property: 'value', equals: 'Saved' }, { value: 'Saved' }, 'passed', 'Saved'],
    [{ property: 'value', equals: 'Saved' }, { value: 'Draft' }, 'failed', 'Draft'],
  ];
  for (const [expect, options, status, actual] of cases) {
    const desktop = elementDesktop(options);
    const target = expect.property === 'exists' && options.role ? { kind: 'element', role: options.role } : editor;
    const { entry } = await runCheck({ target, expect }, desktop);
    assert.equal(entry.status, status, JSON.stringify(expect));
    assert.deepEqual(entry.assertion.expected, expect);
    assert.deepEqual(entry.assertion.actual, actual);
    if (status === 'failed') assert.equal(entry.code, 'ASSERTION_FALSE');
  }

  // A non-exists property without a matching element is an observation error, not `false`.
  const missing = await runCheck({ target: editor, expect: { property: 'text', equals: '' } },
    elementDesktop({ missing: true }));
  assert.equal(missing.entry.status, 'failed');
  assert.equal(missing.entry.code, 'NOT_FOUND');
  assert.equal(missing.entry.assertion.actual, undefined);
});

test('string comparators honour normalization and keep the raw observed value', async () => {
  const passing = [
    [{ property: 'text', equals: 'saved ok' }, { value: 'Saved OK', states: ['visible'] }, { ignoreCase: true }],
    [{ property: 'text', equals: 'saved ok' }, { value: '  saved   ok  ' }, { whitespace: 'collapse' }],
    [{ property: 'text', contains: 'saved successfully' }, { value: 'document saved successfully.' }],
    [{ property: 'text', matches: '^saved\\s+successfully$' }, { value: 'saved successfully' }],
    [{ property: 'value', matches: '^DOC-' }, { value: 'doc-42' }, undefined, true],
  ];
  for (const [expect, options, normalize, ignoreCase] of passing) {
    if (normalize) expect.normalize = normalize;
    if (ignoreCase) expect.normalize = { ignoreCase: true };
    const { entry } = await runCheck({ target: editor, expect }, elementDesktop(options));
    assert.equal(entry.status, 'passed', JSON.stringify(expect));
    if (typeof options.value === 'string') assert.equal(entry.assertion.actual, options.value);
  }

  const failing = [
    [{ property: 'text', equals: 'saved' }, { value: 'Saved' }],
    [{ property: 'text', contains: 'failed' }, { value: 'saved successfully' }],
    [{ property: 'text', matches: '^saved$' }, { value: 'saved twice' }],
  ];
  for (const [expect, options] of failing) {
    const { entry } = await runCheck({ target: editor, expect }, elementDesktop(options));
    assert.equal(entry.status, 'failed', JSON.stringify(expect));
    assert.equal(entry.code, 'ASSERTION_FALSE');
    assert.equal(entry.assertion.actual, options.value);
  }

  const raw = await runCheck({
    target: editor,
    expect: { property: 'text', equals: 'saved', normalize: { ignoreCase: true, whitespace: 'trim' } },
  }, elementDesktop({ value: '  SAVED  ' }));
  assert.equal(raw.entry.status, 'passed');
  assert.equal(raw.entry.assertion.actual, '  SAVED  ');
});

test('regex execution is bounded and reports ASSERTION_MATCH_TIMEOUT with the observed text', async () => {
  const value = `${'a'.repeat(30)}!`;
  const { entry } = await runCheck({ target: editor, expect: { property: 'text', matches: '^(a+)+$' } },
    elementDesktop({ value }));
  assert.equal(entry.code, 'ASSERTION_MATCH_TIMEOUT');
  assert.equal(entry.assertion.actual, value);
});

test('invalid buffers are rejected while planning, before any window is read', () => {
  const cases = [
    [{ property: 'text', matches: '(' }, /regular expression/],
    [{ property: 'text', contains: '   ', normalize: { whitespace: 'collapse' } }, /empty/],
    [{ property: 'text', matches: 'x'.repeat(257) }, /Invalid flow/],
  ];
  for (const [expect, message] of cases) {
    assert.throws(() => parseFlow(flowWith([{ id: 'check', kind: 'assert', check: { target: editor, expect } }])), message);
  }
  assert.throws(() => parseFlow(flowWith([{ id: 'check', kind: 'assert', check: {
    target: { kind: 'window', app: 'A', window: 'W' },
    expect: { property: 'screenshot',
      region: { x: 3, y: 0, width: 2, height: 2 },
      baseline: { sha256: 'a'.repeat(64), frameWidth: 4, frameHeight: 4 }, maxDiffRatio: 0 },
  } }])), /region|beyond/);
});

test('window existence distinguishes one, zero and ambiguous inventories', async () => {
  const exists = equals => ({
    target: { kind: 'window', app: 'com.example.App', window: 'Doc' },
    expect: { property: 'exists', equals },
  });
  const single = await runCheck(exists(true), elementDesktop({ windows: docWindows }));
  assert.equal(single.entry.status, 'passed');
  assert.equal(single.entry.assertion.actual, true);

  const empty = await runCheck(exists(false), elementDesktop({ windows: [] }));
  assert.equal(empty.entry.status, 'passed');
  assert.equal(empty.entry.assertion.actual, false);

  const wrong = await runCheck(exists(true), elementDesktop({ windows: [] }));
  assert.equal(wrong.entry.status, 'failed');
  assert.equal(wrong.entry.assertion.actual, false);

  const ambiguous = await runCheck(exists(true),
    elementDesktop({ windows: [...docWindows, { id: 'w-two', title: 'Doc' }] }));
  assert.equal(ambiguous.entry.code, 'AMBIGUOUS_TARGET');
  assert.deepEqual(ambiguous.entry.assertion.expected, exists(true).expect);
  assert.equal(ambiguous.entry.assertion.actual, undefined);

  const denied = await runCheck(exists(true), elementDesktop({ windows: new Fault('PERM_DENIED', 'denied') }));
  assert.equal(denied.entry.code, 'PERM_DENIED');
  assert.equal(denied.entry.assertion.actual, undefined);

  const missingInventory = await runCheck(exists(true),
    elementDesktop({ windows: new Fault('BAD_RESPONSE', 'Expected a window inventory') }));
  assert.equal(missingInventory.entry.code, 'BAD_RESPONSE');

  // A window assertion for another app leaves the replay window binding intact.
  const desktop = elementDesktop({ windows: docWindows });
  const flow = parseFlow(flowWith([
    { id: 'other-window', kind: 'assert', check: exists(true) },
    { id: 'click-editor', kind: 'click', target: editor },
  ]));
  const report = await runFlow(flow, desktop, { dryRun: false, signal });
  assert.deepEqual(report.entries.map(entry => entry.status), ['passed', 'passed']);
  assert.deepEqual(desktop.actions, [['click', '@scuekeeper:e1']]);
});

test('window titles resolve by no filter, exact, contains and regex', async () => {
  const title = (target, expect) => ({ target, expect: { property: 'title', ...expect } });
  const exactTarget = { kind: 'window', app: 'com.example.App', window: 'CueKeeper Test.txt' };
  const windows = [{ id: 'w-1', title: 'CueKeeper Test.txt' }];

  for (const [check, expected] of [
    [title(exactTarget, { equals: 'CueKeeper Test.txt' }), 'CueKeeper Test.txt'],
    [title({ kind: 'window', app: 'com.example.App', window: 'Cue', match: 'contains' },
      { equals: 'CueKeeper Test.txt' }), 'CueKeeper Test.txt'],
    [title({ kind: 'window', app: 'com.example.App' },
      { matches: '^CueKeeper Test\\.[a-z]+$' }), 'CueKeeper Test.txt'],
  ]) {
    const { entry } = await runCheck(check, elementDesktop({ windows }));
    assert.equal(entry.status, 'passed', JSON.stringify(check));
    assert.equal(entry.assertion.actual, expected);
  }

  const renamed = await runCheck(title({ kind: 'window', app: 'com.example.App', window: 'CueKeeper', match: 'contains' },
    { equals: 'CueKeeper Test.txt' }),
  elementDesktop({ windows: [{ id: 'w-1', title: 'CueKeeper Copy.txt' }] }));
  assert.equal(renamed.entry.code, 'ASSERTION_FALSE');
  assert.equal(renamed.entry.assertion.actual, 'CueKeeper Copy.txt');

  const zero = await runCheck(title(exactTarget, { equals: '' }), elementDesktop({ windows: [] }));
  assert.equal(zero.entry.code, 'WINDOW_NOT_FOUND');

  const duplicate = await runCheck(title({ kind: 'window', app: 'com.example.App' }, { equals: 'A' }),
    elementDesktop({ windows: [{ id: 'w-1', title: 'A' }, { id: 'w-2', title: 'B' }] }));
  assert.equal(duplicate.entry.code, 'AMBIGUOUS_TARGET');

  const blank = await runCheck(title({ kind: 'window', app: 'com.example.App' }, { equals: '' }),
    elementDesktop({ windows: [{ id: 'w-1', title: '' }] }));
  assert.equal(blank.entry.status, 'passed');
  assert.equal(blank.entry.assertion.actual, '');
});

test('screenshot assertions compare the configured region against a saved baseline', async t => {
  const baseline = image(2, 2, [red]);
  const bytes = encodePng(baseline);
  const { directory } = savedBaseline(t, bytes);
  const frame = { width: 2, height: 2 };
  const region = { x: 0, y: 0, width: 2, height: 2 };

  const identical = await runCheck(screenshotCheck(sha256(bytes), region, frame),
    elementDesktop({ windows: docWindows, screenshot: encodePng(baseline) }), { baselineDir: directory });
  assert.equal(identical.entry.status, 'passed');
  assert.deepEqual(identical.entry.assertion.actual,
    { frameWidth: 2, frameHeight: 2, differentPixels: 0, diffRatio: 0 });
  assert.equal(identical.entry.assertion.screenshots, undefined);

  const partiallyDifferent = encodePng(image(2, 2, [red], { 0: blue }));
  const within = await runCheck(screenshotCheck(sha256(bytes), region, frame, 0.25),
    elementDesktop({ windows: docWindows, screenshot: partiallyDifferent }), { baselineDir: directory });
  assert.equal(within.entry.status, 'passed');
  assert.deepEqual(within.entry.assertion.actual,
    { frameWidth: 2, frameHeight: 2, differentPixels: 1, diffRatio: 0.25 });

  const outside = await runCheck(screenshotCheck(sha256(bytes), region, frame, 0.24),
    elementDesktop({ windows: docWindows, screenshot: partiallyDifferent }), { baselineDir: directory });
  assert.equal(outside.entry.status, 'failed');
  assert.equal(outside.entry.code, 'ASSERTION_SCREENSHOT_DIFF');
  assert.equal(outside.entry.assertion.actual.differentPixels, 1);
  assert.equal(outside.entry.assertion.actual.diffRatio, 0.25);

  // Pixels outside the region do not affect the result.
  const wideCrop = image(2, 2, [red]);
  const wideBytes = encodePng(wideCrop);
  const wide = savedBaseline(t, wideBytes);
  const wideRegion = { x: 1, y: 1, width: 2, height: 2 };
  const outsideChange = encodePng(image(4, 4, [red], { 0: blue }));
  const unaffected = await runCheck(screenshotCheck(sha256(wideBytes), wideRegion, { width: 4, height: 4 }),
    elementDesktop({ windows: docWindows, screenshot: outsideChange }), { baselineDir: wide.directory });
  assert.equal(unaffected.entry.status, 'passed');
  assert.equal(unaffected.entry.assertion.actual.differentPixels, 0);

  // Alpha-only changes count, and fully transparent pixels compare as RGB 0.
  const alphaBaseline = image(1, 1, [pixel(10, 20, 30, 255)]);
  const alphaSaved = savedBaseline(t, encodePng(alphaBaseline));
  const alphaChanged = await runCheck(screenshotCheck(alphaSaved.sha, { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }),
    elementDesktop({ windows: docWindows, screenshot: encodePng(image(1, 1, [pixel(10, 20, 30, 128)])) }),
    { baselineDir: alphaSaved.directory });
  assert.equal(alphaChanged.entry.status, 'failed');

  const transparentBaseline = image(1, 1, [pixel(90, 90, 90, 0)]);
  const transparentSaved = savedBaseline(t, encodePng(transparentBaseline));
  const transparentSame = await runCheck(
    screenshotCheck(transparentSaved.sha, { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }, 0),
    elementDesktop({ windows: docWindows, screenshot: encodePng(image(1, 1, [pixel(0, 0, 0, 0)])) }),
    { baselineDir: transparentSaved.directory });
  assert.equal(transparentSame.entry.status, 'passed');
});

test('screenshot faults map to their documented codes and keep structured observations', async t => {
  const baseline = image(2, 2, [red]);
  const bytes = encodePng(baseline);
  const { directory } = savedBaseline(t, bytes);
  const sha = sha256(bytes);
  const frame = { width: 2, height: 2 };
  const region = { x: 0, y: 0, width: 2, height: 2 };
  const check = screenshotCheck(sha, region, frame);

  const missing = await runCheck({ ...check, expect: { ...check.expect, baseline: { ...check.expect.baseline, sha256: 'b'.repeat(64) } } },
    elementDesktop({ windows: docWindows, screenshot: encodePng(baseline) }), { baselineDir: directory });
  assert.equal(missing.entry.code, 'ASSERTION_BASELINE_MISSING');
  assert.equal(missing.entry.assertion.actual, undefined);

  const badDigest = await runCheck(screenshotCheck('c'.repeat(64), region, frame),
    elementDesktop({ windows: docWindows, screenshot: encodePng(baseline) }), { baselineDir: directory });
  assert.equal(badDigest.entry.code, 'ASSERTION_BASELINE_MISSING');

  const wrongSizeBaseline = savedBaseline(t, encodePng(image(3, 3, [red])));
  const wrongCrop = await runCheck(screenshotCheck(wrongSizeBaseline.sha, region, frame),
    elementDesktop({ windows: docWindows, screenshot: encodePng(baseline) }), { baselineDir: wrongSizeBaseline.directory });
  assert.equal(wrongCrop.entry.code, 'ASSERTION_BASELINE_INVALID');

  const sizeChanged = await runCheck(check, elementDesktop({
    windows: docWindows, screenshot: encodePng(image(3, 3, [red])),
  }), { baselineDir: directory });
  assert.equal(sizeChanged.entry.code, 'ASSERTION_SCREENSHOT_SIZE');
  assert.deepEqual(sizeChanged.entry.assertion.actual, { frameWidth: 3, frameHeight: 3 });

  const vanished = await runCheck(check, elementDesktop({
    windows: docWindows, screenshotError: new Fault('WINDOW_NOT_FOUND', 'gone'),
  }), { baselineDir: directory });
  assert.equal(vanished.entry.code, 'WINDOW_CHANGED');

  const denied = await runCheck(check, elementDesktop({
    windows: docWindows, screenshotError: new Fault('PERM_DENIED', 'denied'),
  }), { baselineDir: directory });
  assert.equal(denied.entry.code, 'PERM_DENIED');

  const timedOut = await runCheck(check, elementDesktop({
    windows: docWindows, screenshotError: new Fault('COMMAND_TIMEOUT', 'timed out'),
  }), { baselineDir: directory });
  assert.equal(timedOut.entry.code, 'COMMAND_TIMEOUT');
});

test('dry-run checks assertion scope and baseline without capturing pixels', async t => {
  const bytes = encodePng(image(2, 2, [red]));
  const { directory } = savedBaseline(t, bytes);
  const check = screenshotCheck(sha256(bytes), { x: 0, y: 0, width: 2, height: 2 }, { width: 2, height: 2 });
  let captured = false;
  const desktop = elementDesktop({ windows: docWindows });
  desktop.screenshot = async () => { captured = true; throw new Error('dry-run must not capture'); };

  const resolved = await runFlow(parseFlow(flowWith([{ id: 'check', kind: 'assert', check }])), desktop,
    { dryRun: true, signal, baselineDir: directory });
  assert.deepEqual(resolved.entries.map(entry => [entry.status, entry.assertion]), [['resolved', undefined]]);
  assert.equal(captured, false);

  const missing = await runFlow(parseFlow(flowWith([{ id: 'check', kind: 'assert', check: {
    ...check, expect: { ...check.expect, baseline: { ...check.expect.baseline, sha256: 'a'.repeat(64) } },
  } }])), desktop, { dryRun: true, signal, baselineDir: directory });
  assert.equal(missing.entries[0].code, 'ASSERTION_BASELINE_MISSING');

  const element = await runFlow(parseFlow(flowWith([{
    id: 'check', kind: 'assert', check: { target: editor, expect: { property: 'value', equals: '' } },
  }])), elementDesktop(), { dryRun: true, signal });
  assert.equal(element.entries[0].status, 'resolved');
});

test('failed screenshots save evidence that the packer validates and the viewer renders', async t => {
  const baseline = image(2, 2, [red]);
  const bytes = encodePng(baseline);
  const saved = savedBaseline(t, bytes);
  const check = screenshotCheck(saved.sha, { x: 0, y: 0, width: 2, height: 2 }, { width: 2, height: 2 });
  const desktop = elementDesktop({ windows: docWindows, screenshot: encodePng(image(2, 2, [blue])) });
  const reportPath = join(saved.root, 'run-01.json');
  const { flow, report, entry } = await runCheck(check, desktop, {
    baselineDir: saved.directory, evidenceDir: `${reportPath}.assets`,
  });
  assert.equal(entry.status, 'failed');
  assert.deepEqual(entry.assertion.screenshots, {
    baseline: 'assets/check/assertion-baseline.png',
    actual: 'assets/check/assertion-actual.png',
  });
  const savedBaselineBytes = readFileSync(join(`${reportPath}.assets`, 'check', 'assertion-baseline.png'));
  assert.ok(Buffer.from(bytes).equals(savedBaselineBytes));
  writeFileSync(reportPath, JSON.stringify(report));
  const assets = await discoverAssets(reportPath);
  assert.deepEqual(assets.map(asset => asset.path),
    ['check/assertion-actual.png', 'check/assertion-baseline.png']);

  const files = unzipSync(packReport(report, flow, { assets }));
  const html = strFromU8(files['index.html']);
  assert.match(html, /断言基线/);
  assert.match(html, /断言实际/);
  assert.match(html, /ASSERTION_SCREENSHOT_DIFF/);
  assert.match(html, /断言 1 条，0 条通过/);
  assert.match(html, /只看失败断言/);
  assert.match(html, /阈值/);
  assert.ok(files['assets/check/assertion-baseline.png']);

  assert.throws(() => packReport(report, flow), /evidence is missing/);
  assert.throws(() => packReport({ ...report, entries: [{
    ...report.entries[0], assertion: { ...report.entries[0].assertion, expected: { ...check.expect, maxDiffRatio: 0.5 } },
  }] }, flow, { assets }), /expected value does not match/);
  const wrongPath = structuredClone(report);
  wrongPath.entries[0].assertion.screenshots.actual = 'assets/other/assertion-actual.png';
  assert.throws(() => packReport(wrongPath, flow, { assets }), /evidence path|missing/);
});

test('behavior assertions keep the expanded step id and nested evidence paths', async t => {
  const bytes = encodePng(image(2, 2, [red]));
  const saved = savedBaseline(t, bytes);
  const check = screenshotCheck(saved.sha, { x: 0, y: 0, width: 2, height: 2 }, { width: 2, height: 2 });
  const flow = parseFlow({
    version: 1, id: 'behavior-assert', name: 'Behavior assertion', target: fixture.target,
    behaviors: [{ id: 'check-window', name: 'Check window', steps: [{ id: 'shot', kind: 'assert', check }] }],
    steps: [{ id: 'call', kind: 'behavior', behavior: 'check-window' }],
  });
  const reportPath = join(saved.root, 'run-02.json');
  const report = await runFlow(flow, elementDesktop({
    windows: docWindows, screenshot: encodePng(image(2, 2, [blue])),
  }), { dryRun: false, signal, baselineDir: saved.directory, evidenceDir: `${reportPath}.assets` });
  assert.equal(report.entries[0].id, 'call/shot');
  assert.deepEqual(report.entries[0].assertion.screenshots, {
    baseline: 'assets/call/shot/assertion-baseline.png',
    actual: 'assets/call/shot/assertion-actual.png',
  });
  assert.ok(readFileSync(join(`${reportPath}.assets`, 'call', 'shot', 'assertion-baseline.png')));
  writeFileSync(reportPath, JSON.stringify(report));
  const files = unzipSync(packReport(report, flow, { assets: await discoverAssets(reportPath) }));
  assert.ok(files['assets/call/shot/assertion-baseline.png']);
  assert.ok(files['assets/call/shot/assertion-actual.png']);
  assert.match(strFromU8(files['index.html']), /data-step="call\/shot"/);
});

test('the single-window offline fixture answers window assertions and refuses screenshots', async () => {
  const desktop = offlineDesktop(fixture, fixture.target);
  const exists = parseFlow(flowWith([{ id: 'exists', kind: 'assert', check: {
    target: { kind: 'window', app: fixture.target.app, window: fixture.target.window },
    expect: { property: 'exists', equals: true },
  } }]));
  const report = await runFlow(exists, desktop, { dryRun: false, signal });
  assert.deepEqual(report.entries.map(entry => [entry.status, entry.assertion.actual]), [['passed', true]]);

  const otherApp = parseFlow(flowWith([{ id: 'other', kind: 'assert', check: {
    target: { kind: 'window', app: 'com.example.Other', window: 'Elsewhere' },
    expect: { property: 'exists', equals: false },
  } }]));
  const mismatch = await runFlow(otherApp, desktop, { dryRun: false, signal });
  assert.equal(mismatch.entries[0].code, 'WINDOW_MISMATCH');
  assert.equal(mismatch.entries[0].assertion.actual, undefined);

  const screenshot = parseFlow(flowWith([{ id: 'shot', kind: 'assert', check: screenshotCheck(
    'a'.repeat(64), { x: 0, y: 0, width: 1, height: 1 }, { width: 1, height: 1 }) }]));
  const refused = await runFlow(screenshot, desktop, { dryRun: false, signal });
  assert.equal(refused.entries[0].code, 'WINDOW_MISMATCH');
});

test('viewer counts assertions and filters failed ones without breaking old reports', async () => {
  const steps = [
    { id: 'ok', kind: 'assert', check: { target: editor, expect: { property: 'value', equals: '' } } },
    { id: 'bad', kind: 'assert', check: { target: editor, expect: { property: 'value', equals: 'Saved' } } },
    { id: 'never', kind: 'assert', check: { target: editor, expect: { property: 'exists', equals: true } } },
  ];
  const flow = parseFlow(flowWith(steps));
  const report = await runFlow(flow, elementDesktop(), { dryRun: false, signal });
  assert.deepEqual(report.entries.map(entry => entry.status), ['passed', 'failed', 'skipped']);
  const html = strFromU8(unzipSync(packReport(report, flow))['index.html']);
  assert.match(html, /断言 3 条，1 条通过/);
  assert.match(html, /跳过 1/);
  assert.match(html, /data-kind="assert"/);
  assert.match(html, /class="entry status-failed is-failed is-failed-assert/);
  assert.match(html, /只看失败断言/);

  // v1 reports without `assertion` still render and say the value was not recorded.
  const legacyFlow = parseFlow(flowWith([{
    id: 'legacy', kind: 'assert', check: { target: editor, expect: { property: 'value', equals: '' } },
  }]));
  const legacyReport = await runFlow(legacyFlow, elementDesktop(), { dryRun: false, signal });
  legacyReport.entries = legacyReport.entries.map(({ assertion, ...rest }) => rest);
  const legacyHtml = strFromU8(unzipSync(packReport(legacyReport, legacyFlow))['index.html']);
  assert.match(legacyHtml, /报告未记录实际值/);

  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.doesNotThrow(() => new Function(script[1]));
});

test('schemas reject mixed targets, extra fields and extension fields outside assert', () => {
  const base = flowWith([{ id: 'check', kind: 'assert', check: { target: editor, expect: { property: 'text', equals: '' } } }]);
  assert.equal(flowCheck.Check(base), true);

  const cases = [
    // `match` without a title
    flowWith([{ id: 'check', kind: 'assert', check: {
      target: { kind: 'window', app: 'A', match: 'contains' },
      expect: { property: 'exists', equals: true },
    } }]),
    // element target with a window property
    flowWith([{ id: 'check', kind: 'assert', check: { target: editor, expect: { property: 'title', equals: 'A' } } }]),
    // both comparators
    flowWith([{ id: 'check', kind: 'assert', check: {
      target: editor, expect: { property: 'text', equals: 'a', contains: 'a' },
    } }]),
    // unknown extension field
    flowWith([{ id: 'check', kind: 'assert', check: {
      target: editor, expect: { property: 'text', equals: 'a', extra: true },
    } }]),
    // window target inside wait / setup checks
    flowWith([{ id: 'wait', kind: 'wait', timeoutMs: 100, check: {
      target: { kind: 'window', app: 'A' }, expect: { property: 'exists', equals: true },
    } }]),
  ];
  for (const value of cases) assert.equal(flowCheck.Check(value), false);
  assert.equal(flowCheck.Check(flowWith([{ id: 'check', kind: 'assert', check: {
    target: { kind: 'window', app: 'A', window: 'Doc', match: 'contains' },
    expect: { property: 'title', equals: 'Doc', normalize: { ignoreCase: true } },
  } }])), true);
});

test('all existing examples still parse, validate and replay without edits', async () => {
  const behavior = example('type.behavior');
  const { version, ...definition } = behavior;
  assert.ok(TypeCompiler.Compile(schemas.behavior).Check({ version, ...definition }));
  assert.ok(TypeCompiler.Compile(schemas.setup).Check(example('editor.setup')));
  assert.ok(TypeCompiler.Compile(schemas.report).Check(example('textedit.report')));
  const flow = parseFlow(example('textedit.flow'));
  const dry = await runFlow(flow, offlineDesktop(fixture, fixture.target), { dryRun: true, signal });
  assert.deepEqual(dry.entries.map(entry => entry.status), ['resolved', 'resolved', 'resolved']);
});
