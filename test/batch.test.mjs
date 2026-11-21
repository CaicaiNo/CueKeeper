import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import {
  batchExitCode, bindRows, findDuplicateKey, parseData, readData, resolveBatchSecrets, runBatch,
} from '../dist/batch.js';
import { batchReportCheck } from '../dist/contracts.js';
import { offlineDesktop } from '../dist/desktop.js';
import { hashFlow, parseFlow } from '../dist/flow.js';
import { parseSnapshot } from '../dist/locator.js';
import { packReport } from '../dist/report.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixture = JSON.parse(readFileSync(join(root, 'examples', 'textedit.snapshot.json'), 'utf8'));
const signal = new AbortController().signal;
const editor = { kind: 'element', role: 'textfield' };

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cuekeeper-batch-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function behaviorFlow({ expect = '^(alpha|gamma)$', setup = [] } = {}) {
  return parseFlow({
    version: 1,
    id: 'batch-fill',
    name: 'Batch fill',
    target: fixture.target,
    ...(setup.length ? { setup } : {}),
    behaviors: [{
      id: 'fill', name: 'Fill', parameters: ['note'], steps: [
        { id: 'write', kind: 'type', target: { kind: 'element', role: 'textfield', name: '' }, text: { param: 'note' } },
        { id: 'check', kind: 'assert', check: { target: editor, expect: { property: 'value', matches: expect } } },
      ],
    }],
    steps: [{ id: 'fill', kind: 'behavior', behavior: 'fill', args: { note: 'placeholder' } }],
  });
}

function secretFlow() {
  return parseFlow({
    version: 1,
    id: 'batch-secret',
    name: 'Batch secret',
    target: fixture.target,
    behaviors: [{
      id: 'submit', name: 'Submit', parameters: ['token', 'count'], steps: [
        { id: 'token', kind: 'type', target: { kind: 'element', role: 'textfield', name: '' }, text: { param: 'token' } },
        { id: 'count', kind: 'type', target: { kind: 'element', role: 'textfield', name: '' }, text: { param: 'count' } },
      ],
    }],
    steps: [{
      id: 'fill', kind: 'behavior', behavior: 'submit', args: { token: 'CUEKEEPER_SECRET_TOKEN', count: '0' },
    }],
  });
}

function table(columns, rows) {
  return { version: 1, columns, rows };
}

function failureOf(work) {
  try {
    work();
  } catch (error) {
    return { code: error.code, message: error.message };
  }
  return undefined;
}

/** A driver that mirrors typed text back as the textfield value. */
function fakeDesktop() {
  const typed = [];
  let value = '';
  return {
    ...offlineDesktop(fixture, fixture.target),
    typed,
    async snapshot() {
      const latest = structuredClone(fixture);
      latest.data.tree.children[0].children[0].value = value;
      return parseSnapshot(latest.data, fixture.target);
    },
    async type(ref, text) {
      typed.push(text);
      value = text;
      return 'delivered_verified';
    },
  };
}

test('the data table keeps leading zeros and newlines and rejects every structural gap', () => {
  const valid = parseData(JSON.stringify(table(['recipient', 'note'], [
    { recipient: '0012', note: '第一行\n第二行' },
    { recipient: '0048', note: ' x ' },
  ])));
  assert.deepEqual(valid.columns, ['recipient', 'note']);
  assert.deepEqual(valid.rows[1], { recipient: '0048', note: ' x ' });

  const invalid = [
    ['\uFEFF' + JSON.stringify(table(['a'], [{ a: '1' }])), 'DATA_INVALID'],
    ['', 'DATA_INVALID'],
    ['[]', 'DATA_INVALID'],
    ['{"version":1,"columns":["a"],"rows":[{"a":"1"}],"extra":true}', 'DATA_INVALID'],
    ['{"version":2,"columns":["a"],"rows":[{"a":"1"}]}', 'DATA_INVALID'],
    ['{"version":1,"columns":[],"rows":[{"a":"1"}]}', 'DATA_INVALID'],
    ['{"version":1,"columns":["a","a"],"rows":[{"a":"1"}]}', 'DATA_INVALID'],
    ['{"version":1,"columns":["1bad"],"rows":[{"1bad":"1"}]}', 'DATA_INVALID'],
    ['{"version":1,"columns":["a"],"rows":[]}', 'DATA_INVALID'],
    [JSON.stringify(table(['a'], Array.from({ length: 1001 }, () => ({ a: '1' })))), 'DATA_INVALID'],
    ['{"version":1,"columns":["a"],"rows":[{"a":"1","a":"2"}]}', 'DATA_DUPLICATE_KEY'],
  ];
  for (const [text, code] of invalid) {
    assert.equal(failureOf(() => parseData(text))?.code, code, text.slice(0, 80));
  }
});

