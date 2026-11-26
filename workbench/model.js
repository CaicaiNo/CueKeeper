export const id = prefix => `${prefix}-${crypto.randomUUID()}`;
export const sameTarget = (a, b) => a.app === b.app && a.window === b.window;

export const KIND_LABELS = {
  click: '点击', doubleClick: '双击', tripleClick: '三击', rightClick: '右键', scroll: '滚轮',
  drag: '拖拽', hover: '悬停', paste: '粘贴', type: '输入', key: '快捷键', wait: '等待',
  assert: '断言', behavior: '行为', shell: 'Shell',
  launch_app: '启动', activate_app: '激活', focus_window: '聚焦窗口',
  open_system_surface: '打开系统界面', surface_press: '系统界面操作',
  manual_checkpoint: '人工检查点', gap: '缺口',
};

/** The timeline shows pointer variants as their own kind without changing the flow. */
export function actionKind(action) {
  if (action.kind !== 'click') return action.kind;
  if (action.button === 'right') return 'rightClick';
  if (action.count === 2) return 'doubleClick';
  if (action.count === 3) return 'tripleClick';
  return 'click';
}

export const SURFACE_LABELS = {
  dock: 'Dock', app_menu_bar: 'App 菜单栏', app_context_menu: '上下文菜单',
  menu_bar_extras: '系统状态项', spotlight: 'Spotlight',
};

/** A v2 step scope as shown in the timeline; `appName` resolves bundle IDs. */
export function scopeDescription(scope, appName = id => id) {
  if (!scope) return '缺口';
  if (scope.kind === 'window') return `${appName(scope.app)} · ${scope.windowTitle}`;
  if (scope.kind === 'app') return `${appName(scope.app)} · 应用`;
  if (scope.kind === 'file') {
    if (scope.path !== undefined) return `文件 · ${scope.path}`;
    return `文件 · ${scope.name ?? `*${scope.suffix}`}（${scope.directory}）`;
  }
  if (scope.kind === 'process') return `进程 · ${scope.name ?? scope.path}`;
  return [SURFACE_LABELS[scope.surface] ?? scope.surface,
    scope.app ? appName(scope.app) : '', scope.windowTitle ?? ''].filter(Boolean).join(' · ');
}

/**
 * Product words for the AX roles a recording can carry. The timeline names a
 * control by what it is, so a bare `AXGroup` never reaches a label; the raw
 * role stays in the locator's technical detail. Keys are bare, lower-case
 * role names — `AXTextField` and `textfield` both land on `textfield`.
 */
export const ROLE_LABELS = {
  window: '窗口', group: '区域', textfield: '文本输入框', textarea: '文本区域',
  securetextfield: '密码输入框', searchfield: '搜索框', button: '按钮', cell: '文件项',
  row: '行', table: '表格', outline: '列表', list: '列表', menuitem: '菜单项', menu: '菜单',
  menubar: '菜单栏', menuitemcheckbox: '菜单勾选项', menuitemradio: '菜单选项',
  statictext: '文本', heading: '标题', image: '图片', checkbox: '勾选框',
  radiobutton: '单选框', radiogroup: '单选项组', popupbutton: '下拉菜单', combobox: '组合框',
  slider: '滑块', scrollarea: '滚动区域', link: '链接', tabgroup: '标签页', tab: '标签页',
  toolbar: '工具栏', toolbarbutton: '工具栏按钮', sheet: '工作表', dialog: '对话框',
  webarea: '网页内容', progressindicator: '进度指示器', splitgroup: '分栏',
  disclosuretriangle: '展开三角形', grid: '网格', column: '列', layoutarea: '版面区域',
  layoutitem: '版面元素',
};

/** One role in product words; an unknown role still never leaks `AX*`. */
export function roleLabel(role) {
  const raw = typeof role === 'string' ? role.trim() : '';
  if (!raw || raw === 'AX') return '';
  const bare = raw.replace(/^AX/, '').toLowerCase();
  if (!bare) return '';
  return ROLE_LABELS[bare] ?? '控件';
}

/**
 * The one readable name a user can recognise: the control's own name (file,
 * field or button title) first, then the deepest path segment, then its role.
 * A raw point keeps the warning; nothing readable becomes 「未命名控件」.
 */
