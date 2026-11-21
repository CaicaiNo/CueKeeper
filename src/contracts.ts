import { Type as T } from '@sinclair/typebox';
import type { Static, TProperties } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

const object = <P extends TProperties>(properties: P) =>
  T.Object(properties, { additionalProperties: false });
const label = T.String({ minLength: 1, maxLength: 256 });
const id = T.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' });
const parameterName = T.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' });
const text = T.String({ maxLength: 4000 });
const time = T.Integer({ minimum: 0, maximum: 60_000 });
const digest = T.String({ pattern: '^[a-f0-9]{64}$' });
const point = T.Tuple([T.Integer(), T.Integer()]);
const timestamp = T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

const element = object({
  kind: T.Literal('element'),
  role: label,
  name: T.Optional(T.String({ maxLength: 256 })),
  path: T.Optional(T.Array(label, { minItems: 1, maxItems: 51 })),
  index: T.Optional(T.Integer({ minimum: 0 })),
});
const locator = T.Union([element, object({ kind: T.Literal('point'), point })]);

export const targetSchema = object({ app: label, window: label });

const expectation = T.Union([
  object({ property: T.Union([T.Literal('exists'), T.Literal('visible')]), equals: T.Boolean() }),
  object({ property: T.Union([T.Literal('text'), T.Literal('value')]), equals: text }),
]);
const check = object({ target: element, expect: expectation });
const ensureKind = T.Union([T.Literal('app_running'), T.Literal('window_ready')]);
export const defaultEnsureTimeoutMs = 15_000;
const ensureFields = {
  app: label,
  timeout_ms: T.Optional(T.Integer({ minimum: 1000, maximum: 120_000, default: defaultEnsureTimeoutMs })),
};
const ensure = T.Union([
  object({ kind: T.Literal('app_running'), ...ensureFields }),
  object({ kind: T.Literal('window_ready'), ...ensureFields, window: label }),
]);
const setup = object({
  id, name: label,
  state: T.Union([
    T.Literal('inferred'), T.Literal('confirmed'), T.Literal('invalid'), T.Literal('deleted'),
  ]),
  check,
  ensure: T.Optional(ensure),
});
const conditions = T.Array(setup, { maxItems: 100 });
const inputText = T.Union([T.String({ minLength: 1, maxLength: 4000 }), object({ param: parameterName })]);
const step = { id, setup: T.Optional(conditions) };

const action = T.Union([
  object({ ...step, kind: T.Literal('click'), target: locator }),
  object({ ...step, kind: T.Literal('type'), target: element, text: inputText }),
  object({
    ...step,
    kind: T.Literal('key'),
    key: T.String({ pattern: '^(?:[a-z0-9]|space|return|tab|escape|delete|backspace|forwarddelete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$' }),
    modifiers: T.Optional(T.Array(T.Union([
      T.Literal('meta'), T.Literal('ctrl'), T.Literal('alt'), T.Literal('shift'),
    ]), { uniqueItems: true, maxItems: 4 })),
  }),
  object({ ...step, kind: T.Literal('wait'), check, timeoutMs: time }),
  object({ ...step, kind: T.Literal('assert'), check }),
]);
const call = object({
  id, kind: T.Literal('behavior'), behavior: id,
  args: T.Optional(T.Record(parameterName, text, { additionalProperties: false })),
});
const behavior = object({
  id, name: label,
  parameters: T.Optional(T.Array(parameterName, { uniqueItems: true, maxItems: 32 })),
  steps: T.Array(action, { minItems: 1, maxItems: 500 }),
});
export const flowSchema = object({
  version: T.Literal(1), id, name: label,
  target: targetSchema,
  setup: T.Optional(conditions),
  behaviors: T.Optional(T.Array(behavior, { maxItems: 100 })),
  steps: T.Array(T.Union([action, call]), { minItems: 1, maxItems: 500 }),
});

const resultStatus = T.Union([
  T.Literal('passed'), T.Literal('failed'), T.Literal('blocked'),
  T.Literal('skipped'), T.Literal('resolved'),
]);
const entryFields = {
  id: T.String({ minLength: 1, maxLength: 196 }),
  status: resultStatus,
  atMs: T.Integer({ minimum: 0 }),
  durationMs: T.Integer({ minimum: 0 }),
  message: T.Optional(T.String()),
  code: T.Optional(T.String()),
  delivery: T.Optional(T.Union([
    T.Literal('delivered_verified'), T.Literal('delivered_unverified'),
    T.Literal('delivery_uncertain'), T.Literal('not_delivered'), T.Literal('unknown'),
  ])),
};
const entry = T.Union([
  object({
    ...entryFields,
    kind: T.Literal('setup'),
    repair: T.Optional(object({
      attempted: T.Boolean(),
      kind: ensureKind,
      result: T.Union([T.Literal('passed'), T.Literal('failed')]),
      code: T.Optional(T.String()),
    })),
  }),
  object({
    ...entryFields,
    kind: T.Union([T.Literal('click'), T.Literal('type'), T.Literal('key'), T.Literal('wait'), T.Literal('assert')]),
  }),
]);
export const reportSchema = object({
  version: T.Literal(1), flowId: id, flowSha256: digest, startedAt: timestamp,
  mode: T.Union([T.Literal('replay'), T.Literal('dry-run')]),
  status: T.Union([T.Literal('passed'), T.Literal('failed'), T.Literal('blocked')]),
  entries: T.Array(entry, { minItems: 1 }),
});

export const schemas = {
  flow: flowSchema,
  behavior: object({ version: T.Literal(1), ...behavior.properties }),
  setup: object({ version: T.Literal(1), ...setup.properties }),
  report: reportSchema,
};
export const flowCheck = TypeCompiler.Compile(flowSchema);
export const reportCheck = TypeCompiler.Compile(reportSchema);
export const captureTargetCheck = TypeCompiler.Compile(targetSchema);
export const captureActionCheck = TypeCompiler.Compile(action);

export type Flow = Static<typeof flowSchema>;
export type Action = Static<typeof action>;
export type Setup = Static<typeof setup>;
export type Ensure = Static<typeof ensure>;
export type Locator = Static<typeof locator>;
export type ElementLocator = Static<typeof element>;
export type Check = Static<typeof check>;
export type Target = Static<typeof targetSchema>;
export type Report = Static<typeof reportSchema>;
export type Entry = Static<typeof entry>;
