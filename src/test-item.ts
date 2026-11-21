import type { Flow } from './contracts.js';
import { parseFlow } from './flow.js';
import { object } from './locator.js';

export const secretName = /^CUEKEEPER_SECRET_[A-Z0-9_]{1,64}$/;

export function parseTestItem(input: unknown) {
  const document = object(input);
  const secrets = new Map<string, string>();
  if (document.format !== 'cuekeeper-test') return { flow: parseFlow(input), secrets };
  if (document.version !== 1 || !Array.isArray(document.secrets) ||
      document.secrets.length === 0 || document.secrets.length > 2000) {
    throw new Error('Invalid CueKeeper test item version or secret bindings');
  }
  const flow = parseFlow(document.flow);
  const calls = new Map(flow.steps.filter(step => step.kind === 'behavior').map(step => [step.id, step]));
  const behaviors = new Map(flow.behaviors?.map(behavior => [behavior.id, behavior]));
  for (const binding of document.secrets) {
    const { step, param } = object(binding);
    const call = typeof step === 'string' ? calls.get(step) : undefined;
    if (!call?.args || typeof param !== 'string' || !Object.hasOwn(call.args, param) ||
        !secretName.test(call.args[param])) {
      throw new Error('Secret binding must reference a behavior argument with a CUEKEEPER_SECRET_ variable');
    }
    const actions = behaviors.get(call.behavior)!.steps.filter(action =>
      action.kind === 'type' && typeof action.text !== 'string' && action.text.param === param);
    if (!actions.length) throw new Error('Secret binding does not supply a text action');
    for (const action of actions) {
      const id = `${call.id}/${action.id}`;
      if (secrets.has(id)) throw new Error('Duplicate secret binding');
      secrets.set(id, call.args[param]);
    }
  }
  return { flow, secrets };
}

export function resolveSecrets(secrets: Map<string, string>, env: NodeJS.ProcessEnv) {
  const values = new Map<string, string>();
  for (const [id, name] of secrets) {
    const value = env[name];
    if (!value || value.length > 4000) throw new Error(`Provide ${name} with 1–4000 characters before replay`);
    values.set(id, value);
  }
  return values;
}

type Behavior = NonNullable<Flow['behaviors']>[number];

export function parseLibraryItem(input: unknown) {
  const { version, behavior, parameterTypes, target } = object(input);
  const definition = object(behavior);
  const types = object(parameterTypes);
  const steps = definition.steps;
  if (version !== 1 || typeof definition.id !== 'string' || !Array.isArray(steps) ||
      !Array.isArray(definition.parameters) || definition.parameters.length > 32 ||
      Object.keys(types).length !== definition.parameters.length ||
      !definition.parameters.every(name => typeof name === 'string' && Object.hasOwn(types, name) &&
        (types[name] === 'string' || types[name] === 'secret') &&
        steps.some(raw => {
          const action = object(raw);
          return action.kind === 'type' && typeof action.text === 'object' && action.text !== null &&
            object(action.text).param === name;
        }))) {
    throw new Error('Invalid workbench behavior');
  }
  const args = Object.fromEntries(definition.parameters.map(name => [name, 'validation']));
  const validated = parseFlow({
    version: 1, id: 'validation', name: 'Validation', target, behaviors: [behavior],
    steps: [{ id: 'check', kind: 'behavior', behavior: definition.id, args }],
  });
  return {
    version: 1 as const, behavior: validated.behaviors![0] as Behavior,
    parameterTypes: types as Record<string, 'string' | 'secret'>, target: validated.target,
  };
}
