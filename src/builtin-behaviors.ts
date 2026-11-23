import type { ElementV2, FlowV2, Scope, StepV2, WindowScope } from './contracts-v2.js';

// Built-in behaviors ship with the product. They are not files under
// `~/.cuekeeper/behaviors`, cannot be edited or deleted, and are inserted as
// real v2 steps: a parameterized step names a runtime input, never a value.
// This module owns the definitions, the product-facing summary the workbench
// shows, and the one shot expansion into schema-valid steps.

export type BuiltinGroup = 'finder' | 'universal';
export type BuiltinModifier = 'meta' | 'ctrl' | 'alt' | 'shift';

export interface BuiltinParameter {
  /** Parameter name written into the type step. */
  name: string;
  /** Product wording shown next to the field. */
  label: string;
  placeholder: string;
  maxLength: number;
}

export type BuiltinStepTemplate =
  | { kind: 'key'; key: string; modifiers?: readonly BuiltinModifier[] }
  | { kind: 'type'; input: string; role: string };

export interface BuiltinBehavior {
  id: string;
  name: string;
  group: BuiltinGroup;
  /** The app the shortcuts are written for; a universal behavior omits it. */
  app?: string;
  appLabel: string;
  summary: string;
  parameters: readonly BuiltinParameter[];
  steps: readonly BuiltinStepTemplate[];
}

const nameParameter: BuiltinParameter = {
  name: 'name', label: '名称', placeholder: '例如 报告-2026.md', maxLength: 255,
};
const pathParameter: BuiltinParameter = {
  name: 'path', label: '路径', placeholder: '例如 ~/Downloads 或 /Users/me', maxLength: 1024,
};

export const builtinBehaviors: readonly BuiltinBehavior[] = [
  {
    id: 'finder-rename', name: '重命名', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '在原地进入重命名，输入新名称并确认。',
    parameters: [nameParameter],
    steps: [
      { kind: 'key', key: 'r', modifiers: ['meta'] },
      { kind: 'type', input: 'name', role: 'textfield' },
      { kind: 'key', key: 'return' },
    ],
  },
  {
    id: 'finder-copy', name: '拷贝', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '把选中的文件放到剪贴板。',
    parameters: [],
    steps: [{ kind: 'key', key: 'c', modifiers: ['meta'] }],
  },
  {
    id: 'finder-paste', name: '粘贴', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '把剪贴板里的文件放到当前文件夹。',
    parameters: [],
    steps: [{ kind: 'key', key: 'v', modifiers: ['meta'] }],
  },
  {
    id: 'finder-cut', name: '剪切', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '把选中的文件标记为移动。',
    parameters: [],
    steps: [{ kind: 'key', key: 'x', modifiers: ['meta'] }],
  },
  {
    id: 'finder-delete', name: '删除', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '把选中的文件移到废纸篓。',
    parameters: [],
    // Cmd+Delete is the backspace key with Command held; the recorder names
    // that physical key `backspace`, so the built-in uses the same name.
    steps: [{ kind: 'key', key: 'backspace', modifiers: ['meta'] }],
  },
  {
    id: 'finder-new-folder', name: '新建文件夹', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '新建一个文件夹，输入名称并确认。',
    parameters: [nameParameter],
    steps: [
      { kind: 'key', key: 'n', modifiers: ['meta', 'shift'] },
      { kind: 'type', input: 'name', role: 'textfield' },
      { kind: 'key', key: 'return' },
    ],
  },
  {
    id: 'finder-select-all', name: '全选', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '选中当前窗口里的全部项目。',
    parameters: [],
    steps: [{ kind: 'key', key: 'a', modifiers: ['meta'] }],
  },
  {
    id: 'finder-open', name: '打开选中项', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '打开选中的文件或文件夹。',
    parameters: [],
    steps: [{ kind: 'key', key: 'o', modifiers: ['meta'] }],
  },
  {
    id: 'finder-close-window', name: '关闭窗口', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '关闭当前 Finder 窗口。',
    parameters: [],
    steps: [{ kind: 'key', key: 'w', modifiers: ['meta'] }],
  },
  {
    id: 'finder-go-to-folder', name: '前往文件夹', group: 'finder',
    app: 'com.apple.finder', appLabel: 'Finder',
    summary: '打开「前往文件夹」，输入路径并确认。',
    parameters: [pathParameter],
    steps: [
      { kind: 'key', key: 'g', modifiers: ['meta', 'shift'] },
      { kind: 'type', input: 'path', role: 'textfield' },
      { kind: 'key', key: 'return' },
    ],
  },
  {
    id: 'universal-copy', name: '复制', group: 'universal', appLabel: '通用',
    summary: '复制当前选区。',
    parameters: [],
    steps: [{ kind: 'key', key: 'c', modifiers: ['meta'] }],
  },
  {
    id: 'universal-paste', name: '粘贴', group: 'universal', appLabel: '通用',
    summary: '粘贴剪贴板内容。',
    parameters: [],
    steps: [{ kind: 'key', key: 'v', modifiers: ['meta'] }],
  },
  {
    id: 'universal-undo', name: '撤销', group: 'universal', appLabel: '通用',
    summary: '撤销上一步操作。',
    parameters: [],
    steps: [{ kind: 'key', key: 'z', modifiers: ['meta'] }],
  },
  {
    id: 'universal-save', name: '保存', group: 'universal', appLabel: '通用',
    summary: '保存当前文档。',
    parameters: [],
    steps: [{ kind: 'key', key: 's', modifiers: ['meta'] }],
  },
  {
    id: 'universal-select-all', name: '全选', group: 'universal', appLabel: '通用',
    summary: '选中当前内容。',
    parameters: [],
    steps: [{ kind: 'key', key: 'a', modifiers: ['meta'] }],
  },
];

