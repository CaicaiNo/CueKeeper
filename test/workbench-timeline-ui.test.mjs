import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

// The workbench page is plain ES modules, so the real `app.js` can run against
// a small DOM stand-in: the clicks below go through the same handlers the
// browser uses, and the assertions read the same nodes the operator sees.

class ClassList {
  constructor() { this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : Boolean(force);
    if (on) this.values.add(name); else this.values.delete(name);
    return on;
  }
}

class TextNode {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); }
}

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = '';
    this.classList = new ClassList();
    this._className = '';
    this._id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    for (const handler of ['onclick', 'onchange', 'onsubmit', 'oninput', 'ontoggle',
      'ondragstart', 'ondragover', 'ondrop', 'oncancel', 'onerror']) this[handler] = null;
  }

  get className() { return this._className; }

  get id() { return this._id; }

  set id(value) {
    this._id = String(value ?? '');
    if (this._id) this.ownerDocument.byId.set(this._id, this);
  }

  set className(value) {
    this._className = String(value ?? '');
    this.classList = new ClassList();
    for (const name of this._className.split(/\s+/).filter(Boolean)) this.classList.add(name);
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value ?? '');
  }

  get lastChild() { return this.children.at(-1); }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue;
      const child = typeof node === 'string' ? new TextNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      if (node === undefined || node === null) continue;
      const child = typeof node === 'string' ? new TextNode(node) : node;
      child.parentNode = this;
      this.children.unshift(child);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  after(node) {
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parentNode = parent;
  }

  replaceWith(node) {
    const parent = this.parentNode;
    parent.children[parent.children.indexOf(this)] = node;
    node.parentNode = parent;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}

  matches(selector) {
    return selector.split(',').some(part => {
      const rule = part.trim();
      const match = /^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/.exec(rule);
      if (!match) return false;
      const [, tag, className, attribute] = match;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (className && !this.classList.contains(className)) return false;
      if (attribute && !this.attributes.has(attribute)) return false;
      return true;
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  descendants() {
    return this.children.flatMap(child =>
      child instanceof TextNode ? [] : [child, ...child.descendants()]);
  }

  querySelector(selector) {
    if (selector.includes(':not(')) return null;
    return this.descendants().find(node => node.matches(selector)) ?? null;
  }

  querySelectorAll(selector) {
    return this.descendants().filter(node => node.matches(selector));
  }

  click() {
    const event = {
      target: this, preventDefault() {}, stopPropagation() {}, dataTransfer: { setData() {}, getData() {} },
    };
    if (this.onclick) this.onclick(event);
    for (const handler of this.listeners.get('click') ?? []) handler(event);
  }
}

class Document {
  constructor() {
    this.byId = new Map();
    this.body = new Element('body', this);
    this.activeElement = null;
    this.main = new Element('main', this);
    this.main.className = 'workspace';
    this.body.append(this.main);
  }

  createElement(tag) { return new Element(tag, this); }
  createElementNS(_namespace, tag) { return new Element(tag, this); }
  createTextNode(text) { return new TextNode(text); }
  getElementById(id) { return this.byId.get(id) ?? null; }
  querySelector(selector) {
    if (selector === 'main.workspace') return this.main;
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  addEventListener() {}
}

const PAGE_IDS = [
  'dialog', 'status', 'session-name', 'session-kind', 'summary', 'setup', 'timeline',
  'timeline-count', 'ignored-control', 'selection', 'inspector', 'draft', 'draft-count',
  'test-name', 'save-button', 'run-button', 'shell-button', 'privilege-button', 'import-button',
  'app-picker', 'app-picker-icon', 'app-picker-label', 'mode-edit', 'mode-batch',
  'template-button', 'actions-tab', 'library-tab', 'show-ignored', 'batch-log',
  'batch-workspace', 'edit-workspace', 'draft-section',
];

/** A v2 recording with enough steps that the timeline can scroll. */
async function recording(root) {
  const flow = JSON.parse(await readFile(
    new URL('../examples/global-two-apps.flow.json', import.meta.url), 'utf8'));
  const template = flow.steps.find(step => step.kind === 'type');
  const steps = [flow.steps[0]];
  for (let index = 1; index <= 20; index += 1) {
    const step = structuredClone(template);
    step.id = `s${index}`;
    step.target.name = `地址栏 ${index}`;
    step.atMs = index * 500;
    steps.push(step);
  }
  flow.id = 'timeline-ui';
  flow.name = '时间线夹具';
  flow.steps = steps;
  delete flow.appPaths;
  const directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  return directory;
}

async function bootPage(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-timeline-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await recording(root);
  const cancellation = new AbortController();
  const started = await startWorkbench({
    directory, port: 0, library: join(root, 'library'), allowLive: false,
    allowShell: false, signal: cancellation.signal,
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  // The page asks the real server for its session; only the two fields the
  // fixtures care about are rewritten, so everything else is the shipped view.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' && url.startsWith('/') ? started.url + url : url;
    const response = await realFetch(target, {
      ...init, headers: { ...(init.headers ?? {}), origin: started.url },
    });
    if (url !== '/api/state') return response;
    const state = await response.json();
    state.session.v2.live = { path: join(directory, 'flow.edited-2026.json'), revision: true };
    state.session.v2.dirty = false;
    state.session.v2.diff = {
      changed: true, added: [], removed: [{ id: 's6' }],
      moved: [{ id: 's7', from: 6, to: 5 }, { id: 's8', from: 7, to: 6 }],
      modified: [], orderChanged: false, flowFields: [],
    };
    return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const document = new Document();
  for (const id of PAGE_IDS) {
    const node = document.createElement('div');
    node.id = id;
    document.main.append(node);
  }
  const location = { hash: '' };
  globalThis.document = document;
  globalThis.window = { addEventListener() {}, location };
  globalThis.location = location;
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);

  await import('../workbench/app.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  return { document };
}

const actionRows = document =>
  document.getElementById('timeline').children.filter(node => node.classList.contains('row'));

const v2RowBox = document => document.querySelector('.v2-rows');

test('the workbench page selects a clicked timeline step and keeps the list in place', async t => {
  const { document } = await bootPage(t);

  await t.test('clicking the Nth action row shows that step in the inspector', () => {
    const rows = actionRows(document);
    assert.ok(rows.length > 3, `timeline rows: ${rows.length}`);
    const inspector = document.getElementById('inspector');
    assert.doesNotMatch(inspector.textContent, /s2 · 输入/);

    rows[2].click();

    const selected = actionRows(document).find(row => row.classList.contains('active'));
    assert.ok(selected, 'the clicked row is marked active');
    assert.match(selected.children[0].textContent, /s2/, 'row 2 (third) is the selected one');
    assert.match(inspector.textContent, /s2/, 'the inspector names the clicked step');
    assert.match(inspector.textContent, /地址栏 2/, 'the inspector shows that step\'s own target');
  });

  await t.test('clicking the last action row shows the last step, not the first', () => {
    const rows = actionRows(document);
    rows.at(-1).click();
    const inspector = document.getElementById('inspector');
    assert.match(inspector.textContent, /s20/, 'the last step is displayed');
    assert.doesNotMatch(inspector.textContent, /会话构成/, 'the default overview is gone');

    // Selecting an action re-renders every pane; the chosen step must survive
    // that redraw instead of falling back to the default overview.
    const checkbox = rows[0].children[0].children[0];
    checkbox.checked = true;
    checkbox.onchange({ target: { checked: true } });
    assert.match(document.getElementById('inspector').textContent, /s20/, 'still shown after a redraw');
    const active = actionRows(document).find(row => row.classList.contains('active'));
    assert.ok(active, 'the step stays selected after a redraw');
    assert.match(active.textContent, /s20/);
  });

  await t.test('clicking a step deep in the v2 timeline keeps the list scrolled to it', () => {
    const box = v2RowBox(document);
    assert.ok(box, 'v2 timeline renders');
    box.scrollTop = 600;
    const rows = box.children.filter(node => node.classList.contains('v2-row'));
    assert.ok(rows.length > 10, `v2 rows: ${rows.length}`);
    rows[14].click();

    const after = v2RowBox(document);
    assert.equal(after.scrollTop, 600, 'the list kept its scroll position');
    const selected = after.children.find(node => node.classList.contains('selected'));
    assert.ok(selected, 'the clicked step stays selected');
    assert.match(selected.textContent, /s14/, 'the selected step is the clicked one');
  });

  await t.test('the live replay dialog asks for the saved workflow, never a revision', () => {
    const header = document.getElementById('v2-editor').querySelector('.v2-header');
    const button = header.children.find(node => node.textContent === '实时回放');
    assert.ok(button, 'live replay button renders');
    button.click();

    const dialog = document.getElementById('dialog');
    assert.match(dialog.textContent, /将回放已保存的工作流：/);
    assert.doesNotMatch(dialog.textContent, /revision/i);
  });

  await t.test('the diff footer drops the summary sentence and keeps the difference list', () => {
    const footer = document.getElementById('v2-editor').querySelector('.v2-footer');
    assert.ok(footer, 'v2 footer renders');
    assert.doesNotMatch(footer.textContent, /与录制相比：/);
    assert.doesNotMatch(footer.textContent, /删除 s6；移动 s7 6→5/);
    const list = footer.querySelector('.v2-diff-list');
    assert.ok(list, 'the difference list still renders');
    assert.match(list.textContent, /删除步骤 s6/);
    assert.match(list.textContent, /移动步骤 s7：第 6 步 → 第 5 步/);
    assert.match(list.textContent, /移动步骤 s8：第 7 步 → 第 6 步/);
    assert.doesNotMatch(list.textContent, /、s8 7→6/, 'each difference is its own item');
  });
});
