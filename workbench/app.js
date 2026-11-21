import { createDom } from './dom.js';
import {
  KIND_LABELS, actionKind, canUndo, changeTarget, compileDraft, confirmCondition, confirmedSetup, deleteCondition, id,
  makeBehavior, retargetCondition, sameTarget, scrollLabel, setupDraft, shellDraft, shellSummary, dragSummary,
  undoCondition, visibleRows,
} from './model.js';
import { createAppPicker } from './picker.js';

const $ = name => document.getElementById(name);
const dialog = $('dialog');
const state = {
  session: null, library: [], allowLive: false, app: '', selected: new Set(), ignored: new Set(),
  expanded: new Set(), showIgnored: false, focused: null, draft: [], tab: 'actions', saving: false,
  running: false, setup: null, appPaths: {}, catalog: null, catalogAt: 0, catalogError: null, appNames: {},
};

const dom = createDom(document);
const { el, icon, button, empty, muted, input, field, select } = dom;

const KIND_ICONS = {
  click: 'pointer', doubleClick: 'pointerDouble', tripleClick: 'pointerDouble', rightClick: 'pointerRight',
  scroll: 'wheel', drag: 'drag', type: 'text', key: 'keyboard', wait: 'clock', assert: 'checkCircle',
  behavior: 'layers', shell: 'terminal',
};

function kindChip(action) {
  const kind = typeof action === 'string' ? action : actionKind(action);
  return el('span', { className: 'kind', title: kind },
    icon(KIND_ICONS[kind] ?? 'list', 14), el('span', {}, KIND_LABELS[kind] ?? kind));
}

const duration = ms => ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
const timestamp = ms => ms === undefined ? '—' : `+${(ms / 1000).toFixed(2)} s`;
const actionTarget = action => action.target ?? action.check?.target;
const isCompatible = row => sameTarget(row, state.session.target);
const getRows = () => state.session?.timeline ?? [];
const selectedRows = () => visibleRows(getRows(), state.app, state.ignored, false).filter(row => state.selected.has(row.id));
const short = (text, length = 82) => text.length > length ? text.slice(0, length) + '…' : text;
const appInfo = id => state.session?.apps?.[id] ?? state.catalog?.find(app => app.bundleId === id);
const appIconSrc = id => {
  const info = appInfo(id);
  if (!info) return undefined;
  return info.icon ?? `/app-icon/${encodeURIComponent(id)}`;
};
const appLabel = id => appInfo(id)?.label ?? state.appNames[id] ?? id;
const appMissing = id => Boolean(id && state.catalog) && !state.catalog.some(app => app.bundleId === id) && !state.session?.apps?.[id];
const appTitle = id => {
  const info = appInfo(id);
  if (!info) return id;
  const chosen = state.appPaths[id];
  return [info.bundleId, ...(chosen ? [`已选：${chosen}`] : []), ...info.paths].join('\n');
};

function appIconNode(app, size = 18) {
  const src = appIconSrc(app);
  const fallback = () => el('span', {
    className: 'app-icon-fallback', style: `width:${size}px;height:${size}px`,
  }, icon('appWindow', Math.max(10, size - 6)));
  if (!src) return fallback();
  const img = el('img', { src, alt: '', width: size, height: size });
  img.onerror = () => img.replaceWith(fallback());
  return img;
}

function appGlyph(app, onDuplicate, size = 18) {
  const info = appInfo(app);
  const badge = info && info.paths.length > 1 ? el('button', {
    type: 'button', className: `dup-badge${state.appPaths[app] ? ' resolved' : ''}`,
    title: `${info.paths.length} 份副本，点击选择路径`,
    onclick: event => { event.stopPropagation(); onDuplicate?.(); },
  }, String(info.paths.length)) : undefined;
  return el('span', { className: 'app-glyph' }, appIconNode(app, size), badge);
}

async function openAppPicker() {
  return appPicker.open();
}

const appPicker = createAppPicker({
  requestAnimationFrame, dialog, dom, state, api, openDialog, status, render,
  appGlyph, appTitle,
});
function locatorLabel(target) {
  if (!target) return '目标窗口';
  if (target.kind === 'point') return `坐标 (${target.point.join(', ')})`;
  return [target.role, target.name, target.path?.join(' › '), target.index === undefined ? '' : `[${target.index}]`]
    .filter(Boolean).join(' · ');
}

const modifierOrder = ['ctrl', 'alt', 'shift', 'meta'];
const modifierLabels = { ctrl: 'Ctrl', alt: 'Opt', shift: 'Shift', meta: 'Cmd' };
const keyLabels = {
  space: 'Space', return: 'Return', tab: 'Tab', escape: 'Esc', delete: 'Delete',
  backspace: 'Backspace', forwarddelete: 'Forward Delete', up: '↑', down: '↓',
  left: '←', right: '→', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down',
};
const shortcutLabel = action => [
  ...modifierOrder.filter(key => (action.modifiers ?? []).includes(key)).map(key => modifierLabels[key]),
  keyLabels[action.key] ?? action.key.toUpperCase(),
].join('+');

function actionLabel(action) {
  const target = actionTarget(action);
  const label = target ? locatorLabel(target) : '';
  switch (action.kind) {
    case 'click':
      if (action.button === 'right') return `右键 · ${label}`;
      if (action.count === 2) return `双击 · ${label}`;
      if (action.count === 3) return `三击 · ${label}`;
      return label;
    case 'scroll': return `${scrollLabel(action)} · ${label}`;
    case 'drag': return `${dragSummary(action)} · ${action.durationMs} ms`;
    case 'type': return typeof action.text === 'string' ? `输入 “${short(action.text)}”` : `输入参数 ${action.text.param}`;
    case 'key': return shortcutLabel(action);
    case 'assert':
    case 'wait': return `${label} · ${action.check.expect.property} = ${short(String(action.check.expect.equals))}`;
    case 'shell': return `Shell · ${short(shellSummary(action).command)}`;
    default: return action.kind;
  }
}

function infoList(entries, className) {
  return el('dl', { className }, ...entries.map(([label, value]) => {
    const pair = [el('dt', {}, label), el('dd', {}, String(value))];
    return className === 'stats' ? el('div', {}, ...pair) : pair;
  }).flat());
}

