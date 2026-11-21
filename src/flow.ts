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
      if (action.kind === 'type' && typeof action.text !== 'string' && !parameters.has(action.text.param)) {
        throw new Error(`Unknown parameter ${action.text.param} in behavior ${behavior.id}`);
      }
    }
  }

  const expanded: PlannedStep[] = [];
  function add(action: Action, path: string, args: Record<string, string>) {
    validateConditions(action.setup, path);
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
