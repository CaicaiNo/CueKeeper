import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';
import { installWorkbenchPage } from './support/workbench-dom.mjs';

// The value file is the only place a recorded input text survives. These tests
// drive the real page and the real server: the fields the operator sees, the
// bytes that reach the CLI stub, and the mode of the file on disk.

const examplePath = new URL('../examples/global-two-apps.flow.json', import.meta.url);

async function workspace(t, { values, corrupt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-input-values-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const flow = JSON.parse(await readFile(examplePath, 'utf8'));
  flow.id = 'global-input-values';
  flow.name = '输入值夹具';
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  const sidecar = join(directory, 'flow.values.json');
  if (corrupt) await writeFile(sidecar, '{ broken');
  else if (values) {
    await writeFile(sidecar, JSON.stringify({
      version: 1, flowId: flow.id, updatedAt: '2026-11-26T08:00:00.000Z', values,
    }), { mode: 0o600 });
  }
  return { root, directory, flow, sidecar };
}

/** A replay CLI that records the inputs file it was handed and reports success. */
async function stubCli(root, log) {
  const stub = join(root, 'stub-cli.mjs');
  await writeFile(stub, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const index = args.indexOf('--inputs');",
    "const inputs = index < 0 ? null : JSON.parse(readFileSync(args[index + 1], 'utf8'));",
    `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: args, inputs }));`,
    'const entry = { id: "type-address", kind: "type", status: "passed", atMs: 0, durationMs: 3 };',
    'const report = { version: 2, flowId: "global-input-values", flowSha256: "a".repeat(64),',
    '  startedAt: new Date().toISOString(), mode: "replay", status: "passed", entries: [entry] };',
    'process.stdout.write(JSON.stringify({ ok: true, data: report }) + "\\n");',
    '',
  ].join('\n'));
  return stub;
}

