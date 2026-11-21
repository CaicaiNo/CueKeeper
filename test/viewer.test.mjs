import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Keep the native identity helper out of stubbed runs: a locally built helper
// must not inspect or launch real applications during the test suite.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';
import { unzipSync, strFromU8 } from 'fflate';
import { offlineDesktop } from '../dist/desktop.js';
import { parseFlow } from '../dist/flow.js';
import { packReport } from '../dist/report.js';
import { runFlow } from '../dist/run.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const fixture = example('textedit.snapshot');
const base = example('textedit.flow');

class ClassList {
  constructor(element, value = '') {
    this.element = element;
    this.values = new Set(value.split(/\s+/).filter(Boolean));
  }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : Boolean(force);
    if (on) this.values.add(name); else this.values.delete(name);
    this.element.attributes.class = [...this.values].join(' ');
    return on;
  }
}

class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.hidden = Object.hasOwn(attributes, 'hidden');
    delete this.attributes.hidden;
    this.open = Object.hasOwn(attributes, 'open');
    delete this.attributes.open;
    this.listeners = new Map();
    this.children = [];
    this.classList = new ClassList(this, attributes.class ?? '');
    this.text = '';
    this.textNode = { textContent: '' };
  }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener({ target: this, preventDefault() {}, ...event });
  }
  querySelector(selector) {
    if (selector === '[data-select]') return this.button ?? null;
    return null;
  }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
  get textContent() { return this.text; }
  set textContent(value) {
    this.text = String(value);
    this.textNode.textContent = this.text;
  }
  get lastChild() { return this.textNode; }
}

function buildDocument(html) {
  const entries = [];
  const documents = [];
  const buttons = [];
  for (const match of html.matchAll(/<li class="([^"]*)" data-step="([^"]*)" data-status="([^"]*)" data-kind="([^"]*)">/g)) {
    const element = new Element('li', {
      class: match[1], 'data-step': match[2], 'data-status': match[3], 'data-kind': match[4],
    });
    const button = new Element('button', { 'data-select': match[2], 'aria-current': match[1].includes('selected') ? 'true' : 'false' });
    element.button = button;
    buttons.push(button);
    entries.push(element);
  }
  for (const match of html.matchAll(/<article class="detail-step" data-detail="([^"]*)" data-index="([^"]*)"( hidden)?>/g)) {
    documents.push(new Element('article', {
      'data-detail': match[1], 'data-index': match[2], ...(match[3] ? { hidden: '' } : {}),
    }));
  }
  const details = [...html.matchAll(/<details class="panel" data-restore-key="([^"]*)"( open)?>/g)]
    .map(match => new Element('details', {
      'data-restore-key': match[1], ...(match[2] ? { open: '' } : {}),
    }));
  const bodyMatch = /<body class="([^"]*)" data-report-key="([^"]*)" data-stream="([^"]*)" data-last-step="([^"]*)">/.exec(html);
  assert.ok(bodyMatch, 'body attributes');
  const system = {
    body: new Element('body', { class: bodyMatch[1], 'data-report-key': bodyMatch[2], 'data-stream': bodyMatch[3] }),
    failedOnly: new Element('button', { 'aria-pressed': 'false' }),
    assertFailedOnly: new Element('button', { 'aria-pressed': 'false' }),
    streamToggle: new Element('button', { 'aria-pressed': bodyMatch[3] === 'disconnected' ? 'true' : 'false' }),
    banner: new Element('div', bodyMatch[3] === 'disconnected' ? {} : { hidden: '' }),
    bannerExit: new Element('button'),
    connState: new Element('span'),
    restore: new Element('div', { hidden: '' }),
    restoreAt: new Element('span'),
    clearRestore: new Element('button'),
    railEmpty: new Element('p', { hidden: '' }),
    detail: new Element('section'),
  };
  const ids = {
    failedOnly: 'failedOnly', streamToggle: 'streamToggle', banner: 'banner', bannerExit: 'bannerExit',
    connState: 'connState', restore: 'restore', restoreAt: 'restoreAt',
    clearRestore: 'clearRestore', railEmpty: 'railEmpty', detail: 'detail',
    assertFailedOnly: 'assertFailedOnly',
  };
  const document = {
    body: system.body,
    querySelectorAll(selector) {
      if (selector === '[data-step]') return entries;
      if (selector === '[data-detail]') return documents;
      if (selector === '[data-select]') return buttons;
      if (selector === 'details[data-restore-key]') return details;
      return [];
    },
    getElementById(id) {
      const key = Object.keys(ids).find(name => ids[name] === id);
      return key ? system[key] : null;
    },
    addEventListener() {},
  };
  return { document, entries, documents, details, system };
}

function runViewer(html, storage = new Map()) {
  const { document, entries, documents, details, system } = buildDocument(html);
  const location = { hash: '', pathname: '/index.html' };
  const window = {
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    location,
    history: {
      replaceState(_state, _title, url) {
        if (typeof url === 'string') location.hash = url.startsWith('#') ? url : '';
      },
    },
  };
  const context = vm.createContext({
    window, document, URLSearchParams, console,
    Date, Math, JSON, Object, Array, String, Boolean, Number, RegExp, Error, decodeURIComponent, encodeURIComponent,
  });
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'inline viewer script');
  vm.runInContext(script[1], context, { timeout: 2_000 });
  return { document, entries, documents, details, system, storage, window };
}

