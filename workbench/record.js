/**
 * Global recording controls for the workbench. The page never records by
 * itself: it drives `/api/record/*`, which owns the one `record --global` child
 * and imports the flow it writes. Keeping this in its own module leaves the
 * timeline code untouched.
 */
const COUNTDOWN_CHOICES = [0, 3, 5, 10];
const POLL_MS = 1000;
const TICK_MS = 250;
/**
 * The CLI's own preflight runs before its countdown, so the first stage can last
 * a while; reading it every second would still catch a countdown start promptly.
 */
const STARTING_POLL_MS = 400;
/**
 * Between the countdown and the first captured event the recorder only needs to
 * open its taps, so "preparing" can be shorter than one poll interval. It is
 * read this often while it lasts, or the page would jump from a countdown
 * straight to recording time.
 */
const PREPARING_POLL_MS = 200;
const requestHeader = 'x-cuekeeper-workbench';

const bar = document.createElement('div');
bar.className = 'record-bar';
bar.id = 'record-bar';

const countdown = document.createElement('select');
countdown.id = 'record-countdown';
countdown.className = 'select select-sm record-countdown';
countdown.setAttribute('aria-label', '开始前倒计时');
for (const seconds of COUNTDOWN_CHOICES) {
  const option = document.createElement('option');
  option.value = String(seconds);
  option.textContent = seconds === 0 ? '立即录制' : `倒数 ${seconds} 秒`;
  if (seconds === 3) option.selected = true;
  countdown.append(option);
}

const startButton = document.createElement('button');
startButton.type = 'button';
startButton.id = 'record-start';
startButton.className = 'btn btn-primary btn-sm';
startButton.textContent = '开始录制';

const stopButton = document.createElement('button');
stopButton.type = 'button';
stopButton.id = 'record-stop';
stopButton.className = 'btn btn-error btn-sm';
stopButton.textContent = '停止录制';
stopButton.hidden = true;

const recheckButton = document.createElement('button');
recheckButton.type = 'button';
recheckButton.id = 'record-recheck';
recheckButton.className = 'btn btn-sm';
recheckButton.textContent = '重新检查';
recheckButton.title = '重新检查录制器、权限与 agent-desktop';
recheckButton.hidden = true;

const timer = document.createElement('span');
timer.id = 'record-timer';
timer.className = 'record-timer';
timer.setAttribute('role', 'timer');

const message = document.createElement('span');
message.id = 'record-message';
message.className = 'record-message';
message.setAttribute('role', 'status');
message.setAttribute('aria-live', 'polite');

bar.append(countdown, startButton, stopButton, recheckButton, timer, message);
const anchor = document.getElementById('session-name');
if (anchor) anchor.after(bar);
else document.querySelector('.topbar')?.append(bar);

const state = {
  recording: false, busy: false, elapsedMs: 0, countdownMs: 0, path: '', steps: undefined,
  // Where the running recording is: countdown, preparing (started but not
  // capturing yet), or recording. Absent on a finished recording.
  phase: undefined, countdownEndsAt: undefined,
  stopFailed: false,
  // The last `GET /api/record/health`: undefined until the first probe answers.
  health: undefined,
  // Epoch ms capture really began, so the timer survives a throttled tab. It
  // is the recorder's ready moment, not the moment its process started.
  startedAt: undefined,
};
let healthShown = false;
let pollTimer;
let tickId;

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renderTimer() {
  if (!state.recording) {
    timer.textContent = state.steps === undefined ? '未录制' : `已保存 ${state.steps} 步`;
    return;
  }
  if (state.phase === 'starting') {
    // The recorder process exists, but its preflight and input-source switch run
    // before the countdown starts. Showing digits here would count down twice.
    timer.textContent = '准备启动…';
    return;
  }
  if (state.phase === 'preparing') {
    // Started, but the recorder has not begun capturing: the countdown is over
    // and this gap is not recording time.
    timer.textContent = '准备中…';
    return;
  }
  if (state.phase === 'countdown') {
    // The end comes from the CLI, so the digits are the countdown it really runs.
    const left = state.countdownEndsAt === undefined ? 0 : state.countdownEndsAt - Date.now();
    // At the countdown's end capture has not begun yet, and the next stage is
    // exactly that wait; "0 秒后开始录制" would be a lie for however long it lasts.
    timer.textContent = left > 0 ? `${Math.ceil(left / 1000)} 秒后开始录制` : '准备中…';
    return;
  }
  if (state.phase === 'recording') {
    timer.textContent = `录制中 ${clock(state.elapsedMs)}`;
    return;
  }
  // A server that predates the phase report still counts down from the start.
  if (state.elapsedMs < state.countdownMs) {
    const left = Math.ceil((state.countdownMs - state.elapsedMs) / 1000);
    timer.textContent = `${left} 秒后开始录制`;
    return;
  }
  timer.textContent = `录制中 ${clock(state.elapsedMs - state.countdownMs)}`;
}

