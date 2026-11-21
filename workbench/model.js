export const id = prefix => `${prefix}-${crypto.randomUUID()}`;
export const sameTarget = (a, b) => a.app === b.app && a.window === b.window;

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

export function compileDraft(session, name, entries) {
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
  const flow = {
    version: 1, id: id('test'), name, target: session.target, steps,
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

export function visibleRows(rows, app, ignored, showIgnored) {
  return rows.filter(row => (!app || row.app === app) && (showIgnored || !ignored.has(row.id)));
}

export function changeTarget(action, target) {
  if (action.kind === 'click' || action.kind === 'type') return { ...action, target };
  if (action.kind === 'assert' || action.kind === 'wait') return { ...action, check: { ...action.check, target } };
  throw new Error('快捷键使用目标窗口。');
}
