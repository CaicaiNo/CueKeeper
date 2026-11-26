import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
      address: { value: '  https://example.com/pkg  ', complete: true, steps: ['type-address'] },
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

test('clearing a stored value removes the entry but keeps the file at 0600', async t => {
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
  await tick(120);
  buttonByText(dialog(document), '清除已存值')?.click();
  // Two fields have entries, so the first clear button belongs to `address`.
  assert.equal(document.getElementById('live-input-address').value, '');
  assert.match(statusOf(document, 'address'), /已清除已存值/);
  document.getElementById('live-input-address').value = 'typed now';
  confirmBox(document).checked = true;
  await submitDialog(document);

  const read = JSON.parse(await readFile(sidecar, 'utf8'));
  assert.deepEqual(Object.keys(read.values), ['note']);
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
  const sent = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(sent.inputs.address, 'typed now');
});

test('a corrupt value file warns in the dialog and the replay can still be filled by hand', async t => {
  const { root, directory } = await workspace(t, { corrupt: true });
  const log = join(root, 'stub-inputs.json');
  const cliPath = await stubCli(root, log);
  const { document } = await bootPage(t, { root, directory, cliPath });

  buttonByText(document.body, '实时回放').click();
  await tick(120);
  assert.match(dialog(document).textContent, /已存参数值读取失败/);
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