function render() {
  const blocked = state.health !== undefined && state.health.ok === false;
  startButton.disabled = state.recording || state.busy || blocked;
  startButton.textContent = state.busy && !state.recording ? '正在开始…' : '开始录制';
  stopButton.hidden = !state.recording;
  stopButton.disabled = state.busy;
  stopButton.textContent = state.busy && state.recording ? '正在保存…' : '停止录制';
  countdown.disabled = state.recording || state.busy;
  recheckButton.hidden = !blocked;
  recheckButton.disabled = state.busy || state.recording;
  renderTimer();
}

function setMessage(text, error = false) {
  message.textContent = text;
  message.title = text;
  message.className = `record-message${error ? ' error' : ''}`;
}

/** A stop reason plus the flow prefix that was saved before the stop. */
function errorText(result) {
  const partialPath = result.partial === true ? (result.flowPath || state.path) : '';
  return `${result.error.code}：${result.error.message}` +
    (partialPath ? `（部分录制：${partialPath}）` : '');
}

/** Why the record button is off, plus the first doctor next step. */
function healthText(health) {
  const first = Array.isArray(health.blocking) ? health.blocking[0] : undefined;
  const steps = Array.isArray(health.nextSteps) ? health.nextSteps : [];
  const detail = first ? `${first.label}：${first.detail}` : '录制环境未就绪';
  return `录制不可用（${detail}）${steps.length ? `。${steps[0]}` : ''}`;
}

/** Read-only probe: the recorder binary, its permissions, and agent-desktop. */
async function loadHealth() {
  try {
    state.health = await request('api/record/health', 'GET');
  } catch {
    // A server without the health route leaves the record button usable.
    state.health = undefined;
    render();
    return;
  }
  if (state.health.ok === false) {
    const checks = Array.isArray(state.health.blocking) ? state.health.blocking : [];
    const steps = Array.isArray(state.health.nextSteps) ? state.health.nextSteps : [];
    startButton.title = checks.map(check => `${check.label}：${check.detail}`).concat(steps).join('\n');
    setMessage(healthText(state.health), true);
    healthShown = true;
  } else {
    startButton.title = '';
    if (healthShown) {
      setMessage('');
      healthShown = false;
    }
  }
  render();
}

async function request(route, method = 'POST', body) {
  const response = await fetch(`/${route}`, {
    method,
    headers: {
      [requestHeader]: '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  if (!response.ok) throw new Error(result.error ?? `请求失败（HTTP ${response.status}）`);
  return result;
}

function adopt(status) {
  state.recording = status.recording === true;
  state.elapsedMs = Number.isFinite(status.elapsedMs) ? status.elapsedMs : 0;
  state.countdownMs = Number.isFinite(status.countdownMs) ? status.countdownMs : 0;
  state.phase = ['starting', 'countdown', 'preparing', 'recording'].includes(status.phase)
    ? status.phase : undefined;
  const countdownEndsAt = Date.parse(status.countdownEndsAt ?? '');
  state.countdownEndsAt = Number.isFinite(countdownEndsAt) ? countdownEndsAt : undefined;
  const startedAt = Date.parse(status.startedAt ?? '');
  state.startedAt = Number.isFinite(startedAt) ? startedAt : undefined;
  if (typeof status.flowPath === 'string') state.path = status.flowPath;
  if (Number.isInteger(status.steps)) state.steps = status.steps;
  if (status.recording) {
    setMessage(state.path ? `录制文件：${state.path}` : '');
    startLoops();
  } else {
    stopLoops();
  }
  render();
}

/** How soon the status has to be read again, from the stage it just reported. */
function pollDelay() {
  if (state.phase === 'preparing') return PREPARING_POLL_MS;
  if (state.phase === 'countdown' && state.countdownEndsAt !== undefined) {
    // Read the countdown's end as it lands: capture starts right after it, and
    // that window is shorter than a one-second poll would tolerate.
    return Math.min(POLL_MS, Math.max(40, state.countdownEndsAt - Date.now() + 30));
  }
  if (state.phase === 'starting') return STARTING_POLL_MS;
  return POLL_MS;
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  if (!state.recording) return;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void poll();
  }, pollDelay());
}

function startLoops() {
  if (!tickId) tickId = setInterval(tick, TICK_MS);
  schedulePoll();
}

function stopLoops() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  if (tickId) clearInterval(tickId);
  tickId = undefined;
}