export function targetLabel(target) {
  if (!target) return '目标窗口';
  if (target.kind === 'window') return '窗口';
  if (target.kind === 'point') {
    return `坐标回放 · 需确认${Array.isArray(target.point) ? ` (${target.point.join(', ')})` : ''}`;
  }
  const name = typeof target.name === 'string' ? target.name.trim() : '';
  if (name) return name;
  const path = Array.isArray(target.path)
    ? target.path.filter(segment => typeof segment === 'string' && segment.trim()) : [];
  const fromPath = path.length ? roleLabel(path.at(-1)) : '';
  if (fromPath && fromPath !== '控件') return fromPath;
  return roleLabel(target.role) || '未命名控件';
}

/** The raw locator the detail panel keeps: role, name, path and index. */
export function locatorDetail(target) {
  if (!target) return '—';
  if (target.kind === 'point') return `point (${target.point?.join(', ') ?? ''})`;
  if (target.kind === 'window') {
    return ['window', target.app, target.window, target.match].filter(Boolean).join(' · ');
  }
  return [target.role,
    typeof target.name === 'string' ? `名称 “${target.name}”` : '',
    Array.isArray(target.path) && target.path.length ? target.path.join(' › ') : '',
    target.index === undefined ? '' : `[${target.index}]`]
    .filter(Boolean).join(' · ');
}

const scrollArrows = { up: '↑', down: '↓', left: '←', right: '→' };

export function scrollDetail(action) {
  if (action.direction !== undefined) return { direction: action.direction, amount: action.amount };
  const dx = action.deltaX ?? 0;
  const dy = action.deltaY ?? 0;
  const vertical = Math.abs(dy) >= Math.abs(dx) && dy !== 0;
  return {
    direction: vertical ? (dy > 0 ? 'up' : 'down') : (dx > 0 ? 'right' : 'left'),
    amount: Math.max(1, Math.round(Math.abs(vertical ? dy : dx))),
  };
}

export function scrollLabel(action) {
  const { direction, amount } = scrollDetail(action);
  return `滚轮 ${scrollArrows[direction] ?? ''} ${amount} 行`;
}

/** The timeline names both drag endpoints; a re-picked endpoint stays visible. */
export function dragSummary(action) {
  const endpoint = target => target.kind === 'point'
    ? `坐标 (${target.point[0]}, ${target.point[1]})`
    : targetLabel(target);
  return `拖拽 ${endpoint(action.from)} → ${endpoint(action.to)}`;
}

export function makeBehavior(rows, name, bindings, target) {
  if (rows.some(row => !sameTarget(row, target))) throw new Error('只能合并属于当前目标窗口的动作。');
  const parameterTypes = Object.create(null);
  const defaults = Object.create(null);
  const steps = rows.map((row, index) => {
    const action = { ...row.action, id: `step-${index + 1}` };
    const binding = bindings.get(row.id);
    if (!binding) return action;
    const { param, type } = binding;
    if (action.kind !== 'type' || !/^[a-z][a-z0-9_]{0,63}$/i.test(param) || Object.hasOwn(parameterTypes, param)) {
      throw new Error('每个参数需有唯一名称，使用字母开头，后接字母、数字或下划线。');
    }
    parameterTypes[param] = type;
    defaults[param] = type === 'secret' ? `CUEKEEPER_SECRET_${param.toUpperCase()}` : action.text;
    return { ...action, text: { param } };
  });
  return {
    item: {
      version: 1, target, parameterTypes,
      behavior: { id: id('behavior'), name, parameters: Object.keys(parameterTypes), steps },
    },
    defaults,
  };
}

export function compileDraft(session, name, entries, appPaths = {}) {
  const behaviors = new Map();
  const secrets = [];
  const steps = entries.map(entry => {
    if (!entry.item) return { ...entry.action, id: entry.id };
    const { behavior, parameterTypes } = entry.item;
    behaviors.set(behavior.id, behavior);
    for (const param of behavior.parameters) {
      if (parameterTypes[param] === 'secret') secrets.push({ step: entry.id, param });
    }
    return { id: entry.id, kind: 'behavior', behavior: behavior.id, args: entry.args };
  });
  const setup = confirmedSetup(session.setup);
  const appPath = appPaths[session.target.app];
  const target = appPath ? { ...session.target, appPath } : session.target;
  const flow = {
    version: 1, id: id('test'), name, target, steps,
    ...(setup.length ? { setup } : {}),
    ...(behaviors.size ? { behaviors: [...behaviors.values()] } : {}),
  };
  return secrets.length ? { format: 'cuekeeper-test', version: 1, flow, secrets } : flow;
}