export function getBuiltinBehavior(id: string): BuiltinBehavior | undefined {
  return builtinBehaviors.find(behavior => behavior.id === id);
}

const modifierSymbols: Record<BuiltinModifier, string> = {
  ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘',
};
const namedKeyLabels: Record<string, string> = {
  return: 'Return', tab: 'Tab', space: 'Space', escape: 'Esc',
  backspace: 'Delete', forwarddelete: 'Forward Delete', delete: 'Delete',
  up: '↑', down: '↓', left: '←', right: '→',
  home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down',
};

const modifierOrder: readonly BuiltinModifier[] = ['ctrl', 'alt', 'shift', 'meta'];

/** A shortcut as the product writes it: ⌘R, ⇧⌘N, ⌘Return. */
export function builtinKeyLabel(key: string, modifiers: readonly BuiltinModifier[] = []): string {
  const symbols = modifierOrder.filter(modifier => modifiers.includes(modifier))
    .map(modifier => modifierSymbols[modifier]).join('');
  return symbols + (namedKeyLabels[key] ?? key.toUpperCase());
}

export function builtinStepLabel(step: BuiltinStepTemplate): string {
  return step.kind === 'key'
    ? builtinKeyLabel(step.key, step.modifiers)
    : `输入 {${step.input}}`;
}

/** The read-only card the workbench library panel shows for one built-in. */
export interface BuiltinBehaviorView {
  source: 'builtin';
  editable: false;
  id: string;
  name: string;
  group: BuiltinGroup;
  app?: string;
  appLabel: string;
  summary: string;
  parameters: BuiltinParameter[];
  steps: Array<{ kind: 'key' | 'type'; label: string }>;
  /** The role of the text step, so the insert dialog can prefill a locator. */
  targetRole?: string;
}

export function builtinBehaviorView(behavior: BuiltinBehavior): BuiltinBehaviorView {
  const textStep = behavior.steps.find(step => step.kind === 'type');
  return {
    source: 'builtin',
    editable: false,
    id: behavior.id,
    name: behavior.name,
    group: behavior.group,
    ...(behavior.app === undefined ? {} : { app: behavior.app }),
    appLabel: behavior.appLabel,
    summary: behavior.summary,
    parameters: behavior.parameters.map(parameter => ({ ...parameter })),
    steps: behavior.steps.map(step => ({ kind: step.kind, label: builtinStepLabel(step) })),
    ...(textStep === undefined ? {} : { targetRole: textStep.role }),
  };
}

export function builtinBehaviorViews(): BuiltinBehaviorView[] {
  return builtinBehaviors.map(builtinBehaviorView);
}

