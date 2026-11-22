import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { flowV2Check } from './contracts-v2.js';
import type {
  AppScope, AppWaitCheck, AssertCheckV2, ElementV2, FlowV2, Scope, StepV2, SurfaceKind,
  WindowScope, WindowWaitCheck,
} from './contracts-v2.js';
import { writeNew } from './files.js';
import { hashFlowV2, isFlowV2, validateFlowV2 } from './flow-v2.js';

// The pure editing layer behind the workbench timeline. It loads a v2 flow,
// applies validated edits with undo/redo, and writes a new revision without
// ever touching the recorded file. Nothing here opens a window, reads the
// desktop or calls the CLI.

export interface EditErrorDetail {
  code: string;
  message: string;
  stepId?: string;
  field?: string;
}

export class EditError extends Error {
  readonly code: string;
  readonly stepId?: string;
  readonly field?: string;

  constructor(code: string, message: string, detail: { stepId?: string; field?: string } = {}) {
    super(detail.stepId ? `step ${detail.stepId}: ${message}` : message);
    this.name = 'EditError';
    this.code = code;
    if (detail.stepId !== undefined) this.stepId = detail.stepId;
    if (detail.field !== undefined) this.field = detail.field;
  }

  toDetail(): EditErrorDetail {
    return {
      code: this.code,
      message: this.message,
      ...(this.stepId === undefined ? {} : { stepId: this.stepId }),
      ...(this.field === undefined ? {} : { field: this.field }),
    };
  }
}

/** Fields of an element target that the timeline can edit. */
export interface ElementFields {
  role?: string;
  name?: string | null;
  path?: string[] | null;
  index?: number | null;
}

/**
 * A picked target. `point` is accepted only when the picker also resolved the
 * element at that point: a v2 flow never stores raw coordinates.
 */
export type TargetInput =
  | ({ kind: 'element' } & ElementFields)
  | ({ kind: 'point'; x: number; y: number; element?: ElementFields });

export type ScopePatch =
  | { kind: 'window'; app?: string; windowKey?: string; windowTitle?: string }
  | { kind: 'app'; app?: string }
  | {
    kind: 'surface'; surface: SurfaceKind;
    app?: string; windowKey?: string; windowTitle?: string;
  };

export type StepPatch = Partial<{
  scope: ScopePatch;
  target: TargetInput;
  from: TargetInput;
  to: TargetInput;
  focusAfter: WindowScope | AppScope | null;
  text: string;
  input: string;
  key: string;
  modifiers: string[];
  check: WindowWaitCheck | AppWaitCheck | AssertCheckV2;
  timeoutMs: number;
  count: number;
  button: 'left' | 'right';
  durationMs: number;
  deltaX: number;
  deltaY: number;
  amount: number;
  direction: 'up' | 'down' | 'left' | 'right';
  ime: boolean;
}>;

/** The contract P3 consumes; every operation is one undoable edit. */
export type EditOp =
  | { kind: 'update'; id: string; patch: StepPatch }
  | { kind: 'delete'; id: string }
  | { kind: 'move'; id: string; toIndex: number }
  | { kind: 'insert'; index: number; step: StepV2 }
  | { kind: 'assert'; afterStepId: string; check: AssertCheckV2 };

export type EditResult =
  | { ok: true; flow: FlowV2 }
  | { ok: false; error: EditErrorDetail };

export interface FlowValidationIssue {
  code: string;
  message: string;
  stepId?: string;
  field?: string;
}

export interface FlowValidationReport {
  ok: boolean;
  errors: FlowValidationIssue[];
}

export interface StepChange {
  id: string;
  /** Step-relative field paths, e.g. `scope.windowKey`, `target.role`. */
  fields: string[];
}

export interface FlowDiff {
  added: Array<{ id: string; index: number }>;
  removed: Array<{ id: string; index: number }>;
  moved: Array<{ id: string; from: number; to: number }>;
  modified: StepChange[];
  /** Flow-level paths such as `name`, `inputs[1]`, `appPaths.com.apple.Safari`. */
  flowFields: string[];
  orderChanged: boolean;
  changed: boolean;
}

export interface EditableFlowSource {
  /** Absolute path of the recording that must never be rewritten. */
  path: string;
  /** Raw text exactly as loaded. */
  text: string;
  /** sha256 of the raw bytes, so a caller can prove the original did not change. */
  sha256: string;
  /** Canonical flow hash of the loaded document. */
  flowSha256: string;
}