async function failingReport() {
  const flow = {
    ...base,
    id: 'viewer-test',
    steps: [{
      id: 'assert-text', kind: 'assert',
      check: { target: { kind: 'element', role: 'textfield', name: '' }, expect: { property: 'text', equals: 'Wrong value' } },
    }, ...base.steps],
  };
  const parsed = parseFlow(flow);
  return {
    flow: parsed,
    report: await runFlow(parsed, offlineDesktop(fixture, parsed.target), {
      dryRun: false, signal: new AbortController().signal,
    }),
  };
}

test('viewer selects the failed step, filters, previews disconnects, and restores its state', async () => {
  const { flow, report } = await failingReport();
  assert.equal(report.status, 'failed');
  const html = strFromU8(unzipSync(packReport(report, flow, {
    assets: [{ path: 'assert-text/step.log', bytes: Buffer.from('assert failed\n') }],
  }))['index.html']);

  const first = runViewer(html);
  const failed = first.entries.find(entry => entry.getAttribute('data-step') === 'assert-text');
  assert.ok(failed.classList.contains('selected'), 'failed step is selected on open');
  assert.equal(first.entries.find(entry => entry.getAttribute('data-step') === 'click-body').classList.contains('selected'), false);
  assert.deepEqual(first.documents.map(article => [article.getAttribute('data-detail'), article.hidden]), [
    ['assert-text', false], ['click-body', true], ['type-text', true], ['save', true],
  ]);

  // Selecting another step moves the detail panel and writes the hash.
  first.entries.find(entry => entry.getAttribute('data-step') === 'click-body').button.dispatch('click');
  assert.equal(first.window.location.hash, '#step=click-body');
  assert.equal(first.documents.find(article => article.getAttribute('data-detail') === 'click-body').hidden, false);
  assert.equal(first.documents.find(article => article.getAttribute('data-detail') === 'assert-text').hidden, true);

  // Failure filter and disconnect preview are real toggles on the shipped script.
  first.system.failedOnly.dispatch('click');
  assert.equal(first.system.body.classList.contains('only-failed'), true);
  assert.equal(first.system.failedOnly.getAttribute('aria-pressed'), 'true');
  first.entries.find(entry => entry.getAttribute('data-step') === 'assert-text').button.dispatch('click');
  first.system.streamToggle.dispatch('click');
  assert.equal(first.system.body.classList.contains('disconnected'), true);
  assert.equal(first.system.banner.hidden, false);
  assert.equal(first.system.streamToggle.textContent, '退出断流预览');
  assert.match(first.system.connState.lastChild.textContent, /已断开/);

  // A folded log panel is remembered as well.
  const log = first.details[0];
  assert.ok(log, 'step log panel exists');
  log.open = false;
  log.dispatch('toggle');

  // Reopening with the same storage restores selection, filter, disconnect, and fold state.
  const second = runViewer(html, first.storage);
  assert.equal(second.system.restore.hidden, false);
  assert.equal(second.system.body.classList.contains('only-failed'), true);
  assert.equal(second.system.body.classList.contains('disconnected'), true);
  assert.equal(second.documents.find(article => article.getAttribute('data-detail') === 'assert-text').hidden, false);
  assert.equal(second.details[0].open, false);

  // Clearing the saved view removes the record instead of immediately rewriting it.
  second.system.clearRestore.dispatch('click');
  assert.equal(second.system.restore.hidden, true);
  assert.equal(second.storage.size, 0);
});