function status(message, type = '') {
  $('status').className = `status ${type}`;
  $('status').textContent = message;
}

async function api(route, data = {}) {
  const response = await fetch(`/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cuekeeper-workbench': '1' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function setSession(session) {
  Object.assign(state, {
    session, app: '', focused: null, draft: [], tab: 'actions', showIgnored: false,
    selected: new Set(), ignored: new Set(), expanded: new Set(),
    setup: session ? setupDraft(session.setup ?? []) : null,
    appPaths: session?.target?.appPath ? { [session.target.app]: session.target.appPath } : {},
    appNames: Object.fromEntries(Object.entries(session?.apps ?? {}).map(([id, app]) => [id, app.name])),
  });
  $('show-ignored').checked = false;
  $('test-name').value = session ? `${session.name.slice(0, 248)} 测试` : '';
  render();
}

function renderSummary() {
  const { session } = state;
  $('session-name').textContent = session?.name ?? '';
  if (!session) {
    $('summary').replaceChildren(muted('尚未导入运行目录'));
    $('app-picker').disabled = true;
    $('app-picker-label').textContent = '全部应用';
    $('app-picker-icon').replaceChildren(icon('appWindow', 15));
    return;
  }
  const apps = new Map();
  const windows = new Set();
  for (const row of session.timeline) {
    apps.set(row.app, (apps.get(row.app) ?? 0) + 1);
    windows.add(JSON.stringify([row.app, row.window]));
  }
  const timing = { capture: '录制时间', replay: '回放时间', 'dry-run': '离线验证时间' }[session.timingSource];
  $('summary').replaceChildren(
    muted(short(session.directory.split('/').at(-1), 48)),
    infoList([['时长', duration(session.durationMs)], ['动作', session.timeline.length],
      ['应用', apps.size], ['窗口', windows.size]], 'stats'),
    muted(timing ?? '原始录制缺少时间数据'),
    session.startedAt ? el('time', { className: 'muted', dateTime: session.startedAt },
      session.startedAt.slice(0, 19).replace('T', ' ') + ' UTC') : undefined,
  );
  const picker = $('app-picker');
  picker.disabled = false;
  const missing = Boolean(state.app && appMissing(state.app));
  picker.classList.toggle('missing', missing);
  picker.title = missing ? '本机未找到该应用，可能已卸载' : '选择应用';
  $('app-picker-label').textContent = state.app
    ? `${appLabel(state.app)}${missing ? ' · 已卸载' : ''}`
    : '全部应用';
  $('app-picker-icon').replaceChildren(state.app ? appIconNode(state.app, 18) : icon('appWindow', 15));
}

const setupStates = {
  inferred: '待确认', confirmed: '已确认', invalid: '已失效', deleted: '已删除',
};

function conditionTitle(condition) {
  const ensure = condition.ensure;
  if (ensure?.kind === 'app_running') return '应用已启动';
  if (ensure?.kind === 'window_ready') return `窗口已就绪 · ${ensure.window}`;
  return condition.name;
}

function conditionDetail(condition) {
  const ensure = condition.ensure;
  if (ensure?.kind === 'window_ready') return `${appLabel(ensure.app)} · ${ensure.window}`;
  if (ensure?.kind === 'app_running') return appLabel(ensure.app);
  return locatorLabel(condition.check.target);
}

function conditionDialog(condition) {
  const ensure = condition.ensure;
  const app = input({ required: true, maxLength: 256, value: ensure?.app ?? state.session.target.app });
  const title = input({
    required: true, maxLength: 256,
    value: ensure?.kind === 'window_ready' ? ensure.window : condition.check.target.name ?? state.session.target.window,
  });
  openDialog('更换前置条件', [
    field('应用标识', app), field('窗口标题', title),
    muted('更换后条件回到待确认状态；确认后才会保存进测试项并参与回放。'),
  ], '更换', () => {
    const next = retargetCondition(state.setup, condition.id, { app: app.value, window: title.value });
    render();
    status(`已更换「${next.name}」，待重新确认`, 'success');
  });
}

function renderSetup() {
  const { session, setup } = state;
  const panel = $('setup');
  if (!session || !setup) {
    panel.replaceChildren(muted('导入运行目录后显示推断的前置条件。'));
    return;
  }
  const conditions = setup.conditions;
  const confirmed = confirmedSetup(conditions).length;
  const summary = muted(conditions.length
    ? `${confirmed} / ${conditions.length} 个已确认条件会随测试项保存并参与回放`
    : '没有前置条件。');
  if (!conditions.length) {
    panel.replaceChildren(summary);
    return;
  }
  panel.replaceChildren(summary, ...conditions.map(condition => {
    const deleted = condition.state === 'deleted';
    return el('article', { className: `condition${deleted ? ' removed' : ''}`, id: `condition-${condition.id}` },
      el('div', { className: 'condition-head' },
        el('span', { className: `state-chip ${condition.state}` }, setupStates[condition.state] ?? condition.state),
        el('strong', {}, conditionTitle(condition))),
      el('p', { className: 'muted' }, conditionDetail(condition)),
      el('div', { className: 'actions' },
        button('确认', () => {
          confirmCondition(setup, condition.id);
          render();
          status(`已确认「${conditionTitle(condition)}」，保存时一并写入`, 'success');
        }, { style: 'small', icon: 'check', disabled: deleted || condition.state === 'confirmed' }),
        button('更换', () => conditionDialog(condition), {
          style: 'small', icon: 'refresh', disabled: deleted,
        }),
        button('撤销', () => {
          undoCondition(setup, condition.id);
          render();
          status('已撤销前置条件的上一次修改');
        }, { style: 'small', icon: 'undo', disabled: !canUndo(setup, condition.id) }),
        button('删除', () => {
          deleteCondition(setup, condition.id);
          render();
          status(`已删除「${conditionTitle(condition)}」，可用撤销恢复`, 'success');
        }, { style: 'small danger', icon: 'trash', disabled: deleted })));
  }));
}

function renderTimeline() {
  const rows = visibleRows(getRows(), state.app, state.ignored, state.showIgnored);
  const selected = selectedRows();
  $('ignored-control').hidden = !state.session;
  $('timeline-count').textContent = state.session ? `${rows.length} 个动作` : '';
  $('selection').replaceChildren(...(selected.length ? [
    el('div', { className: 'selection-bar' },
      el('span', {}, `已选 ${selected.length} 个动作`),
      el('span', { className: 'trailing' }),
      button('合并为行为', () => mergeDialog(selected), {
        style: 'small', icon: 'layers', disabled: selected.length < 2 || selected.some(row => !isCompatible(row)), key: 'merge-selected',
      }),
      button('清除', () => { state.selected.clear(); render(); }, { style: 'small', icon: 'x' })),
  ] : []));
  if (!rows.length) {
    $('timeline').replaceChildren(empty(state.session ? '当前筛选下没有动作。' : '导入运行目录后查看录制动作。'));
    return;
  }
  $('timeline').replaceChildren(...rows.map(row => {
    const ignored = state.ignored.has(row.id);
    const selector = el('input', {
      id: `select-${row.id}`, type: 'checkbox', checked: state.selected.has(row.id), disabled: ignored,
      'aria-label': `选择 ${row.action.kind} ${row.id}`,
      onchange: event => {
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        render();
      },
    });
    const focus = el('button', {
      type: 'button', id: `inspect-${row.id}`, className: 'row-focus',
      'aria-pressed': String(state.focused === row.id),
      onclick: () => { state.focused = row.id; state.tab = 'actions'; render(); },
    },
    el('span', { className: 'time' }, timestamp(row.atMs)),
    kindChip(row.action),
    el('span', { className: 'row-description' }, el('strong', {}, actionLabel(row.action)),
      el('small', {}, `${appLabel(row.app)} · ${row.window}${ignored ? ' · 已忽略' : ''}`)),
    el('span', { className: 'time row-duration', title: '动作耗时' }, duration(row.durationMs)));
    const thumbnail = row.thumbnail && el('details', {
      className: 'thumbnail', open: state.expanded.has(row.id),
      ontoggle: event => {
        if (event.target.open) state.expanded.add(row.id);
        else state.expanded.delete(row.id);
      },
    }, el('summary', {}, '查看缩略图'), el('img', { src: row.thumbnail, alt: '动作截图', loading: 'lazy' }));
    return el('article', {
      className: `row${state.focused === row.id ? ' active' : ''}${ignored ? ' ignored' : ''}`,
    }, el('div', { className: 'row-line' }, selector, focus), thumbnail || undefined);
  }));
}

function addAction(action) {
  state.draft.push({ id: id('action'), action: structuredClone(action) });
  renderDraft();
  status(`已加入 ${action.kind}`, 'success');
}

function renderOverview() {
  const rows = getRows();
  const counts = new Map();
  for (const row of rows) {
    const kind = actionKind(row.action);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.length || 1;
  return el('div', { className: 'overview' },
    el('p', { className: 'eyebrow' }, '会话构成'),
    el('p', { className: 'overview-figure' }, el('strong', {}, String(rows.length)), el('span', {}, '个动作')),
    el('div', { className: 'composition', role: 'img', 'aria-label': ordered.map(([kind, count]) => `${KIND_LABELS[kind] ?? kind} ${count}`).join('，') },
      ...ordered.map(([kind, count], index) => el('span', {
        className: `composition-segment seg-${Math.min(index, 4)}`,
        style: `width:${(count / total * 100).toFixed(2)}%`,
        title: `${KIND_LABELS[kind] ?? kind} ${count}`,
      }))),
    el('ul', { className: 'legend' }, ...ordered.map(([kind, count], index) => el('li', {},
      el('span', { className: `legend-dot seg-${Math.min(index, 4)}` }),
      el('span', { className: 'legend-kind' }, KIND_LABELS[kind] ?? kind),
      el('span', { className: 'legend-count' }, String(count))))),
    infoList([
      ['目标', `${appLabel(state.session.target.app)} · ${state.session.target.window}`],
      ['应用路径', state.session.target.appPath ?? '未指定（按唯一运行实例）'],
      ...(state.session.pathConflict
        ? [['快照路径', `${state.session.snapshotAppPath} · 与应用路径不一致`]]
        : []),
      ['来源', short(state.session.directory.split('/').at(-1), 44)],
    ], 'meta-grid'),
    state.session.pathConflict
      ? muted('快照来自另一个应用路径，离线运行会以 APP_AMBIGUOUS / fixture_path_mismatch 阻塞。请重新采集快照或恢复与快照匹配的目标。')
      : muted('选择时间线中的动作查看定位器与整理操作。'));
}

function renderInspector() {
  for (const tab of ['actions', 'library']) $(`${tab}-tab`).setAttribute('aria-pressed', String(state.tab === tab));
  const panel = $('inspector');
  if (state.tab === 'library') {
    const items = [...state.library].sort((a, b) => a.behavior.name.localeCompare(b.behavior.name));
    panel.replaceChildren(items.length ? el('div', { className: 'stack' }, ...items.map(item => {
      const compatible = state.session && sameTarget(item.target, state.session.target);
      const { behavior, parameterTypes } = item;
      const shell = item.shell ?? { steps: 0, privileged: 0 };
      return el('article', { className: 'library-item stack' },
        el('h3', {}, behavior.name),
        muted(`${behavior.steps.length} 步 · ${item.target.app} · ${item.target.window}`),
        shell.steps ? muted(`含 ${shell.steps} 个 Shell 步骤${shell.privileged ? ` · ${shell.privileged} 个提权步骤` : ''}`) : undefined,
        behavior.parameters.length ? muted(behavior.parameters.map(param => `${param} · ${parameterTypes[param]}`).join(' / ')) : undefined,
        el('div', { className: 'actions' },
          button('引用', () => behaviorDialog(item, false), { style: 'small', icon: 'plus', disabled: !compatible }),
          button('复制到草稿', () => behaviorDialog(item, true), { style: 'small', icon: 'copy', disabled: !compatible })),
        compatible || !state.session ? undefined : muted('此行为属于另一目标窗口。'));
    })) : empty('从时间线选中多个动作，合并到行为库。'));
    return;
  }
  const row = getRows().find(action => action.id === state.focused);
  if (!row) {
    panel.replaceChildren(state.session ? renderOverview() : empty('选择时间线中的动作查看定位器与整理操作。'));
    return;
  }
  const ignored = state.ignored.has(row.id);
  const editable = !ignored && isCompatible(row);
  const target = actionTarget(row.action);
  panel.replaceChildren(el('div', { className: 'stack' },
    el('h3', {}, actionLabel(row.action)),
    infoList([
      ['动作', KIND_LABELS[actionKind(row.action)] ?? row.action.kind],
      ...(row.action.kind === 'scroll' ? [['滚动', scrollLabel(row.action)]] : []),
      ...(row.action.kind === 'drag'
        ? [['起点', locatorLabel(row.action.from)], ['终点', locatorLabel(row.action.to)],
          ['时长', `${row.action.durationMs} ms`]]
        : []),
      ['应用', appLabel(row.app)], ['窗口', row.window],
      ...(target ? [['定位器', locatorLabel(target)]] : []),
      ['时间', timestamp(row.atMs)], ['耗时', duration(row.durationMs)],
    ], 'meta-grid'),
    isCompatible(row) ? undefined : muted('该动作属于另一窗口，只能在时间线复盘。'),
    el('div', { className: 'actions' },
      button('加入测试项', () => addAction(row.action), { icon: 'listPlus', disabled: !editable }),
      button('添加断言', () => assertionDialog(row), { icon: 'checkCircle', disabled: !editable }),
      button('重新拾取', () => row.action.kind === 'drag' ? dragDialog(row) : locatorDialog(row), {
        icon: 'crosshair', disabled: !editable || row.action.kind === 'key' || row.action.kind === 'shell',
      }),
      button(ignored ? '恢复动作' : '忽略动作', () => {
        if (ignored) state.ignored.delete(row.id);
        else {
          state.ignored.add(row.id);
          state.selected.delete(row.id);
        }
        status(ignored ? '已恢复动作' : '已从时间线隐藏。可勾选「显示已忽略」查看。', 'success');
        render();
      }, { icon: ignored ? 'eye' : 'eyeOff' }))));
}

function renderDraft() {
  const { draft, session, saving } = state;
  $('draft-count').textContent = `${draft.length} 项`;
  $('save-button').disabled = !draft.length || saving || state.running;
  $('shell-button').disabled = saving || state.running;
  $('run-button').disabled = (!draft.length && !state.running) || saving;
  const runLabel = state.running ? '停止' : '运行测试项';
  const runButton = $('run-button');
  if (runButton.lastChild?.nodeType === 3) runButton.lastChild.textContent = runLabel;
  else runButton.append(document.createTextNode(runLabel));
  const items = draft.map((entry, index) => {
    const move = offset => {
      [draft[index], draft[index + offset]] = [draft[index + offset], draft[index]];
      renderDraft();
      $(`draft-${entry.id}-${offset}`)?.focus();
    };
    const shell = !entry.item && entry.action.kind === 'shell' ? shellSummary(entry.action) : undefined;
    return el('li', { className: 'draft-item' },
      kindChip(entry.item ? 'behavior' : entry.action),
      el('div', { className: 'draft-copy' },
        el('strong', {}, entry.item?.behavior.name ?? actionLabel(entry.action)),
        shell ? muted(`${shell.command} · ${shell.cwd} · ${shell.privilege}`) : undefined),
      el('div', { className: 'button-group trailing' },
        entry.item ? button('参数', () => behaviorDialog(entry.item, false, entry), { style: 'small', icon: 'sliders' }) : undefined,
        button('上移', () => move(-1), { style: 'small', icon: 'up', iconOnly: true, title: '上移', disabled: index === 0, key: `draft-${entry.id}--1` }),
        button('下移', () => move(1), { style: 'small', icon: 'down', iconOnly: true, title: '下移', disabled: index === draft.length - 1, key: `draft-${entry.id}-1` }),
        button('删除', () => { draft.splice(index, 1); renderDraft(); status('已从草稿移除'); }, { style: 'small danger', icon: 'trash', iconOnly: true, title: '删除' })));
  });
  $('draft').replaceChildren(...(items.length ? items : [
    el('li', { className: 'draft-empty' }, empty(session ? '加入动作，或从行为库引用行为。' : '导入会话后开始编排测试项。')),
  ]));
}

function render() {
  const focus = document.activeElement?.id;
  renderSummary();
  renderSetup();
  renderTimeline();
  renderInspector();
  renderDraft();
  if (focus && !dialog.open) $(focus)?.focus({ preventScroll: true });
}

function openDialog(title, content, submitLabel, submit) {
  let busy = false;
  const error = el('p', { className: 'form-error', role: 'alert' });
  const dismiss = button('关闭', () => dialog.close(), { icon: 'x', iconOnly: true, title: '关闭' });
  const confirm = submit && el('button', { className: 'button primary', type: 'submit' },
    icon('check'), el('span', {}, submitLabel));
  const form = el('form', {
    className: 'stack',
    onsubmit: async event => {
      event.preventDefault();
      if (!submit || busy) return;
      busy = true;
      confirm.disabled = true;
      dismiss.disabled = true;
      error.textContent = '';
      try {
        await submit();
        dialog.close();
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        busy = false;
        confirm.disabled = false;
        dismiss.disabled = false;
      }
    },
  },
  el('div', { className: 'dialog-head' }, el('h2', { id: 'dialog-title' }, title), dismiss),
  ...content, error, confirm ? el('div', { className: 'actions' }, confirm) : undefined);
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.replaceChildren(form);
  dialog.showModal();
  requestAnimationFrame(() => dialog.querySelector('input:not([type="checkbox"]), select, textarea')?.focus({ preventScroll: true }));
}

function importDialog() {
  const directory = input({ required: true, placeholder: '/…/sandbox/运行目录' });
  openDialog('导入运行目录', [
    field('本地目录路径', directory),
    muted('读取 flow.json 或 recorded.flow.json。report.json、actions.json 与 snapshot.json 存在时一并导入。'),
    state.draft.length ? muted('成功导入后将切换会话。请先保存要保留的草稿。') : undefined,
  ], '导入', async () => {
    const imported = await api('import', { directory: directory.value.trim() });
    setSession(imported);
    status('已导入本地会话', 'success');
    const shell = imported.shell ?? { reachable: 0, definitions: 0, privileged: 0 };
    if (shell.reachable || shell.definitions) {
      setTimeout(() => openDialog('导入完成', [
        el('h3', {}, `Shell 定义 ${shell.reachable + shell.definitions} 个`),
        muted(`可执行 ${shell.reachable} 个 · 行为定义内 ${shell.definitions} 个（含尚未调用的行为）`),
        shell.privileged
          ? muted(`其中 ${shell.privileged} 个是提权步骤，实时运行还需 --allow-sudo；密码授权型 Root 步骤还会在运行确认后弹框。`)
          : muted('全部是用户态步骤。'),
        muted('保存、校验和离线预览都不会执行；实时运行需要启动参数 --allow-shell。'),
      ]), 0);
    }
  });
}

function mergeDialog(rows) {
  const name = input({ required: true, maxLength: 256, placeholder: '例如 登录' });
  const typeRows = rows.filter(row => row.action.kind === 'type');
  const fields = typeRows.map((row, index) => ({
    row, param: input({ placeholder: index ? `text${index + 1}` : 'text', maxLength: 64 }),
    type: select([['string', 'string'], ['secret', 'secret']]),
  }));
  const add = el('input', { type: 'checkbox', checked: true });
  openDialog('合并为行为', [
    field('行为名称', name),
    muted(rows.map(row => row.action.kind).join(' → ')),
    fields.length ? el('div', { className: 'parameter-list stack' },
      el('h3', {}, '提取输入文本为参数'),
      muted('参数名留空时保留原文本。secret 使用环境变量名，草稿和行为库只保存变量名或参数名。'),
      ...fields.map(({ row, param, type }, index) => el('div', { className: 'parameter-row' },
        field(`参数名 · ${short(actionLabel(row.action), 32)}`, param), field(`类型 ${index + 1}`, type)))) : undefined,
    el('label', { className: 'checkbox' }, add, '同时加入测试项草稿'),
  ], '保存行为', async () => {
    if (!name.value.trim()) throw new Error('填写行为名称。');
    const bindings = new Map(fields.filter(({ param }) => param.value.trim()).map(({ row, param, type }) =>
      [row.id, { param: param.value.trim(), type: type.value }]));
    const { item, defaults } = makeBehavior(rows, name.value.trim(), bindings, state.session.target);
    const saved = await api('library', { session: state.session.id, item });
    state.library.push(saved);
    if (add.checked) state.draft.push({ id: id('call'), item: saved, args: defaults });
    state.selected.clear();
    state.tab = 'library';
    render();
    const shell = saved.shell ?? { steps: 0, privileged: 0 };
    status(`已保存行为「${saved.behavior.name}」${add.checked ? '并加入草稿' : ''}` +
      (shell.steps ? ` · 含 ${shell.steps} 个 Shell 步骤${shell.privileged ? '（需管理员预配置）' : ''}` : ''), 'success');
  });
}

function behaviorDialog(item, copy, entry) {
  const { behavior, parameterTypes } = item;
  const name = copy ? input({ required: true, maxLength: 256, value: `${behavior.name.slice(0, 250)} 副本` }) : undefined;
  const fields = behavior.parameters.map(param => {
    const secret = parameterTypes[param] === 'secret';
    return {
      param, secret, node: input({
        required: true, maxLength: secret ? 81 : 4000, spellcheck: false, autocomplete: 'off',
        value: entry?.args[param] ?? (secret ? `CUEKEEPER_SECRET_${param.toUpperCase()}` : ''),
      }),
    };
  });
  const shellSteps = behavior.steps.filter(step => step.kind === 'shell').length;
  openDialog(entry ? '编辑行为参数' : copy ? '复制行为' : '引用行为', [
    name ? field('副本名称', name) : muted(`${behavior.name} · ${behavior.steps.length} 步`),
    shellSteps ? muted(`该行为含 ${shellSteps} 个 Shell 步骤，加入草稿后仍需 --allow-shell 才能实时运行。`) : undefined,
    ...fields.map(({ param, secret, node }) => field(secret ? `${param} · 环境变量名` : param, node)),
  ], entry ? '应用参数' : '加入草稿', () => {
    for (const { secret, node } of fields) {
      if (secret && !/^CUEKEEPER_SECRET_[A-Z0-9_]{1,64}$/.test(node.value)) {
        throw new Error('secret 必须填写以 CUEKEEPER_SECRET_ 开头的环境变量名。');
      }
    }
    const args = Object.fromEntries(fields.map(({ param, node }) => [param, node.value]));
    if (copy && !name.value.trim()) throw new Error('填写副本名称。');
    const definition = copy
      ? { ...structuredClone(item), behavior: { ...structuredClone(behavior), id: id('behavior'), name: name.value.trim() } }
      : item;
    if (entry) entry.args = args;
    else state.draft.push({ id: id('call'), item: definition, args });
    renderDraft();
    status(entry ? '已更新行为参数' : `已加入行为「${definition.behavior.name}」`, 'success');
  });
}

function frameLabel(candidate) {
  if (!candidate.bounds) return '快照未提供边界';
  const { x, y, width, height } = candidate.bounds;
  return `${x}, ${y} · ${width} × ${height}${candidate.point ? ` · 中心 ${candidate.point.join(', ')}` : ''}`;
}

function candidateLabel(candidate) {
  return `${candidate.interactive ? '可交互' : '容器'} · ${locatorLabel(candidate.locator)}`;
}

function locatorFields(original) {
  const initial = original?.kind === 'element' ? original : undefined;
  const role = input({ required: true, maxLength: 256, value: initial?.role ?? '' });
  const name = input({ maxLength: 256, value: initial?.name ?? '' });
  const exactName = el('input', { type: 'checkbox', checked: initial?.name !== undefined });
  const path = input({ value: initial?.path?.join(' / ') ?? '', placeholder: 'window / scrollarea / textfield' });
  const index = el('input', { type: 'number', min: '0', step: '1', value: initial?.index ?? '' });
  const candidates = state.session.candidates;
  const detail = el('p', { className: 'muted' });
  const picker = select([['', '手动填写'], ...candidates.map((candidate, i) => [String(i), candidateLabel(candidate)])],
    event => {
      if (!event.target.value) {
        detail.textContent = '';
        return;
      }
      const candidate = candidates[Number(event.target.value)];
      const target = candidate.locator;
      role.value = target.role;
      name.value = target.name ?? '';
      exactName.checked = target.name !== undefined;
      path.value = target.path?.join(' / ') ?? '';
      index.value = target.index ?? '';
      detail.textContent = `${candidate.ref} · ${frameLabel(candidate)}`;
    });
  return {
    controls: [
      candidates.length ? field('从快照拾取控件', picker) : muted('此目录没有可拾取的控件快照。可手动填写 AX 定位器。'),
      candidates.length ? detail : undefined,
      field('角色', role), field('名称', name), el('label', { className: 'checkbox' }, exactName, '匹配名称（可匹配空名称）'),
      field('角色路径，可选', path), field('匹配索引，从 0 开始，可选', index),
    ],
    value() {
      const roles = path.value.split('/').map(part => part.trim()).filter(Boolean);
      if (!role.value.trim() || roles.length > 51 || roles.some(part => part.length > 256) ||
          (index.value !== '' && !Number.isSafeInteger(Number(index.value)))) throw new Error('检查定位器角色、路径和索引。');
      return {
        kind: 'element', role: role.value.trim(),
        ...(exactName.checked ? { name: name.value } : {}),
        ...(roles.length ? { path: roles } : {}),
        ...(index.value === '' ? {} : { index: Number(index.value) }),
      };
    },
  };
}

function locatorDialog(row) {
  const picker = locatorFields(actionTarget(row.action));
  openDialog('重新拾取定位器', picker.controls, '替换定位器', () => {
    row.action = changeTarget(row.action, picker.value());
    render();
    status('已替换时间线动作的定位器。可重新加入草稿。', 'success');
  });
}

/**
 * A drag has two endpoints. A coordinate keeps the exact recorded position
 * (text selection, window moves); an element replays from its center.
 */
function dragEndpointFields(title, original) {
  const mode = select([['point', '坐标'], ['element', '元素']]);
  mode.value = original?.kind === 'element' ? 'element' : 'point';
  const coord = input({
    placeholder: 'x, y', maxLength: 40,
    value: original?.kind === 'point' ? original.point.join(', ') : '',
  });
  const picker = locatorFields(original?.kind === 'element' ? original : undefined);
  const coordBox = field('坐标（屏幕逻辑点）', coord);
  const elementBox = el('div', { className: 'stack' }, ...picker.controls);
  const sync = () => {
    coordBox.hidden = mode.value !== 'point';
    elementBox.hidden = mode.value !== 'element';
  };
  mode.onchange = sync;
  sync();
  return {
    controls: [el('h3', {}, title), field('类型', mode), coordBox, elementBox],
    value() {
      if (mode.value === 'element') return picker.value();
      const parts = coord.value.split(',').map(part => Number(part.trim()));
      if (parts.length !== 2 || !parts.every(Number.isSafeInteger)) throw new Error('坐标需填写 “x, y” 整数。');
      return { kind: 'point', point: parts };
    },
  };
}

function dragDialog(row) {
  const from = dragEndpointFields('起点', row.action.from);
  const to = dragEndpointFields('终点', row.action.to);
  const durationMs = el('input', {
    type: 'number', min: '0', max: '60000', step: '10', value: String(row.action.durationMs),
  });
  openDialog('重新拾取拖拽', [
    ...from.controls, ...to.controls, field('时长（毫秒）', durationMs),
  ], '替换拖拽', () => {
    const value = { from: from.value(), to: to.value(), durationMs: Number(durationMs.value) };
    if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 60000) {
      throw new Error('拖拽时长需为 0–60000 毫秒的整数。');
    }
    // The stored path described the old endpoints; it is stale after a re-pick.
    const { path, ...rest } = row.action;
    row.action = { ...rest, ...value };
    render();
    status('已替换拖拽的起止点与时长。可重新加入草稿。', 'success');
  });
}

function assertionDialog(row) {
  const picker = locatorFields(actionTarget(row.action) ??
    (row.action.kind === 'drag' ? row.action.from : undefined));
  const equals = input({ maxLength: 4000 });
  const toggle = select([['true', '成立'], ['false', '不成立']]);
  const textField = field('预期内容', equals);
  const boolField = field('预期结果', toggle);
  textField.hidden = true;
  const property = select([['exists', '存在'], ['visible', '可见'], ['text', '文本'], ['value', '值']], event => {
    textField.hidden = ['exists', 'visible'].includes(event.target.value);
    boolField.hidden = !textField.hidden;
  });
  openDialog('添加断言', [...picker.controls, field('属性', property), boolField, textField], '加入测试项', () => {
    addAction({
      id: id('assert'), kind: 'assert',
      check: { target: picker.value(), expect: {
        property: property.value, equals: textField.hidden ? toggle.value === 'true' : equals.value,
      } },
    });
  });
}

function addEnvRow(container) {
  const key = input({ placeholder: 'FIXTURE_TOKEN', maxLength: 64 });
  const value = input({ placeholder: '值或 CUEKEEPER_SECRET_ 变量名', maxLength: 4000 });
  const secret = el('input', { type: 'checkbox' });
  const row = el('div', { className: 'parameter-row' },
    key, value, el('label', { className: 'checkbox' }, secret, '引用环境变量'),
    button('删除', () => row.remove(), { style: 'small danger', icon: 'trash', iconOnly: true }));
  container.append(row);
}

function shellDialog() {
  const mode = select([['argv', '逐项参数'], ['script', 'Shell 脚本']]);
  const argvRows = el('div', { className: 'stack' });
  const addArg = (value = '') => {
    const arg = input({ value, placeholder: '/usr/bin/tool 或参数', maxLength: 4096 });
    const row = el('div', { className: 'parameter-row' }, arg,
      button('删除', () => row.remove(), { style: 'small danger', icon: 'trash', iconOnly: true }));
    argvRows.append(row);
  };
  addArg('');
  const argvBox = el('div', { className: 'stack' }, argvRows,
    button('添加参数', () => addArg(), { style: 'small', icon: 'plus' }));
  const command = el('textarea', { rows: 4, maxLength: 16384, placeholder: 'echo hello | tr a-z A-Z' });
  const commandBox = field('Shell 脚本', command);
  commandBox.hidden = true;
  const cwd = input({ placeholder: '默认输入文件目录', maxLength: 4096 });
  const timeout = el('input', { type: 'number', min: '1', max: '120000', value: '30000' });
  const expected = el('input', { type: 'number', min: '0', max: '255', value: '0' });
  const privilege = select([['user', '用户态'], ['root', 'Root · 需管理员密码'], ['sudo', '需管理员预配置']]);
  const rootMode = select([['prompt', '每次弹框输入管理员密码'], ['sudoers', 'sudoers 免密（无人值守）']]);
  const task = input({ placeholder: '/Library/CueKeeper/privileged/<任务 ID>', maxLength: 4096 });
  const envRows = el('div', { className: 'stack' });
  const envBlock = el('div', { className: 'stack' },
    el('h3', {}, '环境变量'), muted('保留键与 SUDO_ / DYLD_ / LD_ / CUEKEEPER_ 前缀不可覆盖。'),
    envRows, button('添加环境变量', () => addEnvRow(envRows), { style: 'small', icon: 'plus' }));
  const userBox = el('div', { className: 'stack' },
    field('工作目录', cwd), field('超时（毫秒）', timeout), field('预期退出码', expected), envBlock);
  const rootBox = el('div', { className: 'stack' },
    field('授权方式', rootMode),
    muted('Root 步骤只接受逐项参数，不接受 Shell 脚本或环境变量。运行前会展示完整命令与工作目录，密码只通过弹框交给 sudo。'));
  const sudoBox = el('div', { className: 'stack' },
    field('固定任务路径', task),
    muted('固定任务由管理员预配置，不接受工作目录、环境变量、超时或脚本。'));
  rootBox.hidden = true;
  sudoBox.hidden = true;
  mode.onchange = () => {
    commandBox.hidden = mode.value !== 'script';
    argvBox.hidden = mode.value === 'script';
  };
  privilege.onchange = () => {
    const selected = privilege.value;
    const sudo = selected === 'sudo';
    const root = selected === 'root';
    sudoBox.hidden = !sudo;
    rootBox.hidden = !root;
    userBox.hidden = sudo;
    envBlock.hidden = root;
    if (root && mode.value === 'script') mode.value = 'argv';
    mode.disabled = sudo || root;
    commandBox.hidden = sudo || root || mode.value !== 'script';
    argvBox.hidden = sudo || mode.value === 'script';
  };
  openDialog('插入 Shell 步骤', [
    field('形态', mode), argvBox, commandBox, field('权限', privilege), userBox, rootBox, sudoBox,
    muted('保存与预览都不会执行。含 Shell 的测试项不能打包为离线报告。'),
  ], '加入草稿', () => {
    const selected = privilege.value;
    const sudo = selected === 'sudo';
    const root = selected === 'root';
    const argv = sudo
      ? [task.value.trim()]
      : [...argvRows.querySelectorAll('input')].map(node => node.value);
    const env = [...envRows.children].map(row => {
      const [key, value, secret] = row.querySelectorAll('input');
      return [key.value, value.value, secret.checked];
    });
    const action = shellDraft({
      mode: sudo || root ? 'argv' : mode.value, argv, command: sudo || root ? '' : command.value,
      cwd: sudo ? '' : cwd.value,
      timeoutMs: timeout.value, expectedExitCode: expected.value,
      privilege: selected, privilegeMode: rootMode.value, env: sudo || root ? [] : env,
    });
    state.draft.push({ id: id('action'), action });
    renderDraft();
    status('已加入 Shell 步骤', 'success');
  });
}

function currentTest() {
  const name = $('test-name').value.trim();
  if (!name) throw new Error('填写测试项名称。');
  const session = { ...state.session, setup: state.setup?.conditions ?? state.session.setup };
  return { session: state.session.id, test: compileDraft(session, name, state.draft, state.appPaths) };
}

async function saveTest() {
  state.saving = true;
  renderDraft();
  try {
    const { output } = await api('save', currentTest());
    status(`已保存 · ${output}`, 'success');
  } catch (error) {
    status(error.message, 'error');
  } finally {
    state.saving = false;
    renderDraft();
  }
}

const resultStatus = { resolved: '已解析', passed: '通过', failed: '失败', blocked: '阻塞', skipped: '跳过' };
const identityReasons = {
  invalid_bundle_path: '选中的应用路径已失效，请重新选择副本并保存。',
  bundle_id_mismatch: '应用路径的应用标识已变更，请重新选择副本并保存。',
  unsupported_path_platform: '该应用路径属于另一平台，本机只能离线验证。',
  path_mismatch: '无法唯一确认目标副本，请打开选中的副本后重新运行。',
  multiple_instances: '同一应用有多个运行实例，请关闭冲突实例后重新运行。',
  multiple_installed_copies: '本机有多份可启动的副本，请明确选择路径后保存。',
  identity_unproven: '无法证明操作仍指向选中的副本，本轮已停止。',
  instance_changed: '目标实例在运行中发生了变化，本轮已停止。',
  driver_target_unconfirmed: '驱动无法证明窗口归属，本轮已停止。',
  fixture_path_mismatch: '快照来自另一个应用路径，请重新采集快照。',
  untargeted_input: '该坐标操作无法绑定到选中的副本，请改用元素定位器。',
};

function identityNotice(report) {
  const identity = report.appIdentity;
  if (!identity) return undefined;
  if (identity.status === 'blocked') {
    return muted(`应用身份阻塞 · ${identity.code ?? ''} · ${identityReasons[identity.reason] ?? identity.reason}`);
  }
  return muted(`应用身份 · ${identity.status === 'verified' ? '已核对运行实例' : '离线来源'} · ${identity.mode === 'bundle_path' ? '按副本路径' : '按应用标识'}`);
}

function planText(step) {
  if (step.kind !== 'shell') return step.kind;
  const command = [step.program, ...step.args]
    .map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  const privilege = step.privilege === 'sudo'
    ? '需管理员预配置'
    : step.privilege === 'root'
      ? (step.privilegeMode === 'sudoers' ? 'Root · sudoers 免密' : 'Root · 密码授权')
      : '用户态';
  return `${privilege} · ${step.mode} · ${step.timeoutMs} ms · 目录 ${step.cwd}\n${command}`;
}

function showResult(mode, report) {
  status(`${mode === 'offline' ? '离线运行' : '实时回放'}${resultStatus[report.status]} · ${report.entries.length} 条结果`,
    report.status === 'passed' ? 'success' : 'error');
  setTimeout(() => openDialog('运行结果', [
    el('h3', {}, resultStatus[report.status]),
    identityNotice(report),
    report.stopped ? muted('本次运行已在停止请求后结束。') : undefined,
    el('ol', { className: 'stack' }, ...report.entries.map(entry => {
      const shell = entry.kind === 'shell'
        ? ` · ${entry.shell.privilege}${entry.shell.privilegeMode ? `(${entry.shell.privilegeMode})` : ''}` +
          `/${entry.shell.mode} · ${entry.shell.execution}` +
          (entry.shell.exitCode === undefined ? '' : ` · 退出码 ${entry.shell.exitCode}`)
        : '';
      return el('li', {}, `${entry.id} · ${entry.kind}${shell} · ${resultStatus[entry.status]} · ${entry.durationMs} ms`,
        entry.message ? muted(entry.message) : undefined);
    })),
  ]), 0);
}

async function stopRun() {
  $('run-button').disabled = true;
  try {
    await api('stop', {});
    status('正在停止当前运行…');
  } catch (error) {
    status(error.message, 'error');
  }
}

function runDialog() {
  const { session, allowLive } = state;
  if (!session.hasSnapshot && !allowLive) {
    openDialog('运行测试项', [
      muted('离线运行需要目录内的 snapshot.json。实时回放需要在启动工作台时显式启用 --allow-live-replay。'),
    ]);
    return;
  }
  const modes = [];
  if (session.hasSnapshot) modes.push(['offline', '离线解析定位器']);
  if (allowLive) modes.push(['live', '回放到当前目标窗口']);
  const confirmed = el('input', { type: 'checkbox' });
  const confirmation = el('label', { className: 'checkbox', hidden: session.hasSnapshot },
    confirmed, `我确认向 ${session.target.window} 执行动作`);
  const mode = select(modes, () => { confirmation.hidden = mode.value !== 'live'; });
  const capture = el('input', { type: 'checkbox' });
  const planBox = el('div', { className: 'plan stack' }, muted('正在生成执行计划…'));
  let plan;
  let loading = false;
  const refresh = async () => {
    if (loading) return;
    loading = true;
    try {
      plan = await api('plan', { ...currentTest(), captureOutput: capture.checked });
      planBox.replaceChildren(
        el('h3', {}, `展开后的执行计划 · ${plan.steps.length} 步`),
        ...plan.steps.map(step => el('article', { className: 'plan-step' },
          el('strong', {}, step.id), muted(planText(step)))),
        plan.shell.reachable
          ? muted(`Shell ${plan.shell.reachable} 步 · 提权 ${plan.shell.privileged} 步 · ` +
            (plan.captureAllowed ? (plan.captureOutput ? '采集输出文本' : '不采集输出文本') : '输出仅保留元数据'))
          : muted('没有 Shell 步骤。'),
      );
    } catch (error) {
      plan = undefined;
      planBox.replaceChildren(muted(error.message));
    } finally {
      loading = false;
    }
  };
  capture.onchange = () => { void refresh(); };
  openDialog('运行测试项', [
    field('运行方式', mode), confirmation,
    muted('离线运行读取快照。实时回放向目标窗口写入并可能触发 macOS 权限提示。'),
    muted('前置条件修复可能启动应用或将窗口切到前台；命令引用的磁盘文件仍需你自己信任。'),
    el('label', { className: 'checkbox' }, capture,
      '采集 Shell 输出文本（存在秘密引用或提权步骤时只保留元数据）'),
    planBox,
  ], '开始运行', async () => {
    const selected = mode.value;
    if (selected === 'live' && !confirmed.checked) throw new Error('确认目标窗口后开始回放。');
    if (!plan) throw new Error('执行计划尚未生成，请稍候再试。');
    if (selected === 'live' && plan.shell.reachable && !plan.allowShell) {
      throw new Error('实时运行 Shell 步骤需要启动参数 --allow-shell。');
    }
    if (selected === 'live' && plan.shell.privileged && !plan.allowSudo) {
      throw new Error('含提权步骤，需要启动参数 --allow-sudo。');
    }
    const payload = {
      ...currentTest(), mode: selected, confirm: confirmed.checked, captureOutput: capture.checked,
      ...(selected === 'live' ? { token: plan.token } : {}),
    };
    state.running = true;
    renderDraft();
    status(`${selected === 'offline' ? '离线运行' : '实时回放'}中… 点击「停止」可取消剩余步骤`, '');
    void (async () => {
      try {
        showResult(selected, await api('run', payload));
      } catch (error) {
        status(error.message, 'error');
      } finally {
        state.running = false;
        renderDraft();
      }
    })();
  });
  void refresh();
}

for (const [id, name] of [['import-button', 'folder'], ['save-button', 'save'], ['run-button', 'play'],
  ['shell-button', 'terminal'], ['actions-tab', 'list'], ['library-tab', 'layers']]) {
  const node = $(id);
  if (node && !node.querySelector('svg')) node.prepend(icon(name));
}

$('app-picker').onclick = openAppPicker;
$('import-button').onclick = importDialog;
$('show-ignored').onchange = event => { state.showIgnored = event.target.checked; render(); };
$('save-button').onclick = saveTest;
$('shell-button').onclick = shellDialog;
$('run-button').onclick = () => state.running ? stopRun() : runDialog();
for (const tab of ['actions', 'library']) $(`${tab}-tab`).onclick = () => { state.tab = tab; renderInspector(); };

try {
  const initial = await api('state');
  state.library = initial.library;
  state.allowLive = initial.allowLive;
  setSession(initial.session ?? null);
  status(initial.session ? '已导入本地会话' : '会话与测试项保存在本机');
} catch (error) {
  render();
  status(error.message, 'error');
}