test('duplicate keys are found in nested objects but not in array values', () => {
  assert.equal(findDuplicateKey('{"a":1,"b":{"c":1,"c":2}}'), 'c');
  assert.equal(findDuplicateKey('{"list":["a","a"],"a":1}'), undefined);
  assert.equal(findDuplicateKey('{"a":"\\"a","a":1}'), 'a');
});

test('an oversized data file is rejected before parsing', async t => {
  const directory = temporary(t);
  const path = join(directory, 'rows.json');
  writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(readData(path), { code: 'DATA_TOO_LARGE' });
  writeFileSync(path, Buffer.from([0x7b, 0xff, 0x7d]));
  await assert.rejects(readData(path), { code: 'DATA_INVALID' });
});

test('columns resolve against behavior parameters before any row is bound', () => {
  const flow = behaviorFlow();
  assert.deepEqual(bindRows(flow, table(['fill.note'], [{ 'fill.note': '0012' }]))[0].parameters, {
    'fill.note': '0012',
  });
  assert.equal(bindRows(flow, table(['note'], [{ note: '0012' }]))[0].flow.steps[0].args.note, '0012');

  const unknown = failureOf(() => bindRows(flow, table(['missing.note'], [{ 'missing.note': '1' }])));
  assert.equal(unknown.code, 'DATA_UNKNOWN_COLUMN');
  assert.match(unknown.message, /missing\.note/);

  const duplicate = failureOf(() => bindRows(flow, table(['fill.note', 'note'], [
    { 'fill.note': '1', note: '2' },
  ])));
  assert.equal(duplicate.code, 'DATA_DUPLICATE_MAPPING');

  const missing = failureOf(() => bindRows(flow, table(['fill.note'], [{}, { 'fill.note': '2' }])));
  assert.equal(missing.code, 'DATA_MISSING_COLUMN');
  assert.match(missing.message, /Row 1/);
  assert.match(missing.message, /fill\.note/);

  const extra = failureOf(() => bindRows(flow, table(['fill.note'], [
    { 'fill.note': '1' }, { 'fill.note': '2', other: '3' },
  ])));
  assert.equal(extra.code, 'DATA_EXTRA_COLUMN');
  assert.match(extra.message, /Row 2/);

  // A row that both misses a declared column and carries an unknown one is a
  // missing-column error first, as the design's precedence requires.
  const both = failureOf(() => bindRows(flow, table(['fill.note'], [{ other: '1' }])));
  assert.equal(both.code, 'DATA_MISSING_COLUMN');

  for (const cell of [1, true, null, '', 'x'.repeat(4001)]) {
    const invalidCell = failureOf(() => bindRows(flow, table(['fill.note'], [{ 'fill.note': cell }])));
    assert.equal(invalidCell.code, 'DATA_INVALID_VALUE');
    assert.match(invalidCell.message, /Row 1/);
  }
  assert.equal(bindRows(flow, table(['fill.note'], [{ 'fill.note': 'x'.repeat(4000) }]))[0]
    .parameters['fill.note'].length, 4000);

  const secret = failureOf(() => {
    const item = secretFlow();
    return bindRows(item, table(['fill.token'], [{ 'fill.token': '1' }]), new Map([['fill/token', 'CUEKEEPER_SECRET_TOKEN']]));
  });
  assert.equal(secret.code, 'DATA_SECRET_COLUMN');
  assert.match(secret.message, /fill\.token/);
  // The raw value of a secret column never appears in the error.
  assert.doesNotMatch(secret.message, /CUEKEEPER_SECRET_TOKEN/);
});