test('the viewer summary names double clicks, right clicks and scroll direction', async () => {
  const flow = parseFlow({
    version: 1, id: 'gesture-summary', name: 'Gesture summary', target: base.target,
    steps: [
      { id: 'double', kind: 'click', target: { kind: 'element', role: 'textfield' }, count: 2 },
      { id: 'right', kind: 'click', target: { kind: 'element', role: 'textfield' }, button: 'right' },
      { id: 'wheel', kind: 'scroll', target: { kind: 'element', role: 'textfield' }, deltaX: 0, deltaY: -5 },
    ],
  });
  const report = await runFlow(flow, offlineDesktop(fixture, flow.target), {
    dryRun: true, signal: new AbortController().signal,
  });
  assert.deepEqual(report.entries.map(entry => [entry.kind, entry.status]), [
    ['click', 'resolved'], ['click', 'resolved'], ['scroll', 'resolved'],
  ]);
  const html = strFromU8(unzipSync(packReport(report, flow))['index.html']);
  assert.match(html, /双击 textfield/);
  assert.match(html, /右键 textfield/);
  assert.match(html, /滚轮 ↓ 5 行 textfield/);
});

test('assertion statistics and the failed-assertion filter work on the shipped script', async () => {
  const flow = parseFlow({
    version: 1, id: 'assert-filter', name: 'Assertion filter', target: base.target,
    steps: [
      { id: 'ok', kind: 'assert', check: { target: { kind: 'element', role: 'textfield' }, expect: { property: 'value', equals: '' } } },
      { id: 'bad', kind: 'assert', check: { target: { kind: 'element', role: 'textfield' }, expect: { property: 'value', equals: 'Saved' } } },
      { id: 'never', kind: 'assert', check: { target: { kind: 'element', role: 'textfield' }, expect: { property: 'exists', equals: true } } },
    ],
  });
  const report = await runFlow(flow, offlineDesktop(fixture, flow.target), {
    dryRun: false, signal: new AbortController().signal,
  });
  assert.deepEqual(report.entries.map(entry => entry.status), ['passed', 'failed', 'skipped']);
  const html = strFromU8(unzipSync(packReport(report, flow))['index.html']);
  assert.match(html, /断言 3 条，1 条通过/);
  assert.match(html, /跳过 1/);

  const view = runViewer(html);
  const bad = view.entries.find(entry => entry.getAttribute('data-step') === 'bad');
  assert.ok(bad.classList.contains('selected'), 'failed assertion selected on open');
  assert.equal(bad.getAttribute('data-kind'), 'assert');

  view.system.assertFailedOnly.dispatch('click');
  assert.equal(view.system.body.classList.contains('only-failed-assert'), true);
  assert.equal(view.system.assertFailedOnly.getAttribute('aria-pressed'), 'true');

  // The two filters are exclusive and the legacy filter keeps its own class.
  view.system.failedOnly.dispatch('click');
  assert.equal(view.system.body.classList.contains('only-failed'), true);
  assert.equal(view.system.body.classList.contains('only-failed-assert'), false);
  assert.equal(view.system.assertFailedOnly.getAttribute('aria-pressed'), 'false');

  // The assertion filter survives a reload.
  view.system.assertFailedOnly.dispatch('click');
  const reloaded = runViewer(html, view.storage);
  assert.equal(reloaded.system.body.classList.contains('only-failed-assert'), true);
  assert.equal(reloaded.system.assertFailedOnly.getAttribute('aria-pressed'), 'true');
});