/** A bad built-in insert request; the workbench answers 400 with this code. */
export class BuiltinBehaviorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BuiltinBehaviorError';
  }
}

const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const windowKeyPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const parameterPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const stepIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface BuiltinScopeInput {
  app: string;
  windowTitle: string;
  /** Left out, the app's existing window key or a derived one is used. */
  windowKey?: string;
}

export interface BuiltinInsertion {
  /** Index of the first inserted step, after `afterStepId` or at the end. */
  index: number;
  steps: StepV2[];
  /** Runtime parameters the inserted type steps reference. */
  inputs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown, code: string, message: string) {
  if (typeof value !== 'string' || !value.trim()) throw new BuiltinBehaviorError(code, message);
  return value.trim();
}

function windowBinding(flow: FlowV2): Map<string, string> {
  const bindings = new Map<string, string>();
  const add = (scope: Scope) => {
    if (scope.kind === 'window') bindings.set(scope.windowKey, scope.app);
    if (scope.kind === 'surface' && scope.surface === 'app_context_menu') {
      bindings.set(scope.windowKey, scope.app);
    }
  };
  for (const step of flow.steps) {
    if (step.kind !== 'gap') add(step.scope);
    if ('focusAfter' in step && step.focusAfter) add(step.focusAfter);
    if (step.kind === 'manual_checkpoint') add(step.resume.scope);
  }
  for (const intent of flow.intents ?? []) {
    for (const effect of intent.observableEffects) add(effect.scope);
  }
  return bindings;
}

