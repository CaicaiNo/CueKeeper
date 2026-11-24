import { Type as T } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * The batch summary the workbench writes next to its per-run reports. It is the
 * durable artifact an operator reads the morning after, so every field that
 * locates a failure (run, item, round, step, code, category, report path,
 * reproduce command) is part of the contract.
 */

const label = T.String({ minLength: 1, maxLength: 256 });
const timestamp = T.Integer({ minimum: 0 });
const category = T.Union([
  T.Literal('assertion'), T.Literal('locator'), T.Literal('focus'), T.Literal('permission'),
  T.Literal('timeout'), T.Literal('identity'), T.Literal('driver'), T.Literal('artifact'),
  T.Literal('shell'), T.Literal('unknown'),
]);
const runStatus = T.Union([
  T.Literal('passed'), T.Literal('failed'), T.Literal('blocked'),
  T.Literal('error'), T.Literal('interrupted'),
]);

const failure = T.Object({
  category,
  code: T.Optional(T.String()),
  stepId: T.Optional(T.String()),
  stepKind: T.Optional(T.String()),
  message: T.Optional(T.String()),
  expected: T.Optional(T.Unknown()),
  actual: T.Optional(T.Unknown()),
  screenshots: T.Optional(T.Object({
    baseline: T.Optional(T.String()),
    actual: T.Optional(T.String()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const step = T.Object({
  id: T.String({ minLength: 1 }),
  kind: T.Optional(T.String()),
  status: T.String(),
  code: T.Optional(T.String()),
  privilege: T.Optional(T.String()),
}, { additionalProperties: false });

const run = T.Object({
  run: T.Integer({ minimum: 1 }),
  round: T.Integer({ minimum: 1 }),
  status: runStatus,
  startedAt: timestamp,
  finishedAt: timestamp,
  durationMs: timestamp,
  exitCode: T.Union([T.Integer(), T.Null()]),
  signal: T.Union([T.String(), T.Null()]),
  failure: T.Optional(failure),
  report: T.Optional(T.String()),
  steps: T.Optional(T.Array(step, { maxItems: 500 })),
}, { additionalProperties: false });

const item = T.Object({
  name: label,
  file: label,
  path: T.String({ minLength: 1 }),
  version: T.Integer({ minimum: 1, maximum: 2 }),
  app: T.String(),
  window: T.String(),
  selected: T.Boolean(),
  reproduce: T.String({ minLength: 1 }),
  runs: T.Array(run),
}, { additionalProperties: false });

const counts = T.Object({
  planned: T.Integer({ minimum: 0 }),
  completed: T.Integer({ minimum: 0 }),
  passed: T.Integer({ minimum: 0 }),
  failed: T.Integer({ minimum: 0 }),
  blocked: T.Integer({ minimum: 0 }),
  error: T.Integer({ minimum: 0 }),
  interrupted: T.Integer({ minimum: 0 }),
  notCompleted: T.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const log = T.Object({
  at: timestamp,
  run: T.Integer({ minimum: 1 }),
  name: label,
  round: T.Integer({ minimum: 1 }),
  status: runStatus,
  durationMs: timestamp,
  failure: T.Optional(failure),
}, { additionalProperties: false });

export const workbenchBatchSchema = T.Object({
  format: T.Literal('cuekeeper-workbench-batch'),
  version: T.Literal(2),
  id: T.String({ minLength: 1, maxLength: 256 }),
  status: T.Union([
    T.Literal('running'), T.Literal('passed'), T.Literal('failed'),
    T.Literal('blocked'), T.Literal('stopped'),
  ]),
  stopReason: T.Optional(T.Union([
    T.Literal('operator'), T.Literal('time'), T.Literal('complete'), T.Literal('failure'),
  ])),
  startedAt: T.Optional(timestamp),
  finishedAt: T.Optional(timestamp),
  durationMs: T.Optional(timestamp),
  host: T.Object({
    platform: T.String(),
    arch: T.String(),
    release: T.String(),
    node: T.String(),
    cuekeeper: T.String(),
    driver: T.String(),
  }, { additionalProperties: false }),
  config: T.Optional(T.Object({
    rounds: T.Integer({ minimum: 1, maximum: 500 }),
    intervalMs: T.Integer({ minimum: 0, maximum: 3_600_000 }),
    continueOnFailure: T.Boolean(),
    stopAt: T.Optional(timestamp),
  }, { additionalProperties: false })),
  counts,
  failureCounts: T.Record(T.String(), T.Integer({ minimum: 0 })),
  firstFailure: T.Optional(T.Object({
    run: T.Integer({ minimum: 1 }),
    path: T.String({ minLength: 1 }),
    item: label,
    round: T.Integer({ minimum: 1 }),
    status: runStatus,
    failure,
  }, { additionalProperties: false })),
  error: T.Optional(T.String()),
  items: T.Array(item),
  log: T.Array(log),
}, { additionalProperties: false });

export const workbenchBatchCheck = TypeCompiler.Compile(workbenchBatchSchema);

export const schemasWorkbench = {
  'workbench-batch': workbenchBatchSchema,
};
