import {
  canUndo, changeTarget, compileDraft, confirmCondition, confirmedSetup, deleteCondition, id, makeBehavior,
  retargetCondition, sameTarget, setupDraft, undoCondition, visibleRows,
} from './model.js';

const $ = name => document.getElementById(name);
const dialog = $('dialog');
const state = {
  session: null, library: [], allowLive: false, app: '', selected: new Set(), ignored: new Set(),
  expanded: new Set(), showIgnored: false, focused: null, draft: [], tab: 'actions', saving: false, setup: null, appPaths: {}, catalog: null, catalogAt: 0, catalogError: null, appNames: {},
};

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key in node && !key.startsWith('aria')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== undefined && child !== null));
  return node;
}

const ICONS = {
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m2 2 20 20"/><path d="M6.71 6.71A10.9 10.9 0 0 0 2 12a10.9 10.9 0 0 0 10 6 10.9 10.9 0 0 0 5.29-1.29"/><path d="M10.73 5.08A10.9 10.9 0 0 1 12 5c4.48 0 8.27 2.94 10 7a11.8 11.8 0 0 1-1.67 2.68"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4"/><path d="M6 12H2"/><path d="M12 6V2"/><path d="M12 22v-4"/>',
  listPlus: '<path d="M11 12H3"/><path d="M16 6H3"/><path d="M16 18H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  sliders: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 12.18-9.17 4.16a2 2 0 0 1-1.66 0L2 12.18"/><path d="m22 17.18-9.17 4.16a2 2 0 0 1-1.66 0L2 17.18"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  appWindow: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pointer: '<path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>',
  text: '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 2h1a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H7"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M6 12h.01"/><path d="M10 12h.01"/><path d="M14 12h.01"/><path d="M18 12h.01"/><path d="M7 16h10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};

const KIND_ICONS = { click: 'pointer', type: 'text', key: 'keyboard', wait: 'clock', assert: 'checkCircle', behavior: 'layers' };
const KIND_LABELS = { behavior: '行为' };

function kindChip(kind) {
  return el('span', { className: 'kind', title: kind },
    icon(KIND_ICONS[kind] ?? 'list', 14), el('span', {}, KIND_LABELS[kind] ?? kind));
}

function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(key, value);
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

function button(label, onclick, { style = '', disabled = false, key, title, icon: iconName, iconOnly = false } = {}) {
  const children = [];
  if (iconName) children.push(icon(iconName));
  if (!iconOnly && label) children.push(el('span', {}, label));
  return el('button', {
    type: 'button', className: `button ${style}${iconOnly ? ' icon' : ''}`, onclick, disabled, id: key,
    title: title ?? (iconOnly ? label : undefined),
    'aria-label': iconOnly ? (title ?? label) : undefined,
  }, ...children);
}

const empty = text => el('p', { className: 'empty' }, text);
const muted = text => el('p', { className: 'muted' }, text);
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
  if (!state.session) return;
  const search = input({ placeholder: '搜索应用', 'aria-label': '搜索应用' });
  const list = el('div', { className: 'app-list', role: 'listbox', 'aria-label': '本机应用' });
  const searchWrap = el('div', { className: 'app-search' }, icon('search', 14), search);
  const body = el('div', { className: 'stack' }, searchWrap, list);
  list.replaceChildren(muted('正在读取本机应用…'));
  openDialog('选择应用', [body], undefined);
  requestAnimationFrame(() => search.focus());

  if (!state.catalog || Date.now() - state.catalogAt > 60_000) {
    status('正在读取本机应用…');
    try {
      state.catalog = (await api('apps')).apps;
      state.catalogAt = Date.now();
      state.catalogError = null;
      for (const app of state.catalog) state.appNames[app.bundleId] = app.name;
      status(state.catalog.length ? '已读取本机应用' : '没有读取到本机应用');
    } catch (error) {
      state.catalogError = error.message;
      if (!state.catalog) state.catalog = Object.values(state.session.apps ?? {});
      status(`应用目录读取失败，只显示本次会话的应用：${error.message}`, 'error');
    }
  }
  if (!dialog.open) return;
  const catalog = [...state.catalog];
  for (const app of Object.values(state.session.apps ?? {})) {
    if (!catalog.some(item => item.bundleId === app.bundleId)) catalog.push({ ...app, paths: app.paths ?? [] });
  }

  const choose = (bundleId, path, app) => {
    if (bundleId && app?.paths?.length > 1 && !path) {
      showPaths(app);
      return;
    }
    state.app = bundleId;
    if (bundleId && app) state.appNames[bundleId] = app.name;
    if (bundleId && path) state.appPaths[bundleId] = path;
    dialog.close();
    render();
    status(bundleId ? `已筛选「${app?.name ?? appLabel(bundleId)}」` : '已显示全部应用');
  };

  const showPaths = app => {
    const current = state.appPaths[app.bundleId];
    const options = app.paths.map((path, index) => el('label', { className: 'path-option' },
      el('input', { type: 'radio', name: 'app-path', value: path, checked: current ? current === path : index === 0 }),
      el('span', {}, path)));
    const back = button('返回', () => {
      body.replaceChildren(searchWrap, list);
      draw(search.value);
      search.focus();
    }, { style: 'small', icon: 'undo' });
    const apply = el('button', {
      type: 'button', className: 'button primary',
      onclick: () => {
        const checked = body.querySelector('input[name="app-path"]:checked');
        if (checked) choose(app.bundleId, checked.value, app);
      },
    }, icon('check'), el('span', {}, '使用此副本'));
    body.replaceChildren(
      el('div', { className: 'path-step-head' }, back, el('strong', {}, app.name)),
      muted(`「${app.name}」有 ${app.paths.length} 份副本。保存测试项时会写入这条路径；回放按路径锁定在下一步接入。`),
      el('div', { className: 'path-list' }, ...options),
      el('div', { className: 'actions' }, apply));
  };

  const appEmpty = (title, detail, clearSearch = false) => el('div', { className: 'app-empty' },
    el('span', { className: 'app-empty-icon' }, icon(clearSearch ? 'search' : 'appWindow', 20)),
    el('strong', {}, title),
    muted(detail),
    clearSearch
      ? button('清除搜索', () => { search.value = ''; draw(''); search.focus(); }, { style: 'small', icon: 'x' })
      : button('重新读取', () => {
        state.catalog = null;
        state.catalogError = null;
        dialog.close();
        openAppPicker();
      }, { style: 'small', icon: 'refresh' }));

  const draw = query => {
    const value = query.trim().toLowerCase();
    if (!catalog.length) {
      list.replaceChildren(appEmpty(
        state.catalogError ? '应用目录读取失败' : '没有读取到本机应用',
        state.catalogError ?? '只读取 /Applications、/System/Applications 和 ~/Applications。',
      ));
      return;
    }
    const matches = catalog.filter(app => !value ||
      app.name.toLowerCase().includes(value) || app.bundleId.toLowerCase().includes(value)).slice(0, 80);
    if (value && !matches.length) {
      list.replaceChildren(appEmpty('没有匹配的应用', `没有找到「${value}」，换个名称或 bundle id 试试。`, true));
      return;
    }
    const rows = matches.map(app => el('div', {
      className: 'app-row', role: 'option', tabindex: '0', 'aria-selected': String(state.app === app.bundleId),
      title: appTitle(app.bundleId),
      onclick: () => choose(app.bundleId, undefined, app),
      onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(app.bundleId, undefined, app); } },
    },
    appGlyph(app.bundleId, () => showPaths(app), 24),
    el('span', {}, el('span', { className: 'app-row-name' }, app.name), el('span', { className: 'app-row-id' }, app.bundleId)),
    state.app === app.bundleId ? el('span', { className: 'app-row-check' }, icon('check', 14)) : undefined));
    if (!value) {
      rows.unshift(el('div', {
        className: 'app-row', role: 'option', tabindex: '0', 'aria-selected': String(!state.app),
        onclick: () => choose('', undefined, undefined),
        onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose('', undefined, undefined); } },
      },
      el('span', { className: 'app-glyph app-glyph-all' }, icon('appWindow', 14)),
      el('span', {}, el('span', { className: 'app-row-name' }, '全部应用'), el('span', { className: 'app-row-id' }, '不过滤应用')),
      !state.app ? el('span', { className: 'app-row-check' }, icon('check', 14)) : undefined));
    }
    list.replaceChildren(...rows);
  };

  search.addEventListener('input', () => draw(search.value));
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      list.querySelector('.app-row')?.click();
    }
  });
  draw('');
}
function locatorLabel(target) {
  if (!target) return '目标窗口';
  if (target.kind === 'point') return `坐标 (${target.point.join(', ')})`;
  return [target.role, target.name, target.path?.join(' › '), target.index === undefined ? '' : `[${target.index}]`]
    .filter(Boolean).join(' · ');
}