test('an ambiguous unprefixed column requires the call step prefix', () => {
  const flow = parseFlow({
    version: 1, id: 'twice', name: 'Twice', target: fixture.target,
    behaviors: [{
      id: 'fill', name: 'Fill', parameters: ['note'], steps: [
        { id: 'write', kind: 'type', target: editor, text: { param: 'note' } },
      ],
    }],
    steps: [
      { id: 'first', kind: 'behavior', behavior: 'fill', args: { note: 'a' } },
      { id: 'second', kind: 'behavior', behavior: 'fill', args: { note: 'b' } },
    ],
  });
  const ambiguous = failureOf(() => bindRows(flow, table(['note'], [{ note: '1' }])));
  assert.equal(ambiguous.code, 'DATA_AMBIGUOUS_COLUMN');
  assert.match(ambiguous.message, /first, second/);
  const bound = bindRows(flow, table(['second.note'], [{ 'second.note': '007' }]));
  assert.deepEqual(bound[0].flow.steps.map(step => step.args.note), ['a', '007']);
});

test('missing, empty and oversized secret values block the batch before replay', () => {
  const flow = secretFlow();
  const bindings = new Map([['fill/token', 'CUEKEEPER_SECRET_TOKEN']]);
  const missing = failureOf(() => resolveBatchSecrets(flow, bindings, {}));
  assert.equal(missing.code, 'SECRET_UNAVAILABLE');
  assert.match(missing.message, /CUEKEEPER_SECRET_TOKEN/);
  assert.match(missing.message, /fill\/token/);
  assert.equal(failureOf(() => resolveBatchSecrets(flow, bindings, { CUEKEEPER_SECRET_TOKEN: '' })).code,
    'SECRET_UNAVAILABLE');
  assert.equal(failureOf(() => resolveBatchSecrets(flow, bindings, { CUEKEEPER_SECRET_TOKEN: 'x'.repeat(4001) })).code,
    'SECRET_UNAVAILABLE');
  assert.deepEqual([...resolveBatchSecrets(flow, bindings, { CUEKEEPER_SECRET_TOKEN: 's3cret' })],
    [['fill/token', 's3cret']]);
});

test('a partly failing batch keeps running, reports the failing row and stays packable', async t => {
  const directory = temporary(t);
  const flow = behaviorFlow();
  const rows = bindRows(flow, table(['fill.note'], [
    { 'fill.note': 'alpha' }, { 'fill.note': 'beta' }, { 'fill.note': 'gamma' },
  ]));
  const reportPath = join(directory, 'batch.json');
  const desktop = fakeDesktop();
  const summary = await runBatch(rows, desktop, { dryRun: false, signal, reportPath });

  assert.deepEqual(desktop.typed, ['alpha', 'beta', 'gamma']);
  assert.equal(batchReportCheck.Check(summary), true);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.counts.failed, 1);
  assert.deepEqual(summary.counts, { total: 3, passed: 2, failed: 1, blocked: 0, notCompleted: 0 });
  assert.equal(batchExitCode(summary), 1);
  assert.deepEqual(summary.rows.map(row => [row.row, row.status]), [[1, 'passed'], [2, 'failed'], [3, 'passed']]);
  assert.deepEqual(summary.rows[1].parameters, { 'fill.note': 'beta' });
  assert.deepEqual(summary.rows[1].issues, [{ stepId: 'fill/check', code: 'ASSERTION_FALSE' }]);
  assert.deepEqual(summary.rows[0].issues, []);

  // Every completed row points at its own v1 pair, and each pair packs alone.
  for (const [index, row] of summary.rows.entries()) {
    assert.equal(row.report, `batch.json.rows/row-00000${row.row}/report.json`);
    assert.equal(row.flow, `batch.json.rows/row-00000${row.row}/flow.json`);
    const report = JSON.parse(readFileSync(join(directory, row.report), 'utf8'));
    const bound = parseFlow(JSON.parse(readFileSync(join(directory, row.flow), 'utf8')));
    assert.equal(report.flowSha256, hashFlow(bound));
    assert.equal(bound.steps[0].args.note, ['alpha', 'beta', 'gamma'][index]);
    assert.ok(packReport(report, bound).length > 0);
  }
  const secondReport = JSON.parse(readFileSync(join(directory, summary.rows[1].report), 'utf8'));
  const thirdFlow = parseFlow(JSON.parse(readFileSync(join(directory, summary.rows[2].flow), 'utf8')));
  assert.throws(() => packReport(secondReport, thirdFlow), /do not match/);
  assert.deepEqual(readdirSync(join(directory, 'batch.json.rows')).sort(),
    ['row-000001', 'row-000002', 'row-000003']);
});

