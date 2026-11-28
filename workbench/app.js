import { createDom } from './dom.js';
import {
  KIND_LABELS, SURFACE_LABELS, actionKind, canUndo, changeTarget, compileDraft, confirmCondition, confirmedSetup,
  deleteCondition, id, makeBehavior, retargetCondition, sameTarget, scopeDescription, scrollLabel, setupDraft,
  shellDraft, shellSummary, dragSummary, undoCondition, visibleRows, locatorDetail, targetLabel, roleLabel,
  V2_COPYABLE_KINDS, V2_INSERT_KINDS, V2_TARGET_KINDS, assertCheck, checkLabel, diffItems, diffSummary,
  filterStepsByScope, scopeKey, scopeOptions, statusMap, stepTemplate, stepTiming, v2StepLabel, gapReason,
  checkpointWaitFacts, pickCandidateLabel, durationLabel, sessionDurationLabel, stateCheckLabel,
  defaultLibraryExpanded, libraryGroups, toggleLibraryGroup,
} from './model.js';
import { createAppPicker } from './picker.js';
import { createBatchView } from './batch.js';
import { createGuide } from './guide.js';

const $ = name => document.getElementById(name);
const dialog = $('dialog');
// The picker stacks over the step editor instead of replacing it, so the
// editor's unsaved fields survive a cancelled or failed pick.
const pickDialog = $('v2-pick-dialog');
// A pick request belongs to the editor and picker it was started from: any
// dialog that opens in between retires the pending response.
let editDialogEpoch = 0;
let pickDialogEpoch = 0;
const state = {
  session: null, library: [], allowLive: false, allowShell: true, allowSudo: false, app: '', selected: new Set(), ignored: new Set(),
  expanded: new Set(), showIgnored: false, focused: null, draft: [], tab: 'actions', saving: false,
  // Both library groups open collapsed on every page load; toggling survives a
  // re-render but never a reload.
  libraryExpanded: defaultLibraryExpanded(),
  running: false, setup: null, appPaths: {}, catalog: null, catalogAt: 0, catalogError: null, appNames: {},
  v2: null, v2Report: null, v2Selected: null, v2Filter: '', v2Busy: false,
  v2Running: false, v2Checkpoint: null, mode: 'edit',
  templateMode: null, templateCandidates: [],
};

const dom = createDom(document);
const { el, icon, button, empty, muted, input, field, select } = dom;
const batchView = createBatchView({
  api, status, dialog: openDialog, setMode,
  appLabel: app => state.appNames[app],
  openFlow: async path => {
    try {
      const view = await api('batch/open', { path });
      setSession(view);
      setMode('edit');
      status('已打开工作流，可在草稿区继续编辑', 'success');
    } catch (error) {
      status(error.message, 'error');
    }
  },
});

const KIND_ICONS = {
  click: 'pointer', doubleClick: 'pointerDouble', tripleClick: 'pointerDouble', rightClick: 'pointerRight',
  scroll: 'wheel', drag: 'drag', hover: 'pointer', paste: 'clipboard', type: 'text', key: 'keyboard', wait: 'clock', assert: 'checkCircle',
  behavior: 'layers', shell: 'terminal',
  launch_app: 'play', activate_app: 'appWindow', focus_window: 'crosshair',
  open_system_surface: 'layers', surface_press: 'pointer', manual_checkpoint: 'checkCircle', gap: 'list',
};

/** The color a kind is read as: primary action, secondary text, accent key. */
const KIND_TONES = {
  click: 'primary', doubleClick: 'primary', tripleClick: 'primary', rightClick: 'primary', hover: 'primary',
  surface_press: 'primary', scroll: 'info', drag: 'info', paste: 'secondary', type: 'secondary',
  key: 'accent', wait: 'info', assert: 'success', behavior: 'secondary', shell: 'neutral',
  launch_app: 'ghost', activate_app: 'ghost', focus_window: 'ghost', open_system_surface: 'ghost',
  manual_checkpoint: 'warning', gap: 'warning',
};

const STATUS_TONES = { resolved: 'info', passed: 'success', failed: 'error', blocked: 'warning', skipped: 'ghost' };
// A recorded screen point is a legal step, but a dry run can only prove an
// element target. The timeline marks it yellow before the run, so the operator
// sees which steps to fix without running anything.
const POINT_CONFIRM_TITLE = '屏幕坐标目标：dry-run 需先改成元素目标；实时回放仍会点窗口内坐标';
const pointConfirmChip = step => step?.kind === 'click' && step.target?.kind === 'point'
  ? el('span', {
    className: 'point-confirm badge badge-soft badge-sm badge-warning',
    title: POINT_CONFIRM_TITLE,
    'aria-label': '需确认：坐标目标',
  }, '需确认')
  : undefined;
// A timeline status is one 16px icon in a fixed 28px column at the right edge of
// the row: the Chinese word lives in aria-label/title, so the badge never eats
// width from the action name. Each status keeps its own glyph, so the row stays
// readable without relying on color alone.
const STATUS_MARKS = {
  passed: { icon: 'checkCircle', label: '通过' },
  failed: { icon: 'xCircle', label: '失败' },
  blocked: { icon: 'alertTriangle', label: '阻塞' },
  skipped: { icon: 'minusCircle', label: '跳过' },
  resolved: { icon: 'infoCircle', label: '已解析' },
};
// The code and message only mean something on the states an operator has to
// investigate; on the rest the tooltip is just the Chinese label.
const STATUS_DIAGNOSTIC = new Set(['failed', 'blocked']);
const statusBadge = status =>
  `run-status badge badge-soft badge-sm badge-${STATUS_TONES[status] ?? 'ghost'} ${status}`;
// A step that ran in a window the recorded title did not name stays a pass; the
// yellow chip says why the window differs, without turning it into a failure.
const windowFallbackTitle = fallback =>
  `窗口回退 · 记录窗口「${fallback.recordedTitle}」 → 实际窗口「${fallback.actualTitle}」`;
const windowFallbackChip = entry => entry?.windowFallback
  ? el('span', {
    className: 'badge badge-soft badge-sm badge-warning window-fallback',
    title: windowFallbackTitle(entry.windowFallback),
  }, '窗口回退')
  : undefined;
const statusCell = (entry, detail) => {
  if (!entry) return el('span', { className: 'row-status' });
  const mark = STATUS_MARKS[entry.status] ?? { icon: 'list', label: resultStatus[entry.status] ?? entry.status };
  const diagnostics = STATUS_DIAGNOSTIC.has(entry.status) ? [detail, entry.code, entry.message] : [];
  return el('span', {
    className: `row-status status-${entry.status}`,
    role: 'img',
    'aria-label': mark.label,
    title: [mark.label, ...diagnostics].filter(Boolean).join(' · '),
  }, icon(mark.icon, 16));
};

const STATE_TONES = { inferred: 'warning', confirmed: 'success', invalid: 'ghost', deleted: 'ghost' };
const stateChip = (state, text) => el('span', {
  className: `state-chip badge badge-soft badge-sm badge-${STATE_TONES[state] ?? 'ghost'} ${state}`,
}, text);

function kindChip(action) {
  const kind = typeof action === 'string' ? action : actionKind(action);
  return el('span', { className: `kind badge badge-soft badge-sm badge-${KIND_TONES[kind] ?? 'ghost'}`, title: kind },
    icon(KIND_ICONS[kind] ?? 'list', 14), el('span', {}, KIND_LABELS[kind] ?? kind));
}

const duration = durationLabel;
const timestamp = ms => ms === undefined ? '—' : `+${(ms / 1000).toFixed(2)} s`;
/** The wait before a step, read from the two recorded step times. */
const gapLabel = timing => timing?.sinceMs === undefined
  ? (timing ? '第一个动作' : '未记录')
  : `+${(timing.sinceMs / 1000).toFixed(2)} s`;
const gapTitle = timing => timing?.sinceMs === undefined
  ? (timing ? '录制的第一个动作' : '未记录时间')
  : `距上一步 ${gapLabel(timing)}`;
const actionTarget = action => action.target ?? action.check?.target;
const isCompatible = row => state.session?.version === 1 && sameTarget(row, state.session.target);

/** v2 rows carry their own step scope; v1 rows inherit the flow target. */
const scopeText = scope => scopeDescription(scope, appLabel);
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
// Icon-only buttons keep their label in aria-label/title; a disabled control
// does not receive hover events in every engine, so the explanation lives on
// a wrapper that still does.
const libraryAction = (label, onclick, options) => {
  const node = button(label, onclick, options);
  return options.disabled
    ? el('span', { className: 'library-action-disabled', title: options.title ?? label }, node)
    : node;
};
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

/** A checkpoint's read-only resume condition, in the same words as a wait. */
function resumeLabel(check) {
  if (!check) return '—';
  if (check.kind === 'window_exists') return check.equals ? '窗口存在' : '窗口已关闭';
  if (check.kind === 'element_enabled') {
    return `${targetLabel(check.target)} · ${check.equals ? '可用' : '不可用'}`;
  }
  if (check.kind === 'window') {
    return `窗口 ${check.expect?.property} = ${short(String(check.expect?.equals ?? ''))}`;
  }
  return `${targetLabel(check.target)} · ${check.expect?.property} = ${short(String(check.expect?.equals ?? ''))}`;
}

function actionLabel(action, { confirmPoint = true } = {}) {
  const target = actionTarget(action);
  const label = target ? targetLabel(target, { confirmPoint }) : '';
  switch (action.kind) {
    case 'click':
      if (action.button === 'right') return `右键 ${label}`;
      if (action.count === 2) return `双击 ${label}`;
      if (action.count === 3) return `三击 ${label}`;
      return label;
    case 'scroll': return `${scrollLabel(action)} · ${label}`;
    case 'drag': return `${dragSummary(action)} · ${action.durationMs} ms`;
    case 'hover': return action.scope?.kind === 'screen'
      ? `悬停 · 屏幕坐标 (${action.point.join(', ')}) · ${action.durationMs} ms`
      : `悬停 · ${label} · ${action.durationMs} ms`;
    case 'paste':
      // v1 pins clipboard text on the step; v2 names the copy step or input.
      if (typeof action.text === 'string') return `粘贴 ${action.text.length} 字 · ${label}`;
      return `粘贴 · ${action.source?.kind === 'copy'
        ? `复制 ${action.source.stepId}` : `参数 ${action.source?.input ?? ''}`} · ${label}`;
    case 'type':
      if (typeof action.text === 'string') return `输入 “${short(action.text)}”`;
      if (action.input) return `输入参数 ${action.input}`;
      return `输入参数 ${action.text?.param}`;
    case 'key': return shortcutLabel(action);
    case 'assert':
    case 'wait': {
      const check = action.check;
      if (check?.expect) return `${label} · ${check.expect.property} = ${short(String(check.expect.equals))}`;
      if (check?.kind) return `${label} · ${check.kind} = ${String(check.equals ?? '')}`.trim();
      return label;
    }
    case 'launch_app': return `启动 ${appLabel(action.scope.app)}`;
    case 'activate_app': return `激活 ${appLabel(action.scope.app)}`;
    case 'focus_window': return `聚焦 ${action.scope.windowTitle}`;
    case 'open_system_surface':
      return `打开 ${SURFACE_LABELS[action.scope.surface] ?? action.scope.surface}`;
    case 'surface_press': return `操作 ${SURFACE_LABELS[action.scope.surface] ?? action.scope.surface} · ${action.selector.kind}`;
    case 'manual_checkpoint':
      return `人工检查点 · ${action.reason === 'system_dialog' ? 'macOS 系统弹框' : '安全输入'} · 触发 ${action.triggerStepId}`;
    case 'gap': return `缺口 · ${action.code}`;
    case 'shell': return `Shell · ${short(shellSummary(action).command)}`;
    default: return action.kind;
  }
}

function infoList(entries, className) {
  return el('dl', { className }, ...entries.map(([label, value]) => {
    const pair = [el('dt', {}, label), el('dd', {}, String(value))];
    return className === 'session-stats' ? el('div', {}, ...pair) : pair;
  }).flat());
}

function status(message, type = '') {
  $('status').className = `status-bar ${type}`;
  $('status').textContent = message;
}