export function confirmedSetup(conditions = []) {
  return conditions.filter(condition => condition.state === 'confirmed');
}

export function setupDraft(conditions = []) {
  return { conditions: structuredClone(conditions), history: new Map() };
}

function conditionIndex(draft, id) {
  const index = draft.conditions.findIndex(condition => condition.id === id);
  if (index < 0) throw new Error('前置条件不存在。');
  return index;
}

function edit(draft, id, change) {
  const index = conditionIndex(draft, id);
  const previous = draft.conditions[index];
  const next = change(structuredClone(previous));
  const history = draft.history.get(id) ?? [];
  history.push(previous);
  draft.history.set(id, history);
  draft.conditions[index] = next;
  return next;
}

export function confirmCondition(draft, id) {
  return edit(draft, id, condition => ({ ...condition, state: 'confirmed' }));
}

export function deleteCondition(draft, id) {
  return edit(draft, id, condition => ({ ...condition, state: 'deleted' }));
}

export function retargetCondition(draft, id, { app, window }) {
  const nextApp = typeof app === 'string' ? app.trim() : '';
  const nextWindow = typeof window === 'string' ? window.trim() : '';
  if (!nextApp || !nextWindow || nextApp.length > 256 || nextWindow.length > 256) {
    throw new Error('填写应用标识和窗口标题，均不超过 256 个字符。');
  }
  return edit(draft, id, condition => {
    const kind = condition.ensure?.kind;
    const ensure = kind === 'window_ready'
      ? { ...condition.ensure, app: nextApp, window: nextWindow }
      : kind === 'app_running' ? { ...condition.ensure, app: nextApp } : undefined;
    const name = kind === 'window_ready'
      ? `窗口已就绪 · ${nextWindow}`
      : kind === 'app_running' ? `应用已启动 · ${nextApp}` : condition.name;
    const target = condition.check.target.role === 'window'
      ? { ...condition.check.target, name: nextWindow } : condition.check.target;
    return {
      ...condition, name: name.slice(0, 256), state: 'inferred',
      check: { ...condition.check, target }, ...(ensure ? { ensure } : {}),
    };
  });
}

export function canUndo(draft, id) {
  return (draft.history.get(id)?.length ?? 0) > 0;
}

export function undoCondition(draft, id) {
  const history = draft.history.get(id);
  const previous = history?.pop();
  if (!previous) return undefined;
  draft.conditions[conditionIndex(draft, id)] = previous;
  return previous;
}

export const APP_ROW_LIMIT = 80;