test('all rows passing leaves a passed summary and exit code zero', async () => {
  const flow = behaviorFlow({ expect: '.*' });
  const rows = bindRows(flow, table(['fill.note'], [{ 'fill.note': '0012' }, { 'fill.note': '0048' }]));
  const desktop = fakeDesktop();
  const summary = await runBatch(rows, desktop, { dryRun: false, signal });
  assert.deepEqual(desktop.typed, ['0012', '0048']);
  assert.equal(summary.status, 'passed');
  assert.deepEqual(summary.counts, { total: 2, passed: 2, failed: 0, blocked: 0, notCompleted: 0 });
  assert.equal(batchExitCode(summary), 0);
});

test('a blocked row does not stop later rows and the summary reports blocked', async () => {
  const ready = {
    id: 'ready', name: 'Ready', state: 'confirmed',
    check: { target: editor, expect: { property: 'value', equals: 'ready' } },
  };
  const flow = behaviorFlow({ expect: '.*', setup: [ready] });
  const rows = bindRows(flow, table(['fill.note'], [{ 'fill.note': 'alpha' }, { 'fill.note': 'beta' }]));
  const desktop = fakeDesktop();
  let snapshots = 0;
  const original = desktop.snapshot;
  desktop.snapshot = async () => {
    const current = await original();
    // Only the first row sees an unprepared window; the second row is ready.
    if (++snapshots === 1) current.tree.children[0].children[0].value = '';
    else current.tree.children[0].children[0].value = 'ready';
    return current;
  };
  const summary = await runBatch(rows, desktop, { dryRun: false, signal });
  assert.equal(summary.status, 'blocked');
  assert.equal(batchExitCode(summary), 1);
  assert.deepEqual(summary.counts, { total: 2, passed: 1, failed: 0, blocked: 1, notCompleted: 0 });
  assert.equal(summary.rows[0].status, 'blocked');
  assert.ok(summary.rows[0].issues.some(issue => issue.code === 'PRECONDITION_FALSE'));
  assert.equal(summary.rows[1].status, 'passed');
});

test('an interrupted row is not published and the summary keeps completed rows', async t => {
  const directory = temporary(t);
  const flow = behaviorFlow({ expect: '.*' });
  const rows = bindRows(flow, table(['fill.note'], [
    { 'fill.note': 'alpha' }, { 'fill.note': 'beta' }, { 'fill.note': 'gamma' },
  ]));
  const controller = new AbortController();
  const desktop = fakeDesktop();
  const original = desktop.type;
  desktop.type = async (ref, text) => {
    const delivery = await original(ref, text);
    if (text === 'beta') controller.abort();
    return delivery;
  };
  const summary = await runBatch(rows, desktop, {
    dryRun: false, signal: controller.signal, reportPath: join(directory, 'batch.json'),
  });
  assert.equal(summary.status, 'interrupted');
  assert.equal(batchExitCode(summary), 130);
  assert.deepEqual(summary.counts, { total: 3, passed: 1, failed: 0, blocked: 0, notCompleted: 2 });
  assert.deepEqual(summary.rows.map(row => row.row), [1]);
  assert.deepEqual(summary.error, { code: 'INTERRUPTED', message: 'Interrupted', row: 2 });
  assert.deepEqual(readdirSync(join(directory, 'batch.json.rows')), ['row-000001']);
});

