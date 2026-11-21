import { createHash } from 'node:crypto';
import { validateAssertCheck } from './assertion.js';
import { flowCheck } from './contracts.js';
import type { Action, Flow, Setup } from './contracts.js';

type ExecutableAction = Exclude<Action, { kind: 'type' }> |
  (Extract<Action, { kind: 'type' }> & { text: string });

export interface PlannedStep {
  id: string;
  action: ExecutableAction;
}

function unique(items: { id: string }[], where: string) {
  if (new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error(`${where}: duplicate id`);
  }
}

function validateConditions(conditions: Setup[] = [], where: string) {
  unique(conditions, where);
}

function validateShell(action: Action, where: string) {
  if (action.kind !== 'shell') return;
  const argv = 'argv' in action ? action.argv : undefined;
  if (!argv || !argv.length) return;
  if (!argv[0]) throw new Error(`${where}: shell program name must not be empty`);
}

function validatePointer(action: Action, where: string) {
  if (action.kind === 'click') {
    // A right click opens one context menu; a counted right click has no
    // distinct driver command and would silently replay as a single click.
    if (action.button === 'right' && (action.count ?? 1) !== 1) {
      throw new Error(`${where}: a right click cannot carry a click count`);
    }
    return;
  }
  if (action.kind !== 'scroll') return;
  if ('deltaX' in action) {
    if (action.deltaX === 0 && action.deltaY === 0) {
      throw new Error(`${where}: scroll deltas must not both be zero`);
    }
  } else if (!action.direction || !action.amount) {
    throw new Error(`${where}: scroll needs a direction and a positive amount`);
  }
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Resolves a scroll to the semantic direction/amount the driver accepts for
 * element targets. Recorded deltas use CGEvent line units, where a positive
 * vertical delta scrolls up (the same sign the driver posts for `direction up`).
 */
export function scrollIntent(action: Extract<Action, { kind: 'scroll' }>): {
  direction: ScrollDirection; amount: number;
} {
  if ('direction' in action) return { direction: action.direction, amount: action.amount };
  const { deltaX, deltaY } = action;
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX) && deltaY !== 0;
  const magnitude = Math.abs(vertical ? deltaY : deltaX);
  return {
    direction: vertical ? (deltaY > 0 ? 'up' : 'down') : (deltaX > 0 ? 'right' : 'left'),
    amount: Math.max(1, Math.min(1000, Math.round(magnitude))),
  };
}

export function parseFlow(input: unknown): Flow {
  if (!flowCheck.Check(input)) {
    const error = flowCheck.Errors(input).First();
    throw new Error(`Invalid flow ${error?.path ?? ''}: ${error?.message ?? 'schema mismatch'}`);
  }
  plan(input);
  return input;
}

export function plan(flow: Flow): PlannedStep[] {
  unique(flow.steps, 'Flow steps');
  unique(flow.behaviors ?? [], 'Behaviors');
  validateConditions(flow.setup, 'Global setup');
  const behaviors = new Map(flow.behaviors?.map(behavior => [behavior.id, behavior]));
  for (const behavior of behaviors.values()) {
    unique(behavior.steps, `Behavior ${behavior.id}`);
    const parameters = new Set(behavior.parameters);
    for (const action of behavior.steps) {
      validateConditions(action.setup, `Behavior ${behavior.id}/${action.id}`);
      validateShell(action, `Behavior ${behavior.id}/${action.id}`);
      validatePointer(action, `Behavior ${behavior.id}/${action.id}`);
      if (action.kind === 'type' && typeof action.text !== 'string' && !parameters.has(action.text.param)) {
        throw new Error(`Unknown parameter ${action.text.param} in behavior ${behavior.id}`);
      }
    }
  }

  const expanded: PlannedStep[] = [];
  function add(action: Action, path: string, args: Record<string, string>) {
    validateConditions(action.setup, path);
    validateShell(action, path);
    validatePointer(action, path);
    if (action.kind === 'assert') validateAssertCheck(action.check, path);
    if (action.kind === 'type') {
      const value = typeof action.text === 'string' ? action.text :
        (Object.hasOwn(args, action.text.param) ? args[action.text.param] : undefined);
      if (!value) throw new Error(`Unbound or empty type text at ${path}`);
      expanded.push({ id: path, action: { ...action, text: value } });
    } else {
      expanded.push({ id: path, action });
    }
  }

  for (const step of flow.steps) {
    if (step.kind !== 'behavior') {
      add(step, step.id, {});
      continue;
    }
    const behavior = behaviors.get(step.behavior);
    if (!behavior) throw new Error(`Unknown behavior ${step.behavior} at ${step.id}`);
    const args = step.args ?? {};
    const parameters = new Set(behavior.parameters);
    if (Object.keys(args).length !== parameters.size || Object.keys(args).some(key => !parameters.has(key))) {
      throw new Error(`Arguments at ${step.id} must match parameters of ${behavior.id}`);
    }
    for (const action of behavior.steps) add(action, `${step.id}/${action.id}`, args);
    if (expanded.length > 2000) throw new Error('Expanded flow exceeds 2000 actions');
  }
  return expanded;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashFlow(flow: Flow) {
  return createHash('sha256').update(canonical(flow)).digest('hex');
}