/** How a duration reads in the workbench; `undefined` means it was not timed. */
export function durationLabel(ms) {
  if (ms === undefined || ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

/**
 * The summary line for a recording's length: the net time it ran, with the
 * paused span called out when the recording had one.
 */
export function sessionDurationLabel(durationMs, pausedMs) {
  const net = durationLabel(durationMs);
  return pausedMs > 0 ? `${net} · 含暂停 ${durationLabel(pausedMs)}` : net;
}

export function filterApps(catalog, query, limit = APP_ROW_LIMIT) {
  const value = query.trim().toLowerCase();
  return catalog.filter(app => !value ||
    app.name.toLowerCase().includes(value) || app.bundleId.toLowerCase().includes(value)).slice(0, limit);
}

export function staleAppPath(app, appPaths = {}) {
  const chosen = appPaths?.[app.bundleId];
  return Boolean(chosen) && !(app.paths ?? []).includes(chosen);
}

export function pickerRows(catalog, query, { current = '', appPaths = {} } = {}) {
  const rows = filterApps(catalog, query).map(app => ({
    kind: 'app', app, bundleId: app.bundleId,
    selected: current === app.bundleId, stale: staleAppPath(app, appPaths),
  }));
  if (!query.trim()) rows.unshift({ kind: 'all', app: undefined, bundleId: '', selected: !current, stale: false });
  return rows;
}

export function moveAppFocus(index, delta, length) {
  if (length <= 0) return -1;
  if (index < 0) return delta > 0 ? 0 : length - 1;
  return ((index + delta) % length + length) % length;
}

export function visibleRows(rows, app, ignored, showIgnored) {
  return rows.filter(row => (!app || row.app === app) && (showIgnored || !ignored.has(row.id)));
}

export function changeTarget(action, target) {
  if (action.kind === 'click' || action.kind === 'type' || action.kind === 'scroll' ||
      action.kind === 'hover' || action.kind === 'paste') return { ...action, target };
  if (action.kind === 'assert' || action.kind === 'wait') return { ...action, check: { ...action.check, target } };
  throw new Error('快捷键使用目标窗口。');
}

const shellKey = /^(?!(?:HOME|USER|LOGNAME|TMPDIR|LANG|PATH|NODE_OPTIONS)$|(?:SUDO_|DYLD_|LD_|CUEKEEPER_))[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const shellSecret = /^CUEKEEPER_SECRET_[A-Z0-9_]{1,64}$/;
const privilegedTask = /^\/Library\/CueKeeper\/privileged\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Builds a closed shell step from the draft editor. The workbench validates
 * locally so imported and hand-edited steps fail before replay; the runner
 * validates again from the generated schema.
 */
export function shellDraft(input = {}) {
  const mode = input.mode === 'script' ? 'script' : 'argv';
  const privilege = input.privilege === 'sudo' ? 'sudo' : input.privilege === 'root' ? 'root' : 'user';
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  const timeoutMs = input.timeoutMs === undefined || input.timeoutMs === '' ? 30000 : Number(input.timeoutMs);
  const expectedExitCode = input.expectedExitCode === undefined || input.expectedExitCode === ''
    ? 0 : Number(input.expectedExitCode);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('超时必须为 1–120000 毫秒。');
  }
  if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255) {
    throw new Error('预期退出码必须为 0–255。');
  }
  if (cwd.length > 4096) throw new Error('工作目录过长。');
  if (privilege === 'sudo') {
    const path = Array.isArray(input.argv) ? input.argv.join('').trim() : '';
    if (!privilegedTask.test(path)) {
      throw new Error('管理员任务必须是 /Library/CueKeeper/privileged/<任务 ID> 的绝对路径。');
    }
    if (cwd || mode === 'script') throw new Error('管理员任务不能使用工作目录或脚本模式。');
    return {
      kind: 'shell', argv: [path], privilege: 'sudo',
      ...(expectedExitCode ? { expectedExitCode } : {}),
    };
  }
  if (privilege === 'root') {
    // Root steps run exact argv only: no shell string, no caller environment.
    if (mode === 'script' || (typeof input.command === 'string' && input.command.trim())) {
      throw new Error('Root 步骤只能逐项填写参数，不能使用 Shell 脚本。');
    }
    if ((input.env ?? []).some(row => String(row?.[0] ?? '').trim())) {
      throw new Error('Root 步骤不接受环境变量，避免把调用方环境带进特权进程。');
    }
    const argv = (input.argv ?? []).map(part => String(part ?? ''));
    if (!argv.length || !argv[0]) throw new Error('填写要执行的程序。');
    if (argv.length > 65) throw new Error('参数最多 65 项。');
    if (argv.some(part => part.length > 4096 || part.includes('\u0000'))) throw new Error('参数过长或包含无效字符。');
    const privilegeMode = input.privilegeMode === 'sudoers' ? 'sudoers'
      : input.privilegeMode === 'keychain' ? 'keychain' : 'prompt';
    return {
      kind: 'shell', argv, privilege: 'root',
      ...(privilegeMode !== 'prompt' ? { privilegeMode } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs === 30000 ? {} : { timeoutMs }),
      ...(expectedExitCode ? { expectedExitCode } : {}),
    };
  }
  const env = {};
  for (const [key, value, secret] of input.env ?? []) {
    const name = String(key ?? '').trim();
    const content = String(value ?? '');
    if (!name) continue;
    if (!shellKey.test(name)) throw new Error(`环境变量名 ${name} 无效或属于保留键。`);
    if (Object.hasOwn(env, name)) throw new Error(`环境变量 ${name} 重复。`);
    if (Object.keys(env).length >= 32) throw new Error('环境变量最多 32 个。');
    if (secret) {
      if (!shellSecret.test(content)) throw new Error('环境引用必须是以 CUEKEEPER_SECRET_ 开头的变量名。');
      env[name] = { secretEnv: content };
    } else {
      if (content.length > 4000 || content.includes('\u0000')) throw new Error(`环境变量 ${name} 的值无效。`);
      env[name] = content;
    }
  }
  const common = {
    kind: 'shell',
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(timeoutMs === 30000 ? {} : { timeoutMs }),
    ...(expectedExitCode ? { expectedExitCode } : {}),
  };
  if (mode === 'script') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command.trim() || command.length > 16384) throw new Error('填写 1–16384 个字符的 Shell 脚本。');
    return { ...common, shell: true, command };
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    throw new Error('逐项参数模式不能同时填写 Shell 脚本。');
  }
  const argv = (input.argv ?? []).map(part => String(part ?? ''));
  if (!argv.length || !argv[0]) throw new Error('填写要执行的程序。');
  if (argv.length > 65) throw new Error('参数最多 65 项。');
  if (argv.some(part => part.length > 4096 || part.includes('\u0000'))) throw new Error('参数过长或包含无效字符。');
  return { ...common, argv };
}