export interface SaveRevisionResult {
  path: string;
  flow: FlowV2;
  flowSha256: string;
  diff: FlowDiff;
  createdAt: string;
}

const insertableKinds = new Set([
  'click', 'type', 'key', 'wait', 'assert', 'launch_app', 'activate_app', 'focus_window',
]);
const patchFields = new Set([
  'scope', 'target', 'from', 'to', 'focusAfter', 'text', 'input', 'key', 'modifiers',
  'check', 'timeoutMs', 'count', 'button', 'durationMs', 'deltaX', 'deltaY', 'amount',
  'direction', 'ime',
]);
const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const windowKeyPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const parameterPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const maxUndoDepth = 200;

const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isElementRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === 'element' && typeof value.role === 'string';
}

function scopeApp(scope: Scope): string | undefined {
  if (scope.kind === 'window' || scope.kind === 'app') return scope.app;
  if (scope.kind === 'surface' && (scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu')) {
    return scope.app;
  }
  return undefined;
}

function currentWindowTitle(scope: Scope): string | undefined {
  if (scope.kind === 'window') return scope.windowTitle;
  if (scope.kind === 'surface' && scope.surface === 'app_context_menu') return scope.windowTitle;
  return undefined;
}

function currentWindowKey(scope: Scope): string | undefined {
  if (scope.kind === 'window') return scope.windowKey;
  if (scope.kind === 'surface' && scope.surface === 'app_context_menu') return scope.windowKey;
  return undefined;
}

interface ScopeBinding {
  stepId: string;
  field: 'scope' | 'focusAfter' | 'resume' | 'intent';
  app: string;
  windowKey: string;
}

function collectBinding(scope: Scope, stepId: string, field: ScopeBinding['field'], out: ScopeBinding[]) {
  if (scope.kind === 'window') {
    out.push({ stepId, field, app: scope.app, windowKey: scope.windowKey });
  } else if (scope.kind === 'surface' && scope.surface === 'app_context_menu') {
    out.push({ stepId, field, app: scope.app, windowKey: scope.windowKey });
  }
}

/** Every window-key binding in a document, including intents and checkpoint resumes. */
function windowBindings(flow: FlowV2): ScopeBinding[] {
  const out: ScopeBinding[] = [];
  for (const step of flow.steps) {
    if (step.kind !== 'gap') collectBinding(step.scope, step.id, 'scope', out);
    if ('focusAfter' in step && step.focusAfter) collectBinding(step.focusAfter, step.id, 'focusAfter', out);
    if (step.kind === 'manual_checkpoint') collectBinding(step.resume.scope, step.id, 'resume', out);
  }
  for (const intent of flow.intents ?? []) {
    for (const effect of intent.observableEffects) collectBinding(effect.scope, intent.id, 'intent', out);
  }
  return out;
}

function assertBundleId(app: string, stepId: string, field: string) {
  if (!bundleIdPattern.test(app)) {
    throw new EditError('INVALID_APP', `"${app}" is not an app bundle id`, { stepId, field });
  }
}

function assertWindowKey(key: string, stepId: string, field: string) {
  if (!windowKeyPattern.test(key)) {
    throw new EditError('INVALID_WINDOW_KEY', `"${key}" is not a valid windowKey`, { stepId, field });
  }
}

function assertWindowTitle(title: string, stepId: string, field: string) {
  if (!title.trim() || title.length > 256) {
    throw new EditError('INVALID_WINDOW_TITLE', 'a window title must be 1-256 characters', { stepId, field });
  }
}

/**
 * A new window key derived from the app, avoiding every key already used in
 * this document. Keys are the flow-wide identity of one window, so a changed
 * app always gets a fresh one instead of inheriting the previous app's key.
 */
function windowKeyFor(flow: FlowV2, app: string): string {
  const taken = new Set(windowBindings(flow).map(binding => binding.windowKey));
  const tail = app.split('.').pop() ?? 'window';
  const base = tail.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'window';
  const stem = /^[a-z]/.test(base) ? base : `app-${base}`;
  const trimmed = stem.slice(0, 48);
  let candidate = trimmed;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${trimmed}-${suffix++}`;
  return candidate;
}

function assertWindowKeyFree(flow: FlowV2, key: string, app: string, stepId: string) {
  for (const binding of windowBindings(flow)) {
    if (binding.stepId === stepId && binding.field === 'scope') continue;
    if (binding.windowKey !== key) continue;
    if (binding.app === app) continue;
    throw new EditError(
      'WINDOW_KEY_CONFLICT',
      `windowKey ${key} is already bound to ${binding.app}, not ${app}`,
      { stepId, field: 'scope.windowKey' },
    );
  }
}

/** Merge a scope patch; a changed app never keeps the old window key. */
function mergeScope(current: Scope, patch: ScopePatch, flow: FlowV2, stepId: string): Scope {
  if (patch.kind === 'app') {
    const app = patch.app ?? scopeApp(current);
    if (app === undefined) {
      throw new EditError('SCOPE_APP_REQUIRED', 'an app scope needs an app bundle id', {
        stepId, field: 'scope.app',
      });
    }
    assertBundleId(app, stepId, 'scope.app');
    return { kind: 'app', app };
  }

  if (patch.kind === 'surface') {
    const surface = patch.surface;
    if (surface !== 'app_menu_bar' && surface !== 'app_context_menu') {
      if (patch.app !== undefined) {
        throw new EditError('SCOPE_APP_UNSUPPORTED', `${surface} belongs to no app`, {
          stepId, field: 'scope.app',
        });
      }
      return { kind: 'surface', surface };
    }
    const app = patch.app ?? scopeApp(current);
    if (app === undefined) {
      throw new EditError('SCOPE_APP_REQUIRED', `${surface} needs an app bundle id`, {
        stepId, field: 'scope.app',
      });
    }
    assertBundleId(app, stepId, 'scope.app');
    if (surface === 'app_menu_bar') return { kind: 'surface', surface, app };

    const appChanged = app !== scopeApp(current);
    const title = patch.windowTitle ?? (appChanged ? undefined : currentWindowTitle(current));
    if (title === undefined) {
      throw new EditError('SCOPE_TITLE_REQUIRED', `changing the app to ${app} needs the new window title`, {
        stepId, field: 'scope.windowTitle',
      });
    }
    assertWindowTitle(title, stepId, 'scope.windowTitle');
    let key: string;
    if (patch.windowKey !== undefined) {
      key = patch.windowKey;
      assertWindowKey(key, stepId, 'scope.windowKey');
    } else if (!appChanged && current.kind === 'surface' && current.surface === 'app_context_menu') {
      key = current.windowKey;
    } else {
      key = windowKeyFor(flow, app);
    }
    assertWindowKeyFree(flow, key, app, stepId);
    return { kind: 'surface', surface, app, windowKey: key, windowTitle: title };
  }

  const app = patch.app ?? scopeApp(current);
  if (app === undefined) {
    throw new EditError('SCOPE_APP_REQUIRED', 'a window scope needs an app bundle id', {
      stepId, field: 'scope.app',
    });
  }
  assertBundleId(app, stepId, 'scope.app');
  const appChanged = app !== scopeApp(current);
  const title = patch.windowTitle ?? (appChanged ? undefined : currentWindowTitle(current));
  if (title === undefined) {
    throw new EditError('SCOPE_TITLE_REQUIRED', `changing the app to ${app} needs the new window title`, {
      stepId, field: 'scope.windowTitle',
    });
  }
  assertWindowTitle(title, stepId, 'scope.windowTitle');
  let key: string;
  if (patch.windowKey !== undefined) {
    key = patch.windowKey;
    assertWindowKey(key, stepId, 'scope.windowKey');
  } else if (!appChanged && currentWindowKey(current) !== undefined) {
    key = currentWindowKey(current) as string;
  } else {
    key = windowKeyFor(flow, app);
  }
  assertWindowKeyFree(flow, key, app, stepId);
  return { kind: 'window', app, windowKey: key, windowTitle: title };
}

function assertPoint(input: { x: number; y: number }, stepId: string, field: string) {
  for (const [name, value] of [['x', input.x], ['y', input.y]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 100_000) {
      throw new EditError('INVALID_POINT', `point ${name} must be a nonnegative integer`, {
        stepId, field: `${field}.${name}`,
      });
    }
  }
}

function elementFromFields(
  fields: ElementFields,
  base: Record<string, unknown> | undefined,
  stepId: string,
  field: string,
): ElementV2 {
  const role = fields.role ?? (typeof base?.role === 'string' ? base.role : undefined);
  if (role === undefined || !role.trim() || role.length > 256) {
    throw new EditError('TARGET_ROLE_REQUIRED', 'an element target needs a role', {
      stepId, field: `${field}.role`,
    });
  }
  const element: Record<string, unknown> = { kind: 'element', role };
  const name = 'name' in fields ? fields.name : base?.name;
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string' || name.length > 256) {
      throw new EditError('INVALID_TARGET', 'target name must be at most 256 characters', {
        stepId, field: `${field}.name`,
      });
    }
    element.name = name;
  }
  const path = 'path' in fields ? fields.path : base?.path;
  if (path !== undefined && path !== null) element.path = clone(path);
  const index = 'index' in fields ? fields.index : base?.index;
  if (index !== undefined && index !== null) element.index = index;
  return element as unknown as ElementV2;
}

function mergeElement(current: unknown, input: TargetInput, stepId: string, field: string): ElementV2 {
  const base = isElementRecord(current) ? current : undefined;
  if (input.kind === 'point') {
    assertPoint(input, stepId, field);
    if (input.element === undefined) {
      throw new EditError(
        'POINT_TARGET_UNRESOLVED',
        'a point target must carry the element picked at that point; v2 flows store no coordinates',
        { stepId, field },
      );
    }
    // The picker resolved a complete element; nothing from the old target
    // survives, least of all a stale sibling index.
    return elementFromFields(input.element, undefined, stepId, field);
  }
  return elementFromFields(input, base, stepId, field);
}

/** How often each runtime parameter is referenced by type/paste steps. */
function inputUsages(flow: FlowV2): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const step of flow.steps) {
    if (step.kind === 'type' && 'input' in step) bump(step.input);
    if (step.kind === 'paste' && step.source.kind === 'input') bump(step.source.input);
  }
  return counts;
}

/**
 * Point a type step at an input parameter. Renaming the only user of a
 * declared parameter renames it in place; pointing at another declared
 * parameter prunes the old name once nothing references it. Values never
 * enter the flow.
 */
function setStepInput(draft: FlowV2, step: StepV2, name: string) {
  if (!parameterPattern.test(name)) {
    throw new EditError('INVALID_INPUT_NAME', `"${name}" is not a parameter name`, {
      stepId: step.id, field: 'input',
    });
  }
  const declared = draft.inputs ?? [];
  const oldName = step.kind === 'type' && 'input' in step ? step.input : undefined;
  if (!declared.includes(name)) {
    const usages = inputUsages(draft);
    const onlyUser = oldName !== undefined && oldName !== name &&
      declared.includes(oldName) && (usages.get(oldName) ?? 0) === 1;
    draft.inputs = onlyUser
      ? declared.map(value => (value === oldName ? name : value))
      : [...declared, name];
    return;
  }
  if (oldName === undefined || oldName === name || !declared.includes(oldName)) return;
  if ((inputUsages(draft).get(oldName) ?? 0) === 1) {
    const inputs = declared.filter(value => value !== oldName);
    if (inputs.length) draft.inputs = inputs;
    else delete draft.inputs;
  }
}

/** Drop a parameter declaration and its value slot once nothing references it. */
function pruneInput(draft: FlowV2, name: string | undefined) {
  if (name === undefined || draft.inputs === undefined) return;
  if ((inputUsages(draft).get(name) ?? 0) > 0) return;
  if (!draft.inputs.includes(name)) return;
  const inputs = draft.inputs.filter(value => value !== name);
  if (inputs.length) draft.inputs = inputs;
  else delete draft.inputs;
}

function stepScope(step: StepV2): Scope | undefined {
  return step.kind === 'gap' ? undefined : step.scope;
}

function applyStepPatch(draft: FlowV2, index: number, patch: StepPatch) {
  const step = draft.steps[index];
  const id = step.id;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!patchFields.has(key)) {
      throw new EditError('UNKNOWN_FIELD', `cannot edit ${key}`, { stepId: id, field: key });
    }
  }
  const next = { ...step } as unknown as Record<string, unknown>;
  let oldInput: string | undefined;

  if (patch.scope !== undefined) {
    const current = stepScope(step);
    if (current === undefined) {
      throw new EditError('STEP_HAS_NO_SCOPE', 'a capture gap has no scope to edit', {
        stepId: id, field: 'scope',
      });
    }
    next.scope = mergeScope(current, patch.scope, draft, id);
  }
  if (patch.focusAfter !== undefined) {
    if (patch.focusAfter === null) delete next.focusAfter;
    else next.focusAfter = clone(patch.focusAfter);
  }
  if (patch.target !== undefined) {
    next.target = mergeElement((step as unknown as Record<string, unknown>).target, patch.target, id, 'target');
  }
  if (patch.from !== undefined) {
    next.from = mergeElement((step as unknown as Record<string, unknown>).from, patch.from, id, 'from');
  }
  if (patch.to !== undefined) {
    next.to = mergeElement((step as unknown as Record<string, unknown>).to, patch.to, id, 'to');
  }
  if (patch.text !== undefined && patch.input !== undefined) {
    throw new EditError('CONFLICTING_TEXT_INPUT', 'a type step takes literal text or an input, not both', {
      stepId: id,
    });
  }
  if (patch.text !== undefined) {
    if (step.kind !== 'type') {
      throw new EditError('FIELD_NOT_ON_STEP', `text does not belong to a ${step.kind} step`, {
        stepId: id, field: 'text',
      });
    }
    oldInput = step.kind === 'type' && 'input' in step ? step.input : undefined;
    delete next.input;
    next.text = patch.text;
  }
  if (patch.input !== undefined) {
    if (step.kind !== 'type') {
      throw new EditError('FIELD_NOT_ON_STEP', `input does not belong to a ${step.kind} step`, {
        stepId: id, field: 'input',
      });
    }
    setStepInput(draft, step, patch.input);
    delete next.text;
    next.input = patch.input;
  }
  const passthrough = [
    'key', 'modifiers', 'check', 'timeoutMs', 'count', 'button', 'durationMs',
    'deltaX', 'deltaY', 'amount', 'direction', 'ime',
  ] as const;
  for (const key of passthrough) {
    if (patch[key] !== undefined) next[key] = clone(patch[key]);
  }
  draft.steps[index] = next as unknown as StepV2;
  if (oldInput !== undefined) pruneInput(draft, oldInput);
}

function stepIndex(flow: FlowV2, id: string): number {
  const index = flow.steps.findIndex(step => step.id === id);
  if (index === -1) throw new EditError('STEP_NOT_FOUND', `no step with id ${id}`, { stepId: id });
  return index;
}

function nextStepId(flow: FlowV2, prefix: string): string {
  const taken = new Set(flow.steps.map(step => step.id));
  let counter = 1;
  while (taken.has(`${prefix}-${counter}`)) counter += 1;
  return `${prefix}-${counter}`;
}

function stepIdFromPath(path: string, flow: FlowV2): string | undefined {
  const match = /^\/steps\/(\d+)/.exec(path);
  if (!match) return undefined;
  return flow.steps[Number(match[1])]?.id;
}

function checkDraftSchema(flow: FlowV2) {
  const first = [...flowV2Check.Errors(flow)][0];
  if (!first) return;
  const stepId = stepIdFromPath(first.path, flow);
  const prefix = stepId === undefined ? '' : `step ${stepId}: `;
  throw new EditError(
    'INVALID_STEP_SCHEMA',
    `${prefix}${first.path} ${first.message}`,
    { ...(stepId === undefined ? {} : { stepId }), field: first.path },
  );
}

function stepIdFromMessage(message: string): string | undefined {
  const step = /^Flow step (\S+?):/.exec(message);
  if (step) return step[1];
  const duplicate = /^Flow steps: duplicate id (\S+)/.exec(message);
  if (duplicate) return duplicate[1];
  const gap = /gap[s]? at ([^;]+);/.exec(message);
  if (gap) return gap[1].split(',')[0]?.trim();
  return undefined;
}

function fieldFromMessage(message: string): string | undefined {
  const app = /^Flow (appPaths\.[^:\s]+):/.exec(message);
  return app?.[1];
}

function diffPaths(before: unknown, after: unknown, path: string, out: string[]): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const primitives = [before, after].every(array =>
      array.every(item => item === null || typeof item !== 'object'));
    if (primitives) {
      if (JSON.stringify(before) !== JSON.stringify(after)) out.push(path);
      return;
    }
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffPaths(before[index], after[index], `${path}[${index}]`, out);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      diffPaths(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(path);
}

/** Added, removed, moved and field-level changes between two v2 flows. */
export function diffFlowV2(before: FlowV2, after: FlowV2): FlowDiff {
  const beforeIndex = new Map(before.steps.map((step, index) => [step.id, index]));
  const afterIndex = new Map(after.steps.map((step, index) => [step.id, index]));
  const added: FlowDiff['added'] = [];
  const removed: FlowDiff['removed'] = [];
  const moved: FlowDiff['moved'] = [];
  const modified: StepChange[] = [];
  for (const [id, index] of afterIndex) {
    if (!beforeIndex.has(id)) added.push({ id, index });
  }
  for (const [id, index] of beforeIndex) {
    if (!afterIndex.has(id)) removed.push({ id, index });
  }
  for (const [id, index] of beforeIndex) {
    const next = afterIndex.get(id);
    if (next === undefined) continue;
    if (next !== index) moved.push({ id, from: index, to: next });
    const fields: string[] = [];
    diffPaths(before.steps[index], after.steps[next], '', fields);
    if (fields.length) modified.push({ id, fields: fields.sort() });
  }
  const beforeRest: Record<string, unknown> = { ...before };
  const afterRest: Record<string, unknown> = { ...after };
  delete beforeRest.steps;
  delete afterRest.steps;
  const flowFields: string[] = [];
  diffPaths(beforeRest, afterRest, '', flowFields);
  const orderBefore = before.steps.map(step => step.id).filter(id => afterIndex.has(id));
  const orderAfter = after.steps.map(step => step.id).filter(id => beforeIndex.has(id));
  const orderChanged = orderBefore.join('\u0000') !== orderAfter.join('\u0000');
  return {
    added,
    removed,
    moved,
    modified,
    flowFields: flowFields.sort(),
    orderChanged,
    changed: added.length > 0 || removed.length > 0 || moved.length > 0 ||
      modified.length > 0 || flowFields.length > 0,
  };
}

/**
 * One loaded recording being edited. The original file is only ever read;
 * `saveRevision` writes a sibling revision and returns the diff.
 */
export class EditableFlowV2 {
  readonly source: EditableFlowSource;
  readonly original: FlowV2;
  private state: FlowV2;
  private readonly undoStack: FlowV2[] = [];
  private readonly redoStack: FlowV2[] = [];
  private readonly saved: SaveRevisionResult[] = [];

  private constructor(source: EditableFlowSource, flow: FlowV2) {
    this.source = source;
    this.original = clone(flow);
    this.state = flow;
  }

  static async load(path: string): Promise<EditableFlowV2> {
    const absolute = resolve(path);
    const text = await readFile(absolute, 'utf8');
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch {
      throw new EditError('INVALID_JSON', `${absolute} is not valid JSON`);
    }
    if (!isFlowV2(document)) {
      throw new EditError(
        'UNSUPPORTED_FLOW_VERSION',
        `${absolute} is not a version 2 flow; only v2 recordings can be edited`,
      );
    }
    const flow = document;
    const first = [...flowV2Check.Errors(flow)][0];
    if (first) {
      throw new EditError(
        'INVALID_FLOW',
        `${absolute} does not match the v2 schema: ${first.path} ${first.message}`,
        { field: first.path },
      );
    }
    return new EditableFlowV2({
      path: absolute,
      text,
      sha256: sha256(text),
      flowSha256: hashFlowV2(flow),
    }, clone(flow));
  }

  /** A defensive copy of the current document. */
  get flow(): FlowV2 {
    return clone(this.state);
  }

  get stepCount(): number {
    return this.state.steps.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get savedRevisions(): SaveRevisionResult[] {
    return clone(this.saved);
  }

  private commit<T>(edit: (draft: FlowV2) => T): T {
    const draft = clone(this.state);
    const result = edit(draft);
    checkDraftSchema(draft);
    this.undoStack.push(this.state);
    if (this.undoStack.length > maxUndoDepth) this.undoStack.shift();
    this.redoStack.length = 0;
    this.state = draft;
    return result;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (previous === undefined) return false;
    this.redoStack.push(this.state);
    this.state = previous;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    this.undoStack.push(this.state);
    this.state = next;
    return true;
  }

  /** Edit one step. Only the fields named in `patch` change. */
  updateStep(id: string, patch: StepPatch): FlowV2 {
    return this.commit(draft => {
      const index = stepIndex(draft, id);
      applyStepPatch(draft, index, patch);
      return clone(draft);
    });
  }

  /** Point one step at a different element, including point-to-element conversion. */
  setTarget(id: string, target: TargetInput): FlowV2 {
    return this.updateStep(id, { target });
  }

  /** Change one step's app/window scope, rebuilding a key when the app changes. */
  setScope(id: string, scope: ScopePatch): FlowV2 {
    return this.updateStep(id, { scope });
  }

  deleteStep(id: string): FlowV2 {
    return this.commit(draft => {
      const index = stepIndex(draft, id);
      draft.steps.splice(index, 1);
      if (!draft.steps.length) {
        throw new EditError('FLOW_EMPTY', 'a flow keeps at least one step', { stepId: id });
      }
      return clone(draft);
    });
  }

  /** Move a step to its final index. */
  moveStep(id: string, toIndex: number): FlowV2 {
    return this.commit(draft => {
      const from = stepIndex(draft, id);
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= draft.steps.length) {
        throw new EditError('BAD_INDEX', `index ${toIndex} is outside 0..${draft.steps.length - 1}`, {
          stepId: id, field: 'index',
        });
      }
      if (toIndex === from) return clone(draft);
      const [step] = draft.steps.splice(from, 1);
      draft.steps.splice(toIndex, 0, step);
      return clone(draft);
    });
  }

  /** Insert a new step at `index`; only the kinds the timeline offers are accepted. */
  insertStep(index: number, step: StepV2): FlowV2 {
    return this.commit(draft => {
      insertInto(draft, index, step);
      return clone(draft);
    });
  }

  /**
   * Convert a capture gap in place into a wait or manual checkpoint. Keeping
   * the position lets the operator resolve a gap without breaking a
   * checkpoint's trigger adjacency; the step id is preserved.
   */
  replaceStep(id: string, step: StepV2): FlowV2 {
    return this.commit(draft => {
      const index = stepIndex(draft, id);
      const current = draft.steps[index];
      if (current.kind !== 'gap') {
        throw new EditError('REPLACE_NOT_ALLOWED', 'only a capture gap can be replaced in place', {
          stepId: id,
        });
      }
      if (step.kind !== 'wait' && step.kind !== 'manual_checkpoint') {
        throw new EditError('REPLACE_NOT_ALLOWED', `a gap becomes a wait or manual checkpoint, not ${step.kind}`, {
          stepId: id,
        });
      }
      // A resolved gap keeps the time it was recorded at.
      draft.steps[index] = {
        ...clone(step), id, ...(current.atMs === undefined ? {} : { atMs: current.atMs }),
      } as StepV2;
      return clone(draft);
    });
  }

  /** Insert an assertion directly after an existing step, inheriting its scope. */
  addAssert(afterStepId: string, check: AssertCheckV2): FlowV2 {
    return this.commit(draft => {
      const index = stepIndex(draft, afterStepId);
      const anchor = draft.steps[index];
      const scope = stepScope(anchor);
      if (scope === undefined) {
        throw new EditError('STEP_HAS_NO_SCOPE', 'an assertion cannot follow a capture gap', {
          stepId: afterStepId,
        });
      }
      if (scope.kind === 'surface') {
        throw new EditError('ASSERT_SCOPE_UNSUPPORTED', 'an assertion needs a window or app scope', {
          stepId: afterStepId, field: 'scope',
        });
      }
      const step = {
        id: nextStepId(draft, 'assert'),
        kind: 'assert',
        scope: clone(scope),
        check: clone(check),
        // An assertion is proven at the moment its anchor was recorded.
        ...(anchor.atMs === undefined ? {} : { atMs: anchor.atMs }),
      } as unknown as StepV2;
      insertInto(draft, index + 1, step);
      return clone(draft);
    });
  }

  /**
   * The single entry point P3 consumes. Failures come back with the step id
   * that caused them and leave the document untouched.
   */
  apply(op: EditOp): EditResult {
    try {
      switch (op.kind) {
        case 'update': this.updateStep(op.id, op.patch); break;
        case 'delete': this.deleteStep(op.id); break;
        case 'move': this.moveStep(op.id, op.toIndex); break;
        case 'insert': this.insertStep(op.index, op.step); break;
        case 'assert': this.addAssert(op.afterStepId, op.check); break;
        default: throw new EditError('UNKNOWN_OP', `unknown edit operation ${(op as { kind?: unknown }).kind as string}`);
      }
      return { ok: true, flow: clone(this.state) };
    } catch (error) {
      if (error instanceof EditError) return { ok: false, error: error.toDetail() };
      throw error;
    }
  }

  /** Schema plus semantic validation; every issue carries its step id when known. */
  validate(): FlowValidationReport {
    const errors: FlowValidationIssue[] = [...flowV2Check.Errors(this.state)].map(error => {
      const stepId = stepIdFromPath(error.path, this.state);
      return {
        code: 'INVALID_STEP_SCHEMA',
        message: `${stepId === undefined ? '' : `step ${stepId}: `}${error.path} ${error.message}`,
        ...(stepId === undefined ? {} : { stepId }),
        field: error.path,
      };
    });
    if (!errors.length) {
      try {
        validateFlowV2(clone(this.state));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const withCode = error as { code?: unknown };
        const stepId = stepIdFromMessage(message);
        const field = fieldFromMessage(message);
        errors.push({
          code: typeof withCode.code === 'string' ? withCode.code : 'INVALID_FLOW',
          message,
          ...(stepId === undefined ? {} : { stepId }),
          ...(field === undefined ? {} : { field }),
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /** What the edit changed relative to the recording it was loaded from. */
  diff(): FlowDiff {
    return diffFlowV2(this.original, this.state);
  }

  /**
   * Write the edited flow as `flow.edited-<UTC>.json` next to the recording,
   * or to an explicit new path. The loaded file is never overwritten.
   */
  async saveRevision(target?: string): Promise<SaveRevisionResult> {
    const report = this.validate();
    if (!report.ok) {
      const first = report.errors[0];
      throw new EditError('INVALID_FLOW', first.message, {
        ...(first.stepId === undefined ? {} : { stepId: first.stepId }),
        ...(first.field === undefined ? {} : { field: first.field }),
      });
    }
    const createdAt = new Date().toISOString();
    let path: string;
    if (target !== undefined) {
      path = resolve(target);
      if (path === this.source.path) {
        throw new EditError('ORIGINAL_OVERWRITE', `${path} is the loaded recording; write a revision to a new file`);
      }
    } else {
      path = await this.revisionPath(createdAt);
    }
    const flow = clone(this.state);
    await writeNew(path, `${JSON.stringify(flow, null, 2)}\n`);
    const result: SaveRevisionResult = {
      path,
      flow: clone(flow),
      flowSha256: hashFlowV2(flow),
      diff: this.diff(),
      createdAt,
    };
    this.saved.push(result);
    return clone(result);
  }

  private async revisionPath(createdAt: string): Promise<string> {
    const stamp = createdAt.replace(/[:.]/g, '-');
    const directory = dirname(this.source.path);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const candidate = join(directory, `flow.edited-${stamp}${suffix}.json`);
      try {
        await lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
        throw error;
      }
    }
    throw new EditError('REVISION_NAME_EXHAUSTED', `could not allocate a revision file name in ${directory}`);
  }
}

function insertInto(draft: FlowV2, index: number, step: StepV2) {
  if (!Number.isInteger(index) || index < 0 || index > draft.steps.length) {
    throw new EditError('BAD_INDEX', `index ${index} is outside 0..${draft.steps.length}`, {
      stepId: step.id, field: 'index',
    });
  }
  if (!insertableKinds.has(step.kind)) {
    throw new EditError('STEP_KIND_NOT_INSERTABLE', `${step.kind} cannot be inserted from the timeline`, {
      stepId: step.id,
    });
  }
  if (draft.steps.some(existing => existing.id === step.id)) {
    throw new EditError('DUPLICATE_STEP_ID', `step id ${step.id} already exists`, { stepId: step.id });
  }
  draft.steps.splice(index, 0, clone(step));
}

/** Load a v2 recording for editing; v1 files are refused before any mutation. */
export async function loadEditableFlow(path: string): Promise<EditableFlowV2> {
  return EditableFlowV2.load(path);
}
