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
  const flow = {
    version: 1, id: id('test'), name, target: session.target, setup: session.setup, steps,
    ...(behaviors.size ? { behaviors: [...behaviors.values()] } : {}),
  };
  return secrets.length ? { format: 'cuekeeper-test', version: 1, flow, secrets } : flow;
}

export function visibleRows(rows, app, ignored, showIgnored) {
  return rows.filter(row => (!app || row.app === app) && (showIgnored || !ignored.has(row.id)));
}

export function changeTarget(action, target) {
  if (action.kind === 'click' || action.kind === 'type') return { ...action, target };
  if (action.kind === 'assert' || action.kind === 'wait') return { ...action, check: { ...action.check, target } };
  throw new Error('快捷键使用目标窗口。');
}