function actionLabel(action) {
  const label = locatorLabel(actionTarget(action));
  switch (action.kind) {
    case 'click': return label;
    case 'type': return typeof action.text === 'string' ? `输入 “${short(action.text)}”` : `输入参数 ${action.text.param}`;
    case 'key': return [...(action.modifiers ?? []), action.key].join(' + ');
    case 'assert':
    case 'wait': return `${label} · ${action.check.expect.property} = ${short(String(action.check.expect.equals))}`;
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
    kindChip(row.action.kind),
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
  for (const row of rows) counts.set(row.action.kind, (counts.get(row.action.kind) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.length || 1;
  return el('div', { className: 'overview' },
    el('p', { className: 'eyebrow' }, '会话构成'),
    el('p', { className: 'overview-figure' }, el('strong', {}, String(rows.length)), el('span', {}, '个动作')),
    el('div', { className: 'composition', role: 'img', 'aria-label': ordered.map(([kind, count]) => `${kind} ${count}`).join('，') },
      ...ordered.map(([kind, count], index) => el('span', {
        className: `composition-segment seg-${Math.min(index, 4)}`,
        style: `width:${(count / total * 100).toFixed(2)}%`,
        title: `${kind} ${count}`,
      }))),
    el('ul', { className: 'legend' }, ...ordered.map(([kind, count], index) => el('li', {},
      el('span', { className: `legend-dot seg-${Math.min(index, 4)}` }),
      el('span', { className: 'legend-kind' }, kind),
      el('span', { className: 'legend-count' }, String(count))))),
    infoList([
      ['目标', `${appLabel(state.session.target.app)} · ${state.session.target.window}`],
      ['来源', short(state.session.directory.split('/').at(-1), 44)],
    ], 'meta-grid'),
    muted('选择时间线中的动作查看定位器与整理操作。'));
}

function renderInspector() {
  for (const tab of ['actions', 'library']) $(`${tab}-tab`).setAttribute('aria-pressed', String(state.tab === tab));
  const panel = $('inspector');
  if (state.tab === 'library') {
    const items = [...state.library].sort((a, b) => a.behavior.name.localeCompare(b.behavior.name));
    panel.replaceChildren(items.length ? el('div', { className: 'stack' }, ...items.map(item => {
      const compatible = state.session && sameTarget(item.target, state.session.target);
      const { behavior, parameterTypes } = item;
      return el('article', { className: 'library-item stack' },
        el('h3', {}, behavior.name),
        muted(`${behavior.steps.length} 步 · ${item.target.app} · ${item.target.window}`),
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
  panel.replaceChildren(el('div', { className: 'stack' },
    el('h3', {}, actionLabel(row.action)),
    infoList([['动作', row.action.kind], ['应用', appLabel(row.app)], ['窗口', row.window],
      ['定位器', locatorLabel(actionTarget(row.action))], ['时间', timestamp(row.atMs)], ['耗时', duration(row.durationMs)]], 'meta-grid'),
    isCompatible(row) ? undefined : muted('该动作属于另一窗口，只能在时间线复盘。'),
    el('div', { className: 'actions' },
      button('加入测试项', () => addAction(row.action), { icon: 'listPlus', disabled: !editable }),
      button('添加断言', () => assertionDialog(row), { icon: 'checkCircle', disabled: !editable }),
      button('重新拾取', () => locatorDialog(row), { icon: 'crosshair', disabled: !editable || row.action.kind === 'key' }),
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
  $('save-button').disabled = !draft.length || saving;
  $('run-button').disabled = !draft.length || saving;
  const items = draft.map((entry, index) => {
    const move = offset => {
      [draft[index], draft[index + offset]] = [draft[index + offset], draft[index]];
      renderDraft();
      $(`draft-${entry.id}-${offset}`)?.focus();
    };
    return el('li', { className: 'draft-item' },
      kindChip(entry.item ? 'behavior' : entry.action.kind),
      el('strong', {}, entry.item?.behavior.name ?? actionLabel(entry.action)),
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

const field = (label, input) => el('label', { className: 'field' }, label, input);
const input = (options = {}) => el('input', { type: 'text', ...options });
const select = (items, onchange) => el('select', { onchange },
  ...items.map(([value, label]) => el('option', { value }, label)));

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
    setSession(await api('import', { directory: directory.value.trim() }));
    status('已导入本地会话', 'success');
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
    status(`已保存行为「${saved.behavior.name}」${add.checked ? '并加入草稿' : ''}`, 'success');
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
  openDialog(entry ? '编辑行为参数' : copy ? '复制行为' : '引用行为', [
    name ? field('副本名称', name) : muted(`${behavior.name} · ${behavior.steps.length} 步`),
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

function assertionDialog(row) {
  const picker = locatorFields(actionTarget(row.action));
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
  openDialog('运行测试项', [
    field('运行方式', mode), confirmation,
    muted('离线运行读取快照。实时回放向目标窗口写入并可能触发 macOS 权限提示。'),
    muted('前置条件修复可能启动应用或将窗口切到前台。含坐标点击的测试项需要保存后使用 CLI 的 --headed 参数。'),
  ], '开始运行', async () => {
    const selected = mode.value;
    if (selected === 'live' && !confirmed.checked) throw new Error('确认目标窗口后开始回放。');
    const report = await api('run', { ...currentTest(), mode: selected, confirm: confirmed.checked });
    status(`${selected === 'offline' ? '离线运行' : '实时回放'}${resultStatus[report.status]} · ${report.entries.length} 条结果`,
      report.status === 'passed' ? 'success' : 'error');
    setTimeout(() => openDialog('运行结果', [
      el('h3', {}, resultStatus[report.status]),
      el('ol', { className: 'stack' }, ...report.entries.map(entry => el('li', {},
        `${entry.kind} · ${resultStatus[entry.status]} · ${entry.durationMs} ms`,
        entry.message ? muted(entry.message) : undefined))),
    ]), 0);
  });
}

for (const [id, name] of [['import-button', 'folder'], ['save-button', 'save'], ['run-button', 'play'],
  ['actions-tab', 'list'], ['library-tab', 'layers']]) {
  const node = $(id);
  if (node && !node.querySelector('svg')) node.prepend(icon(name));
}

$('app-picker').onclick = openAppPicker;
$('import-button').onclick = importDialog;
$('show-ignored').onchange = event => { state.showIgnored = event.target.checked; render(); };
$('save-button').onclick = saveTest;
$('run-button').onclick = runDialog;
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
