import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dryRunFlowV2, hashFlowV2, parseFlowV2 } from '../dist/flow-v2.js';
import {
  applyTemplate, createTemplate, deleteTemplate, listTemplates, parseTemplate, saveTemplate,
  stepFieldValue, substituteTemplate, templateCandidates, templatePlaceholders,
} from '../dist/templates.js';
import { startWorkbench } from '../dist/workbench.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));

/** A recorded-shaped v2 flow whose URL and window title are the variable parts. */
function recordedFlow() {
  const flow = example('global-two-apps.flow');
  const type = flow.steps.find(step => step.kind === 'type');
  delete type.input;
  type.text = 'https://staging.example.test/reports';
  type.target.name = '地址与搜索';
  return flow;
}

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'cuekeeper-templates-'));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a created template replaces only the marked values with placeholders', () => {
  const flow = recordedFlow();
  const template = createTemplate({
    id: 'tpl-report',
    name: '打开报表',
    description: '把地址与下载页标题变成变量',
    flow,
    selections: [
      { stepId: 'type-address', field: 'text', parameter: 'url', label: '报表地址' },
      { stepId: 'type-address', field: 'target.name', parameter: 'addressField' },
      { stepId: 'type-address', field: 'scope.windowTitle', parameter: 'pageTitle' },
    ],
  });

  assert.equal(template.version, 1);
  assert.equal(template.parameters.length, 3);
  assert.deepEqual(template.parameters.map(parameter => parameter.name), ['url', 'addressField', 'pageTitle']);
  assert.equal(template.parameters[0].defaultValue, 'https://staging.example.test/reports');

  const type = template.flow.steps.find(step => step.id === 'type-address');
  assert.equal(type.text, '{{url}}');
  assert.equal(type.target.name, '{{addressField}}');
  assert.equal(type.scope.windowTitle, '{{pageTitle}}');
  // Everything the user did not mark keeps its recorded value.
  assert.equal(type.target.role, 'textfield');
  assert.equal(template.flow.steps.find(step => step.id === 'wait-browser').check.kind, 'window_exists');
  // The template is a copy: the workflow being edited does not change.
  assert.equal(flow.steps.find(step => step.id === 'type-address').text, 'https://staging.example.test/reports');
});

test('applying a template writes the values back and produces a distinct, runnable flow', () => {
  const template = createTemplate({
    id: 'tpl-report',
    name: '打开报表',
    flow: recordedFlow(),
    selections: [
      { stepId: 'type-address', field: 'text', parameter: 'url' },
      { stepId: 'type-address', field: 'scope.windowTitle', parameter: 'pageTitle' },
    ],
  });
  const applied = applyTemplate(template, {
    url: 'https://prod.example.test/quarterly',
    pageTitle: '季度报表',
  }, { id: 'flow-applied-1', name: '季度报表流程' });

  assert.equal(applied.id, 'flow-applied-1');
  assert.equal(applied.name, '季度报表流程');
  assert.equal(applied.steps.find(step => step.id === 'type-address').text, 'https://prod.example.test/quarterly');
  assert.equal(applied.steps.find(step => step.id === 'type-address').scope.windowTitle, '季度报表');
  // The parameterized copy is not the applied copy.
  assert.equal(template.flow.steps.find(step => step.id === 'type-address').text, '{{url}}');
  // The applied result is a real flow: schema, hash and dry run all accept it.
  parseFlowV2(applied);
  assert.equal(hashFlowV2(applied).length, 64);
  const report = dryRunFlowV2(applied);
  assert.equal(report.entries.length, applied.steps.length);
});

