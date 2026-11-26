import assert from 'node:assert/strict';
import test from 'node:test';

// The record bar's timer must say what is true: a countdown, a "preparing" gap
// after the countdown and before capture, and only then recording time. Those
// three stages come from the server; this file drives `record.js` through them
// with the real module and a DOM stand-in, so the rendered text is what a
// person would read.

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
  fire(type) { this.listeners.get(type)?.(); }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('the timer shows countdown, then preparing, and only then recorded time', async () => {
  const document = new Document();
  globalThis.document = document;
  globalThis.window = { location: { reload: () => {} } };
  let current = { recording: false, elapsedMs: 0, warnings: [] };
  globalThis.fetch = async url => {
    if (url === '/api/record/status') return { ok: true, status: 200, json: async () => current };
    if (url === '/api/record/health') {
      return { ok: true, status: 200, json: async () => ({ ok: true, blocking: [], nextSteps: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  await import('../workbench/record.js');
  const timer = document.getElementById('record-timer');
  const stopButton = document.getElementById('record-stop');
  const startButton = document.getElementById('record-start');
  assert.ok(await waitFor(() => timer.textContent === '未录制'), 'the idle page must settle first');

  // Countdown: the remaining seconds come from the CLI's real end, not from a
  // spawn-time estimate (countdownMs here is deliberately far away from it).
  current = {
    recording: true, phase: 'countdown', countdownMs: 30000,
    countdownEndsAt: new Date(Date.now() + 2000).toISOString(),
    elapsedMs: 0, flowPath: '/tmp/recording-1.flow.json', warnings: [],
  };
  document.fire('visibilitychange');
  assert.ok(await waitFor(() => timer.textContent === '2 秒后开始录制'),
    `countdown timer was "${timer.textContent}"`);
  assert.equal(stopButton.hidden, false);
  assert.equal(stopButton.disabled, false);
  assert.equal(startButton.disabled, true);

  // After the countdown, before capture: an honest "preparing" state with no
  // recording clock, and the stop button still usable.
  current = {
    recording: true, phase: 'preparing', countdownMs: 30000,
    elapsedMs: 0, flowPath: '/tmp/recording-1.flow.json', warnings: [],
  };
  document.fire('visibilitychange');
  assert.ok(await waitFor(() => timer.textContent === '准备中…'),
    `preparing timer was "${timer.textContent}"`);
  assert.doesNotMatch(timer.textContent, /录制中/);
  assert.doesNotMatch(timer.textContent, /秒后开始录制/);
  assert.equal(stopButton.hidden, false);
  assert.equal(stopButton.disabled, false);

  // Capture began: the clock is the recorder's own elapsed time, and the
  // countdown length is not subtracted from it a second time.
  current = {
    recording: true, phase: 'recording', countdownMs: 30000,
    startedAt: new Date(Date.now() - 1500).toISOString(),
    elapsedMs: 0, flowPath: '/tmp/recording-1.flow.json', warnings: [],
  };
  document.fire('visibilitychange');
  assert.ok(await waitFor(() => timer.textContent === '录制中 00:01'),
    `recording timer was "${timer.textContent}"`);

  // The page's own tick keeps the clock moving from the ready moment, so a
  // throttled tab does not freeze it.
  current = {
    recording: true, phase: 'recording', countdownMs: 30000,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    elapsedMs: 0, flowPath: '/tmp/recording-1.flow.json', warnings: [],
  };
  document.fire('visibilitychange');
  assert.ok(await waitFor(() => /^录制中 00:0[45]$/.test(timer.textContent)),
    `ticking timer was "${timer.textContent}"`);

  // Leave the page idle so the module's polling timers stop with the test.
  current = { recording: false, elapsedMs: 0, steps: 2, warnings: [] };
  document.fire('visibilitychange');
  assert.ok(await waitFor(() => timer.textContent === '已保存 2 步'),
    `finished timer was "${timer.textContent}"`);
});