async function api(route, data = {}) {
  const response = await fetch(`/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cuekeeper-workbench': '1' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) {
    // The server answers a stable code plus the words that explain it. Show the
    // words so a refusal is actionable instead of a bare code; keep the code on
    // the error for callers that branch on it.
    const error = new Error(result.message ?? result.error ?? '工作台请求失败');
    if (result.error) error.code = result.error;
    throw error;
  }
  return result;
}

function setSession(session) {
  Object.assign(state, {
    session, app: '', focused: null, draft: [], tab: 'actions', showIgnored: false,
    selected: new Set(), ignored: new Set(), expanded: new Set(),
    setup: session ? setupDraft(session.setup ?? []) : null,
    appPaths: session?.target?.appPath ? { [session.target.app]: session.target.appPath } : {},
    appNames: Object.fromEntries(Object.entries(session?.apps ?? {}).map(([id, app]) => [id, app.name])),
    v2: session?.v2 ?? null, v2Report: null, v2Selected: null, v2Filter: '', v2Busy: false,
    v2Running: false, v2Checkpoint: null,
    templateMode: null, templateCandidates: [],
  });
  $('show-ignored').checked = false;
  $('test-name').value = session ? `${session.name.slice(0, 248)} 测试` : '';
  render();
}

function renderSummary() {
  const { session } = state;
  const kind = $('session-kind');
  if (session) {
    const crossApp = session.version === 2;
    kind.hidden = false;
    kind.textContent = crossApp ? '全局录制' : '单窗口录制';
    kind.className = `badge badge-soft badge-sm ${crossApp ? 'badge-info' : 'badge-ghost'}`;
    kind.title = crossApp
      ? '全局录制：每一步自带作用域，可跨窗口执行'
      : '单窗口录制：整条流程锁定一个窗口';
  } else {
    kind.hidden = true;
  }
  $('session-name').textContent = session?.name ?? '';
  if (!session) {
    $('summary').replaceChildren(muted('尚未导入运行目录'));
    $('app-picker').disabled = true;
    $('app-picker-label').textContent = '全部应用';
    $('app-picker-icon').replaceChildren(icon('appWindow', 15));
    return;
  }
  const apps = new Map();
  const groups = new Set();
  const windows = new Set();
  for (const row of session.timeline) {
    if (row.app) apps.set(row.app, (apps.get(row.app) ?? 0) + 1);
    if (row.scopeGroup) groups.add(row.scopeGroup);
    windows.add(JSON.stringify([row.app, row.window]));
  }
  const timing = { capture: '录制时间', replay: '回放时间', 'dry-run': '离线验证时间' }[session.timingSource];
  $('summary').replaceChildren(...[
    muted(short(session.directory.split('/').at(-1), 48)),
    infoList([['时长', sessionDurationLabel(session.durationMs, session.pausedMs)],
      ['动作', session.timeline.length],
      ['应用', apps.size], [session.version === 2 ? '作用域' : '窗口',
        session.version === 2 ? groups.size : windows.size]], 'session-stats'),
    muted(timing ?? '未记录时间'),
    session.startedAt ? el('time', { className: 'muted', dateTime: session.startedAt },
      session.startedAt.slice(0, 19).replace('T', ' ') + ' UTC') : undefined,
  ].filter(Boolean));
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
  return targetLabel(condition.check.target);
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

const waitEventLabels = {
  download_completed: '下载完成', installer_shown: '安装器出现', install_completed: '安装完成',
  app_appeared: 'App 出现', uninstaller_shown: '卸载器出现', app_disappeared: 'App 消失',
};

function renderWaitCandidates(session) {
  const candidates = session.waitCandidates ?? [];
  if (!candidates.length) {
    return [muted('全局 flow 没有顶层目标或前置条件；启动、激活与等待都写在声明作用域的步骤里。' +
      '目录内没有 lifecycle.json 的下载/安装/卸载事件时，不提出候选等待。')];
  }
  const summary = muted(
    `${candidates.filter(candidate => candidate.ready).length} / ${candidates.length} 个候选等待来自下载、安装或卸载事件；` +
    '确认后写入新的 flow 副本，不会修改当前 flow.json，也不会启动桌面。');
  return [summary, ...candidates.map(candidate => el('article', { className: 'condition' },
    el('div', { className: 'condition-head' },
      stateChip('inferred', candidate.ready ? '待确认' : '需补充条件'),
      el('strong', {}, waitEventLabels[candidate.eventKind] ?? candidate.eventKind)),
    el('p', { className: 'muted' }, `接在 ${candidate.afterStepId} 之后 · ${candidate.reason}`),
    el('p', { className: 'muted' }, candidate.step ? actionLabel(candidate.step) : '还没有可写入的等待条件。'),
    el('div', { className: 'actions' },
      button('确认并写入', async () => {
        try {
          const result = await api('wait-candidate', { session: session.id, candidate: candidate.id });
          status(`已写入 ${result.output.split('/').at(-1)}（${result.steps} 步），请复核后再运行`, 'success');
        } catch (error) {
          status(error.message, 'error');
        }
      }, { style: 'small', icon: 'check', disabled: !candidate.ready }))))];
}

function renderSetup() {
  const { session, setup } = state;
  const panel = $('setup');
  if (!session || !setup) {
    panel.replaceChildren(muted('导入运行目录后显示推断的前置条件。'));
    return;
  }
  if (session.version === 2) {
    panel.replaceChildren(...renderWaitCandidates(session));
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
        stateChip(condition.state, setupStates[condition.state] ?? condition.state),
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
    el('div', { className: 'selection-bar alert alert-soft alert-primary' },
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
  const groupSteps = new Map((state.session?.scopeGroups ?? []).map(group => [group.key, group.stepIds.length]));
  const v2Statuses = statusMap(state.v2Report);
  // Gaps come from the whole recording, not the filtered view, so a step's
  // interval never depends on which rows happen to be visible.
  const timing = stepTiming(getRows());
  const nodes = [];
  let lastGroup;
  for (const row of rows) {
    // v2 groups consecutive steps that share one scope under a header, so a
    // cross-app recording reads as blocks instead of an undifferentiated list.
    if (state.session?.version === 2 && row.scopeGroup !== lastGroup) {
      nodes.push(el('article', { className: 'scope-head' },
        el('strong', {}, scopeText(row.scope)),
        el('small', { className: 'muted badge badge-ghost badge-sm' }, `${groupSteps.get(row.scopeGroup) ?? 1} 步`)));
      lastGroup = row.scopeGroup;
    }
    const ignored = state.ignored.has(row.id);
    const runEntry = state.session?.version === 2 ? v2Statuses.get(row.id) : undefined;
    // A v2 timeline row is the recording's snapshot of the step. Once the flow
    // is edited, the current step is the one the operator sees (and the one a
    // rerun would use), so the row's action and 需确认 marker follow it. A row
    // whose step was deleted keeps its snapshot only as history: it must not
    // look like a current coordinate step awaiting confirmation.
    const isV2 = state.session?.version === 2;
    const current = isV2 ? v2Step(row.id) : undefined;
    const action = current ?? row.action;
    const history = isV2 && !current;
    const scope = action.scope ?? row.scope;
    const confirmChip = isV2
      ? (current ? pointConfirmChip(current) : undefined)
      : pointConfirmChip(row.action);
    const historyChip = history
      ? el('span', {
        className: 'state-chip badge badge-soft badge-sm badge-ghost deleted',
        title: '该步骤已从当前工作流删除；这里显示的是录制快照',
      }, '历史')
      : undefined;
    const selector = el('input', {
      id: `select-${row.id}`, type: 'checkbox', className: 'checkbox checkbox-sm',
      checked: state.selected.has(row.id), disabled: ignored,
      'aria-label': `选择 ${action.kind} ${row.id}`,
      onchange: event => {
        if (event.target.checked) state.selected.add(row.id);
        else state.selected.delete(row.id);
        render();
      },
    });
    // One step can be read two ways: its own small button, or a click anywhere
    // on the row. Both land on the same selection, and nothing else on the row
    // (checkbox, thumbnail summary) is swallowed.
    const focusRow = () => { state.focused = row.id; state.tab = 'actions'; render(); };
    const focus = el('button', {
      type: 'button', id: `inspect-${row.id}`, className: 'row-focus',
      'aria-pressed': String(state.focused === row.id),
      onclick: () => focusRow(),
    },
    el('span', { className: 'time' },
      el('span', { className: 'time-value', title: gapTitle(timing.get(row.id)) }, timestamp(row.atMs)),
      el('span', { className: 'step-id', title: `步骤 ${row.id}` }, row.id)),
    kindChip(action),
    el('span', { className: 'row-description' }, el('strong', {}, actionLabel(action, { confirmPoint: !history })),
      el('small', {}, `${scope ? scopeText(scope) : `${appLabel(row.app)} · ${row.window}`}${ignored ? ' · 已忽略' : ''}`,
        historyChip, confirmChip, windowFallbackChip(runEntry))),
    el('span', { className: 'time row-duration', title: '动作耗时' }, duration(row.durationMs)),
    statusCell(runEntry));
    const thumbnail = row.thumbnail && el('details', {
      className: 'thumbnail', open: state.expanded.has(row.id),
      ontoggle: event => {
        if (event.target.open) state.expanded.add(row.id);
        else state.expanded.delete(row.id);
      },
    }, el('summary', {}, '查看缩略图'), el('img', { src: row.thumbnail, alt: '动作截图', loading: 'lazy' }));
    nodes.push(el('article', {
      className: `card card-sm bg-base-300 row${state.focused === row.id ? ' active' : ''}${ignored ? ' ignored' : ''}`,
      onclick: event => {
        if (event.target?.closest?.('button, input, summary, a, label, details')) return;
        focusRow();
      },
    }, el('div', { className: 'card-body row-line' }, selector, focus), thumbnail || undefined));
  }
  $('timeline').replaceChildren(...nodes);
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
      ...(state.session.version === 2
        ? [
          ['作用域', `${state.session.scopeGroups.length} 个`],
          ['应用路径', Object.entries(state.session.appPaths ?? {}).map(([app, path]) => `${appLabel(app)}: ${path}`)
            .join('\n') || '未固定（按唯一运行实例）'],
        ]
        : [
          ['目标', `${appLabel(state.session.target.app)} · ${state.session.target.window}`],
          ['应用路径', state.session.target.appPath ?? '未指定（按唯一运行实例）'],
          ...(state.session.pathConflict
            ? [['快照路径', `${state.session.snapshotAppPath} · 与应用路径不一致`]]
            : []),
        ]),
      ['来源', short(state.session.directory.split('/').at(-1), 44)],
    ], 'meta-grid'),
    state.session.pathConflict
      ? muted('快照来自另一个应用路径，离线运行会以 APP_AMBIGUOUS / fixture_path_mismatch 阻塞。请重新采集快照或恢复与快照匹配的目标。')
      : muted(state.session.version === 2
        ? '全局 flow 按步骤作用域分组；实时回放要等跨 App 调度器接入。'
        : '选择时间线中的动作查看定位器与整理操作。'));
}

function renderInspector() {
  for (const tab of ['actions', 'library']) {
    const node = $(`${tab}-tab`);
    node.setAttribute('aria-pressed', String(state.tab === tab));
    node.classList.toggle('tab-active', state.tab === tab);
  }
  const panel = $('inspector');
  if (state.tab === 'library') {
    const library = state.library ?? { builtin: [], custom: [] };
    const builtins = library.builtin ?? [];
    const canInsert = state.session?.version === 2;
    const groups = libraryGroups(library, state.libraryExpanded);
    const custom = groups.find(group => group.key === 'custom')?.items ?? [];
    // Both groups start collapsed: only the title and count show until the
    // operator opens one. The toggle is a real button, so it is keyboard
    // operable; expansion is page memory and a reload returns to collapsed.
    const section = (group, content) => {
      const bodyId = `library-group-${group.key}`;
      return el('section', { className: 'library-group' },
        el('button', {
          type: 'button', className: 'library-group-toggle',
          'aria-expanded': String(group.expanded), 'aria-controls': bodyId,
          'data-library-group': group.key,
          onclick: () => {
            state.libraryExpanded = toggleLibraryGroup(state.libraryExpanded, group.key);
            // Remember which toggle was operated so the redrawn button gets the
            // focus back and the operator can keep pressing Space/Enter.
            state.libraryFocus = group.key;
            renderInspector();
          },
        },
        icon(group.expanded ? 'up' : 'down'),
        el('span', { className: 'library-group-title' }, group.title),
        el('span', { className: 'badge badge-ghost badge-sm' }, String(group.count))),
        group.expanded ? el('div', { className: 'library-group-body', id: bodyId }, ...content) : undefined);
    };
    // Built-ins ship with the product: they are read-only and are inserted as
    // real steps, so they never appear as an editable library file.
    const builtinContent = [
      ...[['finder', 'Finder 基础动作'], ['universal', '通用（任何 App）'], ['check', '状态检查（文件 / 进程）']]
        .flatMap(([group, title]) => {
          const items = builtins.filter(item => item.group === group);
          if (!items.length) return [];
          return [
            el('h3', { className: 'inspector-heading library-group-heading' }, title),
            ...items.map(item => el('article', { className: 'library-item card bg-base-300' },
              el('div', { className: 'library-body' },
                el('h3', { className: 'card-title' }, item.name,
                  el('span', {
                    className: `badge badge-soft badge-sm ${
                      item.group === 'finder' ? 'badge-info'
                        : item.group === 'check' ? 'badge-success' : 'badge-ghost'}`,
                  }, item.appLabel)),
                muted(item.summary)),
              el('div', { className: 'actions' },
                libraryAction('插入', () => builtinInsertDialog(item), {
                  style: 'small primary', icon: 'plus', iconOnly: true, disabled: !canInsert,
                  title: canInsert ? '插入到草稿' : '需要「全局录制」录制才能插入内置行为',
                })))),
          ];
        }),
      !canInsert ? muted('插入内置行为需要「全局录制」录制；「单窗口」会话仍可引用「我的行为」。') : undefined,
    ];
    const customContent = custom.length ? custom.map(item => {
      const compatible = state.session?.version === 1 && sameTarget(item.target, state.session.target);
      const { behavior } = item;
      const shell = item.shell ?? { steps: 0, privileged: 0 };
      const blocked = !state.session ? '导入运行目录后才能' : '此行为属于另一目标窗口，无法';
      return el('article', { className: 'library-item card bg-base-300' },
        el('div', { className: 'library-body' },
          el('h3', { className: 'card-title' }, behavior.name,
            shell.privileged
              ? el('span', { className: 'badge badge-soft badge-sm badge-warning' }, '提权')
              : shell.steps
                ? el('span', { className: 'badge badge-soft badge-sm badge-ghost' }, 'Shell')
                : undefined),
          muted(`${behavior.steps.length} 步 · ${appLabel(item.target.app)}`),
          compatible || !state.session ? undefined : muted('此行为属于另一目标窗口。')),
        el('div', { className: 'actions' },
          libraryAction('引用', () => behaviorDialog(item, false), {
            style: 'small', icon: 'layers', iconOnly: true, disabled: !compatible,
            title: compatible ? '引用到草稿' : `${blocked}引用`,
          }),
          libraryAction('复制到草稿', () => behaviorDialog(item, true), {
            style: 'small', icon: 'copy', iconOnly: true, disabled: !compatible,
            title: compatible ? '复制到草稿' : `${blocked}复制`,
          })));
    }) : [empty('从时间线选中多个动作，合并到行为库。')];
    panel.replaceChildren(el('div', { className: 'stack-list' },
      el('p', { className: 'eyebrow' }, '行为库 · 按需展开'),
      ...groups.map(group =>
        section(group, group.key === 'builtin' ? builtinContent : customContent))));
    const focusGroup = state.libraryFocus;
    state.libraryFocus = undefined;
    if (focusGroup !== undefined) {
      panel.querySelector(`.library-group-toggle[data-library-group="${focusGroup}"]`)?.focus();
    }
    return;
  }
  const row = getRows().find(action => action.id === state.focused);
  if (!row) {
    panel.replaceChildren(state.session ? renderOverview() : empty('选择时间线中的动作查看定位器与整理操作。'));
    return;
  }
  const ignored = state.ignored.has(row.id);
  const editable = !ignored && isCompatible(row);
  // The action timeline keeps every recorded row, but a v2 step may have been
  // edited or deleted since. Read the current flow step here too, so the detail
  // panel names the same target as the row; a deleted step stays visible as the
  // recording snapshot and must not keep a live 需确认 marker.
  const isV2 = state.session?.version === 2;
  const current = isV2 ? v2Step(row.id) : undefined;
  const action = current ?? row.action;
  const history = isV2 && !current;
  const scope = action.scope ?? row.scope;
  const target = actionTarget(action);
  const recordedAt = stepTiming(getRows()).get(row.id);
  panel.replaceChildren(el('div', { className: 'stack-list' },
    el('h3', { className: 'inspector-heading' },
      el('span', { className: 'step-id badge badge-ghost badge-sm', title: '步骤 id' }, row.id),
      actionLabel(action, { confirmPoint: !history })),
    infoList([
      ['动作', KIND_LABELS[actionKind(action)] ?? action.kind],
      ...(action.kind === 'scroll' ? [['滚动', scrollLabel(action)]] : []),
      ...(action.kind === 'drag'
        ? [['起点', targetLabel(action.from)], ['终点', targetLabel(action.to)],
          ['时长', `${action.durationMs} ms`]]
        : []),
      ...(action.kind === 'hover' ? [['停留', `${action.durationMs} ms`]] : []),
      ...(action.kind === 'hover' && scope?.kind === 'screen' ? [
        ['坐标', `(${action.point.join(', ')})`],
        ...(action.hint ? [['录制时目标', hoverHintLabel(action.hint)]] : []),
      ] : []),
      ...(action.kind === 'paste'
        ? [typeof action.text === 'string'
          ? ['文本', `${action.text.length} 字（内容不写入报告）`]
          : ['粘贴来源', action.source.kind === 'copy'
            ? `复制 · ${action.source.stepId}` : `参数 · ${action.source.input}`]]
        : []),
      ...(scope ? [['作用域', scopeText(scope)]] : []),
      ...(scope ? [] : [['应用', appLabel(row.app)], ['窗口', row.window]]),
      ...(action.kind === 'manual_checkpoint' ? [
        ['触发步骤', action.triggerStepId],
        ['恢复条件', resumeLabel(action.resume?.check)],
        ['等待上限', duration(action.timeoutMs)],
      ] : []),
      ...(target ? [['定位器', locatorDetail(target)]] : []),
      ['时间', timestamp(row.atMs)],
      ...(recordedAt ? [['距上一步', gapLabel(recordedAt)]] : []),
      ['耗时', duration(row.durationMs)],
    ], 'meta-grid'),
    history ? muted('该步骤已从当前工作流删除；这里显示的是录制快照，仅供复盘。') : undefined,
    isCompatible(row) ? undefined : muted('该动作属于另一窗口，只能在时间线复盘。'),
    action.kind === 'manual_checkpoint'
      ? muted(action.reason === 'system_dialog'
        ? '回放时先检测系统弹框。请在桌面上处理弹框，再回到运行终端输入 continue。'
        : '回放时请在目标界面由操作者完成授权或输入密码，随后在运行终端输入 continue 独立确认；' +
          'CueKeeper 不读取密码，超时或取消即停在这里，后续步骤不执行。')
      : undefined,
    el('div', { className: 'actions' },
      button('加入测试项', () => addAction(action), { icon: 'listPlus', disabled: !editable }),
      button('添加断言', () => assertionDialog(row), { icon: 'checkCircle', disabled: !editable }),
      button('重新拾取', () => action.kind === 'drag' ? dragDialog(row) : locatorDialog(row), {
        icon: 'crosshair', disabled: !editable || action.kind === 'key' || action.kind === 'shell',
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
  $('shell-button').disabled = saving || state.running || state.session?.version === 2;
  $('privilege-button').disabled = saving || state.running || state.session?.version === 2;
  $('run-button').disabled = (!draft.length && !state.running) || saving || state.session?.version === 2;
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

// --- Version 2 editor -----------------------------------------------------------
// The page never edits a flow itself: every button sends one EditOp to the
// server-side P2 engine and renders the snapshot it returns.

const v2Section = el('section', { className: 'v2 pane card', id: 'v2-editor', hidden: true });
document.querySelector('main.workspace').after(v2Section);
// The workflow the v2 list last showed, so a redraw keeps the scroll position
// while opening another recording starts at the top.
let v2RenderedFlow;

const v2Flow = () => state.v2?.flow;
const v2Steps = () => v2Flow()?.steps ?? [];
const v2Step = stepId => v2Steps().find(step => step.id === stepId);
const v2ScopeText = scope => scopeDescription(scope, appLabel);

// A dry-run result describes the flow it ran on. Once an edit changes that
// flow, its per-step marks and the status line stop being true: the report is
// dropped and the old "N 步需确认" notice is replaced, so the page never shows
// a stale conclusion about a flow the operator already fixed.
function retireDryRunReport() {
  const retired = state.v2Report?.mode === 'dry-run';
  state.v2Report = null;
  if (retired) status('工作流已修改，上次 dry-run 结果已失效，请重新运行');
}

window.addEventListener('beforeunload', event => {
  if (!state.v2?.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function v2Call(route, payload = {}) {
  if (!state.session || state.v2Busy) return undefined;
  state.v2Busy = true;
  renderV2();
  try {
    const result = await api(route, { session: state.session.id, ...payload });
    if (result?.v2) state.v2 = result.v2;
    else if (result?.flow) {
      state.v2 = result;
      // A new edit invalidates the last run's per-step marks and notice.
      retireDryRunReport();
    }
    const editedFlow = result?.v2?.flow ?? result?.flow;
    if (editedFlow && state.templateMode) {
      // Keep variable marks pointing at steps that still exist; a deleted step
      // must not turn into a save-time error the page cannot explain.
      const ids = new Set(editedFlow.steps.map(step => step.id));
      state.templateMode.selections = state.templateMode.selections
        .filter(selection => ids.has(selection.stepId));
    }
    return result;
  } catch (error) {
    status(error.message, 'error');
    throw error;
  } finally {
    state.v2Busy = false;
    renderV2();
    renderTimeline();
    // The action inspector reads the current v2 step too. An already-open
    // detail must follow an edit or delete instead of waiting for another click.
    renderInspector();
  }
}

const v2Edit = op => v2Call('v2/edit', { op });

async function v2Save() {
  try {
    const result = await api('save', { session: state.session.id });
    state.v2 = result.v2;
    renderV2();
    renderTimeline();
    renderInspector();
    status(`已保存工作流 · ${result.output}`, 'success');
  } catch (error) {
    status(error.message, 'error');
  }
}

async function v2Undo() {
  const result = await api('v2/undo', { session: state.session.id }).catch(error => {
    status(error.message, 'error');
    return undefined;
  });
  if (result?.flow) {
    state.v2 = result;
    retireDryRunReport();
    renderV2();
    renderTimeline();
    renderInspector();
  }
}

async function v2Redo() {
  const result = await api('v2/redo', { session: state.session.id }).catch(error => {
    status(error.message, 'error');
    return undefined;
  });
  if (result?.flow) {
    state.v2 = result;
    retireDryRunReport();
    renderV2();
    renderTimeline();
    renderInspector();
  }
}

function v2Move(stepId, toIndex) {
  if (toIndex < 0 || toIndex >= v2Steps().length) return;
  void v2Edit({ kind: 'move', id: stepId, toIndex }).catch(() => {});
}

function v2Delete(stepId) {
  if (v2Steps().length <= 1) {
    status('流程至少保留一个步骤。', 'error');
    return;
  }
  void v2Edit({ kind: 'delete', id: stepId }).catch(() => {});
}

function v2Copy(step) {
  if (!V2_COPYABLE_KINDS.has(step.kind)) {
    status(`${KIND_LABELS[step.kind] ?? step.kind} 不能从时间线复制。`, 'error');
    return;
  }
  const index = v2Steps().findIndex(entry => entry.id === step.id);
  const copy = { ...structuredClone(step), id: id(step.kind) };
  void v2Edit({ kind: 'insert', index: index + 1, step: copy }).catch(() => {});
}

// --- Templates -----------------------------------------------------------------
// A template is the current workflow with some string values replaced by
// `{{name}}` placeholders. Marking happens on the timeline; applying a template
// writes a new workflow and switches the session, so the template stays a
// reusable source instead of being edited in place.

const templateFieldLabels = {
  'target.name': '点击目标', 'from.name': '拖拽起点', 'to.name': '拖拽终点',
  'check.target.name': '检查目标', 'scope.windowTitle': '窗口标题',
  'scope.fileName': '文件名', text: '输入文本', expect: '期望值',
};

function templateSelectionsFor(stepId) {
  return state.templateMode?.selections.filter(selection => selection.stepId === stepId) ?? [];
}

async function v2StartTemplate() {
  if (!state.v2) {
    status('先打开一条版本 2 工作流，再创建模板。', 'error');
    return;
  }
  try {
    const result = await api('templates/candidates', { session: state.session.id });
    const candidates = result.candidates ?? [];
    if (!candidates.length) {
      status('这条工作流没有可变成变量的文本值。', 'error');
      return;
    }
    state.templateCandidates = candidates;
    state.templateMode = { selections: [] };
    state.v2Selected = null;
    renderV2();
    status('模板标记：点步骤前的图标，选要变成变量的值。标好后点「保存模板」。');
  } catch (error) {
    status(error.message, 'error');
  }
}

function v2CancelTemplate() {
  state.templateMode = null;
  state.templateCandidates = [];
  renderV2();
  status('已退出模板标记，工作流没有改变。');
}

function v2TemplateStepDialog(step) {
  const candidates = state.templateCandidates.filter(candidate => candidate.stepId === step.id);
  if (!candidates.length) {
    status('这一步没有可变成变量的文本值。', 'error');
    return;
  }
  const marked = templateSelectionsFor(step.id);
  const rows = candidates.map(candidate => {
    const existing = marked.find(selection => selection.field === candidate.field);
    const checked = el('input', {
      type: 'checkbox', className: 'checkbox checkbox-sm', checked: Boolean(existing),
    });
    const name = input({ value: existing?.parameter ?? candidate.suggested, maxLength: 64 });
    name.disabled = !existing;
    checked.onchange = () => { name.disabled = !checked.checked; };
    return {
      candidate, checked, name,
      node: el('div', { className: 'template-field' },
        el('label', { className: 'check-row' },
          checked,
          el('span', {}, `${templateFieldLabels[candidate.field] ?? candidate.field} · `),
          el('span', { className: 'muted' }, short(candidate.value, 90))),
        field('变量名', name, '在模板里写作 {{变量名}}；留空会使用建议名')),
    };
  });
  openDialog(withStepId('标记模板变量', step), [
    muted('勾选要变成变量的值。同一个变量名可以出现在多个步骤里，但它们的值必须一致。'),
    ...rows.map(row => row.node),
  ], '应用标记', () => {
    const parameterPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
    const rest = state.templateMode.selections.filter(selection => selection.stepId !== step.id);
    const added = rows.filter(row => row.checked.checked).map(row => {
      const parameter = row.name.value.trim();
      if (!parameterPattern.test(parameter)) {
        throw new Error('变量名以字母开头，只含字母、数字与下划线。');
      }
      return {
        stepId: step.id, field: row.candidate.field, parameter,
        label: templateFieldLabels[row.candidate.field] ?? row.candidate.field,
      };
    });
    state.templateMode.selections = [...rest, ...added];
    renderV2();
    status(added.length
      ? `已标记「${v2StepLabel(step, appLabel)}」的 ${added.length} 处变量。`
      : `已取消「${v2StepLabel(step, appLabel)}」的变量标记。`, 'success');
  });
}

function v2SaveTemplate() {
  const mode = state.templateMode;
  if (!mode) return;
  if (!mode.selections.length) {
    status('至少标记一处变量再保存模板。', 'error');
    return;
  }
  const name = input({ required: true, maxLength: 256, placeholder: '例如 登录后台并导出报表' });
  const description = el('textarea', { className: 'textarea', rows: 3, maxLength: 2000 });
  const names = [...new Set(mode.selections.map(selection => selection.parameter))];
  openDialog('保存模板', [
    field('模板名称', name),
    field('说明（可选）', description),
    muted(`已标记 ${mode.selections.length} 处变量：${names.join('、')}`),
    muted('模板只保存变量占位符和默认值；当前工作流与原始录制都不会改变。'),
  ], '保存模板', async () => {
    const saved = await api('templates/create', {
      session: state.session.id,
      name: name.value.trim(),
      description: description.value.trim(),
      selections: mode.selections,
    });
    state.templateMode = null;
    state.templateCandidates = [];
    renderV2();
    status(`已保存模板「${saved.template.name}」· ${saved.path}`, 'success');
  });
}

function downloadTemplate(template) {
  const blob = new Blob([`${JSON.stringify(template, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${template.id}.template.json` });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke after the download starts; an immediate revoke can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(`已导出模板「${template.name}」`, 'success');
}

function applyTemplateDialog(template) {
  const values = template.parameters.map(parameter => ({
    parameter,
    control: input({
      value: parameter.defaultValue ?? '', maxLength: 4000,
      required: parameter.defaultValue === undefined,
    }),
  }));
  const name = input({ value: template.name, maxLength: 256 });
  openDialog(`应用模板 · ${template.name}`, [
    ...values.map(({ parameter, control }) =>
      field(`${parameter.label}（${parameter.name}）`, control)),
    field('新工作流名称', name),
    state.v2?.dirty
      ? muted('当前工作流有未保存修改；应用模板会切换到新会话，请先保存要保留的修改。')
      : undefined,
    muted('应用会写入一条新的「全局录制」工作流并切换当前会话；模板文件与原始录制都不会改变。'),
  ], '应用', async () => {
    const map = {};
    for (const { parameter, control } of values) {
      const value = control.value;
      if (!value.trim()) throw new Error(`填写「${parameter.label}」。`);
      map[parameter.name] = value;
    }
    const applied = await api('templates/apply', {
      templateId: template.id, values: map,
      name: name.value.trim() || template.name, discardEdits: true,
    });
    setSession(applied.session);
    status(`已应用模板「${template.name}」· 新工作流 ${applied.output}`, 'success');
  });
}

function deleteTemplateDialog(template) {
  openDialog('删除模板', [
    muted(`确认删除模板「${template.name}」？`),
    muted(`文件 ${template.id}.template.json 会从模板目录移除；已经应用生成的工作流不受影响。`),
  ], '删除', async () => {
    await api('templates/delete', { templateId: template.id });
    status(`已删除模板「${template.name}」`, 'success');
    // Re-open the list after this dialog closes; the caller owns that close.
    setTimeout(() => void templateDialog(), 0);
  });
}

async function templateDialog() {
  let result;
  try {
    result = await api('templates/list', { session: state.session?.id });
  } catch (error) {
    status(error.message, 'error');
    return;
  }
  const templates = result.templates ?? [];
  const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  file.onchange = async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    try {
      const parsed = JSON.parse(await chosen.text());
      const imported = await api('templates/import', { template: parsed });
      status(imported.renamed
        ? `模板 id 已存在，导入为「${imported.template.name}」· ${imported.template.id}`
        : `已导入模板「${imported.template.name}」· ${imported.path}`, 'success');
      dialog.close();
      await templateDialog();
    } catch (error) {
      status(`导入失败：${error.message}`, 'error');
      file.value = '';
    }
  };
  const rows = templates.map(template => el('div', { className: 'template-row' },
    el('div', { className: 'template-copy' },
      el('strong', {}, template.name),
      template.description ? el('small', { className: 'muted' }, template.description) : undefined,
      el('span', { className: 'muted' },
        `${template.parameters.length} 个变量 · ${template.parameters.map(parameter => parameter.name).join('、')}` +
        (template.createdAt ? ` · ${template.createdAt.slice(0, 10)}` : ''))),
    el('div', { className: 'template-actions' },
      button('应用', () => {
        dialog.close();
        applyTemplateDialog(template);
      }, { style: 'small primary', icon: 'play' }),
      button('导出', () => downloadTemplate(template), { style: 'small', icon: 'download' }),
      button('删除', () => {
        dialog.close();
        deleteTemplateDialog(template);
      }, { style: 'small danger', icon: 'trash', iconOnly: true, title: '删除模板' }))));
  openDialog('本地模板', [
    muted(`模板存放在 ${result.directory}。应用模板会生成新的工作流，不会修改模板本身。`),
    templates.length
      ? el('div', { className: 'template-list stack-list' }, ...rows)
      : empty('还没有模板。打开一条「全局录制」工作流后，在时间线里点「创建模板」。'),
    el('div', { className: 'actions' },
      button('从当前工作流创建', () => {
        if (!state.v2) {
          status('先打开一条版本 2 工作流。', 'error');
          return;
        }
        dialog.close();
        void v2StartTemplate();
      }, { style: 'small primary', icon: 'braces', disabled: !state.v2 }),
      button('导入模板', () => file.click(), { style: 'small', icon: 'upload' })),
    file,
  ], undefined, undefined, { wide: true });
}

$('template-button').addEventListener('click', () => void templateDialog());


function renderV2() {
  // The batch view owns the page; the v2 editor belongs to the edit mode only.
  if (state.mode === 'batch') {
    v2Section.hidden = true;
    document.body.classList.remove('v2-mode');
    return;
  }
  const editor = state.v2;
  if (!state.session || state.session.version !== 2 || !editor) {
    v2Section.hidden = true;
    v2Section.replaceChildren();
    document.body.classList.remove('v2-mode');
    return;
  }
  v2Section.hidden = false;
  document.body.classList.add('v2-mode');
  const flow = editor.flow;
  const steps = flow.steps;
  const diff = diffSummary(editor.diff);
  const differenceList = diffItems(editor.diff);
  const dirty = editor.dirty ?? diff.changed;
  const options = scopeOptions(flow, appLabel);
  const visible = filterStepsByScope(flow, state.v2Filter);
  const statuses = statusMap(state.v2Report);
  const selected = state.v2Selected;
  const busy = state.v2Busy || state.v2Running;
  const saved = editor.saved?.at(-1);

  const filter = select([['', '全部作用域'], ...options.map(option => [option.key, option.label])],
    event => { state.v2Filter = event.target.value; renderV2(); });
  filter.value = state.v2Filter;

  const rowActions = step => el('div', { className: 'v2-row-actions' },
    step.kind === 'gap'
      ? button('处理缺口', () => v2GapDialog(step), { style: 'small', icon: 'sliders', disabled: busy })
      : step.kind === 'manual_checkpoint'
        ? button('查看', () => v2CheckpointDialog(step), { style: 'small', icon: 'eye', disabled: busy })
        : button('编辑', () => v2EditDialog(step), { style: 'small', icon: 'sliders', disabled: busy }),
    button('上移', () => v2Move(step.id, steps.findIndex(entry => entry.id === step.id) - 1), {
      style: 'small', icon: 'up', iconOnly: true, title: '上移',
      disabled: busy || steps.findIndex(entry => entry.id === step.id) === 0,
    }),
    button('下移', () => v2Move(step.id, steps.findIndex(entry => entry.id === step.id) + 1), {
      style: 'small', icon: 'down', iconOnly: true, title: '下移',
      disabled: busy || steps.findIndex(entry => entry.id === step.id) === steps.length - 1,
    }),
    button('复制', () => v2Copy(step), {
      style: 'small', icon: 'copy', iconOnly: true, title: '复制步骤',
      disabled: busy || !V2_COPYABLE_KINDS.has(step.kind),
    }),
    button('删除', () => step.kind === 'gap' ? v2GapDialog(step) : v2Delete(step.id), {
      style: 'small danger', icon: 'trash', iconOnly: true, disabled: busy,
      // A gap is the one step whose deletion drops input evidence, so its row
      // delete opens the same confirmation dialog instead of deleting silently.
      title: step.kind === 'gap' ? '删除缺口需先确认' : '删除步骤',
    }));

  const rows = visible.map(step => {
    const index = steps.findIndex(entry => entry.id === step.id);
    const entry = statuses.get(step.id);
    const marked = templateSelectionsFor(step.id);
    const candidateCount = state.templateCandidates
      .filter(candidate => candidate.stepId === step.id).length;
    return el('article', {
      className: `v2-row${selected === step.id ? ' selected' : ''}`,
      draggable: !busy,
      ondragstart: event => {
        event.dataTransfer.setData('text/plain', step.id);
        event.dataTransfer.effectAllowed = 'move';
      },
      ondragover: event => event.preventDefault(),
      ondrop: event => {
        event.preventDefault();
        const dragged = event.dataTransfer.getData('text/plain');
        if (dragged && dragged !== step.id) v2Move(dragged, index);
      },
      onclick: () => { state.v2Selected = step.id; renderV2(); },
    },
    state.templateMode
      ? candidateCount
        ? el('button', {
          type: 'button', className: `v2-mark${marked.length ? ' marked' : ''}`,
          title: marked.length ? '已标记变量 · 点击修改' : '标记模板变量',
          'aria-label': marked.length ? `已标记 ${marked.length} 处变量，点击修改` : '标记模板变量',
          onclick: event => { event.stopPropagation(); v2TemplateStepDialog(step); },
        }, icon('braces', 14),
        marked.length ? el('span', { className: 'count' }, String(marked.length)) : undefined)
        : el('span', { className: 'v2-mark empty', title: '这一步没有可标记的文本值' })
      : undefined,
    el('span', { className: 'v2-index' },
      el('span', { className: 'v2-ordinal' }, String(index + 1)),
      el('span', { className: 'step-id', title: `步骤 ${step.id}` }, step.id)),
    kindChip(typeof step === 'string' ? step : step.kind),
    el('div', { className: 'v2-copy' },
      el('strong', {}, v2StepLabel(step, appLabel)),
      el('small', { className: 'muted' },
        `${step.kind === 'gap' ? gapReason(step.code) : v2ScopeText(step.scope)}`,
        pointConfirmChip(step))),
    statusCell(entry, stateCheckLabel(entry?.stateCheck)),
    rowActions(step));
  });

  const validation = editor.validation ?? { ok: true, errors: [] };
  // Every edit and every click on a row redraws this list. Keep the operator's
  // place in the flow, unless a different workflow is now on screen: switching
  // sessions starts at the first step again.
  const flowKey = editor.flowPath ?? editor.flow?.id;
  const previousRows = v2Section.querySelector('.v2-rows');
  const scrollTop = previousRows && v2RenderedFlow === flowKey ? previousRows.scrollTop : 0;
  v2Section.replaceChildren(
    el('div', { className: 'v2-header' },
      el('h2', { className: 'card-title' }, el('span', { className: 'sec' }, '03'), ' 时间线'),
      stateChip(dirty ? 'inferred' : 'confirmed',
        dirty ? '未保存修改' : diff.changed ? '已保存工作流' : '与录制一致'),
      state.v2Running
        ? stateChip(state.v2Checkpoint ? 'inferred' : 'confirmed',
          state.v2Checkpoint ? '等待人工授权' : '回放中')
        : undefined,
      state.templateMode
        ? stateChip('inferred',
          `模板标记 · ${state.templateMode.selections.length} 处变量`)
        : undefined,
      el('span', { className: 'trailing' }),
      filter,
      button('撤销', () => void v2Undo(), { style: 'small', icon: 'undo', disabled: busy || !editor.canUndo }),
      button('重做', () => void v2Redo(), { style: 'small', icon: 'refresh', disabled: busy || !editor.canRedo }),
      button('插入步骤', () => v2InsertDialog(), { style: 'small', icon: 'plus', disabled: busy }),
      button('保存工作流', () => void v2Save(), {
        style: 'small', icon: 'save', disabled: busy || !dirty,
      }),
      state.templateMode
        ? button('保存模板', () => v2SaveTemplate(), {
          style: 'small primary', icon: 'braces',
          disabled: busy || !state.templateMode.selections.length,
          title: '把已标记的值保存为可复用模板',
        })
        : button('创建模板', () => void v2StartTemplate(), {
          style: 'small', icon: 'braces', disabled: busy, title: '把这条工作流里的值变成模板变量',
        }),
      state.templateMode
        ? button('取消标记', () => v2CancelTemplate(), { style: 'small', icon: 'x', disabled: busy })
        : undefined,
      button('dry-run', () => void v2DryRun(), { style: 'small', icon: 'checkCircle', disabled: busy }),
      button(state.v2Running ? '回放中' : '实时回放', () => state.v2Running ? void v2StopRun() : void v2LiveDialog(), {
        style: 'small primary', icon: 'play', loading: state.v2Running,
        title: state.v2Running ? '点击停止回放' : undefined,
        disabled: !state.v2Running && (busy || !state.allowLive),
      })),
    checkpointPanel() ?? '',
    rows.length
      ? el('div', { className: `v2-rows${state.templateMode ? ' marking' : ''}` }, ...rows)
      : empty('当前作用域筛选下没有步骤。'),
    el('div', { className: 'v2-footer' },
      // The operator already sees the edits on the steps themselves; a one-line
      // recap of every moved step is noise. The comparison stays available as
      // the actual difference list behind one disclosure.
      diff.changed
        ? el('details', { className: 'v2-diff' },
          el('summary', {}, `查看与录制的差异 · ${differenceList.length} 项`),
          el('ul', { className: 'v2-diff-list' }, ...differenceList.map(item => el('li', {}, item))))
        : muted('与录制一致，尚未修改。'),
      saved ? muted(`最近保存的工作流：${saved.path}`) : muted('保存会在录制旁写一份工作流副本，原始录制保持不变。'),
      validation.ok ? undefined : el('ul', { className: 'v2-errors' }, ...validation.errors.map(error =>
        el('li', {}, `${error.stepId ? `${error.stepId} · ` : ''}${error.code} · ${error.message}`))),
      state.templateMode
        ? muted('模板标记模式：每行左侧的 {} 图标用来选中要变成变量的值；保存模板只生成副本，当前工作流不变。')
        : undefined,
      muted('拖拽行可排序；点击行后「插入步骤」接在其后。未保存的修改在离开页面前会提示。')));
  v2RenderedFlow = flowKey;
  const nextRows = v2Section.querySelector('.v2-rows');
  if (nextRows) nextRows.scrollTop = scrollTop;
}

function v2DryRun() {
  void v2Call('run', { mode: 'dry-run' }).then(report => {
    if (!report?.entries) return;
    state.v2Report = report;
    renderV2();
    renderTimeline();
    const failed = report.entries.filter(entry => entry.status !== 'resolved');
    const blocked = report.entries.filter(entry => entry.status === 'blocked');
    // The dry run cannot open a window; it only says how many steps could use
    // the app's front window when their recorded title is gone.
    const fallbacks = state.v2?.windowFallbackCount ?? 0;
    status(`dry-run ${resultStatus[report.status] ?? report.status} · ${report.entries.length} 步` +
      (blocked.length ? ` · ${blocked.length} 步需确认` : failed.length ? ` · ${failed.length} 步异常` : '') +
      (fallbacks
        ? ` · ${fallbacks} 个窗口步骤在记录窗口不存在时会尝试退回该 App 的前台窗口（需目标唯一）`
        : ''),
    // Only a v2 dry run treats blocked as a confirmation step; every other run
    // keeps its original success / error tone.
    report.status === 'passed' ? 'success' : report.status === 'blocked' ? 'warning' : 'error');
  }).catch(() => {});
}

/** One line explaining where a prefilled value came from, or why it is empty. */
function v2InputStatus(entry, step) {
  if (!entry) return '无值 · 回放前请填写';
  if (entry.sensitive) return '敏感 · 不会自动填入，请手动填写';
  // A value stays usable after the target was changed, but the operator has to
  // know which control it was typed into while recording.
  const recorded = Array.isArray(entry.targets) ? entry.targets[0] : undefined;
  const current = step?.target?.kind === 'element' ? step.target : undefined;
  const changed = Boolean(recorded && current &&
    (recorded.role !== current.role || (recorded.name ?? '') !== (current.name ?? '')));
  const altered = changed ? ` · 录制时用于「${recorded.name ?? recorded.role}」` : '';
  if (entry.complete === false) {
    return `来自录制但不完整 · 部分字符没读到（输入法或采集中断），请核对${altered}`;
  }
  return `来自录制，可直接回放或修改${altered}`;
}

async function v2LiveDialog() {
  const flow = v2Flow();
  if (!flow) return;
  // The server names the file the run would read: the newest revision, or the
  // recording itself when nothing was edited.
  const live = state.v2?.live;
  // Everything this dialog reads, clears, saves and runs belongs to the session
  // and replay target it was opened for. A load that finishes after another
  // flow was imported must be dropped: its values are the other flow's text.
  const openedSession = state.session?.id;
  const openedTarget = live?.path;
  const openedFlowId = flow.id;
  const stillCurrent = () => state.session?.id === openedSession &&
    state.v2?.live?.path === openedTarget && v2Flow()?.id === openedFlowId;
  // Values recorded next to the flow prefill the dialog. A read failure is a
  // warning inside the dialog, never a reason to deny the replay: the operator
  // can still type every value by hand.
  let stored = { values: {} };
  let storedWarning;
  if (live) {
    try {
      stored = await api('v2/inputs', {
        session: openedSession, ...(openedTarget ? { target: openedTarget } : {}),
      });
      // The flow changed while the values were loading; opening now would show
      // this flow's text next to another flow's steps.
      if (!stillCurrent()) return;
      storedWarning = stored.warning;
    } catch (error) {
      // A stale session answers "Reload the current session"; that is not a
      // warning for this dialog, it means this dialog is obsolete.
      if (!stillCurrent()) return;
      storedWarning = error instanceof Error ? error.message : String(error);
    }
  }
  const confirmed = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const remember = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const controls = new Map((flow.inputs ?? []).map(name => {
    const entry = stored.values?.[name];
    const step = flow.steps.find(item => item.kind === 'type' && item.input === name);
    const node = input({
      id: `live-input-${name}`,
      maxLength: 4000, spellcheck: false, autocomplete: 'off',
      placeholder: entry?.sensitive ? '该参数标记为敏感，请手动填写' : '填写本次回放使用的值',
    });
    if (typeof entry?.value === 'string') node.value = entry.value;
    const record = { node, entry };
    const status = el('span', { className: 'muted', id: `live-input-status-${name}` },
      v2InputStatus(entry, step));
    // Clearing writes the file immediately and on its own: an operator who
    // clears a value and closes the dialog must not be left with it on disk.
    // A sensitive entry has no text to clear, so it gets no button.
    const clear = typeof entry?.value === 'string'
      ? button('清除已存值', async () => {
        clear.disabled = true;
        try {
          if (!stillCurrent()) throw new Error('当前工作流已切换，请重新打开回放弹窗');
          await api('v2/inputs/save', {
            session: openedSession, ...(openedTarget ? { target: openedTarget } : {}),
            values: { [name]: null },
          });
          // A response for a dialog that was replaced must not paint state onto
          // the new one.
          if (!stillCurrent()) return;
          node.value = '';
          record.entry = undefined;
          status.textContent = '已清除已存值，本次仍需填写';
        } catch (error) {
          if (!stillCurrent()) return;
          clear.disabled = false;
          status.textContent = `清除失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }, { style: 'small', key: `live-clear-${name}` })
      : undefined;
    record.status = status;
    record.clear = clear;
    return [name, record];
  }));
  const checkpoints = flow.steps.filter(step => step.kind === 'manual_checkpoint');
  const screenHovers = flow.steps.filter(step => step.kind === 'hover' && step.scope?.kind === 'screen');
  openDialog('实时回放全局录制流程', [
    muted(!live
      ? '当前有未保存的修改，请先保存工作流。'
      : live.revision
        ? `将回放已保存的工作流：${live.path}`
        : `将直接回放导入的录制文件：${live.path}`),
    muted('会占用前台并可能触发 macOS 权限提示；运行期间点「停止回放」会中断 CLI。'),
    ...(storedWarning ? [muted(`已存参数值读取失败，本次请手动填写：${storedWarning}`)] : []),
    ...(checkpoints.length ? [muted(
      `含 ${checkpoints.length} 个人工检查点：回放会暂停在检查点，由你在真实界面完成授权，` +
      '再回到工作台点「已完成授权，继续」。工作台不接收密码；超时或取消就停在检查点。')] : []),
    ...(screenHovers.length ? [muted(
      `含 ${screenHovers.length} 条屏幕坐标悬停：只移动指针并停留，不点击、不聚焦；` +
      '坐标与录制时的屏幕布局绑定，窗口改名或版面变化后可能不再落在同一处。')] : []),
    el('label', { className: 'check-row' }, confirmed, '我确认回放会操作当前桌面的应用窗口'),
    ...(controls.size ? [
      el('h3', {}, '运行参数值'),
      muted('参数值只传给本次回放进程，不写入 flow 或报告；下面的默认值来自录制，保存在 flow 旁的本机值文件里。'),
      ...[...controls.entries()].map(([name, control]) => el('label', { className: 'field' },
        name, control.node,
        el('span', { className: 'muted' }, control.status, control.clear ? el('span', {}, ' ') : undefined, control.clear))),
      el('label', { className: 'check-row' }, remember, '把这次填写的值存为默认'),
    ] : []),
  ], '开始回放', async () => {
    if (!stillCurrent()) throw new Error('当前工作流已切换，请重新打开回放弹窗。');
    if (!confirmed.checked) throw new Error('确认后才会开始实时回放。');
    if (!state.v2?.live) throw new Error('当前有未保存的修改，请先保存工作流。');
    // Values are submitted verbatim: trimming silently changed a filename or a
    // URL that legitimately began or ended with a space. Only emptiness blocks.
    const filled = [...controls.entries()].map(([name, control]) => [name, control.node.value]);
    const missing = filled.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`请先填写运行参数：${missing.join('、')}`);
    // Clearing already happened when its button was pressed; this only writes
    // the optional "remember these values" choice.
    if (remember.checked) {
      await api('v2/inputs/save', {
        session: openedSession, ...(openedTarget ? { target: openedTarget } : {}),
        values: Object.fromEntries(filled),
      });
      // A flow imported while the save was in flight owns the page now; this
      // dialog's values must neither be written to it nor replayed in it.
      if (!stillCurrent()) throw new Error('当前工作流已切换，请重新打开回放弹窗。');
    }
    const inputs = Object.fromEntries(filled);
    // The replay may pause at a checkpoint; close the dialog and keep the page
    // live so the waiting panel can be answered.
    dialog.close();
    void v2StartLive(inputs, openedTarget);
  });
}

