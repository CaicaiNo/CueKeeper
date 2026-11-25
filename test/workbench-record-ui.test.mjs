import assert from 'node:assert/strict';
import test from 'node:test';

// A tiny DOM stand-in: `record.js` only builds elements, keeps a few flags and
// listens for clicks. Running the real module against it proves the buttons
// call the recording API and that failures land on the page, not in an alert.

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
}

function json(status, body) {
  return { ok: status < 400, status, json: async () => body };
}

test('the record controls start the recorder, surface errors, and reload after the import', async () => {
  const document = new Document();
  const calls = [];
  const reloads = [];
  let mode = 'busy';
  let stopMode = 'imported';
  let healthMode = 'ok';
  globalThis.document = document;
  globalThis.window = { location: { reload: () => reloads.push(true) } };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/record/status') {
      return json(200, { recording: false, elapsedMs: 0, warnings: [] });
    }
    if (url === '/api/record/health') {
      if (healthMode === 'ok') return json(200, { ok: true, blocking: [], nextSteps: [] });
      return json(200, {
        ok: false,
        blocking: [{ id: 'recorder', label: 'recorder', status: 'fail', detail: 'missing: /Users/test/dist/cuekeeper-capture' }],
        nextSteps: ['Rebuild the recorder with `npm run build:recorder`, or reinstall the release archive.'],
      });
    }
    if (url === '/api/record/start') {
      if (mode === 'busy') return json(400, { error: 'A recording is already in progress' });
      if (mode === 'workdir') {
        return json(200, {
          recording: false, elapsedMs: 0, warnings: [],
          error: {
            code: 'WORKDIR_UNAVAILABLE',
            message: '无法为录制或回放准备临时工作目录，任务没有开始。' +
              '已尝试：/Users/test/.cuekeeper/tmp（EACCES: permission denied）；/tmp（EROFS: read-only）。' +
              '请确认该目录存在且可写，或用 CUEKEEPER_WORKDIR 指定一个可写目录后重试。',
          },
        });
      }
      return json(200, {
        recording: true, flowPath: '/Users/test/.cuekeeper/recordings/recording-1.flow.json',
        startedAt: new Date().toISOString(), elapsedMs: 0, countdownMs: 3000, warnings: [],
      });
    }
    if (url === '/api/record/stop') {
      if (stopMode === 'electron') {
        return json(200, {
          recording: false, exitCode: 1, partial: true, steps: 2, warnings: [],
          flowPath: '/Users/test/.cuekeeper/recordings/recording-2.flow.json',
          error: {
            code: 'ELECTRON_ACCESSIBILITY_REQUIRED',
            message: 'VS Code 的无障碍编辑器没有开启，录制已停止。\n请用 --force-renderer-accessibility 重启 VS Code',
          },
        });
      }
      return json(200, {
        recording: false, exitCode: 130, partial: true, steps: 2, warnings: [],
        flowPath: '/Users/test/.cuekeeper/recordings/recording-1.flow.json',
        session: { id: 'session-1', timeline: [{ id: 's1' }, { id: 's2' }] },
      });
    }
    return json(404, { error: 'not found' });
  };

  await import('../workbench/record.js');
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  await tick();

  // The controls sit in the top bar, where the operator can reach the stop
  // button while the recording owns the desktop.
  const bar = document.getElementById('record-bar');
  assert.ok(bar);
  assert.equal(bar.parentNode, document.topbar);
  const startButton = document.getElementById('record-start');
  const stopButton = document.getElementById('record-stop');
  const timer = document.getElementById('record-timer');
  const message = document.getElementById('record-message');
  assert.equal(startButton.textContent, '开始录制');
  assert.equal(stopButton.hidden, true);
  assert.equal(timer.textContent, '未录制');
  assert.equal(calls[0].url, '/api/record/status');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['x-cuekeeper-workbench'], '1');

  // A missing recorder turns the start button off, names the fix on the page,
  // and offers a recheck that restores the button without a reload.
  const recheckButton = document.getElementById('record-recheck');
  assert.equal(startButton.disabled, false);
  healthMode = 'blocked';
  recheckButton.click();
  await tick();
  assert.equal(startButton.disabled, true);
  assert.equal(recheckButton.hidden, false);
  assert.match(message.textContent, /录制不可用（recorder：missing/);
  assert.match(message.textContent, /build:recorder/);
  healthMode = 'ok';
  recheckButton.click();
  await tick();
  assert.equal(startButton.disabled, false);
  assert.equal(recheckButton.hidden, true);

  // A refused start is shown in the page, never as a dialog.
  await startButton.click();
  await tick();
  assert.equal(message.textContent, 'A recording is already in progress');
  assert.match(message.className, /error/);
  assert.equal(startButton.disabled, false);
  assert.equal(stopButton.hidden, true);

  // A successful start hides the start button and counts down on the page.
  mode = 'start';
  await startButton.click();
  await tick();
  const startCall = calls.filter(call => call.url === '/api/record/start').at(-1);
  assert.deepEqual(JSON.parse(startCall.init.body), { mode: 'global', countdown: 3 });
  assert.equal(startButton.disabled, true);
  assert.equal(stopButton.hidden, false);
  assert.equal(timer.textContent, '3 秒后开始录制');
  assert.match(message.textContent, /recording-1\.flow\.json$/);

  // Stopping imports the flow and asks the page to reload onto the timeline.
  await stopButton.click();
  await tick();
  assert.equal(message.textContent, '录制已导入时间线（2 步），正在刷新…');
  assert.equal(stopButton.hidden, true);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(reloads, [true]);
  assert.equal(stopButton.hidden, true);

  // An inaccessible Electron editor stops the recording: the page names the
  // code, the recovery hint, and the partially saved flow.
  stopMode = 'electron';
  await startButton.click();
  await tick();
  await stopButton.click();
  await tick();
  assert.match(message.textContent, /ELECTRON_ACCESSIBILITY_REQUIRED：/);
  assert.match(message.textContent, /force-renderer-accessibility/);
  assert.match(message.textContent,
    /部分录制：\/Users\/test\/\.cuekeeper\/recordings\/recording-2\.flow\.json/);
  assert.match(message.className, /error/);
  assert.equal(stopButton.hidden, true);

  // A recorder that cannot start answers with that reason: the page names the
  // failed step, the paths it tried, and how to fix it.
  mode = 'workdir';
  await startButton.click();
  await tick();
  assert.match(message.textContent, /^WORKDIR_UNAVAILABLE：/);
  assert.match(message.textContent, /无法为录制或回放准备临时工作目录/);
  assert.match(message.textContent, /\/Users\/test\/\.cuekeeper\/tmp/);
  assert.match(message.textContent, /CUEKEEPER_WORKDIR/);
  assert.match(message.className, /error/);
  assert.equal(startButton.disabled, false);
  assert.equal(stopButton.hidden, true);
});
