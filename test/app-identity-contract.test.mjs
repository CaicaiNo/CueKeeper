import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { flowCheck, reportCheck, schemas } from '../dist/contracts.js';

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const readText = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const digest = text => createHash('sha256').update(text).digest('hex');

const flow = read('examples/textedit.flow.json');
const snapshot = read('examples/textedit.snapshot.json');
const report = {
  version: 1,
  flowId: flow.id,
  flowSha256: digest(JSON.stringify(flow)),
  startedAt: '2026-11-21T14:00:00.000Z',
  mode: 'replay',
  status: 'passed',
  entries: [{ id: flow.steps[0].id, kind: 'click', status: 'passed', atMs: 0, durationMs: 3 }],
};

function accepts(schema, value) {
  return schema.Check(value);
}

function firstError(schema, value) {
  const [error] = schema.Errors(value);
  return error?.path;
}

const withPath = appPath => ({ ...flow, target: { ...flow.target, appPath } });

test('old flows and reports still validate unchanged, and running them keeps the file bytes', () => {
  assert.equal(flowCheck.Check(flow), true);
  assert.equal(reportCheck.Check(report), true);
  assert.equal('appPath' in flow.target, false);
  assert.equal('appIdentity' in report, false);

  for (const name of ['examples/textedit.flow.json', 'examples/textedit.snapshot.json']) {
    const before = digest(readText(name));
    const result = spawnSync(process.execPath, [cliPath, 'flow', 'validate', 'examples/textedit.flow.json', '--json'],
      { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(digest(readText(name)), before, `${name} was rewritten`);
  }
});

test('a picked absolute app path is accepted in POSIX, drive, and UNC shapes', () => {
  for (const appPath of [
    '/Applications/TextEdit.app',
    '/Users/sheng/Applications/TextEdit Copy.app',
    '/Users/sheng/应用副本 2/TextEdit.app',
    'C:\\Apps\\TextEdit\\TextEdit.app',
    'D:/Apps/TextEdit.app',
    '\\\\build-host\\Apps\\TextEdit\\TextEdit.app',
  ]) {
    assert.equal(accepts(flowCheck, withPath(appPath)), true, appPath);
  }
  // Schema shape stays platform-neutral: a Windows path is importable offline.
  assert.equal(accepts(flowCheck, withPath('/tmp/Link.app')), true);
  assert.equal(flowCheck.Check({ ...withPath('/Applications/TextEdit.app'), target: { ...flow.target } }), true);
});

test('relative, shorthand, URL, device, and control-character paths are rejected', () => {
  for (const appPath of [
    '',
    'Applications/TextEdit.app',
    './TextEdit.app',
    '../TextEdit.app',
    '~/Applications/TextEdit.app',
    'file:///Applications/TextEdit.app',
    'file:/Applications/TextEdit.app',
    'C:TextEdit.app',
    'C:\\',
    '\\\\server\\share',
    '\\\\.\\PhysicalDrive0',
    '\\\\?\\UNC\\server\\share\\TextEdit.app',
    '/Applications/Text\u0000Edit.app',
    '/Applications/Text\nEdit.app',
    '/Applications/\u007fEdit.app',
    '/Applications/TextEdit.app\n',
    'Applications\\TextEdit.app',
  ]) {
    assert.equal(accepts(flowCheck, withPath(appPath)), false, JSON.stringify(appPath));
  }
  const tooLong = `/${'a'.repeat(4096)}`;
  assert.equal(accepts(flowCheck, withPath(tooLong)), false);
  assert.equal(firstError(flowCheck, withPath('../TextEdit.app'))?.includes('appPath'), true);
});

test('reports accept optional verified, offline, and blocked app identities', () => {
  const verified = { ...report, appIdentity: { app: flow.target.app, mode: 'bundle_path', status: 'verified' } };
  assert.equal(reportCheck.Check(verified), true);

  const offline = { ...report, appIdentity: { app: flow.target.app, mode: 'legacy_bundle_id', status: 'offline_unverified' } };
  assert.equal(reportCheck.Check(offline), true);

  const blocked = {
    ...report,
    status: 'blocked',
    appIdentity: {
      app: flow.target.app, mode: 'bundle_path', status: 'blocked',
      code: 'APP_AMBIGUOUS', reason: 'multiple_instances', entryId: 'step-1',
    },
  };
  assert.equal(reportCheck.Check(blocked), true);
  const withoutEntry = structuredClone(blocked);
  delete withoutEntry.appIdentity.entryId;
  assert.equal(reportCheck.Check(withoutEntry), true);

  const everyReason = [
    'invalid_bundle_path', 'bundle_id_mismatch', 'unsupported_path_platform', 'path_mismatch',
    'multiple_instances', 'multiple_installed_copies', 'identity_unproven', 'instance_changed',
    'driver_target_unconfirmed', 'fixture_path_mismatch', 'untargeted_input',
  ];
  for (const reason of everyReason) {
    assert.equal(reportCheck.Check({ ...blocked, appIdentity: { ...blocked.appIdentity, reason } }), true, reason);
  }
});

test('blocked identities need a code and a known reason, and extra fields stay rejected', () => {
  const blocked = {
    ...report,
    appIdentity: {
      app: flow.target.app, mode: 'bundle_path', status: 'blocked',
      code: 'APP_PATH_INVALID', reason: 'invalid_bundle_path',
    },
  };
  for (const broken of [
    { ...blocked, appIdentity: { ...blocked.appIdentity, reason: undefined } },
    { ...blocked, appIdentity: { ...blocked.appIdentity, code: undefined } },
    { ...blocked, appIdentity: { ...blocked.appIdentity, reason: 'unknown_reason' } },
    { ...blocked, appIdentity: { ...blocked.appIdentity, code: 'NOT_A_CODE' } },
    { ...blocked, appIdentity: { ...blocked.appIdentity, pid: 42 } },
    { ...blocked, appIdentity: { ...blocked.appIdentity, entryId: '' } },
    { ...report, appIdentity: { app: flow.target.app, mode: 'bundle_path', status: 'blocked' } },
    { ...report, appIdentity: { app: flow.target.app, mode: 'bundle_id', status: 'verified' } },
    { ...report, appIdentity: { app: '', mode: 'bundle_path', status: 'verified' } },
    { ...report, appIdentity: 'verified' },
    { ...report, extra: true },
  ]) {
    assert.equal(reportCheck.Check(broken), false, JSON.stringify(broken.appIdentity ?? broken));
  }
});

// The design publishes RFC 6902 patches against the schemas before this change.
// Applying them to those exact pre-change files proves the patch still describes
// a real, applicable contract, not just an aspiration.
function applyPatch(document, operations) {
  const clone = structuredClone(document);
  const tokens = path => path.split('/').slice(1).map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const operation of operations) {
    const parts = tokens(operation.path);
    const last = parts.pop();
    let parent = clone;
    for (const part of parts) parent = parent[part];
    if (operation.op === 'test') {
      assert.deepEqual(parent[last], operation.value, `patch test failed at ${operation.path}`);
    } else if (operation.op === 'add') {
      parent[last] = structuredClone(operation.value);
    } else {
      assert.fail(`Unsupported patch operation ${operation.op}`);
    }
  }
  return clone;
}

function constants(node, found = []) {
  if (Array.isArray(node)) node.forEach(item => constants(item, found));
  else if (node && typeof node === 'object') {
    if (typeof node.const === 'string') found.push(node.const);
    for (const value of Object.values(node)) constants(value, found);
  }
  return found.sort();
}

test('the published schema patch applies to the pre-change schemas and matches the generated contract', () => {
  const diff = read('design/app-identity/schema-diff.json');
  const patchedFlow = applyPatch(read('test/fixtures/app-identity/flow.pre.schema.json'), diff['schemas/flow.schema.json']);
  const patchedReport = applyPatch(read('test/fixtures/app-identity/report.pre.schema.json'), diff['schemas/report.schema.json']);

  const generatedFlow = schemas.flow;
  assert.equal(patchedFlow.properties.target.properties.appPath.pattern,
    generatedFlow.properties.target.properties.appPath.pattern);
  assert.deepEqual(patchedFlow.properties.target.required, generatedFlow.properties.target.required);

  const generatedIdentity = schemas.report.properties.appIdentity;
  const patchedBranches = patchedReport.properties.appIdentity.anyOf;
  assert.deepEqual(patchedBranches.map(branch => branch.required),
    generatedIdentity.anyOf.map(branch => branch.required));
  const blockedOf = branches => branches.find(branch => branch.properties.status.const === 'blocked');
  const patchedBlocked = blockedOf(patchedBranches);
  const generatedBlocked = blockedOf(generatedIdentity.anyOf);
  for (const [property, generated] of [
    ['code', generatedBlocked.properties.code],
    ['reason', generatedBlocked.properties.reason],
    ['mode', generatedIdentity.anyOf[0].properties.mode],
  ]) {
    const patched = patchedBlocked.properties[property] ?? patchedBranches[0].properties[property];
    assert.deepEqual([...patched.enum].sort(), constants(generated), property);
  }
  assert.deepEqual([...patchedBranches[0].properties.status.enum].sort(), ['offline_unverified', 'verified']);
});