export function shellSummary(action) {
  if (action.kind !== 'shell') throw new Error('不是 Shell 步骤。');
  const privilege = action.privilege === 'sudo'
    ? '需管理员预配置'
    : action.privilege === 'root'
      ? (action.privilegeMode === 'sudoers' ? 'Root · sudoers 免密'
        : action.privilegeMode === 'keychain' ? 'Root · 钥匙串无人值守' : 'Root · 密码授权')
      : '用户态';
  const command = action.shell === true
    ? `/bin/sh -c ${action.command}`
    : action.argv.map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  return { command, cwd: action.cwd ?? '输入目录', privilege };
}

// --- Version 2 timeline editing -------------------------------------------------
// These helpers only turn a v2 step into words and build the payloads the P2
// `EditOp` contract accepts. The server owns every mutation, undo/redo, the
// diff and revision writes; nothing here edits a flow in place.

const waitKindLabels = {
  window_exists: '窗口存在', element_enabled: '元素可用', element: '元素状态',
  window: '窗口属性', app_running: '应用运行中', app_installed: '应用已安装',
  file_exists: '文件存在', file_stable: '文件已写完',
  process_running: '进程运行中',
};

/** One window/app/surface/file/process scope as the editor groups and filters it. */
export function scopeKey(scope) {
  if (!scope) return 'gap';
  if (scope.kind === 'window') return `window:${scope.app}:${scope.windowKey}`;
  if (scope.kind === 'app') return `app:${scope.app}`;
  if (scope.kind === 'file') {
    return scope.path !== undefined
      ? `file:${scope.path}`
      : `file:${scope.directory}/${scope.name ?? `*${scope.suffix}`}`;
  }
  if (scope.kind === 'process') {
    return scope.name !== undefined ? `process:name:${scope.name}` : `process:path:${scope.path}`;
  }
  return `surface:${scope.surface}:${scope.app ?? ''}:${scope.windowKey ?? ''}`;
}

export function expectLabel(expect) {
  if (!expect) return '';
  if (expect.property === 'exists') return `存在 = ${expect.equals ? '成立' : '不成立'}`;
  if (expect.property === 'visible') return `可见 = ${expect.equals ? '成立' : '不成立'}`;
  if (expect.property === 'screenshot') return '截图比对';
  if (expect.equals !== undefined) return `${expect.property} = ${expect.equals}`;
  if (expect.contains !== undefined) return `${expect.property} 包含 ${expect.contains}`;
  if (expect.matches !== undefined) return `${expect.property} 匹配 ${expect.matches}`;
  return expect.property ?? '';
}

/**
 * What a system state check compared, as the report shows it. A passing check
 * still prints both values; an unknown observation prints `实际 未知`.
 */