async function server(t, options) {
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, library: join(options.root, 'library'), signal: cancellation.signal, ...options,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });
  async function post(route, payload, status = 200) {
    const response = await fetch(`${started.url}/api/${route}`, {
      method: 'POST',
      headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  }
  return { started, post };
}

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
let page = 0;
const nextPage = () => (page += 1);

/** Boot the real page against the running workbench. */
async function bootPage(t, { root, directory, cliPath }) {
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: true, cliPath,
    signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    return realFetch(target, { ...init, headers: { ...(init.headers ?? {}), origin: started.url } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const document = installWorkbenchPage();
  await import(`../workbench/app.js?page=${nextPage()}`);
  await tick(40);
  return { document, url: started.url };
}

const dialog = document => document.getElementById('dialog');
const buttonByText = (node, text) => node.querySelectorAll('button').find(candidate =>
  [candidate.textContent.trim(), candidate.getAttribute('aria-label'), candidate.getAttribute('title')]
    .includes(text));
const fields = document => document.querySelectorAll('input')
  .filter(node => node.id && node.id.startsWith('live-input-') && !node.id.startsWith('live-input-status-'));
const statusOf = (document, name) => document.getElementById(`live-input-status-${name}`).textContent;
const submitDialog = async document => {
  const form = dialog(document).children.find(node => node.tagName === 'FORM');
  await form.onsubmit({ preventDefault() {} });
  await tick(120);
};
const confirmBox = document => dialog(document).querySelectorAll('input')
  .find(node => node.getAttribute('type') === 'checkbox');

test('the replay dialog prefills the recorded text and sends it verbatim to the CLI', async t => {
  const { root, directory } = await workspace(t, {
    values: {
      address: {
        value: '  https://example.com/pkg  ', complete: true, steps: ['type-address'],
        targets: [{ role: 'textfield', name: '旧地址栏' }],
      },
      note: { value: 'hello note', complete: false, issues: ['chars_missing'] },
    },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { document } = await bootPage(t, { root, directory, cliPath });

  buttonByText(document.body, '实时回放').click();
  await tick(120);
  assert.equal(dialog(document).open, true);

  const address = document.getElementById('live-input-address');
  const note = document.getElementById('live-input-note');
  assert.equal(address.value, '  https://example.com/pkg  ');
  assert.equal(note.value, 'hello note');
  assert.match(statusOf(document, 'address'), /来自录制/);
  // The step's current target is 「地址与搜索」 but the value was typed into
  // 「旧地址栏」: the hint names the old control instead of hiding the change.
  assert.match(statusOf(document, 'address'), /录制时用于「旧地址栏」/);
  // A value the recorder did not read completely is prefilled and flagged, not
  // silently treated as whole.
  assert.match(statusOf(document, 'note'), /不完整/);

  // The "save as default" choice is opt-in on every dialog.
  const checkboxes = dialog(document).querySelectorAll('input')
    .filter(node => node.getAttribute('type') === 'checkbox');
  assert.equal(checkboxes.at(-1).checked, false);

  // Submitting must not trim: the padding is part of the recorded text.
  confirmBox(document).checked = true;
  await submitDialog(document);
  const sent = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(sent.inputs.address, '  https://example.com/pkg  ');
  assert.equal(sent.inputs.note, 'hello note');
  assert.ok(sent.argv.includes('--inputs'));
});

test('a parameter without a value is still required, and a sensitive one never shows text', async t => {
  const { root, directory } = await workspace(t, {
    values: { address: { sensitive: true, complete: true } },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { document } = await bootPage(t, { root, directory, cliPath });

  buttonByText(document.body, '实时回放').click();
  await tick(120);
  const address = document.getElementById('live-input-address');
  assert.equal(address.value, '', 'a sensitive entry never carries its text to the page');
  assert.match(statusOf(document, 'address'), /敏感/);
  assert.match(statusOf(document, 'note'), /无值/);

  confirmBox(document).checked = true;
  await submitDialog(document);
  const error = dialog(document).querySelector('.form-error');
  assert.match(error.textContent, /请先填写运行参数：address、note/);
  // Nothing ran, so the CLI never saw an inputs file.
  await assert.rejects(readFile(log), failure => failure.code === 'ENOENT');
});

test('clearing a stored value writes it immediately and survives reopening the dialog', async t => {
  const { root, directory, sidecar } = await workspace(t, {
    values: {
      address: { value: 'stored address', complete: true, steps: ['type-address'] },
      note: { value: 'stored note', complete: true },
    },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { document } = await bootPage(t, { root, directory, cliPath });

  buttonByText(document.body, '实时回放').click();
  await tick(150);
  buttonByText(dialog(document), '清除已存值').click();
  await tick(150);
  assert.equal(document.getElementById('live-input-address').value, '');
  assert.match(statusOf(document, 'address'), /已清除已存值/);

  // The clear is on disk before any replay starts: closing the dialog and
  // reopening it must not bring the value back.
  buttonByText(dialog(document), '关闭').click();
  assert.equal(dialog(document).open, false);
  buttonByText(document.body, '实时回放').click();
  await tick(150);
  assert.equal(document.getElementById('live-input-address').value, '');
  assert.match(statusOf(document, 'address'), /无值/);
  // Only `note` still has a value, so only it offers a clear button.
  const clears = dialog(document).querySelectorAll('button')
    .filter(node => node.textContent.includes('清除已存值'));
  assert.equal(clears.length, 1);

  const read = JSON.parse(await readFile(sidecar, 'utf8'));
  assert.deepEqual(Object.keys(read.values), ['note']);
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);

  // Replaying with a typed value does not store it unless asked to.
  document.getElementById('live-input-address').value = 'typed now';
  confirmBox(document).checked = true;
  await submitDialog(document);
  const sent = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(sent.inputs.address, 'typed now');
  assert.equal(sent.inputs.note, 'stored note');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(sidecar, 'utf8')).values), ['note']);
});

test('a corrupt value file warns in the dialog without echoing its content, and manual replay works', async t => {
  const secret = `Zq${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-input-values-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'run');
  await mkdir(directory);
  const flow = JSON.parse(await readFile(examplePath, 'utf8'));
  flow.id = 'global-input-values';
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  // Unquoted JSON: the parser's own message quotes this text, so a warning that
  // forwards the message would leak the value.
  await writeFile(join(directory, 'flow.values.json'),
    `{"version":1,"flowId":"global-input-values","updatedAt":"2026-11-26T08:00:00.000Z","values":{"address":{"value":${secret}}}}`);
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { document } = await bootPage(t, { root, directory, cliPath });

  buttonByText(document.body, '实时回放').click();
  await tick(120);
  assert.match(dialog(document).textContent, /已存参数值读取失败/);
  assert.ok(!dialog(document).textContent.includes(secret),
    'the warning names the file, never a byte of its content');
  assert.match(statusOf(document, 'address'), /无值/);
  document.getElementById('live-input-address').value = 'manual address';
  document.getElementById('live-input-note').value = 'manual note';
  confirmBox(document).checked = true;
  await submitDialog(document);
  const sent = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(sent.inputs.address, 'manual address');
  assert.equal(sent.inputs.note, 'manual note');
});

test('the server reads, saves and clears values, and refuses to save while a run is in flight', async t => {
  const { root, directory, sidecar } = await workspace(t, {
    values: {
      address: { value: 'stored address', complete: true },
      note: { sensitive: true, complete: true },
      orphan: { value: 'not declared', complete: true },
    },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { post } = await server(t, { root, directory, cliPath, allowLive: true });
  const session = await post('import', { directory });

  // Reading hides the sensitive text and every name the flow does not declare.
  const read = await post('v2/inputs', { session: session.id });
  assert.deepEqual(Object.keys(read.values).sort(), ['address', 'note']);
  assert.equal(read.values.address.value, 'stored address');
  assert.equal(read.values.note.value, undefined);
  assert.equal(read.values.note.sensitive, true);

  // Saving merges and clears; the value keeps its padding on disk.
  const saved = await post('v2/inputs/save', {
    session: session.id, values: { address: '  padded save  ' },
  });
  assert.equal(saved.values.address.value, '  padded save  ');
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
  const cleared = await post('v2/inputs/save', { session: session.id, values: { address: null } });
  assert.equal(cleared.values.address, undefined);
  assert.deepEqual(JSON.parse(await readFile(sidecar, 'utf8')).values.address, undefined);

  // A run in flight owns the desktop, so the file cannot change under it.
  await writeFile(sidecar, JSON.stringify({
    version: 1, flowId: 'global-input-values', updatedAt: '2026-11-26T09:00:00.000Z',
    values: {
      address: { value: 'before run', complete: true },
      note: { value: 'run note', complete: true },
    },
  }), { mode: 0o600 });
  const slow = join(root, 'slow-cli.mjs');
  await writeFile(slow, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "const index = args.indexOf('--inputs');",
    "writeFileSync(process.env.CUEKEEPER_SLOW_STARTED, String(Date.now()));",
    "const inputs = index < 0 ? null : JSON.parse(readFileSync(args[index + 1], 'utf8'));",
    `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ inputs }));`,
    'await new Promise(resolve => setTimeout(resolve, 400));',
    'process.stdout.write(JSON.stringify({ ok: true, data: { version: 2, flowId: "global-input-values",',
    '  flowSha256: "a".repeat(64), startedAt: new Date().toISOString(), mode: "replay", status: "passed", entries: [] } }) + "\\n");',
    '',
  ].join('\n'));
  process.env.CUEKEEPER_SLOW_STARTED = join(root, 'slow-started');
  t.after(() => { delete process.env.CUEKEEPER_SLOW_STARTED; });
  const slowServer = await server(t, { root, directory, cliPath: slow, allowLive: true });
  const slowSession = await slowServer.post('import', { directory });
  const running = slowServer.post('run', {
    session: slowSession.id, mode: 'live', confirm: true,
  });
  // Wait for the CLI to start, then attempt the forbidden save.
  for (let attempt = 0; attempt < 40; attempt++) {
    await tick(25);
    try { await readFile(join(root, 'slow-started'), 'utf8'); break; } catch { /* not yet */ }
  }
  const refused = await slowServer.post('v2/inputs/save', {
    session: slowSession.id, values: { address: 'during run' },
  }, 409);
  assert.match(refused.error, /running/i);
  await running;
  // /api/run falls back to the stored values the page did not send.
  const sent = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(sent.inputs.address, 'before run');
  assert.equal(sent.inputs.note, 'run note');
});

test('a revision clear lands on the sidecar the lookup actually reads', async t => {
  const { root, directory, sidecar } = await workspace(t, {
    values: {
      address: { value: 'old address', complete: true },
      note: { value: 'old note', complete: true },
    },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { post } = await server(t, { root, directory, cliPath });
  const session = await post('import', { directory });
  // The saved revision becomes the replay target, but the values belong to the
  // recording's sidecar: the reader finds it by flowId.
  const saved = await post('save', { session: session.id }, 201);
  const state = await post('state', {});
  assert.equal(state.session.v2.live.path, saved.output);

  const read = await post('v2/inputs', { session: session.id });
  assert.equal(read.path, join(await realpath(directory), 'flow.values.json'));
  assert.equal(read.values.address.value, 'old address');

  // Clearing through the revision must clear what the revision reads next.
  const cleared = await post('v2/inputs/save', { session: session.id, values: { address: null } });
  assert.equal(cleared.values.address, undefined);
  const reread = await post('v2/inputs', { session: session.id });
  assert.equal(reread.values.address, undefined);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(sidecar, 'utf8')).values), ['note']);
});

test('clearing a sensitive entry keeps its mark, and a later save never writes its text', async t => {
  const { root, directory, sidecar } = await workspace(t, {
    values: {
      address: { value: 'address', complete: true },
      note: { sensitive: true, complete: true },
      orphan: { value: 'not declared', complete: true },
    },
  });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { post } = await server(t, { root, directory, cliPath });
  const session = await post('import', { directory });

  // An explicit save drops a value whose parameter the flow no longer declares.
  await post('v2/inputs/save', { session: session.id, values: { address: 'new' } });
  const disk = JSON.parse(await readFile(sidecar, 'utf8'));
  assert.equal(disk.values.orphan, undefined);
  assert.deepEqual(Object.keys(disk.values).sort(), ['address', 'note']);

  // Clearing the sensitive entry must not turn it into a normal one.
  await post('v2/inputs/save', { session: session.id, values: { note: null } });
  const read = await post('v2/inputs', { session: session.id });
  assert.deepEqual(read.values.note, { sensitive: true, complete: true });

  // "Save as default" for that parameter still must not store the text.
  const typed = `Zq${Date.now()}`;
  await post('v2/inputs/save', { session: session.id, values: { note: typed } });
  const after = JSON.parse(await readFile(sidecar, 'utf8'));
  assert.equal(after.values.note.sensitive, true);
  assert.equal('value' in after.values.note, false);
  assert.ok(!JSON.stringify(after).includes(typed));
});

test('concurrent live runs start one CLI, and concurrent saves keep both fields', async t => {
  const { root, directory } = await workspace(t, {
    values: {
      address: { value: 'concurrent address', complete: true },
      note: { value: 'concurrent note', complete: true },
    },
  });
  const starts = join(root, 'starts.log');
  const slow = join(root, 'slow-cli.mjs');
  await writeFile(slow, [
    "import { appendFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(starts)}, 'start\\n');`,
    'await new Promise(resolve => setTimeout(resolve, 250));',
    'process.stdout.write(JSON.stringify({ ok: true, data: { version: 2, flowId: "global-input-values",',
    '  flowSha256: "a".repeat(64), startedAt: new Date().toISOString(), mode: "replay", status: "passed", entries: [] } }) + "\\n");',
    '',
  ].join('\n'));
  const { started, post } = await server(t, { root, directory, cliPath: slow, allowLive: true });
  const session = await post('import', { directory });
  const send = (route, payload) => fetch(`${started.url}/api/${route}`, {
    method: 'POST',
    headers: { origin: started.url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
    body: JSON.stringify(payload),
  });
  const run = () => send('run', { session: session.id, mode: 'live', confirm: true });

  // Four confirmations arrive at once; only one may own the desktop.
  const runs = await Promise.all([run(), run(), run(), run()]);
  const statuses = runs.map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 400, 400, 400]);
  const startedLines = (await readFile(starts, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(startedLines.length, 1, 'exactly one replay process was started');

  // Two dialogs saving different fields at once must both survive.
  const [first, second] = await Promise.all([
    send('v2/inputs/save', { session: session.id, values: { address: 'first field' } }),
    send('v2/inputs/save', { session: session.id, values: { note: 'second field' } }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const read = await post('v2/inputs', { session: session.id });
  assert.equal(read.values.address.value, 'first field');
  assert.equal(read.values.note.value, 'second field');
});
