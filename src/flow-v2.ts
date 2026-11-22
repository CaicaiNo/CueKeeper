import { createHash } from 'node:crypto';
import { flowV2Check } from './contracts-v2.js';
import type {
  FlowV2, ReportV2, ReportV2Entry, Scope, StepV2,
} from './contracts-v2.js';
import { canonicalJson, parseFlow } from './flow.js';
import type { Flow } from './contracts.js';
import { Fault } from './locator.js';

// Flow v2 parsing, semantic validation, canonical hashing and the read-only
// dry-run plan. Live replay of a v2 flow belongs to the scope resolver and the
// cross-app runner; this module never touches the desktop.

export interface PlannedStepV2 {
  id: string;
  kind: StepV2['kind'];
  scope?: Scope;
}

const windowWaitKinds = new Set(['window_exists', 'element_enabled', 'element', 'window']);
const appWaitKinds = new Set(['app_running', 'app_installed']);
const fileWaitKinds = new Set(['file_exists', 'file_stable']);

/**
 * An entry point that still depends on the v1 contract refuses a v2 document
 * with this code before creating any desktop or file side effect.
 */
export class UnsupportedFlowVersionError extends Error {
  readonly code = 'UNSUPPORTED_FLOW_VERSION';
  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

export function isFlowV2(input: unknown): input is FlowV2 {
  return input !== null && typeof input === 'object' && !Array.isArray(input) &&
    (input as { version?: unknown }).version === 2;
}

/** Scope identity used for grouping and filtering; never persisted in a flow. */
export function scopeKey(scope: Scope): string {
  if (scope.kind === 'window') return `window:${scope.app}:${scope.windowKey}`;
  if (scope.kind === 'app') return `app:${scope.app}`;
  if (scope.kind === 'file') {
    return `file:${scope.directory}/${'name' in scope ? scope.name : `*${scope.suffix}`}`;
  }
  if (scope.surface === 'app_menu_bar') return `surface:app_menu_bar:${scope.app}`;
  if (scope.surface === 'app_context_menu') {
    return `surface:app_context_menu:${scope.app}:${scope.windowKey}`;
  }
  return `surface:${scope.surface}`;
}

/** Human-readable scope label for CLI output and workbench rows. */
export function scopeLabel(scope: Scope): string {
  if (scope.kind === 'window') return `${scope.app} · ${scope.windowTitle} (${scope.windowKey})`;
  if (scope.kind === 'app') return scope.app;
  if (scope.kind === 'file') {
    return `文件 · ${'name' in scope ? scope.name : `*${scope.suffix}`}（${scope.directory}）`;
  }
  if (scope.surface === 'app_menu_bar') return `${scope.app} · menu bar`;
  if (scope.surface === 'app_context_menu') {
    return `${scope.app} · ${scope.windowTitle} context menu (${scope.windowKey})`;
  }
  return scope.surface;
}

function describeScope(scope: Scope): string {
  return scopeLabel(scope);
}

function waitCheckFor(kind: string) {
  return windowWaitKinds.has(kind) ? 'window'
    : appWaitKinds.has(kind) ? 'app'
      : fileWaitKinds.has(kind) ? 'file'
        : undefined;
}

function validateWaitScope(scope: Scope, check: { kind: string }, where: string) {
  if (scope.kind === 'surface') fail(`${where}: a wait cannot observe a system surface`);
  const expected = waitCheckFor(check.kind);
  if (expected !== undefined && expected !== scope.kind) {
    fail(`${where}: ${check.kind} needs a ${expected} scope, not ${scope.kind}`);
  }
}

/** Per-flow window-key bindings and app references. */
interface ScopeState {
  apps: Set<string>;
  windows: Map<string, string>;
}

function validateScope(scope: Scope, where: string, state: ScopeState) {
  if (scope.kind === 'window') {
    state.apps.add(scope.app);
    bindWindowKey(scope, where, state);
    return;
  }
  if (scope.kind === 'app') {
    state.apps.add(scope.app);
    return;
  }
  if (scope.kind === 'file') {
    // A file wait names no app; only an absolute, non-climbing directory is a
    // location the run may read.
    if (!scope.directory.startsWith('/') || scope.directory.split('/').includes('..')) {
      fail(`${where}: expected an absolute download directory`);
    }
    return;
  }
  if (scope.surface === 'app_menu_bar') {
    state.apps.add(scope.app);
    return;
  }
  if (scope.surface === 'app_context_menu') {
    state.apps.add(scope.app);
    bindWindowKey(scope, where, state);
  }
}

function bindWindowKey(scope: { app: string; windowKey: string }, where: string, state: ScopeState) {
  const bound = state.windows.get(scope.windowKey);
  if (bound === undefined) {
    state.windows.set(scope.windowKey, scope.app);
    return;
  }
  if (bound !== scope.app) {
    fail(`${where}: windowKey ${scope.windowKey} is already bound to ${bound}, not ${scope.app}`);
  }
}

function validateAppPaths(flow: FlowV2, state: ScopeState) {
  for (const [app, path] of Object.entries(flow.appPaths ?? {})) {
    if (!path.startsWith('/') || path.split('/').includes('..')) {
      fail(`Flow appPaths.${app}: expected an absolute macOS app path`);
    }
    if (!/\.app$/i.test(path)) fail(`Flow appPaths.${app}: expected a .app bundle path`);
    if (!state.apps.has(app)) fail(`Flow appPaths.${app}: the app is not referenced by any step`);
  }
}

function validateInputs(flow: FlowV2) {
  const declared = new Set(flow.inputs ?? []);
  for (const step of flow.steps) {
    if (step.kind !== 'type' && step.kind !== 'paste') continue;
    if (step.kind === 'type' && 'input' in step && !declared.has(step.input)) {
      fail(`Flow step ${step.id}: input ${step.input} is not declared in inputs`);
    }
    if (step.kind === 'paste' && step.source.kind === 'input' && !declared.has(step.source.input)) {
      fail(`Flow step ${step.id}: input ${step.source.input} is not declared in inputs`);
    }
  }
}

function validateSteps(flow: FlowV2, state: ScopeState, allowGaps = false) {
  const index = new Map<string, number>();
  const gaps: string[] = [];
  for (const [position, step] of flow.steps.entries()) {
    if (index.has(step.id)) fail(`Flow steps: duplicate id ${step.id}`);
    index.set(step.id, position);
    const where = `Flow step ${step.id}`;
    if (step.kind === 'gap') {
      gaps.push(step.id);
      continue;
    }
    validateScope(step.scope, where, state);
    if ('focusAfter' in step && step.focusAfter) {
      validateScope(step.focusAfter, `${where} focusAfter`, state);
    }

    if (step.kind === 'paste' && step.source.kind === 'copy') {
      const copy = flow.steps[index.get(step.source.stepId) ?? -1];
      const copyPosition = index.get(step.source.stepId);
      if (copyPosition === undefined) fail(`${where}: copy source ${step.source.stepId} does not exist`);
      if (copyPosition >= position) fail(`${where}: copy source ${step.source.stepId} must come earlier`);
      if (!copy || copy.kind !== 'key' || copy.key !== 'c' || !(copy.modifiers ?? []).includes('meta')) {
        fail(`${where}: copy source ${step.source.stepId} is not a Cmd+C step`);
      }
    }
    if (step.kind === 'wait') validateWaitScope(step.scope, step.check, where);
    if (step.kind === 'manual_checkpoint') {
      const trigger = flow.steps[position - 1];
      if (!trigger || trigger.id !== step.triggerStepId) {
        fail(`${where}: triggerStepId must name the immediately preceding step`);
      }
      if (trigger.kind === 'gap') fail(`${where}: a gap cannot trigger a checkpoint`);
      if (trigger.scope.kind !== 'window' ||
          trigger.scope.app !== step.scope.app || trigger.scope.windowKey !== step.scope.windowKey) {
        fail(`${where}: trigger step must share the checkpoint window scope`);
      }
      if (step.resume.scope.app !== step.scope.app ||
          step.resume.scope.windowKey !== step.scope.windowKey) {
        fail(`${where}: resume scope must share the checkpoint window scope`);
      }
    }
    if (step.kind === 'surface_press') {
      const expected = {
        dock: 'dock_item', app_menu_bar: 'menu_item', app_context_menu: 'menu_item',
        menu_bar_extras: 'status_item', spotlight: 'spotlight_result',
      }[step.scope.surface];
      if (step.selector.kind !== expected) {
        fail(`${where}: ${step.selector.kind} cannot press a ${step.scope.surface} surface`);
      }
    }
    if (step.kind === 'assert' && step.scope.kind === 'app' &&
        (step.check.target.kind !== 'window' || step.check.expect.property !== 'exists')) {
      fail(`${where}: an app-scoped assertion can only check window existence`);
    }
  }
  if (gaps.length && !allowGaps) {
    throw new Fault('CAPTURE_GAP',
      `Flow ${flow.id} has unresolved capture gaps at ${gaps.join(', ')}; resolve them before any desktop call`);
  }
}

function validateIntents(flow: FlowV2, state: ScopeState) {
  const index = new Map(flow.steps.map((step, position) => [step.id, position]));
  const claimed = new Set<string>();
  const intentIds = new Set<string>();
  for (const intent of flow.intents ?? []) {
    const where = `Flow intent ${intent.id}`;
    if (intentIds.has(intent.id)) fail(`${where}: duplicate intent id`);
    intentIds.add(intent.id);
    if (!intent.sourceStepIds.length) fail(`${where}: sourceStepIds must not be empty`);
    const positions = intent.sourceStepIds.map(id => {
      const position = index.get(id);
      if (position === undefined) fail(`${where}: source step ${id} does not exist`);
      return position;
    });
    for (const [offset, position] of positions.entries()) {
      if (offset && position !== positions[offset - 1] + 1) {
        fail(`${where}: sourceStepIds must be a contiguous run in flow order`);
      }
      if (claimed.has(flow.steps[position].id)) {
        fail(`${where}: source step ${flow.steps[position].id} is claimed by another intent`);
      }
      claimed.add(flow.steps[position].id);
    }
    const skipped = intent.skippedUiStepIds ?? [];
    let cursor = -1;
    for (const id of skipped) {
      const offset = intent.sourceStepIds.indexOf(id, cursor + 1);
      if (offset === -1) fail(`${where}: skipped step ${id} is not an ordered subset of the range`);
      cursor = offset;
    }
    if (!intent.observableEffects.length) fail(`${where}: at least one observable effect is required`);
    for (const effect of intent.observableEffects) {
      validateScope(effect.scope, `${where} effect ${effect.kind}`, state);
      validateWaitScope(effect.scope, effect.check, `${where} effect ${effect.kind}`);
    }
  }
}

/**
 * Semantic validation for a structurally valid v2 flow: unique IDs, stable
 * window keys, referenced app paths and inputs, copy ranges, checkpoint
 * adjacency and non-overlapping intent ranges. Capture gaps are a hard stop
 * for execution: the flow is refused before any desktop call. A review reader
 * that only displays the recording passes `allowGaps`, because the gap is part
 * of what the operator has to see and resolve.
 */
export function validateFlowV2(flow: FlowV2, options: { allowGaps?: boolean } = {}): FlowV2 {
  const state: ScopeState = { apps: new Set(), windows: new Map() };
  validateSteps(flow, state, options.allowGaps === true);
  validateAppPaths(flow, state);
  validateInputs(flow);
  validateIntents(flow, state);
  return flow;
}

export function parseFlowV2(input: unknown, options: { allowGaps?: boolean } = {}): FlowV2 {
  if (!flowV2Check.Check(input)) {
    const error = flowV2Check.Errors(input).First();
    fail(`Invalid flow version 2 ${error?.path ?? ''}: ${error?.message ?? 'schema mismatch'}`);
  }
  return validateFlowV2(input, options);
}

/**
 * One dispatch point for readers that take a raw flow document. A v1 document
 * keeps the original parser, plan and hash; a v2 document gets its own closed
 * contract. Secret test items stay on the v1 parser, because the wrapper has no
 * top-level version.
 */
export function parseFlowDocument(input: unknown, options: { allowGaps?: boolean } = {}):
  | { version: 1; flow: Flow }
  | { version: 2; flow: FlowV2 } {
  if (isFlowV2(input)) return { version: 2, flow: parseFlowV2(input, options) };
  return { version: 1, flow: parseFlow(input) };
}

export function hashFlowV2(flow: FlowV2): string {
  return createHash('sha256').update(canonicalJson(flow)).digest('hex');
}

export function planFlowV2(flow: FlowV2): PlannedStepV2[] {
  return flow.steps.map(step => ({
    id: step.id,
    kind: step.kind,
    ...(step.kind === 'gap' ? {} : { scope: step.scope }),
  }));
}

/**
 * Structural dry run. It reports each step with its declared scope as
 * `resolved` and performs no launch, focus, clipboard or input operation. A
 * scope is only proven against a live window by the cross-app runner; until
 * then the report says exactly what the flow would bind, not that the window
 * exists.
 */
export function dryRunFlowV2(flow: FlowV2): ReportV2 {
  const entries: ReportV2Entry[] = flow.steps.map(step => ({
    id: step.id,
    kind: step.kind,
    ...(step.kind === 'gap' ? {} : { scope: step.scope }),
    status: 'resolved',
    atMs: 0,
    durationMs: 0,
  }));
  return {
    version: 2,
    flowId: flow.id,
    flowSha256: hashFlowV2(flow),
    startedAt: new Date().toISOString(),
    mode: 'dry-run',
    status: 'passed',
    entries,
  };
}

/** Dry-run report line, e.g. `s1 type resolved · com.apple.TextEdit · QA Notes (editor)`. */
export function describePlannedStep(step: PlannedStepV2): string {
  return step.scope ? `${step.id} ${step.kind} · ${describeScope(step.scope)}` : `${step.id} ${step.kind}`;
}