export function stateCheckLabel(stateCheck) {
  if (!stateCheck) return '';
  const words = stateCheck.kind === 'file_exists'
    ? { yes: '存在', no: '不存在' }
    : { yes: '运行', no: '未运行' };
  const value = observed => observed === null || observed === undefined
    ? '未知' : observed ? words.yes : words.no;
  return `期望 ${value(stateCheck.expected)} · 实际 ${value(stateCheck.actual)}`;
}

/** A wait or assertion condition in one readable line. */
export function checkLabel(check) {
  if (!check) return '—';
  if (check.expect) {
    const target = check.target
      ? (check.target.kind === 'window' ? '窗口' : targetLabel(check.target))
      : '';
    const label = check.kind ? `${waitKindLabels[check.kind] ?? check.kind} · ` : '';
    return `${label}${target}${target ? ' · ' : ''}${expectLabel(check.expect)}`;
  }
  if (check.equals !== undefined) {
    return `${waitKindLabels[check.kind] ?? check.kind} = ${check.equals ? '成立' : '不成立'}`;
  }
  return waitKindLabels[check.kind] ?? check.kind;
}

/** The timeline's one-line description of a v2 step. */
export function v2StepLabel(step, appName = id => id) {
  if (!step) return '';
  switch (step.kind) {
    case 'click': {
      const prefix = step.button === 'right' ? '右键'
        : step.count === 2 ? '双击' : step.count === 3 ? '三击' : '点击';
      return `${prefix} ${targetLabel(step.target)}`;
    }
    case 'type': return 'text' in step
      ? `输入 “${step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text}”`
      : `输入参数 ${step.input}`;
    case 'key': return `快捷键 ${[...(step.modifiers ?? []), step.key].join('+')}`;
    case 'scroll': return `滚轮 ${targetLabel(step.target)}`;
    case 'drag': return `拖拽 ${targetLabel(step.from)} → ${targetLabel(step.to)}`;
    case 'hover': return `悬停 · ${targetLabel(step.target)} · ${step.durationMs} ms`;
    case 'paste': return step.source.kind === 'copy'
      ? `粘贴 · 复制 ${step.source.stepId}`
      : `粘贴 · 参数 ${step.source.input}`;
    case 'wait': return `等待 · ${checkLabel(step.check)}`;
    case 'assert': return `断言 · ${checkLabel(step.check)}`;
    case 'launch_app': return `启动 ${appName(step.scope.app)}`;
    case 'activate_app': return `激活 ${appName(step.scope.app)}`;
    case 'focus_window': return isWindowScope(step.scope) ? `聚焦 ${step.scope.windowTitle}` : '聚焦窗口';
    case 'open_system_surface': return `打开 ${SURFACE_LABELS[step.scope.surface] ?? step.scope.surface}`;
    case 'surface_press': return `操作 ${SURFACE_LABELS[step.scope.surface] ?? step.scope.surface}`;
    case 'manual_checkpoint': return `人工检查点 · 触发 ${step.triggerStepId}`;
    case 'gap': return `缺口 · ${step.code}`;
    default: return KIND_LABELS[step.kind] ?? step.kind;
  }
}

/** The steps whose target the editor can repoint. */
export const V2_TARGET_KINDS = new Set(['click', 'type', 'scroll', 'drag', 'hover', 'paste']);
/** The steps the P2 insert operation accepts. */
export const V2_INSERT_KINDS = new Map([
  ['wait', '等待'], ['assert', '断言'], ['click', '点击'], ['type', '输入'],
  ['key', '快捷键'], ['launch_app', '启动应用'], ['activate_app', '激活应用'], ['focus_window', '聚焦窗口'],
]);
/** The steps a duplicate can insert again. */
export const V2_COPYABLE_KINDS = new Set([
  'click', 'type', 'key', 'wait', 'assert', 'launch_app', 'activate_app', 'focus_window',
]);

// --- Behavior library -----------------------------------------------------------
// The library has two top-level groups. Both open collapsed on every page load;
// the expansion lives in page memory only, so a re-render keeps it and a reload
// forgets it.