test('a row artifact write failure keeps earlier rows and stops on exit code two', async t => {
  const directory = temporary(t);
  const flow = behaviorFlow({ expect: '.*' });
  const rows = bindRows(flow, table(['fill.note'], [
    { 'fill.note': 'alpha' }, { 'fill.note': 'beta' }, { 'fill.note': 'gamma' },
  ]));
  const reportPath = join(directory, 'batch.json');
  const rowsDirectory = `${reportPath}.rows`;
  const desktop = fakeDesktop();
  const original = desktop.type;
  desktop.type = async (ref, text) => {
    const delivery = await original(ref, text);
    // The first row is already published; stop the second row from publishing.
    if (text === 'beta') chmodSync(rowsDirectory, 0o500);
    return delivery;
  };
  const summary = await runBatch(rows, desktop, { dryRun: false, signal, reportPath });
  chmodSync(rowsDirectory, 0o700);
  assert.equal(summary.status, 'error');
  assert.equal(batchExitCode(summary), 2);
  assert.deepEqual(summary.counts, { total: 3, passed: 1, failed: 0, blocked: 0, notCompleted: 2 });
  assert.deepEqual(summary.error && { code: summary.error.code, row: summary.error.row },
    { code: 'REPORT_WRITE_FAILED', row: 2 });
  assert.deepEqual(readdirSync(rowsDirectory), ['row-000001']);
  const row = summary.rows[0];
  const report = JSON.parse(readFileSync(join(directory, row.report), 'utf8'));
  const bound = parseFlow(JSON.parse(readFileSync(join(directory, row.flow), 'utf8')));
  assert.ok(packReport(report, bound).length > 0);
});

test('CLI batch dry-run writes a summary and one packable v1 pair per row', t => {
  const directory = temporary(t);
  const flowPath = join(directory, 'flow.json');
  const dataPath = join(directory, 'rows.json');
  const reportPath = join(directory, 'batch.json');
  writeFileSync(flowPath, JSON.stringify(behaviorFlow({ expect: '.*' })));
  writeFileSync(dataPath, JSON.stringify(table(['fill.note'], [
    { 'fill.note': '0012' }, { 'fill.note': '0048' },
  ])));
  const result = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--data', dataPath, '--dry-run',
    '--snapshot', join(root, 'examples', 'textedit.snapshot.json'), '--report', reportPath, '--json'],
  { encoding: 'utf8' });
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0, result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(batchReportCheck.Check(response.data), true);
  assert.equal(response.data.mode, 'dry-run');
  assert.deepEqual(response.data.counts, { total: 2, passed: 2, failed: 0, blocked: 0, notCompleted: 0 });
  assert.deepEqual(response.data.rows.map(row => row.parameters), [
    { 'fill.note': '0012' }, { 'fill.note': '0048' },
  ]);
  for (const row of response.data.rows) {
    const report = JSON.parse(readFileSync(join(directory, row.report), 'utf8'));
    const bound = parseFlow(JSON.parse(readFileSync(join(directory, row.flow), 'utf8')));
    assert.equal(report.mode, 'dry-run');
    assert.deepEqual(report.entries.map(entry => entry.status), ['resolved', 'resolved']);
    assert.ok(packReport(report, bound).length > 0);
  }
});

test('CLI preflight rejects a missing column before the desktop driver starts', t => {
  const directory = temporary(t);
  const flowPath = join(directory, 'flow.json');
  const dataPath = join(directory, 'rows.json');
  writeFileSync(flowPath, JSON.stringify(behaviorFlow({ expect: '.*' })));
  writeFileSync(dataPath, JSON.stringify(table(['fill.note'], [
    { 'fill.note': '0012' }, {},
  ])));
  const log = join(directory, 'driver.log');
  const stub = join(directory, 'desktop');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
console.log(JSON.stringify({ version: '2.6', command: process.argv[2], ok: false, error: { code: 'UNEXPECTED' } }));
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--data', dataPath, '--json'], {
    encoding: 'utf8', env: { ...process.env, CUEKEEPER_AGENT_DESKTOP: stub, CUEKEEPER_APP_IDENTITY: join(directory, 'identity') },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'DATA_MISSING_COLUMN');
  assert.match(response.error.message, /Row 2/);
  assert.equal(existsSync(log), false);
});