test('placeholders substitute inside a larger string and never touch ids or roles', () => {
  const flow = recordedFlow();
  flow.steps.find(step => step.id === 'type-address').text = 'https://{{host}}/reports/{{period}}.csv';
  flow.steps.find(step => step.id === 'type-address').scope.windowTitle = '{{title}}';
  // `host` and `period` are written by hand into the flow; an imported template
  // must declare every placeholder it uses, so an undeclared one is refused.
  const template = {
    version: 1,
    id: 'tpl-nested',
    name: '嵌套占位',
    parameters: [{ name: 'title', label: '窗口标题', defaultValue: '报表' }],
    flow,
  };
  assert.throws(() => parseTemplate(template), /host/);

  const declared = { ...template, parameters: [
    ...template.parameters,
    { name: 'host', label: 'host', defaultValue: 'example.test' },
    { name: 'period', label: 'period', defaultValue: 'q3' },
  ] };
  assert.deepEqual([...templatePlaceholders(parseTemplate(declared).flow)].sort(), ['host', 'period', 'title']);
  const applied = applyTemplate(parseTemplate(declared), { title: '报表', host: 'corp.test', period: 'q4' });
  const type = applied.steps.find(step => step.id === 'type-address');
  assert.equal(type.text, 'https://corp.test/reports/q4.csv');
  assert.equal(type.scope.windowTitle, '报表');
  assert.equal(type.target.role, 'textfield');
  assert.equal(type.target.name, '地址与搜索');
});

test('creating a template refuses ambiguous or empty variable marks', () => {
  const flow = recordedFlow();
  assert.throws(() => createTemplate({
    id: 'tpl-empty', name: '空', flow, selections: [],
  }), /Mark at least one/);
  assert.throws(() => createTemplate({
    id: 'tpl-dupe', name: '重复', flow,
    selections: [
      { stepId: 'type-address', field: 'text', parameter: 'url' },
      { stepId: 'type-address', field: 'text', parameter: 'url2' },
    ],
  }), /already marks/);
  assert.throws(() => createTemplate({
    id: 'tpl-conflict', name: '冲突', flow,
    selections: [
      { stepId: 'type-address', field: 'text', parameter: 'same' },
      { stepId: 'type-address', field: 'scope.windowTitle', parameter: 'same' },
    ],
  }), /two different values/);
  // A step without a value at the chosen field cannot become a variable.
  const noName = structuredClone(flow);
  delete noName.steps.find(step => step.id === 'type-address').target.name;
  assert.throws(() => createTemplate({
    id: 'tpl-missing', name: '缺失', flow: noName,
    selections: [{ stepId: 'type-address', field: 'target.name', parameter: 'name' }],
  }), /has no value/);
});

test('applying requires every value and rejects a half-substituted flow', () => {
  const template = createTemplate({
    id: 'tpl-report',
    name: '打开报表',
    flow: recordedFlow(),
    selections: [
      { stepId: 'type-address', field: 'text', parameter: 'url' },
      { stepId: 'type-address', field: 'scope.windowTitle', parameter: 'pageTitle' },
    ],
  });
  // Without a recorded default a missing value is an error, not an empty string.
  const bare = {
    ...template,
    parameters: template.parameters.map(({ name, label }) => ({ name, label })),
  };
  assert.throws(() => applyTemplate(bare, { url: 'https://x.test' }), /pageTitle/);
  assert.throws(() => applyTemplate(template, { url: '   ', pageTitle: 'x' }), /needs a value/);
  // Defaults are the recorded values, so applying without edits replays the
  // recording as it was.
  const plain = applyTemplate(template, {});
  assert.equal(plain.steps.find(step => step.id === 'type-address').text, 'https://staging.example.test/reports');
});

test('templates round-trip through their own directory and list sorted', async () => {
  const { directory, cleanup } = tempDirectory();
  try {
    const make = (id, name) => createTemplate({
      id, name, flow: recordedFlow(),
      selections: [{ stepId: 'type-address', field: 'text', parameter: 'url' }],
    });
    const second = make('tpl-b', 'B 模板');
    const first = make('tpl-a', 'A 模板');
    const secondPath = await saveTemplate(second, directory);
    await saveTemplate(first, directory);
    const text = readFileSync(secondPath, 'utf8');
    assert.match(text, /\{\{url\}\}/);
    assert.equal(statSync(secondPath).mode & 0o777, 0o600);
    assert.deepEqual((await listTemplates(directory)).map(template => template.id), ['tpl-a', 'tpl-b']);

    // A malformed sibling is skipped instead of hiding the good templates.
    const brokenPath = join(directory, 'tpl-broken.template.json');
    await import('node:fs/promises').then(fs => fs.writeFile(brokenPath, '{ nope'));
    assert.deepEqual((await listTemplates(directory)).map(template => template.id), ['tpl-a', 'tpl-b']);

    await deleteTemplate('tpl-a', directory);
    assert.deepEqual((await listTemplates(directory)).map(template => template.id), ['tpl-b']);
  } finally {
    cleanup();
  }
});