/** A window key derived from the bundle id, avoiding every key the flow uses. */
function derivedWindowKey(flow: FlowV2, app: string): string {
  const taken = new Set(windowBinding(flow).keys());
  const tail = app.split('.').pop() ?? 'window';
  const base = tail.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'window';
  const stem = (/^[a-z]/.test(base) ? base : `app-${base}`).slice(0, 48);
  let candidate = stem;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${stem}-${suffix++}`;
  return candidate;
}

function windowScope(flow: FlowV2, input: unknown): WindowScope {
  if (!isRecord(input)) throw new BuiltinBehaviorError('INVALID_SCOPE', '窗口作用域需要 App 与窗口标题');
  const app = textField(input.app, 'INVALID_APP', '内置行为需要一个 App 标识');
  if (!bundleIdPattern.test(app)) {
    throw new BuiltinBehaviorError('INVALID_APP', `"${app}" 不是 App 标识（例如 com.apple.finder）`);
  }
  const windowTitle = textField(input.windowTitle, 'INVALID_WINDOW_TITLE', '内置行为需要目标窗口标题');
  if (windowTitle.length > 256) {
    throw new BuiltinBehaviorError('INVALID_WINDOW_TITLE', '窗口标题最多 256 个字符');
  }
  const requested = input.windowKey === undefined || input.windowKey === ''
    ? undefined : textField(input.windowKey, 'INVALID_WINDOW_KEY', 'windowKey 不能为空');
  if (requested !== undefined && !windowKeyPattern.test(requested)) {
    throw new BuiltinBehaviorError('INVALID_WINDOW_KEY', `"${requested}" 不是有效的 windowKey`);
  }
  const bindings = windowBinding(flow);
  if (requested !== undefined) {
    const bound = bindings.get(requested);
    if (bound !== undefined && bound !== app) {
      throw new BuiltinBehaviorError(
        'WINDOW_KEY_CONFLICT', `windowKey ${requested} 已经绑给 ${bound}，不能用于 ${app}`);
    }
    return { kind: 'window', app, windowKey: requested, windowTitle };
  }
  const existing = [...bindings.entries()].find(([, boundApp]) => boundApp === app)?.[0];
  return { kind: 'window', app, windowKey: existing ?? derivedWindowKey(flow, app), windowTitle };
}

function elementTarget(input: unknown, role: string): ElementV2 {
  if (input === undefined || input === null) return { kind: 'element', role };
  if (!isRecord(input)) throw new BuiltinBehaviorError('INVALID_TARGET', '输入步骤的目标需要一个元素定位器');
  const targetRole = input.role === undefined ? role : textField(input.role, 'INVALID_TARGET', '定位器需要控件类型（role）');
  const target: ElementV2 = { kind: 'element', role: targetRole };
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > 256) {
      throw new BuiltinBehaviorError('INVALID_TARGET', '定位器名称最多 256 个字符');
    }
    target.name = input.name;
  }
  if (input.path !== undefined) {
    if (!Array.isArray(input.path) || input.path.length === 0 || input.path.length > 51 ||
        input.path.some(part => typeof part !== 'string' || !part || part.length > 256)) {
      throw new BuiltinBehaviorError('INVALID_TARGET', '定位器路径需要 1–51 个非空段');
    }
    target.path = [...(input.path as string[])];
  }
  if (input.index !== undefined) {
    if (!Number.isSafeInteger(input.index) || (input.index as number) < 0) {
      throw new BuiltinBehaviorError('INVALID_TARGET', '定位器序号需要非负整数');
    }
    target.index = input.index as number;
  }
  return target;
}

function parameterName(input: unknown, fallback: string): string {
  if (input === undefined) return fallback;
  if (typeof input !== 'string' || !parameterPattern.test(input)) {
    throw new BuiltinBehaviorError(
      'INVALID_INPUT_NAME', `"${String(input)}" 不是参数名（字母开头，只含字母、数字与下划线）`);
  }
  return input;
}

function freeStepIds(flow: FlowV2, base: string, count: number): string[] {
  const taken = new Set(flow.steps.map(step => step.id));
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const prefix = attempt === 1 ? base : `${base}-${attempt}`;
    const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
    if (ids.every(id => stepIdPattern.test(id) && !taken.has(id))) return ids;
  }
  throw new BuiltinBehaviorError('STEP_ID_EXHAUSTED', `没有可用的步骤 id 前缀：${base}`);
}

/**
 * Expand one built-in behavior into real v2 steps at a chosen position. The
 * caller (the edit engine) commits this as one undoable insertion and declares
 * the returned inputs on the flow.
 */
export function planBuiltinInsertion(flow: FlowV2, input: unknown): BuiltinInsertion {
  if (!isRecord(input)) throw new BuiltinBehaviorError('INVALID_REQUEST', '插入内置行为需要请求体');
  const behaviorId = textField(input.behavior, 'UNKNOWN_BEHAVIOR', '没有指定内置行为');
  const behavior = getBuiltinBehavior(behaviorId);
  if (!behavior) throw new BuiltinBehaviorError('UNKNOWN_BEHAVIOR', `没有内置行为 ${behaviorId}`);
  const scope = windowScope(flow, input.scope);
  const role = behavior.steps.find(step => step.kind === 'type')?.role;
  const target = elementTarget(input.target, role ?? 'textfield');
  const params = isRecord(input.params) ? input.params : {};

  let index = flow.steps.length;
  let anchor: StepV2 | undefined;
  if (input.afterStepId !== undefined) {
    const afterStepId = textField(input.afterStepId, 'UNKNOWN_STEP', '插入位置需要一个步骤 id');
    const found = flow.steps.findIndex(step => step.id === afterStepId);
    if (found === -1) throw new BuiltinBehaviorError('UNKNOWN_STEP', `流程里没有步骤 ${afterStepId}`);
    index = found + 1;
    anchor = flow.steps[found];
  }

  const ids = freeStepIds(flow, behavior.id, behavior.steps.length);
  const atMs = anchor && anchor.atMs !== undefined ? { atMs: anchor.atMs } : {};
  const inputs: string[] = [];
  const steps = behavior.steps.map((template, offset): StepV2 => {
    const stepScope: WindowScope = { ...scope };
    if (template.kind === 'key') {
      return {
        id: ids[offset], kind: 'key', scope: stepScope,
        key: template.key,
        ...(template.modifiers === undefined ? {} : { modifiers: [...template.modifiers] }),
        ...atMs,
      } as StepV2;
    }
    const name = parameterName(params[template.input], template.input);
    if (!inputs.includes(name)) inputs.push(name);
    return {
      id: ids[offset], kind: 'type', scope: stepScope,
      target: { ...target },
      input: name,
      ...atMs,
    } as StepV2;
  });
  return { index, steps, inputs };
}