function showV2Result(report) {
  const counts = report.entries.reduce((memo, entry) => {
    memo[entry.status] = (memo[entry.status] ?? 0) + 1;
    return memo;
  }, {});
  const rows = report.entries.map(entry => {
    const step = v2Step(entry.id);
    return el('tr', {},
      el('td', { className: 'mono' }, entry.id),
      el('td', {}, step ? v2StepLabel(step, appLabel) : KIND_LABELS[entry.kind] ?? entry.kind),
      el('td', {}, el('span', { className: statusBadge(entry.status) }, resultStatus[entry.status] ?? entry.status)),
      el('td', { className: 'mono' }, `${entry.durationMs} ms`),
      el('td', { className: 'report-detail' }, [
        entry.code ? `${entry.code}${entry.message ? ` · ${entry.message}` : ''}` : '',
        stateCheckLabel(entry.stateCheck),
      ].filter(Boolean).join(' · '), windowFallbackChip(entry)));
  });
  const exportReport = async () => {
    try {
      // The workbench writes the report next to its other data and reveals it
      // in Finder; a browser download cannot open a folder from the page.
      const result = await api('report/export', { report, flowId: report.flowId });
      status(`报告已导出：${result.path}`, 'success');
      return;
    } catch {
      // Keep the page download as a fallback when the local export is blocked.
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `report-${report.flowId}-${Date.now()}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  openDialog('回放报告', [
    el('p', { className: 'report-summary' },
      `共 ${report.entries.length} 步 · 通过 ${counts.passed ?? 0} · 失败 ${counts.failed ?? 0}` +
      ` · 跳过 ${counts.skipped ?? 0}${report.stopped ? ' · 已停止' : ''}`),
    el('div', { className: 'report-table' },
      el('table', { className: 'table table-sm' },
        el('thead', {}, el('tr', {},
          el('th', {}, '步骤'), el('th', {}, '动作'), el('th', {}, '结果'),
          el('th', {}, '耗时'), el('th', {}, '详情'))),
        el('tbody', {}, ...rows))),
    ...(report.appIdentities ?? []).map(identity => muted(
      `${identity.app} · ${identity.status}${identity.code ? ` · ${identity.code}` : ''}` +
      (identity.reason ? ` · ${identity.reason}` : ''))),
  ], '导出报告', exportReport);
}

/** Every v2 detail panel names the flow step it edits, so the id matches the row. */
const withStepId = (title, step) => step?.id ? `${title} · ${step.id}` : title;

/**
 * Picking a live control is an edit of the step's target, so the entry lives
 * with the other target fields instead of on every timeline row. The capability
 * is unchanged: this still opens the same read-only window snapshot dialog.
 */
function v2PickEntry(step, onPicked, pickOptions) {
  return V2_TARGET_KINDS.has(step.kind) && step.kind !== 'drag'
    ? button('从窗口拾取', () => void v2PickDialog(step, onPicked, pickOptions), {
      style: 'small', icon: 'crosshair', title: '从当前窗口拾取目标元素',
      disabled: state.v2Busy || state.v2Running,
    })
    : undefined;
}

/** The row's 编辑 button opens the editor that fits the step's kind. */
function v2EditDialog(step) {
  switch (step.kind) {
    case 'click': case 'scroll':
      return v2TargetDialog(step);
    case 'hover': return step.scope?.kind === 'screen' ? v2ScreenHoverDialog(step) : v2HoverDialog(step);
    case 'type': return v2TypeDialog(step);
    case 'drag': return v2DragDialog(step);
    case 'key': return v2KeyDialog(step);
    case 'wait': return v2WaitDialog(step);
    case 'assert': return v2AssertDialog(step);
    case 'launch_app': case 'activate_app': case 'focus_window':
    case 'open_system_surface': case 'surface_press':
      return v2ScopeDialog(step);
    case 'manual_checkpoint': return v2CheckpointDialog(step);
    case 'gap': return v2GapDialog(step);
    default: return v2StepFactsDialog(step);
  }
}

/** A step without an editor still opens its facts under the same id. */
function v2StepFactsDialog(step) {
  openDialog(withStepId('步骤详情（只读）', step), [
    infoList([
      ['步骤 id', step.id],
      ['动作', v2StepLabel(step, appLabel)],
      ['作用域', step.kind === 'gap' ? '缺口' : v2ScopeText(step.scope)],
    ], 'meta-grid'),
    v2PickEntry(step),
    muted('这一步目前没有可视化编辑器；可在 flow 文件里修改后重新导入。'),
  ]);
}

function v2ScopeFields(initial = {}) {
  const kind = select([['window', '窗口'], ['app', '应用']]);
  kind.value = initial.kind === 'app' ? 'app' : 'window';
  const app = input({ value: initial.app ?? '', maxLength: 256, placeholder: 'com.apple.TextEdit' });
  const title = input({ value: initial.windowTitle ?? '', maxLength: 256 });
  const key = input({ value: initial.windowKey ?? '', maxLength: 64, placeholder: '留空自动生成' });
  const titleBox = field('窗口标题', title);
  const keyBox = field('windowKey', key);
  const sync = () => {
    titleBox.hidden = kind.value === 'app';
    keyBox.hidden = kind.value === 'app';
  };
  kind.onchange = sync;
  sync();
  return {
    controls: [field('作用域类型', kind), field('App 标识', app), titleBox, keyBox],
    value() {
      const appId = app.value.trim();
      if (!appId) throw new Error('填写 App 标识。');
      if (kind.value === 'app') return { kind: 'app', app: appId };
      if (!title.value.trim()) throw new Error('填写窗口标题。');
      return {
        kind: 'window', app: appId, windowTitle: title.value.trim(),
        ...(key.value.trim() ? { windowKey: key.value.trim() } : {}),
      };
    },
  };
}

function v2ScopeDialog(step) {
  if (!step.scope || step.scope.kind === 'surface') {
    openDialog(withStepId('作用域', step), [muted('系统界面步骤的作用域在录制时固定，当前版本只支持窗口与应用作用域编辑。')]);
    return;
  }
  const fields = v2ScopeFields(step.scope);
  openDialog(withStepId('编辑作用域', step), [
    ...fields.controls,
    muted(step.scope.kind === 'window'
      ? '更换 App 时会重建 windowKey；窗口标题必须同时更新。'
      : 'App 作用域没有窗口键。'),
  ], '应用', () => v2Edit({ kind: 'update', id: step.id, patch: { scope: fields.value() } }));
}

/**
 * The window a step's target lives in, in the operator's words. The scope is
 * where macOS resolves the control, so it belongs on the summary line.
 */
function targetWindowLabel(step) {
  return step.scope?.kind === 'window' ? step.scope.windowTitle : '';
}

/**
 * One readable line for a step's target: role and name (or 无名称), the window
 * it lives in, and — once a pick resolved the rectangle — its size. A
 * coordinate target has no role, so it says what it is instead.
 */
function targetSummaryText(target, { window: windowTitle = '', frame } = {}) {
  if (!target) return '这一步没有可定位的目标。';
  const head = target.kind === 'point'
    ? `屏幕坐标 (${(target.point ?? []).join(', ')})`
    : `${String(target.role ?? '').trim() || '控件'}（` +
      `${(typeof target.name === 'string' ? target.name.trim() : '') || '无名称'}）`;
  return head +
    (windowTitle ? `· ${windowTitle}` : '') +
    (frame ? ` · ${frame.width} × ${frame.height}` : '');
}

/**
 * The display-only note a coordinate hover kept about what the recording saw.
 * It never becomes a locator: the point is the address, this is for the person
 * deciding whether to re-record.
 */
function hoverHintLabel(hint) {
  const element = hint?.element;
  const roles = element
    ? `${element.role}（${(element.name ?? '').trim() || '无名称'}）`
    : '';
  return [roles, hint?.windowTitle ?? ''].filter(Boolean).join(' · ');
}

/**
 * A picked locator describes the whole control. The element merge inherits any
 * field the patch omits, so a stale path/index (and name) from the recorded
 * target has to be cleared explicitly, or the replay would address a control
 * that no longer matches.
 */
function pickedTargetPatch(locator) {
  return {
    ...locator,
    ...(locator.name === undefined ? { name: null } : {}),
    ...(locator.path === undefined ? { path: null } : {}),
    ...(locator.index === undefined ? { index: null } : {}),
  };
}

/**
 * Click and scroll address exactly one control, so their editor keeps the
 * summary, the pick entry and the three fields that repair a recorded locator:
 * the control type (role), the name the operator sees, and which same-named
 * control to take (index). A recorded deep anonymous group can be fixed by
 * typing a name or by picking a control; path, the exact-name flag and the
 * replay preview are not offered, because an everyday repair never needs them.
 *
 * The pick lands in this form and is written on 应用, so closing the editor
 * never leaves a half-edited target behind. The fields are compared against
 * what the form shows after backfilling, not against the raw locator: a
 * single-line input cannot hold a line break from a recorded name, and reading
 * the values back keeps an untouched form from looking edited.
 *
 * Applying an untouched form keeps the recorded target as it is (a coordinate
 * stays a coordinate, a recorded path and identifier survive). An edit that
 * only changes the index stays inside the recorded role/name/path range, so
 * its path is kept; a new role or name names a different control, so the old
 * path is dropped. A recorded index that was never re-entered is refused after
 * the range changes instead of silently addressing a different control.
 */
function v2TargetDialog(step) {
  const windowTitle = targetWindowLabel(step);
  const recorded = step.target?.kind === 'element' ? step.target : undefined;
  let target = step.target;
  let picked;
  let frame;
  const summary = el('p', { className: 'target-summary' });
  const renderSummary = () => {
    summary.textContent = targetSummaryText(target, { window: windowTitle, frame });
  };
  renderSummary();
  const role = input({ maxLength: 256, value: recorded?.role ?? '', placeholder: '例如 button' });
  const name = input({ maxLength: 256, value: recorded?.name ?? '', placeholder: '例如 保存' });
  const index = el('input', {
    type: 'number', className: 'input input-sm', min: '0', step: '1',
    value: recorded?.index === undefined ? '' : String(recorded.index),
  });
  const fill = locator => {
    role.value = locator?.role ?? '';
    name.value = typeof locator?.name === 'string' ? locator.name : '';
    index.value = locator?.index === undefined ? '' : String(locator.index);
  };
  // What the operator actually has on screen. The browser sanitizes a text
  // input on assignment, so this is the only honest baseline for "not edited".
  const shown = () => ({ role: role.value, name: name.value, index: index.value });
  let baseline = shown();
  // Retyping the same digit is still a choice: an input event on the index
  // field re-specifies it even when the resulting number is unchanged.
  let indexRespecified = false;
  index.oninput = () => { indexRespecified = true; };
  const untouched = () => {
    const now = shown();
    return now.role === baseline.role && now.name === baseline.name && now.index === baseline.index;
  };
  openDialog(withStepId(step.kind === 'scroll' ? '编辑滚动目标' : '编辑点击目标', step), [
    summary,
    v2PickEntry(step, (locator, candidate) => {
      target = locator;
      picked = true;
      frame = candidate?.bounds;
      fill(locator);
      baseline = shown();
      indexRespecified = false;
      renderSummary();
    }, { commit: false }),
    field('控件类型（role）', role, '控件的类别：button 按钮、textfield 输入框、menuitem 菜单项……'),
    field('控件名称（name）', name, '界面上显示的文字，例如按钮「保存」；不改沿用录制值，改成空表示不限定名称'),
    field('同名控件序号（index，可选）', index, '类型与名称相同的控件有多个时取第几个，从 0 开始；留空表示不限定'),
  ], '应用', () => {
    if (untouched()) {
      // A pick the operator accepted without further edits: its locator exactly.
      // Otherwise the recorded target stays as it is, including a path this
      // editor does not show.
      return picked
        ? v2Edit({ kind: 'update', id: step.id, patch: { target: pickedTargetPatch(target) } })
        : undefined;
    }
    const now = shown();
    const roleValue = String(now.role ?? '').trim();
    if (!roleValue) throw new Error('填写控件类型（role），或点「从窗口拾取」选一个控件。');
    const rawIndex = String(now.index ?? '').trim();
    if (rawIndex !== '' && (!Number.isSafeInteger(Number(rawIndex)) || Number(rawIndex) < 0)) {
      throw new Error('同名控件序号（index）填 0 或更大的整数，或留空。');
    }
    // The locator the fields were filled from: the picked control, or the
    // recorded target a coordinate step does not have.
    const source = picked ? target : recorded;
    const roleChanged = roleValue !== String(baseline.role ?? '').trim();
    const nameChanged = String(now.name ?? '') !== baseline.name;
    const indexChanged = rawIndex !== baseline.index.trim();
    // An untouched name keeps the recorded value: a line break a single-line
    // input could not display, and — while the recorded range is still the one
    // being edited — the empty string that means "this control has no name".
    // A new role rebuilds the range, so a blank field is then simply "not
    // filled" (no name restriction), like any hand-written locator.
    const sameRange = !roleChanged && !nameChanged;
    const nextName = nameChanged
      ? (String(now.name ?? '') || undefined)
      : (typeof source?.name === 'string' && (source.name !== '' || sameRange) ? source.name : undefined);
    // The index is positional in the role/name/path range. Reusing an
    // unedited one after that range changed would address another control.
    if (!indexChanged && !indexRespecified && rawIndex !== '' && (roleChanged || nameChanged)) {
      throw new Error('改了控件类型或名称后，原来的同名序号不再指向同一个控件；请重新填写序号，或留空。');
    }
    const nextIndex = rawIndex === '' ? undefined : Number(rawIndex);
    // The recorded path is the role chain down to the old control and the range
    // the old index was taken from. Only an index-only edit stays inside that
    // range; a new role or name names a different control, so the old chain is
    // dropped instead of narrowing the new one out.
    const nextPath = roleChanged || nameChanged ? undefined : source?.path;
    return v2Edit({
      kind: 'update', id: step.id,
      patch: {
        target: {
          kind: 'element', role: roleValue,
          ...(nextName === undefined ? {} : { name: nextName }),
          ...(nextPath ? { path: nextPath } : {}),
          ...(nextIndex === undefined ? {} : { index: nextIndex }),
          // The merge inherits any field the patch omits from the recorded
          // target; the edited locator keeps nothing the form could not show.
          ...(nextName === undefined ? { name: null } : {}),
          ...(nextPath ? {} : { path: null }),
          ...(nextIndex === undefined ? { index: null } : {}),
        },
      },
    });
  });
}

/**
 * A coordinate hover is a dwell at a recorded screen point. There is no window
 * to read a control from, so its editor keeps only what an operator can act on
 * without re-recording: the point it will move to, what the recording saw there,
 * and how long the pointer stays. No role/name/path/index fields and no pick
 * entry — a pick would need a window this step deliberately does not bind.
 */
function v2ScreenHoverDialog(step) {
  const [x, y] = step.point;
  const hint = hoverHintLabel(step.hint);
  const duration = input({
    type: 'number', min: '0', max: '60000', step: '10',
    value: String(step.durationMs ?? 0),
  });
  openDialog(withStepId('编辑悬停目标', step), [
    el('p', { className: 'target-summary' }, `屏幕坐标 (${x}, ${y})`),
    muted(`整块屏幕${hint ? ` · 录制时：${hint}` : ''}`),
    field('悬停时长（毫秒）', duration),
    muted('坐标型悬停只移动指针并停留，不点击、不聚焦。坐标与录制时的屏幕布局绑定；' +
      '窗口改名或版面变化后可能不再落在同一处，必要时重新录制。'),
  ], '应用', () => {
    const raw = duration.value.trim();
    const ms = Number(raw);
    if (!raw || !Number.isSafeInteger(ms) || ms < 0 || ms > 60000) {
      throw new Error('悬停时长填 0–60000 之间的整数毫秒。');
    }
    return v2Edit({ kind: 'update', id: step.id, patch: { durationMs: ms } });
  });
}

/**
 * Hover is a dwell on one control, so its editor keeps only the two things an
 * operator can act on: which control (replaced by picking, never by typing a
 * role/name/path), and how long the pointer stays. It shares the summary and
 * the pick entry with click/scroll and adds the dwell.
 *
 * A flow stores a locator, not a rectangle: bounds are only known when the
 * picker returns the control from a read-only window snapshot. A picked control
 * without bounds is the same thing that makes a hover fail with
 * HOVER_UNRESOLVED, so it is reported as that error and never saved.
 */
function v2HoverDialog(step) {
  const windowTitle = targetWindowLabel(step);
  let target = step.target?.kind === 'element' ? step.target : undefined;
  let picked;
  // `frame` is the picked control's rectangle; `frameMissing` records a pick
  // that came back without one, which is a real replay failure, not a guess.
  let frame;
  let frameMissing = false;
  const boundsMessage = '这个控件在窗口快照里没有边界（bounds），悬停回放会以 HOVER_UNRESOLVED 失败；请换一个能读到位置的控件。';
  const summary = el('p', { className: 'target-summary' });
  const problem = el('p', { className: 'form-error', role: 'alert' });
  const renderSummary = () => {
    summary.textContent = targetSummaryText(target, { window: windowTitle, frame });
    problem.textContent = !target
      ? '这一步的目标不是一个控件；用「从窗口拾取」选一个再应用。'
      : frameMissing ? boundsMessage : '';
  };
  renderSummary();
  const duration = input({
    type: 'number', min: '0', max: '60000', step: '10',
    value: String(step.durationMs ?? 0),
  });
  openDialog(withStepId('编辑悬停目标', step), [
    summary,
    problem,
    // The pick lands in this form only; 应用 writes it with the duration, so a
    // cancelled editor never leaves a half-edited step behind.
    v2PickEntry(step, (locator, candidate) => {
      target = locator;
      picked = true;
      frame = candidate?.bounds;
      frameMissing = Boolean(candidate) && !candidate.bounds;
      renderSummary();
    }, { commit: false }),
    field('悬停时长（毫秒）', duration),
  ], '应用', () => {
    if (!target) throw new Error('这一步的目标不是一个控件；用「从窗口拾取」选一个再应用。');
    if (frameMissing) throw new Error(boundsMessage);
    const raw = duration.value.trim();
    const ms = Number(raw);
    if (!raw || !Number.isSafeInteger(ms) || ms < 0 || ms > 60000) {
      throw new Error('悬停时长填 0–60000 之间的整数毫秒。');
    }
    return v2Edit({
      kind: 'update', id: step.id,
      patch: {
        durationMs: ms,
        ...(picked ? { target: pickedTargetPatch(target) } : {}),
      },
    });
  });
}

function v2DragDialog(step) {
  const from = locatorFields(step.from);
  const to = locatorFields(step.to);
  openDialog(withStepId('编辑拖拽端点', step), [...from.controls, el('hr'), ...to.controls], '应用', () =>
    v2Edit({ kind: 'update', id: step.id, patch: { from: from.value(), to: to.value() } }));
}

function v2TypeDialog(step) {
  const picker = locatorFields(step.target,
    '要换控件，点上面的「从窗口拾取」，直接选中真实控件；下面只用于手动修正。', { collapsible: true });
  const mode = select([['text', '文本'], ['input', '参数名']]);
  mode.value = 'input' in step ? 'input' : 'text';
  const text = el('textarea', { className: 'textarea', rows: 3, maxLength: 4000 });
  if ('text' in step) text.value = step.text;
  const param = input({ maxLength: 64, value: 'input' in step ? step.input : '' });
  const textBox = field('输入文本', text);
  const paramBox = field('参数名', param);
  const sync = () => {
    textBox.hidden = mode.value !== 'text';
    paramBox.hidden = mode.value !== 'input';
  };
  mode.onchange = sync;
  sync();
  openDialog(withStepId('编辑输入步骤', step), [
    v2PickEntry(step, locator => picker.set(locator)),
    ...picker.keyControls, field('内容来源', mode), textBox, paramBox, picker.advanced,
    muted('参数值保存在 flow 旁的本机值文件里（不进 flow 与报告）；回放弹窗可预填、修改或清除。'),
  ], '应用', () => {
    const patch = picker.shouldSubmitTarget() ? { target: picker.value() } : {};
    if (mode.value === 'text') {
      if (!text.value) throw new Error('填写输入文本。');
      patch.text = text.value;
    } else {
      const name = param.value.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) throw new Error('参数名以字母开头，只含字母、数字与下划线。');
      patch.input = name;
    }
    return v2Edit({ kind: 'update', id: step.id, patch });
  });
}

const v2Keys = ['return', 'tab', 'space', 'escape', 'delete', 'backspace', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'];
const v2Modifiers = ['ctrl', 'alt', 'shift', 'meta'];

function v2KeyDialog(step) {
  const key = input({ value: step.key, maxLength: 20 });
  const boxes = v2Modifiers.map(name => ({
    name,
    node: el('input', { type: 'checkbox', className: 'checkbox checkbox-sm', checked: (step.modifiers ?? []).includes(name) }),
  }));
  openDialog(withStepId('编辑快捷键', step), [
    field('按键', key),
    el('div', { className: 'parameter-list' }, ...boxes.map(({ name, node }) =>
      el('label', { className: 'check-row' }, node, name))),
    muted(`常用键：${v2Keys.join(' ')}；单字符键写小写字母或数字。`),
  ], '应用', () => {
    const name = key.value.trim().toLowerCase();
    if (!/^(?:[a-z0-9]|space|return|tab|escape|delete|backspace|forwarddelete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/.test(name)) {
      throw new Error('按键名不受支持。');
    }
    return v2Edit({
      kind: 'update', id: step.id,
      patch: { key: name, modifiers: boxes.filter(box => box.node.checked).map(box => box.name) },
    });
  });
}

function v2WaitDialog(step) {
  const appScope = step.scope.kind === 'app';
  const kinds = appScope
    ? [['app_running', '应用运行中'], ['app_installed', '应用已安装']]
    : [['window_exists', '窗口存在'], ['element', '元素状态'], ['element_enabled', '元素可用'], ['window', '窗口属性']];
  const kind = select(kinds);
  kind.value = step.check.kind;
  const picker = locatorFields(step.check.target);
  const property = select([['exists', '存在'], ['visible', '可见'], ['text', '文本'], ['value', '值']]);
  const value = input({ maxLength: 4000, value: typeof step.check.expect?.equals === 'string' ? step.check.expect.equals : '' });
  const toggle = select([['true', '成立'], ['false', '不成立']]);
  toggle.value = step.check.equals === false || step.check.expect?.equals === false ? 'false' : 'true';
  const elements = el('div', { className: 'stack-list' }, ...picker.controls);
  const propertyBox = field('属性', property);
  const toggleBox = field('预期结果', toggle);
  const valueBox = field('预期内容', value);
  const timeout = el('input', { type: 'number', className: 'input input-sm', min: '1000', max: '1800000', step: '1000', value: String(step.timeoutMs ?? 15000) });
  const sync = () => {
    const elementKind = kind.value === 'element';
    elements.hidden = !['element', 'element_enabled'].includes(kind.value);
    propertyBox.hidden = !['element', 'window'].includes(kind.value);
    if (kind.value === 'window') {
      property.replaceChildren(
        el('option', { value: 'exists' }, '存在'), el('option', { value: 'title' }, '标题'));
    } else {
      property.replaceChildren(
        el('option', { value: 'exists' }, '存在'), el('option', { value: 'visible' }, '可见'),
        el('option', { value: 'text' }, '文本'), el('option', { value: 'value' }, '值'));
    }
    if (kind.value === 'window' && step.check.expect?.property === 'title') property.value = 'title';
    else if (elementKind && step.check.expect?.property) property.value = step.check.expect.property;
    const bool = property.value === 'exists' || property.value === 'visible';
    toggleBox.hidden = !['window_exists', 'app_running', 'app_installed', 'element_enabled'].includes(kind.value) && !bool;
    valueBox.hidden = propertyBox.hidden || bool;
  };
  kind.onchange = sync;
  property.onchange = sync;
  sync();
  openDialog(withStepId('编辑等待', step), [
    field('条件', kind), elements, propertyBox, toggleBox, valueBox, field('超时（毫秒）', timeout),
  ], '应用', () => {
    let check;
    if (kind.value === 'window_exists' || kind.value === 'app_running' || kind.value === 'app_installed') {
      check = { kind: kind.value, equals: toggle.value === 'true' };
    } else if (kind.value === 'element_enabled') {
      check = { kind: 'element_enabled', target: picker.value(), equals: toggle.value === 'true' };
    } else if (kind.value === 'element') {
      const bool = property.value === 'exists' || property.value === 'visible';
      check = {
        kind: 'element', target: picker.value(),
        expect: bool
          ? { property: property.value, equals: toggle.value === 'true' }
          : { property: property.value, equals: value.value },
      };
    } else {
      check = {
        kind: 'window',
        expect: property.value === 'exists'
          ? { property: 'exists', equals: toggle.value === 'true' }
          : { property: 'title', equals: value.value },
      };
    }
    const timeoutMs = Number(timeout.value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) {
      throw new Error('超时需为 1000–1800000 毫秒。');
    }
    return v2Edit({ kind: 'update', id: step.id, patch: { check, timeoutMs } });
  });
}

const ASSERT_MODE_LABELS = {
  element: '元素', window: '窗口', file: '文件存在', process: '进程运行',
};

/** Which kind of assertion a saved step is, from its scope and check. */
function assertModeOf(check, scope) {
  if (scope?.kind === 'file' && scope.path !== undefined) return 'file';
  if (scope?.kind === 'process') return 'process';
  return check?.target?.kind === 'window' ? 'window' : 'element';
}

/**
 * Show or hide one control group. A hidden `required` control still takes part
 * in native form validation and silently blocks the dialog, so hiding a group
 * disables its controls too.
 */
function showControlGroup(box, visible) {
  box.hidden = !visible;
  for (const node of box.querySelectorAll('input, select, textarea')) node.disabled = !visible;
}

/**
 * One field set for both the add and the edit entry: a desktop assertion
 * (element/window) or a system state check (file/process). The caller receives
 * the check, plus the scope when the check is system-level.
 */
function v2AssertFields(initial, options = {}) {
  const scope = options.scope;
  const initialMode = assertModeOf(initial, scope);
  const modes = options.modes ?? ['element', 'window', 'file', 'process'];
  const targetKind = select(modes.map(mode => [mode, ASSERT_MODE_LABELS[mode]]));
  targetKind.value = modes.includes(initialMode) ? initialMode : modes[0];
  const picker = locatorFields(initial?.target?.kind === 'window' ? undefined : initial?.target);
  const property = select([['exists', '存在'], ['visible', '可见'], ['text', '文本'], ['value', '值'], ['title', '标题']]);
  if (initial?.expect?.property) property.value = initial.expect.property;
  const equals = input({ maxLength: 4000, value: initial?.expect?.equals !== undefined && typeof initial.expect.equals === 'string' ? initial.expect.equals : '' });
  const toggle = select([['true', '成立'], ['false', '反向（不成立）']]);
  // A desktop expectation keeps `equals` under `expect`; a system check keeps
  // it on the check itself, so both shapes open on their saved value.
  const initialExpected = initial?.expect?.equals ?? initial?.equals;
  toggle.value = initialExpected === false ? 'false' : 'true';
  const filePath = input({
    maxLength: 4096, value: scope?.kind === 'file' && scope.path !== undefined ? scope.path : '',
    placeholder: '/Users/me/Downloads/report.pdf',
  });
  const processMatch = select([['name', '可执行文件名'], ['path', '完整路径']]);
  if (scope?.kind === 'process') processMatch.value = scope.name !== undefined ? 'name' : 'path';
  const processName = input({
    maxLength: 255, value: scope?.kind === 'process' && scope.name !== undefined ? scope.name : '',
    placeholder: '例如 Safari',
  });
  const processPath = input({
    maxLength: 4096, value: scope?.kind === 'process' && scope.path !== undefined ? scope.path : '',
    placeholder: '/Applications/Safari.app/Contents/MacOS/Safari',
  });
  // Arguments refine a name match only. Each row is one argv element, kept
  // literally: spaces and quotes are part of the value, and a blank row is not
  // an argument at all.
  const argsRows = el('div', { className: 'stack-list' });
  const addArgRow = (value = '') => {
    const arg = input({ maxLength: 4096, value, placeholder: '一个参数，空格与引号原样保留' });
    const row = el('div', { className: 'parameter-row' }, arg,
      button('删除', () => {
        row.remove();
        sync();
      }, { style: 'small danger', icon: 'trash', iconOnly: true }));
    argsRows.append(row);
  };
  for (const value of Array.isArray(initial?.args) ? initial.args : []) addArgRow(String(value));
  const argsBox = field('参数（可选，按顺序连续匹配）', el('div', { className: 'stack-list' }, argsRows,
    button('添加参数', () => addArgRow(), { style: 'small', icon: 'plus' })));
  const elementBox = el('div', { className: 'stack-list' }, ...picker.controls);
  const valueBox = field('预期内容', equals);
  const boolBox = field('预期结果', toggle);
  const propertyBox = field('属性', property);
  const fileBox = field('文件绝对路径', filePath);
  const processNameBox = field('可执行文件名', processName);
  const processPathBox = field('可执行完整路径', processPath);
  const processMatchBox = field('匹配方式', processMatch);
  // The whole group can be hidden too (a non-assert insert dialog).
  let groupVisible = true;
  const show = (box, visible) => showControlGroup(box, visible && groupVisible);
  const sync = () => {
    const mode = targetKind.value;
    const window = mode === 'window';
    const system = mode === 'file' || mode === 'process';
    targetKind.disabled = !groupVisible;
    toggle.disabled = !groupVisible;
    show(elementBox, mode === 'element');
    show(propertyBox, !system);
    show(fileBox, mode === 'file');
    show(processMatchBox, mode === 'process');
    show(processNameBox, mode === 'process' && processMatch.value === 'name');
    show(processPathBox, mode === 'process' && processMatch.value === 'path');
    show(argsBox, mode === 'process' && processMatch.value === 'name');
    if (system) {
      show(boolBox, true);
      show(valueBox, false);
      return;
    }
    const wanted = property.value || initial?.expect?.property;
    property.replaceChildren(...(window
      ? [el('option', { value: 'exists' }, '存在'), el('option', { value: 'title' }, '标题')]
      : [el('option', { value: 'exists' }, '存在'), el('option', { value: 'visible' }, '可见'),
        el('option', { value: 'text' }, '文本'), el('option', { value: 'value' }, '值')]));
    if (wanted && [...property.options].some(option => option.value === wanted)) property.value = wanted;
    const bool = property.value === 'exists' || property.value === 'visible';
    show(boolBox, bool);
    show(valueBox, !bool);
  };
  targetKind.onchange = sync;
  property.onchange = sync;
  processMatch.onchange = sync;
  sync();
  return {
    /** Show or hide the whole group; hidden controls are disabled too. */
    setVisible(visible) {
      groupVisible = visible;
      sync();
    },
    controls: [
      field('断言目标', targetKind), elementBox, propertyBox, boolBox, valueBox,
      fileBox, processMatchBox, processNameBox, processPathBox, argsBox,
    ],
    value() {
      const expected = toggle.value === 'true';
      const processArgs = () => {
        const values = [...argsRows.querySelectorAll('input')]
          .map(arg => arg.value)
          .filter(value => value !== '');
        for (const value of values) {
          if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('参数不能包含控制字符。');
        }
        return values;
      };
      if (targetKind.value === 'file') {
        const path = filePath.value.trim();
        if (!path.startsWith('/')) throw new Error('填写要检查的文件绝对路径（以 / 开头）。');
        return { scope: { kind: 'file', path }, check: { kind: 'file_exists', equals: expected } };
      }
      if (targetKind.value === 'process') {
        if (processMatch.value === 'path') {
          const path = processPath.value.trim();
          if (!path.startsWith('/')) throw new Error('填写可执行的绝对路径（以 / 开头）。');
          return { scope: { kind: 'process', path }, check: { kind: 'process_running', equals: expected } };
        }
        const name = processName.value.trim();
        if (!name) throw new Error('填写可执行文件名（不含路径）。');
        const args = processArgs();
        return {
          scope: { kind: 'process', name },
          check: { kind: 'process_running', equals: expected, ...(args.length ? { args } : {}) },
        };
      }
      const bool = property.value === 'exists' || property.value === 'visible';
      return {
        check: assertCheck({
          target: targetKind.value === 'window' ? { kind: 'window' } : picker.value(),
          property: property.value,
          equals: bool ? expected : equals.value,
        }),
      };
    },
  };
}

function v2AssertDialog(step) {
  const system = step.scope?.kind === 'file' || step.scope?.kind === 'process';
  const fields = v2AssertFields(step.check, {
    scope: step.scope,
    modes: system ? ['file', 'process'] : ['element', 'window'],
  });
  openDialog(withStepId('编辑断言', step), [
    ...fields.controls,
    system ? muted('系统检查只看文件元数据与进程列表，不会启动、聚焦或操作任何 App。') : undefined,
  ], '应用', () => {
    const value = fields.value();
    return v2Edit({
      kind: 'update', id: step.id,
      patch: value.scope ? { scope: value.scope, check: value.check } : { check: value.check },
    });
  });
}

function v2CheckpointDialog(step) {
  openDialog(withStepId('人工检查点（只读）', step), [
    infoList([
      ['触发步骤', step.triggerStepId],
      ['原因', step.reason],
      ['恢复条件', checkLabel(step.resume?.check)],
      ['等待上限', duration(step.timeoutMs)],
      ['恢复作用域', v2ScopeText(step.resume?.scope)],
    ], 'meta-grid'),
    muted('密码不进入 flow，也不由工作台读取；回放时由操作者在目标界面完成授权。'),
  ]);
}

function v2GapDialog(step) {
  const kind = select([['wait', '转为等待'], ['manual_checkpoint', '转为人工检查点']]);
  const fields = v2ScopeFields(step.scope);
  const timeout = el('input', { type: 'number', className: 'input input-sm', min: '1000', max: '1800000', step: '1000', value: '15000' });
  const trigger = v2Steps()[Math.max(0, v2Steps().findIndex(entry => entry.id === step.id) - 1)];
  const onlyStep = v2Steps().length <= 1;
  // Dropping a gap is the one gap edit that throws away evidence, so it is never
  // one click: the operator has to say that nothing in that stretch needs a
  // replay. The timeline row's delete opens this same dialog, so there is no
  // second path that could remove a gap unchecked.
  const confirmed = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const remove = button('确认没有需要重放的操作并移除', () => void removeGap(), {
    style: 'small danger', icon: 'trash', disabled: true,
  });
  // The conversion submit and this removal share one in-flight state: while
  // either request runs, the other action is disabled, so a second edit for the
  // same step can never be queued behind the first.
  const syncRemove = pending => {
    remove.disabled = pending || onlyStep || !confirmed.checked;
  };
  confirmed.onchange = () => syncRemove(gapDialog.busy());
  const removeGap = async () => {
    if (!confirmed.checked || onlyStep) return;
    if (!await gapDialog.run(() => v2Edit({ kind: 'delete', id: step.id }))) return;
    // Only the dialog that asked may close: a late answer must not close the
    // import dialog the operator opened meanwhile.
    gapDialog.close();
    status(`已移除缺口 ${step.id}；可用「撤销」恢复，差异里会记下这次删除。`, 'success');
  };
  const gapDialog = openDialog(withStepId(`处理缺口 · ${step.code}`, step), [
    muted(gapReason(step.code)),
    muted('缺口没有可回放的作用域，运行前必须转成等待或人工检查点，或在确认没有丢失操作后移除。'),
    field('转换方式', kind), ...fields.controls, field('超时（毫秒）', timeout),
    kind.value === 'manual_checkpoint'
      ? muted(`触发步骤沿用前一步 ${trigger?.id ?? '（无）'}；恢复条件为窗口存在。`)
      : undefined,
    el('h3', {}, '或者：确认后移除'),
    muted('只有确认这段缺口期间没有需要重放的操作时才移除。移除后这一步不再进 flow；它可用「撤销」恢复，也会出现在与录制的差异里。'),
    onlyStep
      ? muted('这是流程里唯一的一步：先插入别的步骤，才能移除最后一个缺口。')
      : el('label', { className: 'check-row' }, confirmed, '我确认这段缺口期间没有需要重放的操作'),
    remove,
  ], '转换', async () => {
    const scope = fields.value();
    const timeoutMs = Number(timeout.value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) {
      throw new Error('超时需为 1000–1800000 毫秒。');
    }
    const next = kind.value === 'wait'
      ? {
        id: step.id, kind: 'wait', scope, timeoutMs,
        check: scope.kind === 'app' ? { kind: 'app_running', equals: true } : { kind: 'window_exists', equals: true },
      }
      : {
        id: step.id, kind: 'manual_checkpoint', scope, reason: 'secure_input',
        triggerStepId: trigger?.id ?? step.id,
        resume: { scope, check: { kind: 'window_exists', equals: true } }, timeoutMs,
      };
    const result = await api('v2/replace', { session: state.session.id, id: step.id, step: next });
    state.v2 = result;
    retireDryRunReport();
    renderV2();
    renderTimeline();
    status('缺口已转换，仍需复核并保存。', 'success');
  }, { onBusyChange: syncRemove });
}

function v2InsertDialog() {
  const anchor = v2SelectedStep() ?? v2Steps().at(-1);
  const anchorScope = anchor && anchor.kind !== 'gap' ? anchor.scope : undefined;
  const kind = select([...V2_INSERT_KINDS.entries()]);
  const app = input({ value: anchorScope?.app ?? '', maxLength: 256, placeholder: 'com.apple.TextEdit' });
  const title = input({ value: anchorScope?.kind === 'window' ? anchorScope.windowTitle : '', maxLength: 256 });
  const key = input({ value: anchorScope?.kind === 'window' ? anchorScope.windowKey : '', maxLength: 64 });
  const titleBox = field('窗口标题', title);
  const keyBox = field('windowKey', key);
  const timeout = el('input', { type: 'number', className: 'input input-sm', min: '1000', max: '1800000', step: '1000', value: '15000' });
  const timeoutBox = field('等待超时（毫秒）', timeout);
  const picker = locatorFields(anchor?.target);
  const targetBox = el('div', { className: 'stack-list' }, ...picker.controls);
  const assertFields = v2AssertFields(undefined);
  const assertBox = el('div', { className: 'stack-list' }, ...assertFields.controls);
  // A check is useful at the end of a flow; the desktop assertion still has to
  // follow a step with a scope, so the position only matters for system checks.
  const position = select([['after', anchor ? `插到 ${anchor.id} 之后` : '流程末尾'], ['end', '流程末尾']]);
  position.value = anchor ? 'after' : 'end';
  const positionBox = field('插入位置', position);
  const sync = () => {
    const appScope = kind.value === 'launch_app' || kind.value === 'activate_app';
    // Every group is disabled while hidden: the element locator's `role` is
    // required, and a hidden one would block a system check from submitting.
    showControlGroup(titleBox, !appScope);
    showControlGroup(keyBox, !appScope);
    showControlGroup(targetBox, ['click', 'type'].includes(kind.value));
    assertFields.setVisible(kind.value === 'assert');
    showControlGroup(positionBox, kind.value === 'assert');
    showControlGroup(timeoutBox, kind.value === 'wait');
  };
  kind.onchange = sync;
  sync();
  const scopeValue = () => {
    if (!app.value.trim()) throw new Error('填写 App 标识。');
    if (kind.value === 'launch_app' || kind.value === 'activate_app') {
      return { kind: 'app', app: app.value.trim() };
    }
    if (!title.value.trim() || !key.value.trim()) throw new Error('窗口步骤需要窗口标题与 windowKey。');
    return { kind: 'window', app: app.value.trim(), windowTitle: title.value.trim(), windowKey: key.value.trim() };
  };
  openDialog('插入步骤', [
    field('类型', kind), field('App 标识', app), titleBox, keyBox,
    targetBox, assertBox, positionBox, timeoutBox,
    muted(anchor ? `插入到 ${anchor.id} 之后，或改为流程末尾。` : '插入到流程末尾。'),
  ], '插入', async () => {
    const index = anchor ? v2Steps().findIndex(entry => entry.id === anchor.id) + 1 : v2Steps().length;
    if (kind.value === 'assert') {
      const value = assertFields.value();
      const atEnd = position.value === 'end' || !anchor;
      // A system check carries its own scope and can be appended to any flow.
      if (value.scope) {
        const step = {
          id: id('assert'), kind: 'assert', scope: value.scope, check: value.check,
          ...(anchor?.atMs === undefined ? {} : { atMs: anchor.atMs }),
        };
        return v2Edit({ kind: 'insert', index: atEnd ? v2Steps().length : index, step });
      }
      if (!atEnd) {
        if (anchor.kind === 'gap') throw new Error('桌面断言要接在一个有目标窗口的步骤之后。');
        return v2Edit({ kind: 'assert', afterStepId: anchor.id, check: value.check });
      }
      // Appending a desktop assertion needs the window it observes.
      const step = {
        id: id('assert'), kind: 'assert', scope: scopeValue(), check: value.check,
        ...(anchor?.atMs === undefined ? {} : { atMs: anchor.atMs }),
      };
      return v2Edit({ kind: 'insert', index: v2Steps().length, step });
    }
    const timeoutMs = Number(timeout.value);
    if (kind.value === 'wait' && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)) {
      throw new Error('超时需为 1000–1800000 毫秒。');
    }
    const step = stepTemplate(kind.value, {
      id: id(kind.value), scope: scopeValue(),
      target: ['click', 'type'].includes(kind.value) ? picker.value() : undefined,
      timeoutMs, atMs: anchor?.atMs,
    });
    return v2Edit({ kind: 'insert', index, step });
  });
}

function v2SelectedStep() {
  return state.v2Selected ? v2Step(state.v2Selected) : undefined;
}

/** The waiting-checkpoint card; the page never receives or stores a password. */
function checkpointPanel() {
  const checkpoint = state.v2Checkpoint;
  if (!checkpoint) return undefined;
  return el('article', { className: 'v2-checkpoint' },
    el('div', { className: 'v2-checkpoint-head' },
      el('strong', {}, '等待人工授权'),
      stateChip('inferred', '回放已暂停')),
    infoList(checkpointWaitFacts(checkpoint, appLabel), 'meta-grid'),
    muted('请在真实界面由操作者完成授权或输入密码；工作台只发确认，不接收密码。' +
      '完成后点「已完成授权，继续」，CLI 会重新核对安全输入与恢复条件。'),
    muted('超时或取消会停在检查点，后续步骤标为 skipped。'),
    el('div', { className: 'actions' },
      button('已完成授权，继续', () => void v2CheckpointAnswer('continue'),
        { style: 'small primary', icon: 'check' }),
      button('取消运行', () => void v2CheckpointAnswer('cancel'),
        { style: 'small danger', icon: 'x' })));
}

async function v2CheckpointAnswer(answer) {
  try {
    await api('run/checkpoint', { session: state.session.id, answer });
    state.v2Checkpoint = null;
    renderV2();
    status(answer === 'continue'
      ? '已发送继续；CLI 会重新核对安全输入与恢复条件'
      : '已发送取消；后续步骤不会执行', answer === 'continue' ? 'success' : '');
  } catch (error) {
    status(error.message, 'error');
  }
}

async function v2StopRun() {
  try {
    await api('stop', {});
    status('正在停止当前回放…');
  } catch (error) {
    status(error.message, 'error');
  }
}

/**
 * Starts a v2 replay without blocking the page: the run POST stays in flight
 * while the page polls for a checkpoint and answers it.
 */
async function v2StartLive(inputs, target) {
  state.v2Running = true;
  state.v2Checkpoint = null;
  renderV2();
  status('实时回放已启动；可在时间线看到每一步的结果。', '');
  const timer = setInterval(async () => {
    try {
      const info = await api('run/status', { session: state.session.id });
      // Steps arrive one at a time; paint them onto the timeline as they land
      // so the replay reads like the editor selecting each row in turn.
      if (Array.isArray(info.entries) && info.entries.length) {
        state.v2Report = { ...(state.v2Report ?? { version: 2 }), entries: info.entries };
        renderV2();
        renderTimeline();
        const last = info.entries[info.entries.length - 1];
        const row = typeof last?.id === 'string' ? document.getElementById(`select-${last.id}`) : null;
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      const next = info.running ? info.checkpoint ?? null : null;
      if (JSON.stringify(next) === JSON.stringify(state.v2Checkpoint)) return;
      state.v2Checkpoint = next;
      renderV2();
      if (next) status(`等待人工授权 · ${next.stepId}`, '');
    } catch {
      // A transient poll failure must not interrupt the replay; retry next tick.
    }
  }, 500);
  try {
    const report = await api('run', {
      session: state.session.id, mode: 'live', confirm: true, inputs,
      ...(target ? { target } : {}),
    });
    state.v2Report = report;
    renderV2();
    renderTimeline();
    status(`实时回放${resultStatus[report.status] ?? report.status} · ${report.entries.length} 步` +
      (report.stopped ? ' · 已停止' : ''), report.status === 'passed' ? 'success' : 'error');
    setTimeout(() => showV2Result(report), 0);
  } catch (error) {
    status(error.message, 'error');
  } finally {
    clearInterval(timer);
    state.v2Running = false;
    state.v2Checkpoint = null;
    renderV2();
  }
}

/** The picker's own dialog options: it always stacks over the step editor. */
const pickDialogOptions = { dialog: pickDialog, titleId: 'v2-pick-dialog-title' };

/**
 * Reads the live window snapshot behind one step's scope and applies a pick.
 * The picker runs in its own dialog, so the editor behind it keeps every field
 * the operator already filled in; a closed picker or a newer editor retires a
 * snapshot that arrives late.
 */
async function v2PickDialog(step, onPicked, { commit = true } = {}) {
  const editor = editDialogEpoch;
  // Without the locator fields an editor cannot offer manual repair, so the
  // fallback is to make the window readable and pick again.
  const manualHint = commit
    ? '仍可以在「编辑」里手动填写角色/名称/路径。'
    : '先把应用和窗口打开，再回到这里用「从窗口拾取」重新选控件。';
  const show = (title, content, submitLabel, submit) =>
    openDialog(withStepId(title, step), content, submitLabel, submit, pickDialogOptions);
  if (!step.scope || step.scope.kind !== 'window') {
    show('从当前窗口拾取', [
      muted('这个步骤没有窗口作用域，读不到可拾取的控件快照。请先把作用域改成窗口。'),
      muted(manualHint),
    ]);
    return;
  }
  // The request belongs to this editor and this pick dialog: closing either one
  // retires it, so a late snapshot never reopens a dialog the operator closed.
  show('从当前窗口拾取', [muted(`正在读取${v2ScopeText(step.scope)}的控件快照…`)]);
  const picker = pickDialogEpoch;
  const live = () => editor === editDialogEpoch && picker === pickDialogEpoch && pickDialog.open;
  let picked;
  try {
    picked = await api('v2/pick', { session: state.session.id, stepId: step.id });
  } catch (error) {
    if (!live()) return;
    show('从当前窗口拾取', [
      muted(`无法从窗口读取控件：${error.message}`),
      muted(`${v2ScopeText(step.scope)}；确认应用正在运行并打开了该窗口，且已授予 CueKeeper 辅助功能权限。`),
      muted(manualHint),
    ]);
    return;
  }
  if (!live()) return;
  const candidates = picked.candidates ?? [];
  const chooser = select(candidates.map((candidate, index) => [String(index), pickCandidateLabel(candidate)]));
  const detail = el('p', { className: 'muted' }, pickCandidateLabel(candidates[0]));
  chooser.onchange = () => { detail.textContent = pickCandidateLabel(candidates[Number(chooser.value)]); };
  show(`从当前窗口拾取 · ${picked.windowTitle}`, [
    muted(`${v2ScopeText(step.scope)} · 窗口 ${picked.windowId} · ${candidates.length} 个控件`),
    field('控件', chooser),
    detail,
    muted(!commit
      ? '确认后会替换编辑框里的目标；回到编辑框点「应用」才保存。'
      : v2Step(step.id)?.target?.kind === 'point'
        ? '当前目标是坐标；确认后会替换成元素定位器（point → element）。'
        : '确认后会替换这一步的目标定位器。'),
    muted('只读快照：不会点击、聚焦或输入。'),
  ], '使用此控件', async () => {
    const candidate = candidates[Number(chooser.value)];
    // `commit: false` hands the pick back to an editor that submits it with its
    // own fields (the hover dialog); every other editor writes it right away,
    // and its form mirrors the pick so applying it cannot restore the old target.
    if (commit) await v2Edit({ kind: 'update', id: step.id, patch: { target: candidate.locator } });
    onPicked?.(candidate.locator, candidate);
  });
}

/** Switches the workbench between editing one flow and running a queue. */
function setMode(mode) {
  const batch = mode === 'batch';
  state.mode = batch ? 'batch' : 'edit';
  document.body.classList.toggle('batch-view', batch);
  $('edit-workspace').hidden = batch;
  $('draft-section').hidden = batch;
  $('batch-workspace').hidden = !batch;
  $('batch-log').hidden = !batch;
  $('mode-edit').classList.toggle('tab-active', !batch);
  $('mode-batch').classList.toggle('tab-active', batch);
  $('mode-edit').setAttribute('aria-selected', String(!batch));
  $('mode-batch').setAttribute('aria-selected', String(batch));
  if (batch) {
    v2Section.hidden = true;
    document.body.classList.remove('v2-mode');
    batchView.enter();
  } else {
    batchView.leave();
    renderV2();
  }
}

function render() {
  const focus = document.activeElement?.id;
  // Selecting a row re-renders every pane; keep the scroll position of the
  // action list so a click near the bottom does not jump back to the top. The
  // v2 editor does the same for its own list, inside renderV2.
  const timeline = $('timeline');
  const timelineTop = timeline?.scrollTop ?? 0;
  renderSummary();
  renderSetup();
  renderTimeline();
  renderInspector();
  renderDraft();
  renderV2();
  if (timeline) timeline.scrollTop = timelineTop;
  if (focus && !dialog.open) $(focus)?.focus({ preventScroll: true });
}

function openDialog(title, content, submitLabel, submit, options = {}) {
  // A second dialog can stack over the page's own one (the picker over the step
  // editor). Opening either retires the responses addressed to what was there.
  const modal = options.dialog ?? dialog;
  if (modal === dialog) editDialogEpoch += 1;
  else pickDialogEpoch += 1;
  const error = el('p', { className: 'form-error alert alert-soft alert-error', role: 'alert' });
  const dismiss = button('关闭', () => modal.close(), { icon: 'x', iconOnly: true, title: '关闭' });
  const confirm = submit && el('button', { className: 'btn btn-primary', type: 'submit' },
    icon('check'), el('span', {}, submitLabel));
  // A dialog may carry a second action beside its default submit (the capture
  // gap's confirmed removal). Both run through `run`, so only one edit is ever
  // in flight: while it is pending the other button, Escape and the close
  // button are disabled, and Enter cannot queue a second request.
  const pending = { busy: false };
  const current = () => modal.open && modal.children[0] === form;
  const sync = () => {
    if (confirm) confirm.disabled = pending.busy;
    dismiss.disabled = pending.busy;
    options.onBusyChange?.(pending.busy);
  };
  const run = async action => {
    if (pending.busy) return false;
    pending.busy = true;
    sync();
    error.textContent = '';
    try {
      await action();
      return true;
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      return false;
    } finally {
      pending.busy = false;
      sync();
    }
  };
  const form = el('form', {
    className: `modal-box stack-list${options.wide ? ' modal-wide' : ''}`,
    onsubmit: async event => {
      event.preventDefault();
      if (!submit) return;
      // Closing is bound to this dialog: an answer that arrives after the
      // operator opened another one must not close that other dialog.
      if (await run(submit) && current()) modal.close();
    },
  },
  el('div', { className: 'dialog-head' },
    el('h2', { id: options.titleId ?? 'dialog-title' }, title), dismiss),
  ...content, error, confirm ? el('div', { className: 'actions' }, confirm) : undefined);
  modal.oncancel = event => { if (pending.busy) event.preventDefault(); };
  modal.replaceChildren(form);
  // A second answer for the same dialog (the picker's loading state, then its
  // candidates) replaces the content in place; only a closed dialog is opened.
  if (!modal.open) modal.showModal();
  requestAnimationFrame(() => modal.querySelector('input:not([type="checkbox"]), select, textarea')?.focus({ preventScroll: true }));
  return {
    busy: () => pending.busy,
    /** Run a second action under the dialog's single in-flight edit. */
    run,
    /** Close only when this dialog is still the one on screen. */
    close: () => { if (current()) modal.close(); },
  };
}

function importDialog() {
  const directory = input({ required: true, placeholder: '/…/recording-xxx.flow.json 或 /…/运行目录' });
  openDialog('导入工作流', [
    field('工作流文件或运行目录', directory),
    muted('可以直接填一个 .flow.json 文件，也可以填包含 flow.json 的运行目录。同目录的 report.json、actions.json 与 snapshot.json 存在时一并导入。'),
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
          ? muted(`其中 ${shell.privileged} 个是提权步骤；密码授权型 Root 步骤会在运行确认后弹框，钥匙串模式需先执行 cuekeeper sudo set。${state.allowSudo ? '' : ' 本次启动用 --no-allow-sudo 关闭了提权，运行会被拒绝。'}`)
          : muted('全部是用户态步骤。'),
        muted(`保存、校验和离线预览都不会执行；实时运行需在运行前确认。${state.allowShell ? '' : ' 本次启动用 --no-allow-shell 关闭了 Shell 执行。'}`),
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
  const add = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm', checked: true });
  openDialog('合并为行为', [
    field('行为名称', name),
    muted(rows.map(row => row.action.kind).join(' → ')),
    fields.length ? el('div', { className: 'parameter-list stack-list' },
      el('h3', {}, '提取输入文本为参数'),
      muted('参数名留空时保留原文本。secret 使用环境变量名，草稿和行为库只保存变量名或参数名。'),
      ...fields.map(({ row, param, type }, index) => el('div', { className: 'parameter-row' },
        field(`参数名 · ${short(actionLabel(row.action), 32)}`, param), field(`类型 ${index + 1}`, type)))) : undefined,
    el('label', { className: 'check-row' }, add, '同时加入测试项草稿'),
  ], '保存行为', async () => {
    if (!name.value.trim()) throw new Error('填写行为名称。');
    const bindings = new Map(fields.filter(({ param }) => param.value.trim()).map(({ row, param, type }) =>
      [row.id, { param: param.value.trim(), type: type.value }]));
    const { item, defaults } = makeBehavior(rows, name.value.trim(), bindings, state.session.target);
    const saved = await api('library', { session: state.session.id, item });
    state.library.custom.push(saved);
    if (add.checked) state.draft.push({ id: id('call'), item: saved, args: defaults });
    state.selected.clear();
    state.tab = 'library';
    render();
    const shell = saved.shell ?? { steps: 0, privileged: 0 };
    status(`已保存行为「${saved.behavior.name}」${add.checked ? '并加入草稿' : ''}` +
      (shell.steps ? ` · 含 ${shell.steps} 个 Shell 步骤${shell.privileged ? '（需管理员预配置）' : ''}` : ''), 'success');
  });
}

/** The window a built-in insert should default to: a window of the target app. */
function builtinScopeDefault(item) {
  const anchor = v2SelectedStep() ?? v2Steps().at(-1);
  const anchorScope = anchor && anchor.kind !== 'gap' && anchor.scope.kind === 'window'
    ? anchor.scope : undefined;
  const matches = scope => item.app === undefined || scope.app === item.app;
  if (anchorScope && matches(anchorScope)) return anchorScope;
  const windows = v2Steps()
    .filter(step => step.kind !== 'gap' && step.scope.kind === 'window')
    .map(step => step.scope)
    .filter(matches);
  if (windows.length) return windows.at(-1);
  // A Finder action never defaults to another app's window: the app is fixed
  // by the behavior, only the title and key are the operator's to fill in.
  if (item.app !== undefined) return { kind: 'window', app: item.app, windowTitle: '', windowKey: '' };
  return anchorScope ?? { kind: 'window', app: '', windowTitle: '', windowKey: '' };
}

/**
 * Insert one built-in behavior. It expands on the server into real steps in a
 * single undo entry; the dialog only names the window and the runtime inputs.
 */
function builtinInsertDialog(item) {
  if (!state.session || state.session.version !== 2) {
    status('内置行为只能插入「全局录制」录制。', 'error');
    return;
  }
  if (item.check) return systemCheckInsertDialog(item);
  const anchor = v2SelectedStep() ?? v2Steps().at(-1);
  const prefill = builtinScopeDefault(item);
  const app = input({ required: true, maxLength: 256, value: prefill.app ?? '', placeholder: 'com.apple.finder' });
  const title = input({ required: true, maxLength: 256, value: prefill.windowTitle ?? '' });
  const key = input({ maxLength: 64, value: prefill.windowKey ?? '', placeholder: '留空自动生成' });
  const params = item.parameters.map(parameter => ({
    parameter, node: input({ maxLength: 64, value: parameter.name }),
  }));
  const needsTarget = item.steps.some(step => step.kind === 'type');
  const picker = needsTarget ? locatorFields({ kind: 'element', role: item.targetRole }) : undefined;
  openDialog(`插入内置行为 · ${item.name}`, [
    muted(`${item.appLabel} · ${item.steps.map(step => step.label).join(' → ')}`),
    muted('内置行为展开成真实步骤；参数不会写进 flow，运行测试项时再填值。'),
    field('App 标识', app), field('窗口标题', title), field('windowKey', key),
    params.length ? el('div', { className: 'parameter-list stack-list' },
      el('h3', {}, '参数名'),
      muted('插入后也可以在步骤详情里改参数名或目标控件。'),
      ...params.map(({ parameter, node }) => field(parameter.label, node, parameter.placeholder))) : undefined,
    picker ? el('div', { className: 'stack-list' },
      muted(`「输入」步骤需要一个文本控件；默认按类型 ${item.targetRole} 匹配，匹配不唯一时在这里指定名称或序号。`),
      ...picker.controls) : undefined,
    muted(anchor ? `插入到 ${anchor.id} 之后。` : '插入到流程末尾。'),
  ], '插入', async () => {
    const appId = app.value.trim();
    if (!appId) throw new Error('填写 App 标识。');
    if (!title.value.trim()) throw new Error('填写窗口标题。');
    const values = {};
    for (const { parameter, node } of params) {
      const name = node.value.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
        throw new Error(`参数名 ${parameter.name} 需要字母开头，只含字母、数字与下划线。`);
      }
      values[parameter.name] = name;
    }
    const target = picker ? picker.value() : undefined;
    const known = new Set(v2Steps().map(step => step.id));
    const inserted = await v2Call('v2/behavior', {
      behavior: item.id,
      scope: {
        app: appId, windowTitle: title.value.trim(),
        ...(key.value.trim() ? { windowKey: key.value.trim() } : {}),
      },
      ...(target ? { target } : {}),
      ...(params.length ? { params: values } : {}),
      ...(anchor ? { afterStepId: anchor.id } : {}),
    });
    // Select the first expanded step so the timeline shows where it landed.
    const first = inserted?.flow?.steps.find(step => !known.has(step.id));
    if (first) {
      state.v2Selected = first.id;
      renderV2();
      renderTimeline();
    }
    status(`已插入内置行为「${item.name}」：${item.steps.length} 步`, 'success');
  });
}

/**
 * Insert one system check card. The path or executable and the expectation are
 * the only inputs: the step is a real `assert` scoped to the machine, so no
 * window, app identity or desktop permission is involved.
 */
function systemCheckInsertDialog(item) {
  const anchor = v2SelectedStep() ?? v2Steps().at(-1);
  const expected = select([['true', '成立'], ['false', '反向（不成立）']]);
  const file = item.check === 'file_exists';
  const filePath = input({ maxLength: 4096, placeholder: '/Users/me/Downloads/report.pdf' });
  const match = select([['name', '可执行文件名'], ['path', '完整路径']]);
  const processName = input({ maxLength: 255, placeholder: '例如 Safari' });
  const processPath = input({ maxLength: 4096, placeholder: '/Applications/Safari.app/Contents/MacOS/Safari' });
  const processNameBox = field('可执行文件名', processName);
  const processPathBox = field('可执行完整路径', processPath);
  const sync = () => {
    processNameBox.hidden = file || match.value !== 'name';
    processPathBox.hidden = file || match.value !== 'path';
  };
  match.onchange = sync;
  sync();
  openDialog(`插入检查 · ${item.name}`, [
    muted(`${item.appLabel} · ${item.summary}`),
    file ? field('文件绝对路径', filePath) : field('匹配方式', match),
    file ? undefined : processNameBox,
    file ? undefined : processPathBox,
    field('预期结果', expected),
    muted('检查只读文件元数据与进程列表，不启动、不聚焦也不操作任何 App。'),
    muted(anchor ? `插入到 ${anchor.id} 之后。` : '插入到流程末尾。'),
  ], '插入', async () => {
    const equals = expected.value === 'true';
    const payload = { behavior: item.id, equals, ...(anchor ? { afterStepId: anchor.id } : {}) };
    if (file) {
      const path = filePath.value.trim();
      if (!path.startsWith('/')) throw new Error('填写要检查的文件绝对路径（以 / 开头）。');
      payload.path = path;
    } else if (match.value === 'path') {
      const path = processPath.value.trim();
      if (!path.startsWith('/')) throw new Error('填写可执行的绝对路径（以 / 开头）。');
      payload.match = 'path';
      payload.path = path;
    } else {
      const name = processName.value.trim();
      if (!name) throw new Error('填写可执行文件名（不含路径）。');
      payload.match = 'name';
      payload.name = name;
    }
    const known = new Set(v2Steps().map(step => step.id));
    const inserted = await v2Call('v2/behavior', payload);
    const first = inserted?.flow?.steps.find(step => !known.has(step.id));
    if (first) {
      state.v2Selected = first.id;
      renderV2();
      renderTimeline();
    }
    status(`已插入检查「${item.name}」`, 'success');
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
    shellSteps ? muted(`该行为含 ${shellSteps} 个 Shell 步骤，加入草稿后可实时运行（运行前需确认）。${state.allowShell ? '' : ' 本次启动用 --no-allow-shell 关闭了 Shell 执行。'}`) : undefined,
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
  return `${candidate.interactive ? '可交互' : '容器'} · ${targetLabel(candidate.locator)} · ${frameLabel(candidate)}`;
}

/**
 * The accessibility locator editor shared by the v1 and v2 target dialogs.
 * Picking the control from the window is the reliable path; the fields below
 * are macOS's description of that control, so each one says what it means.
 *
 * `collapsible` is for the step editors an operator uses every day: role, name
 * and the replay preview stay visible and the narrowing conditions (exact
 * name, path, index) move under a closed 「高级定位」 block. They are still
 * submitted through the same `value()`; closing the block only hides them.
 * A target that already carries a path or index opens the block, so an active
 * condition is never hidden from the operator.
 */
function locatorFields(original, emptyPickHint, { collapsible = false } = {}) {
  const initial = original?.kind === 'element' ? original : undefined;
  const role = input({ required: true, maxLength: 256, value: initial?.role ?? '', placeholder: '例如 textfield' });
  const name = input({ maxLength: 256, value: initial?.name ?? '', placeholder: '例如 保存' });
  const exactName = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm', checked: initial?.name !== undefined });
  const path = input({ value: initial?.path?.join(' / ') ?? '', placeholder: '例如 window / toolbar / button' });
  const index = el('input', { type: 'number', className: 'input input-sm', min: '0', step: '1', value: initial?.index ?? '' });
  const candidates = state.session.candidates;
  const detail = el('p', { className: 'muted' });
  let pickedFields;
  const picker = select([['', '手动填写'], ...candidates.map((candidate, i) => [String(i), candidateLabel(candidate)])],
    event => {
      if (!event.target.value) {
        detail.textContent = '';
        return;
      }
      const candidate = candidates[Number(event.target.value)];
      pickedFields = undefined;
      fill(candidate.locator);
      detail.textContent = `${candidate.ref} · ${frameLabel(candidate)}`;
    });
  const narrowingControls = [
    el('label', { className: 'check-row' }, exactName, '要求名称完全一致（勾选且名称留空 = 只匹配没有名称的控件）'),
    field('层级路径（path，可选）', path, '从窗口往下的中间层类型，用 / 分隔；同名控件分不开时才填'),
    field('同名控件序号（index，可选）', index, '类型和名称都相同的控件有多个时取第几个，从 0 开始'),
  ];
  const advanced = collapsible
    ? el('details', {
      className: 'locator-advanced',
      open: Boolean(initial?.path?.length) || initial?.index !== undefined,
    },
    el('summary', {}, '高级定位'),
    muted('同名控件分不开时才需要这些条件；一般不用改。'),
    ...narrowingControls)
    : undefined;
  const fill = target => {
    role.value = target.role ?? '';
    name.value = target.name ?? '';
    exactName.checked = target.name !== undefined;
    path.value = target.path?.join(' / ') ?? '';
    index.value = target.index ?? '';
    // A pick or an edit can add a narrowing condition; show it rather than
    // leaving a now-active filter inside a closed block.
    if (advanced && (target.path?.length || target.index !== undefined)) advanced.open = true;
    refresh();
  };
  const locator = () => {
    const segments = path.value.split('/').map(part => part.trim()).filter(Boolean);
    return {
      kind: 'element', role: role.value.trim(),
      ...(exactName.checked ? { name: name.value } : {}),
      ...(segments.length ? { path: segments } : {}),
      ...(index.value === '' ? {} : { index: Number(index.value) }),
    };
  };
  // Read the values back in product words: what a replay would look for.
  const preview = el('p', { className: 'muted' });
  const refresh = () => {
    const current = locator();
    const type = roleLabel(current.role) || current.role;
    preview.textContent = !current.role
      ? '还没填控件类型（role），回放找不到这个控件。'
      : `按这些值回放会找：${type}${typeof current.name === 'string' ? `「${current.name || '没有名称'}」` : ''}` +
        `${current.index === undefined ? '' : ` · 同名里的第 ${current.index} 个`}`;
  };
  for (const node of [role, name, path, index]) node.oninput = refresh;
  exactName.onchange = refresh;
  refresh();
  const keyControls = [
    muted('这些值来自 macOS 辅助功能（Accessibility），用来在窗口里认出同一个控件，一般不用手改。'),
    candidates.length
      ? field('从快照拾取控件', picker)
      : muted(emptyPickHint ??
        '要换控件，请关掉对话框，在时间线点「重新拾取」，直接选中真实控件；下面只用于手动修正。'),
    candidates.length ? detail : undefined,
    field('控件类型（role）', role, '控件的类别：button 按钮、textfield 输入框、menuitem 菜单项……'),
    field('控件名称（name）', name, '界面上显示的文字，例如按钮「保存」、输入框标签「地址栏」'),
    preview,
  ];
  return {
    set(target) {
      fill(target);
      pickedFields = JSON.stringify(locator());
    },
    shouldSubmitTarget() {
      // Confirmation already saved the target. Only rewrite it if the
      // operator changes the locator fields afterward.
      return pickedFields !== JSON.stringify(locator());
    },
    /** The always-visible fields: what control, and what a replay would look for. */
    keyControls,
    /** The collapsed 「高级定位」 block, when this editor asked for one. */
    advanced,
    controls: collapsible ? [...keyControls, advanced] : [...keyControls, ...narrowingControls],
    value() {
      const current = locator();
      const segments = current.path ?? [];
      if (!current.role || segments.length > 51 || segments.some(part => part.length > 256) ||
          (index.value !== '' && !Number.isSafeInteger(Number(index.value)))) {
        throw new Error('检查定位器角色、路径和索引。');
      }
      return current;
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
  const elementBox = el('div', { className: 'stack-list' }, ...picker.controls);
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
    className: 'input input-sm', type: 'number', min: '0', max: '60000', step: '10', value: String(row.action.durationMs),
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
  const secret = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const row = el('div', { className: 'parameter-row' },
    key, value, el('label', { className: 'check-row' }, secret, '引用环境变量'),
    button('删除', () => row.remove(), { style: 'small danger', icon: 'trash', iconOnly: true }));
  container.append(row);
}

function shellDialog(preset = {}) {
  const mode = select([['argv', '逐项参数'], ['script', 'Shell 脚本']]);
  const argvRows = el('div', { className: 'stack-list' });
  const addArg = (value = '') => {
    const arg = input({ value, placeholder: '/usr/bin/tool 或参数', maxLength: 4096 });
    const row = el('div', { className: 'parameter-row' }, arg,
      button('删除', () => row.remove(), { style: 'small danger', icon: 'trash', iconOnly: true }));
    argvRows.append(row);
  };
  addArg('');
  const argvBox = el('div', { className: 'stack-list' }, argvRows,
    button('添加参数', () => addArg(), { style: 'small', icon: 'plus' }));
  const command = el('textarea', { className: 'textarea', rows: 4, maxLength: 16384, placeholder: 'echo hello | tr a-z A-Z' });
  const commandBox = field('Shell 脚本', command);
  commandBox.hidden = true;
  const cwd = input({ placeholder: '默认输入文件目录', maxLength: 4096 });
  const timeout = el('input', { type: 'number', className: 'input input-sm', min: '1', max: '120000', value: '30000' });
  const expected = el('input', { type: 'number', className: 'input input-sm', min: '0', max: '255', value: '0' });
  const privilege = select([['user', '用户态'], ['root', 'Root · 需管理员密码'], ['sudo', '需管理员预配置']]);
  const rootMode = select([
    ['prompt', '每次弹框输入管理员密码'],
    ['keychain', '登录钥匙串自动填充（需先 cuekeeper sudo set）'],
    ['sudoers', 'sudoers 免密（无人值守）'],
  ]);
  const task = input({ placeholder: '/Library/CueKeeper/privileged/<任务 ID>', maxLength: 4096 });
  const envRows = el('div', { className: 'stack-list' });
  const envBlock = el('div', { className: 'stack-list' },
    el('h3', {}, '环境变量'), muted('保留键与 SUDO_ / DYLD_ / LD_ / CUEKEEPER_ 前缀不可覆盖。'),
    envRows, button('添加环境变量', () => addEnvRow(envRows), { style: 'small', icon: 'plus' }));
  const userBox = el('div', { className: 'stack-list' },
    field('工作目录', cwd), field('超时（毫秒）', timeout), field('预期退出码', expected), envBlock);
  const sudoConfigured = muted('正在读取钥匙串状态…');
  const password = el('input', {
    type: 'password', className: 'input input-sm', maxLength: 1024,
    autocomplete: 'new-password', placeholder: '管理员密码',
  });
  const refreshSudo = async () => {
    if (!state.allowSudo) {
      sudoConfigured.textContent = '本次启动用 --no-allow-sudo 关闭了提权，无法保存或使用管理员密码。';
      return;
    }
    try {
      const credential = await api('sudo/status');
      sudoConfigured.textContent = credential.configured
        ? `已保存管理员密码（登录钥匙串 · ${credential.account}）`
        : '尚未保存管理员密码';
    } catch (error) {
      sudoConfigured.textContent = error.message;
    }
  };
  const storePassword = button('保存到钥匙串', async () => {
    if (!password.value) {
      status('先填写管理员密码', 'error');
      return;
    }
    try {
      await api('sudo/set', { password: password.value, confirm: true });
      password.value = '';
      status('管理员密码已保存到登录钥匙串', 'success');
      await refreshSudo();
    } catch (error) {
      status(error.message, 'error');
    }
  }, { icon: 'save' });
  const clearPassword = button('清除已保存密码', async () => {
    try {
      await api('sudo/clear', { confirm: true });
      status('已清除登录钥匙串里的管理员密码', 'success');
      await refreshSudo();
    } catch (error) {
      status(error.message, 'error');
    }
  }, { style: 'small danger' });
  const passwordBox = el('div', { className: 'stack-list' },
    field('管理员密码', password),
    el('div', { className: 'actions' }, storePassword, clearPassword),
    muted('密码只写入登录钥匙串，不进入流程文件、报告或日志；它等价于完整管理员密码，仅限可信单机使用。'));
  passwordBox.hidden = true;
  const rootBox = el('div', { className: 'stack-list' },
    field('授权方式', rootMode),
    sudoConfigured, passwordBox,
    muted('Root 步骤只接受逐项参数，不接受 Shell 脚本或环境变量。运行前会展示完整命令与工作目录。'));
  const sudoBox = el('div', { className: 'stack-list' },
    field('固定任务路径', task),
    muted('固定任务由管理员预配置，不接受工作目录、环境变量、超时或脚本。'));
  rootBox.hidden = true;
  sudoBox.hidden = true;
  if (preset.root) {
    privilege.value = 'root';
    rootMode.value = 'keychain';
    rootBox.hidden = false;
    userBox.hidden = true;
    envBlock.hidden = true;
    mode.disabled = true;
    passwordBox.hidden = false;
    void refreshSudo();
  }
  mode.onchange = () => {
    commandBox.hidden = mode.value !== 'script';
    argvBox.hidden = mode.value === 'script';
  };
  rootMode.onchange = () => {
    passwordBox.hidden = rootMode.value !== 'keychain';
    if (!passwordBox.hidden) void refreshSudo();
  };
  privilege.onchange = () => {
    const selected = privilege.value;
    const sudo = selected === 'sudo';
    const root = selected === 'root';
    sudoBox.hidden = !sudo;
    rootBox.hidden = !root;
    if (root) {
      passwordBox.hidden = rootMode.value !== 'keychain';
      void refreshSudo();
    }
    userBox.hidden = sudo;
    envBlock.hidden = root;
    if (root && mode.value === 'script') mode.value = 'argv';
    mode.disabled = sudo || root;
    commandBox.hidden = sudo || root || mode.value !== 'script';
    argvBox.hidden = sudo || mode.value === 'script';
  };
  openDialog(preset.root ? '插入提权步骤' : '插入 Shell 步骤', [
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
      ? (step.privilegeMode === 'sudoers' ? 'Root · sudoers 免密'
        : step.privilegeMode === 'keychain' ? 'Root · 钥匙串无人值守' : 'Root · 密码授权')
      : '用户态';
  return `${privilege} · ${step.mode} · ${step.timeoutMs} ms · 目录 ${step.cwd}\n${command}`;
}

function showResult(mode, report) {
  status(`${mode === 'offline' ? '离线运行' : '实时回放'}${resultStatus[report.status]} · ${report.entries.length} 条结果`,
    report.status === 'passed' ? 'success' : 'error');
  setTimeout(() => openDialog('运行结果', [
    el('h3', { className: `badge badge-soft badge-sm badge-${STATUS_TONES[report.status] ?? 'ghost'}` },
      resultStatus[report.status]),
    identityNotice(report),
    report.stopped ? muted('本次运行已在停止请求后结束。') : undefined,
    el('ol', { className: 'stack-list report-list' }, ...report.entries.map(entry => {
      const row = state.session?.timeline.find(item => item.id === entry.id);
      const name = row ? actionLabel(row.action) : KIND_LABELS[entry.kind] ?? entry.kind;
      const shell = entry.kind === 'shell'
        ? ` · ${entry.shell.privilege}${entry.shell.privilegeMode ? `(${entry.shell.privilegeMode})` : ''}` +
          `/${entry.shell.mode} · ${entry.shell.execution}` +
          (entry.shell.exitCode === undefined ? '' : ` · 退出码 ${entry.shell.exitCode}`)
        : '';
      return el('li', { className: 'report-row' },
        `${entry.id} · ${name}${shell} · ${resultStatus[entry.status]} · ${entry.durationMs} ms`,
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
  if (session.version === 2) {
    openDialog('运行测试项', [
      muted('全局 flow 的实时回放要等跨 App 回放调度器（HAOC-113）接入。' +
        '工作台目前只按作用域复盘「全局录制」时间线，不会启动、聚焦或输入。'),
    ]);
    return;
  }
  if (!session.hasSnapshot && !allowLive) {
    openDialog('运行测试项', [
      muted('离线运行需要目录内的 snapshot.json。实时回放需要在启动工作台时显式启用 --allow-live-replay。'),
    ]);
    return;
  }
  const modes = [];
  if (session.hasSnapshot) modes.push(['offline', '离线解析定位器']);
  if (allowLive) modes.push(['live', '回放到当前目标窗口']);
  const confirmed = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const confirmation = el('label', { className: 'check-row', hidden: session.hasSnapshot },
    confirmed, `我确认向 ${session.target.window} 执行动作`);
  const mode = select(modes, () => { confirmation.hidden = mode.value !== 'live'; });
  const capture = el('input', { type: 'checkbox', className: 'checkbox checkbox-sm' });
  const planBox = el('div', { className: 'plan stack-list' }, muted('正在生成执行计划…'));
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
    el('label', { className: 'check-row' }, capture,
      '采集 Shell 输出文本（存在秘密引用或提权步骤时只保留元数据）'),
    planBox,
  ], '开始运行', async () => {
    const selected = mode.value;
    if (selected === 'live' && !confirmed.checked) throw new Error('确认目标窗口后开始回放。');
    if (!plan) throw new Error('执行计划尚未生成，请稍候再试。');
    if (selected === 'live' && plan.shell.reachable && !plan.allowShell) {
      throw new Error('本次启动以 --no-allow-shell 关闭了 Shell 执行，无法实时运行 Shell 步骤。');
    }
    if (selected === 'live' && plan.shell.privileged && !plan.allowSudo) {
      throw new Error('含提权步骤，本次启动以 --no-allow-sudo 关闭了提权。');
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
  ['shell-button', 'terminal'], ['privilege-button', 'lock'], ['actions-tab', 'list'], ['library-tab', 'layers']]) {
  const node = $(id);
  if (node && !node.querySelector('svg')) node.prepend(icon(name));
}

$('mode-edit').onclick = () => setMode('edit');
$('mode-batch').onclick = () => setMode('batch');
$('app-picker').onclick = openAppPicker;
$('import-button').onclick = importDialog;
$('show-ignored').onchange = event => { state.showIgnored = event.target.checked; render(); };
$('save-button').onclick = saveTest;
$('shell-button').onclick = () => shellDialog();
$('privilege-button').onclick = () => shellDialog({ root: true });
$('run-button').onclick = () => state.running ? stopRun() : runDialog();
for (const tab of ['actions', 'library']) $(`${tab}-tab`).onclick = () => { state.tab = tab; renderInspector(); };

const guide = createGuide({
  dialog: $('guide-dialog'), dom,
  onStart: () => $('record-start')?.click(),
});
$('guide-button').onclick = () => guide.open();

try {
  const initial = await api('state');
  state.library = initial.library ?? { builtin: [], custom: [] };
  state.allowLive = initial.allowLive;
  state.allowShell = initial.allowShell !== false;
  state.allowSudo = initial.allowSudo !== false;
  setSession(initial.session ?? null);
  status(initial.session ? '已导入本地会话' : '会话与测试项保存在本机');
  // The workbench opens on the queue: most sessions are overnight batches.
  // Editing is the everyday view: a fresh page (including the reload after a
  // recording) must not land on batch mode. #batch is the explicit opt-in.
  setMode(location.hash === '#batch' ? 'batch' : 'edit');
} catch (error) {
  render();
  status(error.message, 'error');
}

// First visit: open the four-step guide once. A missing global (tests, embedded
// pages) must not turn this into a blocking error.
try {
  if (!localStorage.getItem('cuekeeper.guide.v1')) guide.open();
} catch {
  // The header button still opens it.
}