test('import validation refuses unknown fields, unknown placeholders and code-shaped text', () => {
  const flow = recordedFlow();
  const template = createTemplate({
    id: 'tpl-report', name: '打开报表', flow,
    selections: [{ stepId: 'type-address', field: 'text', parameter: 'url' }],
  });

  assert.throws(() => parseTemplate({ ...template, version: 2 }), /version 1/);
  assert.throws(() => parseTemplate({ ...template, parameters: [{ name: 'url' }] }), /name, a label/);
  assert.throws(() => parseTemplate({ ...template, flow: { ...template.flow, script: 'rm -rf /' } }), /Invalid flow/);
  const unknown = structuredClone(template);
  unknown.flow.steps.find(step => step.id === 'type-address').text = '{{url}}/{{other}}';
  assert.throws(() => parseTemplate(unknown), /other/);

  // A template is data. A shell-looking string stays a literal string; it is
  // never evaluated and never becomes a new step.
  const literal = createTemplate({
    id: 'tpl-literal', name: '字面量', flow,
    selections: [{ stepId: 'type-address', field: 'scope.windowTitle', parameter: 'title' }],
  });
  literal.flow.steps.find(step => step.id === 'type-address').text = '$(open /Applications/Calculator.app)';
  const applied = applyTemplate(parseTemplate(literal), { title: 'x' });
  assert.equal(applied.steps.find(step => step.id === 'type-address').text,
    '$(open /Applications/Calculator.app)');
});

test('candidate listing offers one choice per real string, not per step', () => {
  const flow = recordedFlow();
  const candidates = templateCandidates(flow);
  const typeCandidates = candidates.filter(candidate => candidate.stepId === 'type-address');
  assert.deepEqual(typeCandidates.map(candidate => candidate.field), ['target.name', 'scope.windowTitle', 'text']);
  assert.equal(typeCandidates.find(candidate => candidate.field === 'text').suggested, 'https_staging_example_test_reports');
  assert.equal(stepFieldValue(flow.steps.find(step => step.id === 'type-address'), 'text'),
    'https://staging.example.test/reports');
  assert.equal(substituteTemplate(flow, {}).steps.length, flow.steps.length);
});

test('a download wait can parameterize the file name it watches', () => {
  const flow = recordedFlow();
  flow.steps.push({
    id: 'wait-download', kind: 'wait',
    scope: { kind: 'file', directory: '/Users/example/Downloads', name: 'report.xlsx' },
    check: { kind: 'file_stable' }, timeoutMs: 15000,
  });
  const template = createTemplate({
    id: 'tpl-download', name: '下载报表', flow,
    selections: [
      { stepId: 'wait-download', field: 'scope.fileName', parameter: 'filename', label: '下载文件名' },
      { stepId: 'type-address', field: 'text', parameter: 'url' },
    ],
  });
  assert.equal(template.flow.steps.at(-1).scope.name, '{{filename}}');
  assert.equal(template.parameters.find(parameter => parameter.name === 'filename').defaultValue, 'report.xlsx');
  const applied = applyTemplate(template, { filename: 'q4.xlsx', url: 'https://x.test/report' });
  assert.equal(applied.steps.at(-1).scope.name, 'q4.xlsx');
  assert.equal(applied.steps.at(-1).scope.directory, '/Users/example/Downloads');
  parseFlowV2(applied);
  assert.equal(dryRunFlowV2(applied).entries.at(-1).id, 'wait-download');
});

