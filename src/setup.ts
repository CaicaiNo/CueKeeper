import { createHash } from 'node:crypto';
import type { Ensure, Setup, Target } from './contracts.js';

/** One recorded action reduced to the app/window it was captured in. */
export interface SetupStep {
  id: string;
  app: string;
  window: string;
}

const labelLimit = 256;
const idLimit = 64;

function truncate(value: string) {
  return value.length <= labelLimit ? value : `${value.slice(0, labelLimit - 1)}…`;
}

function slug(parts: string[]) {
  const text = parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = text || 'target';
  if (base.length <= 48) return base;
  return `${base.slice(0, 47).replace(/-+$/, '')}-${createHash('sha256').update(base).digest('hex').slice(0, 8)}`;
}

// The window root carries the exact title, so an existing root element is the
// strongest check a flow alone can express for both an app and its window.
function windowCheck(window: string): Setup['check'] {
  return {
    target: { kind: 'element', role: 'window', name: window },
    expect: { property: 'exists', equals: true },
  };
}

function covers(condition: Setup, ensure: Ensure) {
  const current = condition.ensure;
  if (!current || current.app !== ensure.app) return false;
  if (current.kind === 'app_running' && ensure.kind === 'app_running') return true;
  return current.kind === 'window_ready' && ensure.kind === 'window_ready' && current.window === ensure.window;
}

function idFor(ensure: Ensure, window: string) {
  return ensure.kind === 'app_running' ? `app-${slug([ensure.app])}` : `window-${slug([ensure.app, window])}`;
}

/**
 * Suggest setup conditions from a flow target and the app/window of each
 * recorded action. The first app and the first window become inferred
 * `app_running` and `window_ready` conditions; later distinct apps or windows
 * add their own suggestion once. Existing conditions in any state suppress a
 * duplicate suggestion, so a confirmed, invalid or deleted condition stays put.
 */
export function inferSetup(target: Target, steps: SetupStep[] = [], existing: Setup[] = []): Setup[] {
  const known = [...existing];
  const ids = new Set(known.map(condition => condition.id));
  const inferred: Setup[] = [];
  function add(ensure: Ensure, window: string) {
    if (known.some(condition => covers(condition, ensure))) return;
    const base = idFor(ensure, window);
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base.slice(0, idLimit - String(suffix).length - 1)}-${suffix}`;
    const condition: Setup = {
      id,
      name: ensure.kind === 'app_running' ? truncate(`应用已启动 · ${ensure.app}`) : truncate(`窗口已就绪 · ${window}`),
      state: 'inferred',
      check: windowCheck(window),
      ensure,
    };
    ids.add(id);
    known.push(condition);
    inferred.push(condition);
  }
  add({ kind: 'app_running', app: target.app }, target.window);
  add({ kind: 'window_ready', app: target.app, window: target.window }, target.window);
  for (const step of steps) {
    if (step.app === target.app && step.window === target.window) continue;
    add({ kind: 'app_running', app: step.app }, step.window);
    add({ kind: 'window_ready', app: step.app, window: step.window }, step.window);
  }
  return inferred;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep only confirmed conditions in a flow or `cuekeeper-test` document before
 * it is saved. Inferred, invalid and deleted conditions never reach a test item.
 */
export function keepConfirmedSetup(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const wrapped = input.format === 'cuekeeper-test';
  const flow = wrapped ? input.flow : input;
  if (!isRecord(flow) || !Array.isArray(flow.setup)) return input;
  const setup = flow.setup.filter(condition => isRecord(condition) && condition.state === 'confirmed');
  const next = { ...flow, ...(setup.length ? { setup } : {}) };
  if (!setup.length) delete next.setup;
  return wrapped ? { ...input, flow: next } : next;
}