function tick() {
  if (!state.recording) return;
  // Browsers throttle timers in a background tab, so a recording the operator
  // watches elsewhere would freeze at "3 秒后开始录制". Derive the elapsed time
  // from the recorder's ready moment instead of counting ticks. Before that
  // moment nothing is captured, so elapsed stays where the server put it.
  if (state.phase === 'recording' && state.startedAt !== undefined) {
    state.elapsedMs = Math.max(0, Date.now() - state.startedAt);
  } else if (state.phase === undefined) {
    state.elapsedMs = state.startedAt === undefined ?
      state.elapsedMs + TICK_MS : Math.max(0, Date.now() - state.startedAt);
  }
  renderTimer();
}

async function poll() {
  let status;
  try {
    status = await request('api/record/status', 'GET');
  } catch (error) {
    // A transient read failure must not mask a recording that is still going.
    setMessage(`无法读取录制状态：${error.message}`, true);
    schedulePoll();
    return;
  }
  const wasRecording = state.recording;
  adopt(status);
  // After the page reloads onto a partial recording, the last outcome is still
  // on the server: keep the stop reason (and the saved prefix) visible.
  if (!status.recording && !wasRecording && status.error) {
    setMessage(errorText(status), true);
  }
  if (!status.recording && wasRecording && !state.busy && !state.stopFailed) {
    // The recorder finished on its own (max duration, crash, permission stop).
    // Stopping now is what imports the flow and reports the reason.
    await finish();
  }
}

async function begin() {
  if (state.busy || state.recording) return;
  state.busy = true;
  state.stopFailed = false;
  setMessage('');
  render();
  try {
    const seconds = Number(countdown.value);
    const status = await request('api/record/start', 'POST', {
      mode: 'global', countdown: Number.isFinite(seconds) ? seconds : 3,
    });
    adopt(status);
    // A recorder that fails during start-up answers with its own fault instead
    // of a running status; that reason must reach the page, not just the log.
    if (status.error) setMessage(errorText(status), true);
  } catch (error) {
    setMessage(error.message, true);
    state.busy = false;
    render();
    return;
  }
  state.busy = false;
  render();
}

async function finish() {
  if (state.busy) return;
  state.busy = true;
  render();
  let result;
  try {
    result = await request('api/record/stop', 'POST', {});
  } catch (error) {
    setMessage(`停止录制失败：${error.message}`, true);
    state.busy = false;
    state.stopFailed = true;
    render();
    return;
  }
  state.busy = false;
  state.stopFailed = false;
  adopt(result);
  if (result.error) {
    setMessage(errorText(result), true);
  } else if (Array.isArray(result.warnings) && result.warnings.length) {
    const text = result.warnings.map(warning => `${warning.code}：${warning.message}`).join('；');
    setMessage(text, result.partial === true);
  } else if (!result.session) {
    setMessage('录制已停止，但没有生成可导入的录制文件。', true);
  }
  if (result.session) {
    const steps = Array.isArray(result.session.timeline) ? result.session.timeline.length : 0;
    setMessage(`录制已导入时间线（${steps} 步），正在刷新…`);
    stopLoops();
    setTimeout(() => window.location.reload(), 600);
    return;
  }
  render();
}

startButton.addEventListener('click', () => { void begin(); });
stopButton.addEventListener('click', () => { void finish(); });
recheckButton.addEventListener('click', () => { void loadHealth(); });
// The tab was throttled while the operator worked in another app; catch up the
// timer the moment it comes back.
document.addEventListener?.('visibilitychange', () => {
  if (!document.hidden) {
    void poll();
    renderTimer();
  }
});

render();
// A page loaded while a recording runs shows its timer instead of hiding it.
void (async () => {
  await poll();
  // After the status: a blocked recorder explains itself, but a stale outcome
  // from the last recording still owns the message while the probe is healthy.
  await loadHealth();
})();