test('a secure text field never becomes a template variable', () => {
  const flow = recordedFlow();
  const type = flow.steps.find(step => step.id === 'type-address');
  type.target.role = 'securetextfield';
  assert.equal(templateCandidates(flow).filter(candidate =>
    candidate.stepId === 'type-address' && candidate.field === 'text').length, 0);
  assert.throws(() => createTemplate({
    id: 'tpl-secret', name: '密码', flow,
    selections: [{ stepId: 'type-address', field: 'text', parameter: 'password' }],
  }), /secure text field/);
});

test('the workbench serves template create, list, apply, import and delete', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-template-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  mkdirSync(directory);
  const flow = parseFlowV2(example('global-two-apps.flow'));
  writeFileSync(join(directory, 'flow.json'), JSON.stringify(flow));

  const cancellation = new AbortController();
  const { url, closed } = await startWorkbench({
    port: 0, allowLive: false, signal: cancellation.signal,
    library: join(root, 'library'),
    templates: join(root, 'templates'),
    applied: join(root, 'applied'),
  });
  t.after(async () => { cancellation.abort(); await closed; });
  const post = async (route, payload) => {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  const imported = await post('import', { directory });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const sessionId = imported.body.id;

  const candidates = await post('templates/candidates', { session: sessionId });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.body));
  const address = candidates.body.candidates.find(candidate =>
    candidate.stepId === 'type-address' && candidate.field === 'target.name');
  assert.equal(address.value, '地址与搜索');

  const created = await post('templates/create', {
    session: sessionId, name: '搜索地址', description: '把地址框名字与标题变成变量',
    selections: [
      { stepId: 'type-address', field: 'target.name', parameter: 'addressField', label: '地址框' },
      { stepId: 'type-address', field: 'scope.windowTitle', parameter: 'pageTitle', label: '页面标题' },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const templateId = created.body.template.id;
  const templateFile = join(root, 'templates', `${templateId}.template.json`);
  const before = readFileSync(templateFile, 'utf8');
  assert.match(before, /\{\{addressField\}\}/);

  const listed = await post('templates/list', {});
  assert.equal(listed.body.templates.length, 1);
  assert.equal(listed.body.directory, join(root, 'templates'));

  const applied = await post('templates/apply', {
    templateId,
    values: { addressField: '搜索框', pageTitle: '新页面' },
    name: '应用后的工作流',
    discardEdits: true,
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.session.version, 2);
  assert.equal(applied.body.session.name, '应用后的工作流');
  const appliedStep = applied.body.session.v2.flow.steps.find(step => step.id === 'type-address');
  assert.equal(appliedStep.target.name, '搜索框');
  assert.equal(appliedStep.scope.windowTitle, '新页面');
  assert.notEqual(applied.body.session.v2.flow.id, flow.id);
  assert.match(applied.body.output, /templates-.*|applied/);
  // Applying never edits the template it came from.
  assert.equal(readFileSync(templateFile, 'utf8'), before);

  // The new workflow is a real session: its dry run covers every step.
  const dry = await post('run', { session: applied.body.session.id, mode: 'dry-run' });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.entries.length, applied.body.session.v2.flow.steps.length);

  // An explicitly empty value is refused; omitting it would use the recorded default.
  const missing = await post('templates/apply', {
    templateId, values: { addressField: 'x', pageTitle: '' }, discardEdits: true,
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.match(missing.body.message, /pageTitle/);

  // An imported file that reuses the stored id gets a fresh id, not an overwrite.
  const reimported = await post('templates/import', {
    template: JSON.parse(readFileSync(templateFile, 'utf8')),
  });
  assert.equal(reimported.status, 201, JSON.stringify(reimported.body));
  assert.equal(reimported.body.renamed, true);
  assert.notEqual(reimported.body.template.id, templateId);
  assert.equal((await post('templates/list', {})).body.templates.length, 2);

  await post('templates/delete', { templateId });
  assert.deepEqual((await post('templates/list', {})).body.templates.map(item => item.id),
    [reimported.body.template.id]);
});
