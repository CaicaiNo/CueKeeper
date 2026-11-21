import assert from 'node:assert/strict';
import test from 'node:test';
import { createDom } from '../workbench/dom.js';
import { filterApps, moveAppFocus, pickerRows, staleAppPath } from '../workbench/model.js';
import { createAppPicker } from '../workbench/picker.js';

const catalog = [
  { bundleId: 'com.apple.Safari', name: 'Safari', paths: ['/Applications/Safari.app'], label: 'Safari' },
  { bundleId: 'com.apple.TextEdit', name: '文本编辑', paths: ['/Applications/TextEdit.app'], label: '文本编辑' },
  { bundleId: 'com.example.Notes', name: 'Notes', paths: ['/Applications/Notes.app'], label: 'Notes' },
  {
    bundleId: 'com.example.Dupe', name: 'Dupe', label: 'Dupe · 2 份',
    paths: ['/Applications/Dupe.app', '/Users/sheng/Applications/Dupe.app'],
  },
];

class ClassList {
  constructor(node) { this.node = node; }
  get values() { return new Set(this.node.className.split(/\s+/).filter(Boolean)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    const values = this.values;
    if (on) values.add(name); else values.delete(name);
    this.node.className = [...values].join(' ');
    return on;
  }
}

class Node {
  constructor(tag, document) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = document;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrolls = [];
    this.onclick = null;
    this.onkeydown = null;
    this.oninput = null;
    this.onchange = null;
    this.onerror = null;
    this.ontoggle = null;
    this.oncancel = null;
    this.classList = new ClassList(this);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue;
      if (typeof node === 'string') this.children.push({ textContent: node, parentNode: this });
      else {
        node.parentNode = this;
        this.children.push(node);
      }
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(name, listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener));
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView(options) { this.scrolls.push(options ?? {}); }
  click() { fire(this, 'click', { target: this }); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const result = [];
    const walk = node => {
      for (const child of node.children) {
        if (!child.tagName) continue;
        if (matches(child, selector)) result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
}

function matches(node, selector) {
  let rest = selector.trim();
  let checked = false;
  if (rest.endsWith(':checked')) { checked = true; rest = rest.slice(0, -8); }
  const tag = /^[a-zA-Z]+/.exec(rest)?.[0];
  if (tag) rest = rest.slice(tag.length);
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (rest.startsWith('.') && !node.classList.contains(rest.slice(1).split('.')[0])) return false;
  if (checked && !node.checked) return false;
  for (const match of rest.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
    if (node.getAttribute(match[1]) !== match[2]) return false;
  }
  return true;
}

function fire(target, type, extra = {}) {
  const event = {
    type, target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...extra,
  };
  for (let node = target; node && !event.stopped; node = node.parentNode) {
    if (typeof node[`on${type}`] === 'function') node[`on${type}`](event);
    for (const listener of node.listeners.get(type) ?? []) listener(event);
  }
  return event;
}

function text(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  return (node.textContent ?? '') + (node.children ?? []).map(text).join('');
}

const find = (root, predicate) => {
  const queue = [...root.children];
  while (queue.length) {
    const node = queue.shift();
    if (!node.tagName) continue;
    if (predicate(node)) return node;
    queue.push(...node.children);
  }
  return undefined;
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const press = (node, key, extra = {}) => fire(node, 'keydown', { key, target: node, ...extra });
const type = (node, value) => { node.value = value; fire(node, 'input', { target: node }); };

async function openPicker({ apps = catalog, sessionApps = {}, state: overrides = {}, api } = {}) {
  const document = {
    activeElement: null,
    createElement(tag) { return new Node(tag, this); },
    createElementNS(_namespace, tag) { return new Node(tag, this); },
  };
  const dialog = document.createElement('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const dom = createDom(document);
  const state = {
    session: { apps: sessionApps }, app: '', appPaths: {}, appNames: {},
    catalog: null, catalogAt: 0, catalogError: null, ...overrides,
  };
  const calls = { apps: 0, statuses: [], renders: 0 };
  const picker = createAppPicker({
    requestAnimationFrame: callback => callback(), dialog, dom, state,
    api: async route => {
      assert.equal(route, 'apps');
      calls.apps += 1;
      return api ? api(calls.apps) : { apps };
    },
    openDialog: (_title, content) => { dialog.replaceChildren(...content); dialog.showModal(); },
    status: (message, kind = '') => calls.statuses.push([message, kind]),
    render: () => { calls.renders += 1; },
    appIconNode: () => dom.el('span', { className: 'app-icon' }),
    appGlyph: () => dom.el('span', { className: 'app-glyph' }),
    appTitle: id => `${id}\n/Applications/${id}.app`,
  });
  await picker.open();
  const search = find(dialog, node => node.tagName === 'INPUT' && node.getAttribute('aria-label') === '搜索应用');
  const list = find(dialog, node => node.classList.contains('app-list'));
  return {
    document, dialog, dom, state, calls,
    search, list,
    rows: () => list.querySelectorAll('.app-row'),
    refresh: () => find(dialog, node => node.getAttribute('aria-label') === '刷新目录'),
    empty: () => list.children.find(node => node.tagName && node.classList.contains('app-empty')),
  };
}

test('app filtering matches names and bundle ids case-insensitively and caps the list', () => {
  assert.deepEqual(filterApps(catalog, 'saf').map(app => app.bundleId), ['com.apple.Safari']);
  assert.deepEqual(filterApps(catalog, 'com.apple.TEXT').map(app => app.bundleId), ['com.apple.TextEdit']);
  assert.deepEqual(filterApps(catalog, '  文本 ').map(app => app.bundleId), ['com.apple.TextEdit']);
  assert.equal(filterApps(catalog, '').length, catalog.length);
  assert.deepEqual(filterApps(catalog, 'nothing-here'), []);
  const many = Array.from({ length: 120 }, (_, index) => ({
    bundleId: `com.example.app${index}`, name: `App ${index}`, paths: [],
  }));
  assert.equal(filterApps(many, '').length, 80);
});

test('picker rows flag a stale selected path and never clear it', () => {
  const appPaths = { 'com.apple.TextEdit': '/Removed/TextEdit.app', 'com.apple.Safari': '/Applications/Safari.app' };
  const rows = pickerRows(catalog, '', { current: 'com.apple.TextEdit', appPaths });
  assert.equal(rows[0].kind, 'all');
  assert.equal(rows[0].selected, false);
  const textedit = rows.find(row => row.bundleId === 'com.apple.TextEdit');
  assert.equal(textedit.selected, true);
  assert.equal(textedit.stale, true);
  assert.equal(rows.find(row => row.bundleId === 'com.apple.Safari').stale, false);
  assert.equal(pickerRows(catalog, 'saf', {}).some(row => row.kind === 'all'), false);
  assert.equal(staleAppPath({ bundleId: 'com.apple.TextEdit', paths: ['/A.app'] }, {}), false);
});

test('moving focus wraps around the row list', () => {
  assert.equal(moveAppFocus(-1, 1, 3), 0);
  assert.equal(moveAppFocus(-1, -1, 3), 2);
  assert.equal(moveAppFocus(2, 1, 3), 0);
  assert.equal(moveAppFocus(0, -1, 3), 2);
  assert.equal(moveAppFocus(0, 0, 0), -1);
});

test('the picker auto-focuses search, moves row focus with arrows and scrolls the row into view', async () => {
  const picker = await openPicker();
  assert.equal(picker.document.activeElement, picker.search);
  assert.equal(picker.rows().length, catalog.length + 1);

  press(picker.search, 'ArrowDown');
  const first = picker.rows()[0];
  assert.equal(text(first), '全部应用不过滤应用');
  assert.equal(picker.document.activeElement, first);
  assert.deepEqual(first.scrolls, [{ block: 'nearest' }]);

  press(first, 'ArrowDown');
  assert.equal(picker.document.activeElement, picker.rows()[1]);
  press(picker.document.activeElement, 'ArrowDown');
  assert.equal(picker.document.activeElement, picker.rows()[2]);
  press(picker.document.activeElement, 'ArrowUp');
  assert.equal(picker.document.activeElement, picker.rows()[1]);
  press(picker.document.activeElement, 'ArrowUp');
  assert.equal(picker.document.activeElement, picker.rows()[0]);
  press(picker.document.activeElement, 'ArrowUp');
  assert.equal(picker.document.activeElement, picker.rows().at(-1));
});

test('Enter selects the focused row and Escape closes from search or a row', async () => {
  const picker = await openPicker();
  press(picker.search, 'ArrowDown');
  press(picker.search, 'ArrowDown');
  const safari = picker.rows().find(row => text(row).includes('com.apple.Safari'));
  assert.equal(picker.document.activeElement, safari);
  press(safari, 'Enter');
  assert.equal(picker.state.app, 'com.apple.Safari');
  assert.equal(picker.dialog.open, false);
  assert.equal(picker.calls.renders, 1);
  assert.match(picker.calls.statuses.at(-1)[0], /Safari/);

  const escapeFromSearch = await openPicker();
  press(escapeFromSearch.search, 'Escape');
  assert.equal(escapeFromSearch.dialog.open, false);

  const escapeFromRow = await openPicker();
  press(escapeFromRow.rows()[1], 'Escape');
  assert.equal(escapeFromRow.dialog.open, false);
  assert.equal(escapeFromRow.state.app, '');
});

test('Enter on the search box selects the first row, including 全部应用', async () => {
  const picker = await openPicker({ state: { app: 'com.apple.Safari' } });
  assert.equal(picker.rows()[0].getAttribute('aria-selected'), 'false');
  press(picker.search, 'Enter');
  assert.equal(picker.state.app, '');
  assert.equal(picker.dialog.open, false);
  assert.match(picker.calls.statuses.at(-1)[0], /已显示全部应用/);
});

test('an unmatched search shows an empty state that keeps focus and still closes on Escape', async () => {
  const picker = await openPicker();
  type(picker.search, 'zzz');
  assert.equal(picker.rows().length, 0);
  assert.match(text(picker.empty()), /没有匹配的应用/);
  assert.equal(picker.document.activeElement, picker.search);
  press(picker.search, 'Escape');
  assert.equal(picker.dialog.open, false);

  const cleared = await openPicker();
  type(cleared.search, 'zzz');
  const clear = find(cleared.empty(), node => node.tagName === 'BUTTON');
  assert.ok(clear);
  clear.click();
  assert.equal(cleared.search.value, '');
  assert.equal(cleared.rows().length, catalog.length + 1);
  assert.equal(cleared.document.activeElement, cleared.search);
});

test('an empty catalog and a failed catalog read both keep focus on search and close on Escape', async () => {
  const emptyCatalog = await openPicker({ apps: [] });
  assert.equal(emptyCatalog.rows().length, 0);
  assert.match(text(emptyCatalog.empty()), /没有读取到本机应用/);
  assert.equal(emptyCatalog.document.activeElement, emptyCatalog.search);
  press(emptyCatalog.search, 'Escape');
  assert.equal(emptyCatalog.dialog.open, false);

  const failed = await openPicker({ api: async () => { throw new Error('mdls failed'); } });
  assert.equal(failed.rows().length, 0);
  assert.match(text(failed.empty()), /应用目录读取失败/);
  assert.match(failed.calls.statuses.at(-1)[0], /mdls failed/);
  assert.equal(failed.calls.statuses.at(-1)[1], 'error');
  assert.equal(failed.document.activeElement, failed.search);
  press(failed.search, 'Escape');
  assert.equal(failed.dialog.open, false);
});

test('refreshing clears the client cache, refetches, and keeps the search term and scroll position', async () => {
  const latest = [...catalog, { bundleId: 'com.example.New', name: '新应用', paths: ['/Applications/新应用.app'], label: '新应用' }];
  const picker = await openPicker({ api: attempt => ({ apps: attempt === 1 ? catalog : latest }) });
  type(picker.search, 'dupe');
  assert.equal(picker.rows().length, 1);
  assert.equal(picker.calls.apps, 1);
  picker.list.scrollTop = 90;

  picker.refresh().click();
  await tick();
  assert.equal(picker.calls.apps, 2);
  assert.equal(picker.search.value, 'dupe');
  assert.equal(picker.list.scrollTop, 90);
  assert.equal(picker.rows().length, 1);
  assert.equal(picker.document.activeElement, picker.search);
  assert.match(picker.calls.statuses.at(-1)[0], /已刷新本机应用/);
  assert.deepEqual(picker.state.catalog.map(app => app.bundleId), latest.map(app => app.bundleId));

  type(picker.search, '');
  assert.ok(picker.rows().some(row => text(row).includes('com.example.New')));
});

test('refresh retries after a failed catalog read without closing the picker', async () => {
  const picker = await openPicker({ api: attempt => {
    if (attempt === 1) throw new Error('system_profiler exploded');
    return { apps: catalog };
  } });
  assert.match(text(picker.empty()), /应用目录读取失败/);
  picker.refresh().click();
  await tick();
  assert.equal(picker.dialog.open, true);
  assert.equal(picker.rows().length, catalog.length + 1);
  assert.equal(picker.state.catalogError, null);
});

test('a stale selected path is surfaced on its row without touching the saved selection', async () => {
  const appPaths = { 'com.apple.TextEdit': '/Removed/TextEdit.app' };
  const picker = await openPicker({ state: { app: 'com.apple.TextEdit', appPaths } });
  const row = picker.rows().find(item => text(item).includes('com.apple.TextEdit'));
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.match(text(row), /路径已失效/);
  assert.equal(picker.state.appPaths['com.apple.TextEdit'], '/Removed/TextEdit.app');
  const safari = picker.rows().find(item => text(item).includes('com.apple.Safari'));
  assert.doesNotMatch(text(safari), /路径已失效/);
});