export const LIBRARY_GROUPS = [
  { key: 'builtin', title: '内置行为' },
  { key: 'custom', title: '我的行为' },
];

export function defaultLibraryExpanded() {
  return { builtin: false, custom: false };
}

/** Flip one group's expansion without touching the other. */
export function toggleLibraryGroup(expanded, key) {
  if (!Object.hasOwn(defaultLibraryExpanded(), key)) throw new Error(`未知的行为库分组：${key}`);
  return { ...defaultLibraryExpanded(), ...expanded, [key]: !expanded?.[key] };
}

/**
 * The two collapsible groups in display order, each with its own count and
 * expansion flag. Custom behaviors are sorted by name; built-ins keep the
 * product order so Finder, universal and system cards stay together.
 */
export function libraryGroups(library, expanded = {}) {
  const builtin = library?.builtin ?? [];
  const custom = [...(library?.custom ?? [])].sort((a, b) => a.behavior.name.localeCompare(b.behavior.name));
  return LIBRARY_GROUPS.map(group => ({
    key: group.key,
    title: group.title,
    count: group.key === 'builtin' ? builtin.length : custom.length,
    expanded: expanded?.[group.key] === true,
    items: group.key === 'builtin' ? builtin : custom,
  }));
}

const isWindowScope = scope => Boolean(scope) && scope.kind === 'window';

