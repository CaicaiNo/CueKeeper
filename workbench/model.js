export const id = prefix => `${prefix}-${crypto.randomUUID()}`;
export const sameTarget = (a, b) => a.app === b.app && a.window === b.window;

export const KIND_LABELS = {
  click: '点击', doubleClick: '双击', tripleClick: '三击', rightClick: '右键', scroll: '滚轮',
  drag: '拖拽', hover: '悬停', paste: '粘贴', type: '输入', key: '快捷键', wait: '等待',
  assert: '断言', behavior: '行为', shell: 'Shell',
};

/** The timeline shows pointer variants as their own kind without changing the flow. */
export function actionKind(action) {
  if (action.kind !== 'click') return action.kind;
  if (action.button === 'right') return 'rightClick';
  if (action.count === 2) return 'doubleClick';
  if (action.count === 3) return 'tripleClick';
  return 'click';
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
    : `${target.role}${target.name ? ` “${target.name}”` : ''}`;
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