test('CLI resolves secrets once, injects them per row and keeps them out of artifacts', t => {
  const directory = temporary(t);
  const flowPath = join(directory, 'test.json');
  const dataPath = join(directory, 'rows.json');
  writeFileSync(flowPath, JSON.stringify({
    format: 'cuekeeper-test', version: 1, flow: secretFlow(),
    secrets: [{ step: 'fill', param: 'token' }],
  }));
  writeFileSync(dataPath, JSON.stringify(table(['fill.count'], [
    { 'fill.count': '0012' }, { 'fill.count': '0048' },
  ])));
  const log = join(directory, 'driver.log');
  const state = join(directory, 'state.txt');
  const stub = join(directory, 'desktop');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ command, args, input }) + '\\n');
let data;
if (command === 'version') data = { version: '1.3.1' };
else if (command === 'snapshot') data = ${JSON.stringify(fixture.data)};
else if (command === 'type') {
  fs.writeFileSync(${JSON.stringify(state)}, input);
  data = { disposition: { delivery: 'delivered_verified' } };
} else if (command === 'get') {
  data = { value: fs.existsSync(${JSON.stringify(state)}) ? fs.readFileSync(${JSON.stringify(state)}, 'utf8') : '' };
} else data = { disposition: { delivery: 'delivered_verified' } };
console.log(JSON.stringify({ version: '2.6', command, ok: true, data }));
`, { mode: 0o700 });

  const env = { ...process.env, CUEKEEPER_AGENT_DESKTOP: stub, CUEKEEPER_APP_IDENTITY: join(directory, 'identity') };
  delete env.CUEKEEPER_SECRET_TOKEN;
  const missing = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--data', dataPath, '--json'],
    { encoding: 'utf8', env });
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.equal(JSON.parse(missing.stdout).error.code, 'SECRET_UNAVAILABLE');
  assert.equal(existsSync(log), false);

  const dry = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--data', dataPath, '--dry-run',
    '--snapshot', join(root, 'examples', 'textedit.snapshot.json'), '--json'], { encoding: 'utf8', env });
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).data.counts,
    { total: 2, passed: 2, failed: 0, blocked: 0, notCompleted: 0 });

  const reportPath = join(directory, 'batch.json');
  const replay = spawnSync(process.execPath, [cliPath, 'run', flowPath, '--data', dataPath,
    '--report', reportPath, '--json'], {
    encoding: 'utf8', env: { ...env, CUEKEEPER_SECRET_TOKEN: 's3cret-value' },
  });
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  const summary = JSON.parse(replay.stdout).data;
  assert.deepEqual(summary.rows.map(row => row.parameters), [
    { 'fill.count': '0012' }, { 'fill.count': '0048' },
  ]);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(call => call.command === 'type').map(call => call.input),
    ['s3cret-value', '0012', 's3cret-value', '0048']);
  // Injected values stay out of the summary and every persisted v1 artifact.
  const artifacts = [readFileSync(reportPath, 'utf8')];
  for (const row of summary.rows) {
    const report = readFileSync(join(directory, row.report), 'utf8');
    const flow = readFileSync(join(directory, row.flow), 'utf8');
    assert.equal(JSON.parse(report).flowSha256, hashFlow(parseFlow(JSON.parse(flow))));
    assert.match(flow, /CUEKEEPER_SECRET_TOKEN/);
    artifacts.push(report, flow);
  }
  assert.equal(artifacts.length, 5);
  for (const text of artifacts) assert.doesNotMatch(text, /s3cret-value/);
  assert.equal(existsSync(`${reportPath}.rows/row-000001/assets`), false);
});