/** Distinct scopes in flow order, for the timeline's scope filter. */
export function scopeOptions(flow, appName = id => id) {
  const seen = new Map();
  for (const step of flow?.steps ?? []) {
    if (step.kind === 'gap' || !step.scope) continue;
    const key = scopeKey(step.scope);
    if (!seen.has(key)) seen.set(key, scopeDescription(step.scope, appName));
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

export function filterStepsByScope(flow, key) {
  const steps = flow?.steps ?? [];
  return key ? steps.filter(step => scopeKey(step.kind === 'gap' ? undefined : step.scope) === key) : steps;
}

/** Added/removed/moved/modified lines for the save panel. */
export function diffSummary(diff) {
  if (!diff) return { changed: false, lines: [] };
  const lines = [];
  if (diff.added.length) lines.push(`新增 ${diff.added.map(item => item.id).join('、')}`);
  if (diff.removed.length) lines.push(`删除 ${diff.removed.map(item => item.id).join('、')}`);
  if (diff.moved.length) {
    lines.push(`移动 ${diff.moved.map(item => `${item.id} ${item.from}→${item.to}`).join('、')}`);
  }
  if (diff.orderChanged && !diff.moved.length) lines.push('步骤顺序变化');
  if (diff.modified.length) {
    lines.push(`修改 ${diff.modified.map(item => `${item.id}（${item.fields.join(' / ')}）`).join('、')}`);
  }
  if (diff.flowFields.length) lines.push(`flow 字段 ${diff.flowFields.join('、')}`);
  return { changed: Boolean(diff.changed ?? lines.length), lines };
}

/**
 * One entry per actual difference, so the page can list what changed instead of
 * recapping every moved step in a single sentence. `diffFlowV2` reports
 * zero-based indices while the timeline numbers steps from 1, so both ends of a
 * move are shifted before they are shown.
 */
export function diffItems(diff) {
  if (!diff) return [];
  const items = [];
  for (const item of diff.added ?? []) items.push(`新增步骤 ${item?.id ?? item}`);
  for (const item of diff.removed ?? []) items.push(`删除步骤 ${item?.id ?? item}`);
  for (const move of diff.moved ?? []) {
    items.push(`移动步骤 ${move.id}：第 ${move.from + 1} 步 → 第 ${move.to + 1} 步`);
  }
  if (diff.orderChanged && !(diff.moved ?? []).length) items.push('步骤顺序变化');
  for (const change of diff.modified ?? []) {
    items.push(`修改步骤 ${change.id}${change.fields?.length ? `（${change.fields.join(' / ')}）` : ''}`);
  }
  if ((diff.flowFields ?? []).length) items.push(`修改流程字段 ${diff.flowFields.join('、')}`);
  return items;
}

/** A run report's entries keyed by step id, so the timeline can mark each step. */
export function statusMap(report) {
  const map = new Map();
  for (const entry of report?.entries ?? []) map.set(entry.id, entry);
  return map;
}

/**
 * Each timed row's place in the recording and the gap since the previous timed
 * row. An untimed row is skipped rather than guessed at, so a gap always spans
 * two steps that were actually recorded with a time.
 */
export function stepTiming(rows) {
  const timing = new Map();
  let previous;
  for (const row of rows) {
    if (row.atMs === undefined) continue;
    timing.set(row.id, {
      atMs: row.atMs,
      sinceMs: previous === undefined ? undefined : row.atMs - previous,
    });
    previous = row.atMs;
  }
  return timing;
}

/** One candidate in the v2 "pick from the current window" dialog. */
export function pickCandidateLabel(candidate) {
  const frame = candidate.bounds
    ? ` · ${candidate.bounds.width} × ${candidate.bounds.height} @ ${candidate.bounds.x}, ${candidate.bounds.y}`
    : '';
  return `${candidate.interactive ? '可交互' : '容器'} · ${targetLabel(candidate.locator)}${frame}`;
}

/** The waiting-checkpoint facts the run panel shows; never a secret. */
export function checkpointWaitFacts(checkpoint, appName = id => id) {
  if (!checkpoint) return [];
  return [
    ['当前步骤', checkpoint.stepId],
    ['触发步骤', checkpoint.triggerStepId],
    ['App / 窗口', checkpoint.scope ? scopeDescription(checkpoint.scope, appName) : '—'],
    ['等待上限', `${Math.round(checkpoint.timeoutMs / 1000)} 秒`],
  ];
}

/**
 * Build an assertion from the dialog. `target` is a window marker or an element
 * locator; text/value assertions carry exactly one comparator.
 */
export function assertCheck({ target, property, equals, contains, matches, normalize }) {
  if (!target) throw new Error('断言需要目标元素或窗口。');
  const comparator = matches !== undefined ? { matches }
    : contains !== undefined ? { contains }
      : { equals: property === 'exists' || property === 'visible' ? Boolean(equals) : String(equals ?? '') };
  if (!['exists', 'visible', 'text', 'value', 'title', 'screenshot'].includes(property)) {
    throw new Error('未知的断言属性。');
  }
  return {
    target,
    expect: {
      property,
      ...(property === 'exists' || property === 'visible' ? { equals: Boolean(equals) } : comparator),
      ...(normalize ? { normalize } : {}),
    },
  };
}

/**
 * Build a complete insert step. Target and app/window fields come from the
 * dialog; ids come from the page because the engine only validates uniqueness.
 */
export function stepTemplate(kind, {
  id, scope, target, key = 'tab', modifiers = [], timeoutMs = 15000, atMs,
}) {
  const step = stepBody(kind, { id, scope, target, key, modifiers, timeoutMs });
  // A step inserted next to an existing one keeps that step's recorded time, so
  // the timeline stays in order; a fresh flow without times stays untimed.
  return atMs === undefined ? step : { ...step, atMs };
}

function stepBody(kind, { id, scope, target, key = 'tab', modifiers = [], timeoutMs = 15000 }) {
  if (!id) throw new Error('步骤需要 id。');
  if (!scope) throw new Error('步骤需要作用域。');
  switch (kind) {
    case 'click':
      if (!target) throw new Error('点击步骤需要元素定位器。');
      return { id, kind, scope, target };
    case 'type':
      if (!target) throw new Error('输入步骤需要元素定位器。');
      return { id, kind, scope, target, text: '输入文本' };
    case 'key':
      return { id, kind, scope, key, ...(modifiers.length ? { modifiers } : {}) };
    case 'wait':
      if (scope.kind === 'app') return { id, kind, scope, check: { kind: 'app_running', equals: true }, timeoutMs };
      return { id, kind, scope, check: { kind: 'window_exists', equals: true }, timeoutMs };
    case 'launch_app':
    case 'activate_app':
      if (scope.kind !== 'app') throw new Error('启动与激活需要 App 作用域。');
      return { id, kind, scope };
    case 'focus_window':
      if (scope.kind !== 'window') throw new Error('聚焦窗口需要窗口作用域。');
      return { id, kind, scope };
    default:
      throw new Error(`${kind} 不能从时间线插入。`);
  }
}
