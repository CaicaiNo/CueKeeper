import { createDom } from './dom.js';

const { el, button, muted, empty } = createDom(document);

const TONES = { passed: 'success', failed: 'error', blocked: 'warning', error: 'error', interrupted: 'error' };
const LABELS = {
  passed: '通过', failed: '失败', blocked: '阻塞', error: '错误', interrupted: '已中断', pending: '待运行',
};
const CATEGORY_LABELS = {
  assertion: '断言未通过', locator: '定位不到', focus: '焦点被抢', permission: '权限不足',
  timeout: '超时', identity: '应用身份异常', driver: '驱动失败', artifact: '产物写入失败',
  shell: '脚本失败', unknown: '其他错误',
};

const categoryLabel = failure => failure ? CATEGORY_LABELS[failure.category] ?? failure.category : '';

const PROPERTY_LABELS = {
  text: '文本', value: '值', title: '标题', exists: '存在', visible: '可见',
  screenshot: '截图', exitCode: '退出码',
};

/** Expected/actual arrive as whatever the report wrote: strings, objects or numbers. */
function printable(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value;
    // Assertion expectations read as product words instead of raw schema JSON.
    if (typeof record.property === 'string') {
      const label = PROPERTY_LABELS[record.property] ?? record.property;
      if (record.equals !== undefined) return `${label} = ${printable(record.equals)}`;
      if (record.contains !== undefined) return `${label} 包含 ${printable(record.contains)}`;
      if (record.matches !== undefined) return `${label} 匹配 ${printable(record.matches)}`;
      return label;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const badge = status => el('span', {
  className: `run-status badge badge-soft badge-sm badge-${TONES[status] ?? 'ghost'} ${status}`,
}, LABELS[status] ?? status);

const dot = status => el('span', { className: `queue-dot ${status ?? 'pending'}` });

function clock(at) {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} s`;
}

function span(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * The batch page: a queue of saved test items, a serial run over them and one
 * row per workflow with its latest result. It renders from `/api/batch/state`
 * so a reload keeps watching the run the server owns.
 */
export function createBatchView({ api, status, dialog, setMode, appLabel = app => app }) {
  const $ = id => document.getElementById(id);
  const state = { active: false, snapshot: null, timer: null, key: '', selected: null, picks: new Map(), busy: false };

  const appText = value => value
    ? value.split(' / ').map(app => appLabel(app) ?? app).join(' / ')
    : '未知应用';
  const roundsOf = () => (state.snapshot?.config?.rounds ?? Number($('batch-rounds').value)) || 0;

  const pickOf = path => {
    if (!state.picks.has(path)) state.picks.set(path, true);
    return state.picks.get(path);
  };

  async function refresh() {
    try {
      const snapshot = await api('batch/state');
      const key = JSON.stringify({ ...snapshot, items: snapshot.items.map(item => ({ ...item, selected: undefined })) });
      state.snapshot = snapshot;
      for (const item of snapshot.items) if (!state.picks.has(item.path)) state.picks.set(item.path, item.selected);
      if (!snapshot.items.some(item => item.path === state.selected)) {
        state.selected = snapshot.items.find(item => item.last && item.last.status !== 'passed')?.path ??
          snapshot.items[0]?.path;
      }
      if (key !== state.key) {
        state.key = key;
        render();
      }
    } catch (error) {
      state.snapshot = null;
      render(error.message);
    }
  }

  function tick() {
    if (!state.active) return;
    void refresh().finally(() => {
      if (state.active) state.timer = setTimeout(tick, state.snapshot?.running ? 800 : 2500);
    });
  }

  function enter() {
    if (state.active) return;
    state.active = true;
    state.key = '';
    void refresh().finally(() => {
      if (state.active) state.timer = setTimeout(tick, state.snapshot?.running ? 800 : 2500);
    });
    $('batch-start').onclick = start;
    $('batch-stop').onclick = stop;
    $('batch-export').onclick = exportSummary;
    $('batch-open-summary').onclick = openSummary;
    $('batch-select-all').onchange = event => {
      for (const item of state.snapshot?.items ?? []) {
        if (!item.checkpoint) state.picks.set(item.path, event.target.checked);
      }
      render();
    };
    $('batch-add').onclick = () => setMode('edit');
    $('batch-rounds').oninput = () => render();
  }

  function leave() {
    state.active = false;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function selectedPaths() {
    return (state.snapshot?.items ?? []).filter(item => pickOf(item.path) && !item.checkpoint).map(item => item.path);
  }

  async function start() {
    if (state.busy) return;
    const items = selectedPaths();
    if (!items.length) {
      status('先勾选至少一个工作流', 'error');
      return;
    }
    const rounds = Number($('batch-rounds').value);
    const intervalMs = Number($('batch-interval').value) * 1000;
    const stopTime = $('batch-stop-at').value;
    let stopAt;
    if (stopTime) {
      const [hours, minutes] = stopTime.split(':').map(Number);
      const when = new Date();
      when.setHours(hours, minutes, 0, 0);
      if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
      stopAt = when.getTime();
    }
    state.busy = true;
    render();
    try {
      state.snapshot = await api('batch/start', {
        items, rounds, intervalMs, stopAt,
        continueOnFailure: $('batch-failure').value === 'continue',
      });
      state.key = '';
      status(`批次已开始 · ${items.length} 个工作流 × ${rounds} 轮`, '');
      render();
    } catch (error) {
      status(error.message, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function stop() {
    try {
      await api('batch/stop');
      status('正在停止批次…', '');
    } catch (error) {
      status(error.message, 'error');
    }
  }

  function snapshotJson() {
    return JSON.stringify(state.snapshot, null, 2);
  }

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function exportSummary() {
    if (!state.snapshot) return;
    download(snapshotJson(), `cuekeeper-batch-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  }

  function openSummary() {
    dialog('批次汇总', [el('pre', { className: 'report-json' }, snapshotJson())]);
  }

  async function openReport(item) {
    if (!item.last?.reportPath) return;
    try {
      const report = await api('batch/report', { path: item.last.reportPath });
      dialog(`运行报告 · ${item.name} 第 ${item.last.round} 轮`, [
        el('pre', { className: 'report-json' }, JSON.stringify(report, null, 2)),
      ]);
    } catch (error) {
      status(error.message, 'error');
    }
  }

  function queueRow(item) {
    const last = item.last?.status;
    const row = el('label', {
      className: `queue-item ${state.selected === item.path ? 'active' : ''} ${item.checkpoint ? 'unsupported' : ''}`,
      title: item.checkpoint ? '含需要人工确认的步骤，不能放进无人值守批次' : item.file,
      onclick: () => { state.selected = item.path; render(); },
    },
    el('input', {
      type: 'checkbox', className: 'checkbox checkbox-sm',
      checked: pickOf(item.path), disabled: item.checkpoint || state.snapshot?.running,
      onchange: event => {
        event.stopPropagation();
        state.picks.set(item.path, event.target.checked);
        render();
      },
    }),
    el('span', { className: 'queue-copy' },
      el('strong', {}, item.name),
      el('small', {}, `${appText(item.app)} · ${item.steps} 步`)),
    el('span', { className: 'queue-rounds' }, `${item.runs.length}/${roundsOf()}`),
    dot(last));
    return row;
  }

  function tableRow(item) {
    const total = item.runs.length;
    const planned = roundsOf();
    const last = item.last;
    const failure = last?.failure;
    return el('div', {
      className: `batch-row ${state.selected === item.path ? 'active' : ''}`,
      onclick: () => { state.selected = item.path; render(); },
    },
    el('div', { className: 'batch-row-line' },
      el('input', {
        type: 'checkbox', className: 'checkbox checkbox-sm', checked: pickOf(item.path),
        disabled: item.checkpoint || state.snapshot?.running,
        'aria-label': item.name,
        onchange: event => {
          event.stopPropagation();
          state.picks.set(item.path, event.target.checked);
          render();
        },
      }),
      el('div', { className: 'batch-name' }, el('strong', {}, item.name), el('small', {}, item.file)),
      el('span', { className: 'cell-app', title: item.window }, appText(item.app)),
      el('span', { className: 'cell-num' }, planned ? `${total}/${planned}` : String(total)),
      el('span', { className: 'status-stack' }, badge(last?.status ?? 'pending')),
      el('span', { className: 'cell-time' }, last ? duration(last.durationMs) : '—'),
      el('span', {
        className: `cell-fail ${failure ? 'bad' : ''}`,
        title: failure?.message ?? undefined,
      }, failure
        ? `${categoryLabel(failure)} · ${failure.stepId ?? failure.code ?? '—'}`
        : (last?.status === 'passed' ? '—' : '')),
      el('span', { className: 'cell-report' },
        button('详情', () => { state.selected = item.path; render(); }, {
          style: 'small', disabled: !last?.reportPath, title: '打开这一轮的报告',
        }))));
  }

  function detail() {
    const item = state.snapshot?.items.find(entry => entry.path === state.selected);
    if (!item) return empty('点一行工作流，查看它最近一轮的结果。');
    const last = item.last;
    if (!last) {
      return [
        el('div', { className: 'inspector-head' },
          el('h3', {}, item.name, badge('pending')),
          el('span', { className: 'step-id' }, `${appText(item.app)} · ${item.steps} 步`),
          el('dl', { className: 'meta-grid' },
            el('dt', {}, '文件'), el('dd', {}, item.file),
            el('dt', {}, '轮次'), el('dd', {}, `0 / ${roundsOf()}`))),
        el('p', { className: 'hint' }, '还没有执行记录。勾选后点击「开始批次」。'),
      ];
    }
    const steps = last.entries.map((entry, index) => el('div', {
      className: `step ${entry.status === 'failed' ? 'failed' : entry.status === 'skipped' ? 'skipped' : ''}`,
    },
    el('span', { className: 'idx' }, String(index + 1).padStart(2, '0')),
    el('div', { className: 'step-copy' },
      el('strong', {}, entry.id),
      el('span', { className: 'step-id' }, [entry.kind, entry.code].filter(Boolean).join(' · ') || entry.status)),
    badge(entry.status)));
    return [
      el('div', { className: 'inspector-head' },
        el('h3', {}, item.name, badge(last.status)),
        el('span', { className: 'step-id' }, `第 ${last.round} 轮 · ${clock(last.startedAt)} 开始`),
        el('dl', { className: 'meta-grid' },
          el('dt', {}, '应用'), el('dd', {}, appText(item.app)),
          el('dt', {}, '耗时'), el('dd', {}, `${duration(last.durationMs)} · ${last.entries.length} 步`))),
      last.status === 'passed' ? undefined : el('div', { className: 'failure' },
        el('strong', {}, [categoryLabel(last.failure), last.failure?.code, last.failure?.stepId]
          .filter(Boolean).join(' · ') || '未通过'),
        el('p', {}, last.failure?.message ?? '这一步没有通过，后面的步骤按规则处理。'),
        last.failure?.expected === undefined && last.failure?.actual === undefined
          ? undefined
          : el('dl', { className: 'failure-facts' },
            last.failure?.expected === undefined ? undefined : el('dt', {}, '期望'),
            last.failure?.expected === undefined ? undefined : el('dd', {}, printable(last.failure.expected)),
            last.failure?.actual === undefined ? undefined : el('dt', {}, '实际'),
            last.failure?.actual === undefined ? undefined : el('dd', {}, printable(last.failure.actual))),
        last.failure?.screenshots ? el('p', { className: 'muted' }, '报告内含截图证据，可在「打开报告」里查看。') : undefined),
      el('div', { className: 'step-list' }, ...steps),
      el('div', { className: 'inspector-actions' },
        button('打开报告', () => void openReport(item), { style: 'btn-soft', disabled: !last.reportPath }),
        button('复制复现命令', () => void copyCommand(item), { style: 'btn-soft', title: item.reproduce }),
        button('只重跑这一轮', () => void rerun(item), { style: 'btn-soft', disabled: state.snapshot?.running })),
    ];
  }

  async function copyCommand(item) {
    try {
      await navigator.clipboard.writeText(item.reproduce);
      status('已复制复现命令', 'success');
    } catch {
      status(`复制失败，命令：${item.reproduce}`, 'error');
    }
  }

  async function rerun(item) {
    if (state.busy || state.snapshot?.running) return;
    state.busy = true;
    try {
      state.snapshot = await api('batch/start', {
        items: [item.path], rounds: 1, intervalMs: 0, continueOnFailure: true,
      });
      state.key = '';
      state.picks.set(item.path, true);
      status(`已重跑 ${item.name}`, '');
    } catch (error) {
      status(error.message, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  function counts() {
    const snapshot = state.snapshot;
    const items = snapshot?.items ?? [];
    const selected = items.filter(item => pickOf(item.path) && !item.checkpoint);
    const planned = snapshot?.counts.planned ?? selected.length * roundsOf();
    const done = snapshot?.counts.completed ?? 0;
    const percent = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;
    return { selected, planned, done, percent, ...(snapshot?.counts ?? {}) };
  }

  function render(error) {
    const snapshot = state.snapshot;
    const config = snapshot?.config;
    if (config) {
      // The running batch owns these values; show what it actually does.
      if (document.activeElement !== $('batch-rounds')) $('batch-rounds').value = String(config.rounds);
      if (document.activeElement !== $('batch-interval')) $('batch-interval').value = String(config.intervalMs / 1000);
      $('batch-failure').value = config.continueOnFailure ? 'continue' : 'stop';
    }
    const { selected, planned, done, percent } = counts();
    $('batch-start').disabled = state.busy || snapshot?.running === true || !selected.length;
    $('batch-stop').disabled = !snapshot?.running;
    $('batch-open-summary').disabled = !snapshot?.summaryPath || snapshot.running;
    $('batch-export').disabled = !snapshot;
    $('batch-select-all').checked = selected.length > 0 &&
      selected.length === (snapshot?.items ?? []).filter(item => !item.checkpoint).length;
    $('batch-count').textContent = planned ? `${done} / ${planned} 次` : '';
    $('batch-progress-bar').style.width = `${percent}%`;
    const elapsed = snapshot?.startedAt
      ? ((snapshot.finishedAt ?? Date.now()) - snapshot.startedAt) : 0;
    $('batch-progress-text').textContent = !snapshot || !planned || !snapshot.startedAt
      ? '尚未开始'
      : snapshot.running
        ? `已用 ${span(elapsed)} · 预计剩余 ${done ? span((elapsed / done) * (planned - done)) : '计算中'}`
        : `已用 ${span(elapsed)} · ${snapshot.stopReason === 'time' ? '到点停止'
          : snapshot.stopReason === 'operator' ? '手动停止'
            : snapshot.stopReason === 'failure' ? '失败后停止' : '已完成'}`;

    const first = snapshot?.firstFailure;
    const banner = $('batch-first-failure');
    banner.hidden = !first;
    if (first) {
      banner.replaceChildren(
        el('strong', {}, '首个失败'),
        el('span', {}, `${first.item} · 第 ${first.round} 轮`),
        el('span', { className: 'mono' },
          [categoryLabel(first.failure), first.failure.stepId, first.failure.code].filter(Boolean).join(' · ')),
        el('span', { className: 'muted' }, first.failure.message ?? ''),
      );
      banner.onclick = () => { state.selected = first.path; render(); };
    } else {
      banner.onclick = undefined;
      banner.replaceChildren();
    }

    $('batch-queue').replaceChildren(...(
      snapshot?.items.length
        ? snapshot.items.map(queueRow)
        : [muted('当前运行目录还没有保存的测试项。在「编辑流程」里保存后再回来。')]
    ));

    $('batch-rows').replaceChildren(...(
      error ? [el('p', { className: 'form-error alert alert-soft alert-error' }, error)]
        : snapshot?.items.length
          ? snapshot.items.map(tableRow)
          : [empty('队列是空的。先在「编辑流程」里保存测试项，批量运行只排队已保存的文件。')]
    ));

    const detailNode = $('batch-detail');
    const content = detail();
    detailNode.replaceChildren(...(Array.isArray(content) ? content.filter(Boolean) : [content]));

    const log = snapshot?.log ?? [];
    const body = $('batch-log-body');
    if (!log.length) {
      body.replaceChildren(el('span', { className: 'muted' }, '还没有执行记录。'));
    } else {
      const fragment = document.createDocumentFragment();
      for (const entry of log) {
        const tone = entry.status === 'passed' ? 'ok'
          : entry.status === 'blocked' ? 'warn' : 'bad';
        fragment.append(
          el('span', { className: 't' }, clock(entry.at)),
          el('span', { className: 'flow' }, `${entry.name} · 第 ${entry.round} 轮`),
          el('span', { className: tone }, LABELS[entry.status] ?? entry.status),
          `  ${entry.failure
            ? [categoryLabel(entry.failure), entry.failure.stepId, entry.failure.code].filter(Boolean).join(' · ')
            : ''} ${duration(entry.durationMs)}\n`,
        );
      }
      body.replaceChildren(fragment);
      body.scrollTop = body.scrollHeight;
    }

    $('batch-log-counts').replaceChildren(...(
      snapshot && snapshot.counts.total
        ? [
          el('span', { className: 'badge badge-soft badge-sm badge-success' }, `通过 ${snapshot.counts.passed}`),
          el('span', { className: 'badge badge-soft badge-sm badge-error' }, `失败 ${snapshot.counts.failed}`),
          el('span', { className: 'badge badge-soft badge-sm badge-warning' }, `阻塞 ${snapshot.counts.blocked}`),
          snapshot.counts.error
            ? el('span', { className: 'badge badge-soft badge-sm badge-error' }, `错误 ${snapshot.counts.error}`)
            : undefined,
        ].filter(Boolean)
        : []
    ));
  }

  return { enter, leave };
}
