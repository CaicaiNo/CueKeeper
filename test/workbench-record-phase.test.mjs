import assert from 'node:assert/strict';
import test from 'node:test';

// The record bar's timer must say what is true: preparing to start, then a
// countdown, then a "preparing" gap after the countdown and before capture, and
// only then recording time. This file runs the real `record.js` on a virtual
// clock with its real polling schedule, so the stages are the ones an operator
// actually sees — the earlier version of this test fired `visibilitychange`,
// which skipped the polling path and hid a 350 ms window the page used to miss.

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.disabled = false;
    this.selected = false;
    this.value = '';
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  after(node) {
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, node);
    node.parentNode = parent;
  }

  get id() { return this.elementId ?? ''; }

  set id(value) {
    this.elementId = value;
    this.ownerDocument.byId.set(value, this);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  click() { this.listeners.get('click')?.(); }
}

class Select extends Element {
  get value() {
    return this.children.find(option => option.selected)?.value ?? '';
  }

  set value(next) {
    for (const option of this.children) option.selected = option.value === next;
  }
}

class Document {
  constructor() {
    this.byId = new Map();
    this.hidden = false;
    this.listeners = new Map();
    this.topbar = new Element('header', this);
    this.topbar.className = 'topbar';
    const name = new Element('span', this);
    name.id = 'session-name';
    this.topbar.append(name);
  }

  createElement(tag) {
    return tag === 'select' ? new Select(tag, this) : new Element(tag, this);
  }

  getElementById(id) { return this.byId.get(id) ?? null; }
  querySelector(selector) { return selector === '.topbar' ? this.topbar : null; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
}

const realSetImmediate = setImmediate;
const realSetTimeout = setTimeout;
const realSetInterval = setInterval;
const realClearTimeout = clearTimeout;
const realClearInterval = clearInterval;
const realNow = Date.now;

const epoch = 1_700_000_000_000;
const countdownEnd = epoch + 3000;
const readyAt = epoch + 3350;

test('the record bar follows its real poll schedule through every stage', async t => {
  let now = epoch;
  const timers = new Map();
  let nextTimerId = 1;
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextTimerId++;
    timers.set(id, { fn, at: now + Math.max(0, ms), every: 0 });
    return id;
  };
  globalThis.setInterval = (fn, ms = 0) => {
    const id = nextTimerId++;
    timers.set(id, { fn, at: now + Math.max(1, ms), every: Math.max(1, ms) });
    return id;
  };
  globalThis.clearTimeout = id => { timers.delete(id); };
  globalThis.clearInterval = id => { timers.delete(id); };
  Date.now = () => now;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.clearInterval = realClearInterval;
    Date.now = realNow;
  });

  // The server's answer for the virtual moment: a 300 ms start-up, a 3 s
  // countdown, 350 ms of preparing, then capture.
  const statusAt = () => {
    const elapsed = now - epoch;
    const base = { recording: true, countdownMs: 3000, flowPath: '/tmp/recording-1.flow.json', warnings: [] };
    if (elapsed < 300) return { ...base, phase: 'starting', elapsedMs: 0 };
    if (elapsed < 3000) {
      return { ...base, phase: 'countdown', countdownEndsAt: new Date(countdownEnd).toISOString(), elapsedMs: 0 };
    }
    if (elapsed < 3350) return { ...base, phase: 'preparing', elapsedMs: 0 };
    return { ...base, phase: 'recording', startedAt: new Date(readyAt).toISOString(), elapsedMs: elapsed - 3350 };
  };

  const document = new Document();
  globalThis.document = document;
  globalThis.window = { location: { reload: () => {} } };
  globalThis.fetch = async url => {
    if (url === '/api/record/status') return { ok: true, status: 200, json: async () => statusAt() };
    if (url === '/api/record/health') {
      return { ok: true, status: 200, json: async () => ({ ok: true, blocking: [], nextSteps: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const flush = async () => {
    for (let round = 0; round < 8; round++) await new Promise(resolve => realSetImmediate(resolve));
  };
  const advance = async ms => {
    const target = now + ms;
    for (let guard = 0; guard < 20_000; guard++) {
      let chosen;
      for (const entry of timers) {
        if (entry[1].at > target) continue;
        if (!chosen || entry[1].at < chosen[1].at) chosen = entry;
      }
      if (!chosen) break;
      const [id, timer] = chosen;
      now = Math.max(now, timer.at);
      if (timer.every) timer.at = now + timer.every;
      else timers.delete(id);
      timer.fn();
      await flush();
    }
    now = target;
    await flush();
  };

  await import('../workbench/record.js');
  await flush();
  const timer = document.getElementById('record-timer');
  const stopButton = document.getElementById('record-stop');

  // Before the CLI reports its countdown the page says it is starting up; no
  // digits run here, so a slow preflight cannot count down twice.
  await advance(250);
  assert.equal(timer.textContent, '准备启动…');

  // The CLI's countdown arrives and the digits follow its own end.
  await advance(300);
  assert.equal(timer.textContent, '3 秒后开始录制');

  await advance(1900);
  assert.equal(timer.textContent, '1 秒后开始录制');

  // The regression the review found: 5 ms after the countdown ends the page must
  // already be in the preparing stage, not stuck on a countdown digit.
  await advance(555);
  assert.equal(timer.textContent, '准备中…');

  // ... and 150 ms later — inside the 350 ms window — it is still preparing
  // and the stop button is still usable.
  await advance(150);
  assert.equal(timer.textContent, '准备中…');
  assert.equal(stopButton.hidden, false);
  assert.equal(stopButton.disabled, false);

  // Then the capture clock starts from the ready moment.
  await advance(300);
  assert.equal(timer.textContent, '录制中 00:00');
  await advance(2600);
  assert.equal(timer.textContent, '录制中 00:02');
});
