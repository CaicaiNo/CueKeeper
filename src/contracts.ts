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
const pixel = T.Integer({ minimum: 1, maximum: 8192 });
const ratio = T.Number({ minimum: 0, maximum: 1 });

const element = object({
  kind: T.Literal('element'),
  role: label,
  name: T.Optional(T.String({ maxLength: 256 })),
  path: T.Optional(T.Array(label, { minItems: 1, maxItems: 51 })),
  index: T.Optional(T.Integer({ minimum: 0 })),
});
const locator = T.Union([element, object({ kind: T.Literal('point'), point })]);

// An app path names one installed copy. The shape check stays platform-neutral:
// POSIX absolute, Windows drive absolute, or a standard UNC path. Relative
// paths, `~`, file URLs, device namespaces and control characters are rejected.
export const appPathPattern =
  '^(?![\\s\\S]*[\\u0000-\\u001f\\u007f])(?:/(?!/)[\\s\\S]+|[A-Za-z]:[/\\\\][^/\\\\][\\s\\S]*' +
  '|\\\\\\\\(?![?.]\\\\)[^/\\\\]+\\\\[^/\\\\]+\\\\[^/\\\\][\\s\\S]*)$';

export const targetSchema = object({
  app: label,
  window: label,
  appPath: T.Optional(T.String({ minLength: 1, maxLength: 4096, pattern: appPathPattern })),
});

const comparator = T.Union([T.Literal('equals'), T.Literal('contains'), T.Literal('matches')]);

// A window assertion names its own app/window, so it can inspect a second window
// while the flow keeps replaying into its original target.
const windowTarget = T.Union([
  object({ kind: T.Literal('window'), app: label }),
  object({
    kind: T.Literal('window'), app: label, window: label,
    match: T.Optional(comparator),
  }),
]);

const normalize = object({
  ignoreCase: T.Optional(T.Boolean()),
  whitespace: T.Optional(T.Union([T.Literal('trim'), T.Literal('collapse')])),
});

const stringExpectation = <P extends 'text' | 'value' | 'title'>(property: P) => T.Union([
  object({ property: T.Literal(property), equals: text, normalize: T.Optional(normalize) }),
  object({ property: T.Literal(property), contains: T.String({ minLength: 1, maxLength: 4000 }), normalize: T.Optional(normalize) }),
  object({ property: T.Literal(property), matches: T.String({ minLength: 1, maxLength: 256 }), normalize: T.Optional(normalize) }),
]);
const booleanExpectation = object({ property: T.Union([T.Literal('exists'), T.Literal('visible')]), equals: T.Boolean() });
const elementExpectation = T.Union([
  booleanExpectation, stringExpectation('text'), stringExpectation('value'),
]);

const windowExistsExpectation = object({ property: T.Literal('exists'), equals: T.Boolean() });
const region = object({
  x: T.Integer({ minimum: 0, maximum: 8191 }),
  y: T.Integer({ minimum: 0, maximum: 8191 }),
  width: pixel,
  height: pixel,
});
const baseline = object({
  sha256: digest,
  frameWidth: pixel,
  frameHeight: pixel,
});
const screenshotExpectation = object({
  property: T.Literal('screenshot'),
  region,
  baseline,
  maxDiffRatio: ratio,
});
const windowExpectation = T.Union([
  windowExistsExpectation, stringExpectation('title'), screenshotExpectation,
]);

// Wait and setup keep the original element-only contract.
const check = object({
  target: element,
  expect: T.Union([
    object({ property: T.Union([T.Literal('exists'), T.Literal('visible')]), equals: T.Boolean() }),
    object({ property: T.Union([T.Literal('text'), T.Literal('value')]), equals: text }),
  ]),
});
const assertCheck = T.Union([
  object({ target: element, expect: elementExpectation }),
  object({ target: windowTarget, expect: windowExpectation }),
]);

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
// Pointer input beyond the plain left click: a double/triple click keeps the
// same locator contract, and a scroll records the deltas the capture helper
// observed (or an authored direction and amount). Delta and direction forms
// are separate closed objects so a step cannot mix them.
const clickCount = T.Optional(T.Integer({ minimum: 1, maximum: 3 }));
const clickButton = T.Optional(T.Union([T.Literal('left'), T.Literal('right')]));
const scrollDirection = T.Union([
  T.Literal('up'), T.Literal('down'), T.Literal('left'), T.Literal('right'),
]);
const scrollDelta = T.Integer({ minimum: -1000, maximum: 1000 });
const scrollDuration = T.Optional(time);
// A drag records both endpoints and its measured duration. The sampled path is
// evidence of the gesture; replay keeps the endpoints and duration. A drag that
// starts and ends at the same element is still a drag, not a click.
const dragPathPoint = T.Tuple([T.Integer(), T.Integer()]);
const drag = object({
  ...step, kind: T.Literal('drag'),
  from: locator, to: locator, durationMs: T.Integer({ minimum: 0, maximum: 60_000 }),
  path: T.Optional(T.Array(dragPathPoint, { maxItems: 64 })),
  button: clickButton,
});
// Hover is a physical pointer move plus a dwell. The locator names the element
// or coordinate under the cursor; durationMs is the recorded dwell, not a
// promise that a tooltip or menu survives replay.
const hover = object({
  ...step, kind: T.Literal('hover'), target: locator,
  durationMs: T.Integer({ minimum: 0, maximum: 60_000 }),
});
// A paste pins the text recorded from the clipboard. The target is the editable
// control that had focus when Cmd+V was pressed. Replay writes the text to the
// clipboard and sends the shortcut; the content never enters a report entry.
const pasteText = T.String({ minLength: 1, maxLength: 4000, pattern: '^[^\\u0000]*$' });
const paste = object({
  ...step, kind: T.Literal('paste'), target: element, text: pasteText,
});
const scroll = T.Union([
  object({
    ...step, kind: T.Literal('scroll'), target: locator,
    deltaX: scrollDelta, deltaY: scrollDelta, durationMs: scrollDuration,
  }),
  object({
    ...step, kind: T.Literal('scroll'), target: locator,
    direction: scrollDirection, amount: T.Integer({ minimum: 1, maximum: 1000 }),
    durationMs: scrollDuration,
  }),
]);

// Shell steps are one closed object per execution shape so that argv and
// command cannot be combined and sudo cannot carry a caller-supplied cwd, env
// or timeout. The published schema keeps the same constraints even though the
// generated form inlines the three variants instead of using $ref.
const shellString = (minLength: number, maxLength: number) =>
  T.String({ minLength, maxLength, pattern: '^[^\\u0000]*$' });
const shellArgv = T.Array(shellString(0, 4096), { minItems: 1, maxItems: 65 });
const shellCommand = shellString(1, 16_384);
const shellCwd = shellString(1, 4096);
const shellEnvKey = T.String({
  pattern: '^(?!(?:HOME|USER|LOGNAME|TMPDIR|LANG|PATH|NODE_OPTIONS)$|(?:SUDO_|DYLD_|LD_|CUEKEEPER_))[A-Za-z_][A-Za-z0-9_]{0,63}$',
});
const shellEnv = T.Record(shellEnvKey, T.Union([
  shellString(0, 4000),
  object({ secretEnv: T.String({ pattern: '^CUEKEEPER_SECRET_[A-Z0-9_]{1,64}$' }) }),
]), { additionalProperties: false, maxProperties: 32 });
const shellTimeout = T.Optional(T.Integer({ minimum: 1, maximum: 120_000, default: 30_000 }));
const shellExpectedExit = T.Optional(T.Integer({ minimum: 0, maximum: 255, default: 0 }));
// Authorization for root steps. `prompt` shows the native password dialog
// through sudo -A and SUDO_ASKPASS; `sudoers` relies on a pre-installed
// NOPASSWD policy and never prompts; `keychain` reads a password stored by
// `cuekeeper sudo set` through the system security binary.
const shellPrivilegeMode = T.Optional(T.Union([
  T.Literal('prompt'), T.Literal('sudoers'), T.Literal('keychain'),
]));
const shellFields = {
  ...step, kind: T.Literal('shell'),
  shell: T.Optional(T.Literal(false)),
  cwd: T.Optional(shellCwd),
  env: T.Optional(shellEnv),
  expectedExitCode: shellExpectedExit,
};
const shellSteps = [
  object({ ...shellFields, argv: shellArgv, timeoutMs: shellTimeout, privilege: T.Optional(T.Literal('user')) }),
  object({
    ...step, kind: T.Literal('shell'), shell: T.Literal(true), command: shellCommand,
    cwd: T.Optional(shellCwd), env: T.Optional(shellEnv),
    timeoutMs: shellTimeout, expectedExitCode: shellExpectedExit,
    privilege: T.Optional(T.Literal('user')),
  }),
  object({
    ...step, kind: T.Literal('shell'), shell: T.Optional(T.Literal(false)),
    argv: T.Array(T.String({ pattern: '^/Library/CueKeeper/privileged/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' }),
      { minItems: 1, maxItems: 1 }),
    privilege: T.Literal('sudo'), expectedExitCode: shellExpectedExit,
  }),
  // Root steps run caller-supplied argv as root. They never accept a command
  // string or caller environment: the whole point of the password gate is that
  // the operator can read the exact program and arguments before approving.
  object({
    ...step, kind: T.Literal('shell'), shell: T.Optional(T.Literal(false)),
    argv: shellArgv, cwd: T.Optional(shellCwd),
    timeoutMs: shellTimeout, expectedExitCode: shellExpectedExit,
    privilege: T.Literal('root'), privilegeMode: shellPrivilegeMode,
  }),
] as const;
const shellStep = T.Union([...shellSteps]);
const action = T.Union([
  object({
    ...step, kind: T.Literal('click'), target: locator,
    count: clickCount, button: clickButton,
  }),
  object({ ...step, kind: T.Literal('type'), target: element, text: inputText, ime: T.Optional(T.Boolean()) }),
  object({
    ...step,
    kind: T.Literal('key'),
    key: T.String({ pattern: '^(?:[a-z0-9]|space|return|tab|escape|delete|backspace|forwarddelete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$' }),
    modifiers: T.Optional(T.Array(T.Union([
      T.Literal('meta'), T.Literal('ctrl'), T.Literal('alt'), T.Literal('shift'),
    ]), { uniqueItems: true, maxItems: 4 })),
  }),
  object({ ...step, kind: T.Literal('wait'), check, timeoutMs: time }),
  object({ ...step, kind: T.Literal('assert'), check: assertCheck }),
  drag,
  scroll,
  hover,
  paste,
  ...shellSteps,
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
const deliveryState = T.Union([
  T.Literal('delivered_verified'), T.Literal('delivered_unverified'),
  T.Literal('delivery_uncertain'), T.Literal('not_delivered'), T.Literal('unknown'),
]);
const entryFields = {
  id: T.String({ minLength: 1, maxLength: 196 }),
  status: resultStatus,
  atMs: T.Integer({ minimum: 0 }),
  durationMs: T.Integer({ minimum: 0 }),
  message: T.Optional(T.String()),
  code: T.Optional(T.String()),
  delivery: T.Optional(deliveryState),
};
const evidencePath = T.String({
  pattern: '^assets/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?/assertion-(?:baseline|actual)\\.png$',
});
const screenshotActual = object({
  frameWidth: T.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  frameHeight: T.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  differentPixels: T.Optional(T.Integer({ minimum: 0, maximum: 16_777_216 })),
  diffRatio: T.Optional(ratio),
});
const shellBytes = T.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const shellOutput = T.Union([
  object({
    kind: T.Literal('text'), bytes: shellBytes, truncated: T.Boolean(),
    text: shellString(0, 16_384),
  }),
  object({
    kind: T.Union([T.Literal('binary'), T.Literal('omitted')]),
    bytes: shellBytes, truncated: T.Boolean(),
  }),
]);
const shellExecution = T.Union([
  T.Literal('finished'), T.Literal('terminated'), T.Literal('unknown'),
]);
const shellResultFields = {
  mode: T.Union([T.Literal('argv'), T.Literal('shell')]),
  privilege: T.Union([T.Literal('user'), T.Literal('sudo'), T.Literal('root')]),
  privilegeMode: shellPrivilegeMode,
  cleanup: T.Optional(T.Union([T.Literal('complete'), T.Literal('unknown')])),
  stdout: T.Optional(shellOutput),
  stderr: T.Optional(shellOutput),
  warnings: T.Optional(T.Array(T.Literal('SHELL_OUTPUT_TRUNCATED'), { maxItems: 1 })),
};
const shellResult = T.Union([
  object({
    mode: shellResultFields.mode,
    privilege: shellResultFields.privilege,
    privilegeMode: shellPrivilegeMode,
    execution: T.Union([T.Literal('preview'), T.Literal('not-run')]),
  }),
  object({
    ...shellResultFields, execution: shellExecution,
    exitCode: T.Integer({ minimum: 0, maximum: 255 }),
  }),
  object({
    ...shellResultFields, execution: shellExecution,
    signal: T.String({ pattern: '^SIG[A-Z0-9]+$' }),
  }),
  object({ ...shellResultFields, execution: shellExecution }),
]);
const assertionResult = T.Union([
  object({ expected: booleanExpectation, actual: T.Optional(T.Boolean()) }),
  object({
    expected: T.Union([stringExpectation('text'), stringExpectation('value'), stringExpectation('title')]),
    actual: T.Optional(T.String()),
  }),
  object({
    expected: screenshotExpectation,
    actual: T.Optional(screenshotActual),
    screenshots: T.Optional(object({
      baseline: T.Optional(evidencePath),
      actual: T.Optional(evidencePath),
    })),
  }),
]);
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
    kind: T.Union([
      T.Literal('click'), T.Literal('type'), T.Literal('key'), T.Literal('wait'), T.Literal('scroll'),
      T.Literal('drag'), T.Literal('hover'), T.Literal('paste'),
    ]),
  }),
  object({
    ...entryFields,
    kind: T.Literal('assert'),
    assertion: T.Optional(assertionResult),
  }),
  object({
    id: entryFields.id,
    status: resultStatus,
    atMs: entryFields.atMs,
    durationMs: entryFields.durationMs,
    message: entryFields.message,
    code: entryFields.code,
    kind: T.Literal('shell'),
    shell: shellResult,
  }),
]);
const appIdentityCode = T.Union([
  T.Literal('APP_PATH_INVALID'), T.Literal('APP_AMBIGUOUS'),
  T.Literal('UNSUPPORTED_PLATFORM'), T.Literal('UNSAFE_POINT'),
]);
const appIdentityReason = T.Union([
  T.Literal('invalid_bundle_path'), T.Literal('bundle_id_mismatch'),
  T.Literal('unsupported_path_platform'), T.Literal('path_mismatch'),
  T.Literal('multiple_instances'), T.Literal('multiple_installed_copies'),
  T.Literal('identity_unproven'), T.Literal('instance_changed'),
  T.Literal('driver_target_unconfirmed'), T.Literal('fixture_path_mismatch'),
  T.Literal('untargeted_input'),
]);
const appIdentityMode = T.Union([T.Literal('bundle_path'), T.Literal('legacy_bundle_id')]);
// Optional identity summary. A blocked identity carries the first terminating
// reason; the entry it stopped on is named when one exists.
const appIdentity = T.Union([
  object({
    app: label,
    mode: appIdentityMode,
    status: T.Union([T.Literal('verified'), T.Literal('offline_unverified')]),
  }),
  object({
    app: label,
    mode: appIdentityMode,
    status: T.Literal('blocked'),
    code: appIdentityCode,
    reason: appIdentityReason,
    entryId: T.Optional(T.String({ minLength: 1, maxLength: 196 })),
  }),
]);
// An input source fact. Flow v1 keeps its required fields; a report carries
// which source a run started on, which one it used and how it ended.
const inputSource = object({
  id: T.String({ minLength: 1, maxLength: 256 }),
  name: T.String({ minLength: 1, maxLength: 256 }),
  ascii: T.Boolean(),
});
// One IME warning is user-visible: CLI stderr, --json and viewer read the same
// record. `level` separates a blocked step from an advisory restore result.
const imeWarning = object({
  code: T.String({ minLength: 1, maxLength: 64, pattern: '^[A-Z_]+$' }),
  level: T.Union([T.Literal('blocked'), T.Literal('warning')]),
  title: T.String({ minLength: 1, maxLength: 256 }),
  message: T.String({ maxLength: 2000 }),
  action: T.String({ maxLength: 2000 }),
  original: T.Optional(inputSource),
  current: T.Optional(inputSource),
  runId: T.Optional(T.String({ minLength: 1, maxLength: 128 })),
  holderRunId: T.Optional(T.String({ minLength: 1, maxLength: 128 })),
  lockExpiresAt: T.Optional(T.String({ maxLength: 64 })),
  attempted: T.Optional(inputSource),
  verified: T.Optional(inputSource),
});
const imeSummary = object({
  switched: T.Boolean(),
  original: T.Optional(inputSource),
  target: T.Optional(inputSource),
  final: T.Optional(inputSource),
  runDir: T.Optional(T.String({ minLength: 1, maxLength: 4096 })),
});
export const reportSchema = object({
  version: T.Literal(1), flowId: id, flowSha256: digest, startedAt: timestamp,
  mode: T.Union([T.Literal('replay'), T.Literal('dry-run')]),
  status: T.Union([T.Literal('passed'), T.Literal('failed'), T.Literal('blocked')]),
  appIdentity: T.Optional(appIdentity),
  ime: T.Optional(imeSummary),
  warnings: T.Optional(T.Array(imeWarning, { maxItems: 50 })),
  entries: T.Array(entry, { minItems: 1 }),
});

// A batch summary indexes the completed rows of one data table. Each indexed
// row points at an ordinary v1 report and its bound flow, which stay packable.
const batchIssue = object({
  stepId: T.String({ minLength: 1, maxLength: 196 }),
  code: T.Optional(T.String()),
});
const batchRow = object({
  row: T.Integer({ minimum: 1, maximum: 1000 }),
  status: T.Union([T.Literal('passed'), T.Literal('failed'), T.Literal('blocked')]),
  parameters: T.Record(T.String({ minLength: 1, maxLength: 129 }), T.String()),
  issues: T.Array(batchIssue, { maxItems: 2000 }),
  report: T.Optional(T.String({ minLength: 1 })),
  flow: T.Optional(T.String({ minLength: 1 })),
});
export const batchReportSchema = object({
  format: T.Literal('cuekeeper-batch-report'),
  version: T.Literal(1),
  flowId: id,
  mode: T.Union([T.Literal('replay'), T.Literal('dry-run')]),
  startedAt: timestamp,
  status: T.Union([
    T.Literal('passed'), T.Literal('failed'), T.Literal('blocked'),
    T.Literal('error'), T.Literal('interrupted'),
  ]),
  counts: object({
    total: T.Integer({ minimum: 1, maximum: 1000 }),
    passed: T.Integer({ minimum: 0, maximum: 1000 }),
    failed: T.Integer({ minimum: 0, maximum: 1000 }),
    blocked: T.Integer({ minimum: 0, maximum: 1000 }),
    notCompleted: T.Integer({ minimum: 0, maximum: 1000 }),
  }),
  rows: T.Array(batchRow, { maxItems: 1000 }),
  error: T.Optional(object({
    code: T.String({ minLength: 1 }),
    message: T.String({ minLength: 1 }),
    row: T.Optional(T.Integer({ minimum: 1, maximum: 1000 })),
  })),
});

export const schemas = {
  flow: flowSchema,
  behavior: object({ version: T.Literal(1), ...behavior.properties }),
  setup: object({ version: T.Literal(1), ...setup.properties }),
  report: reportSchema,
  batch: batchReportSchema,
};
export const flowCheck = TypeCompiler.Compile(flowSchema);
export const reportCheck = TypeCompiler.Compile(reportSchema);
export const batchReportCheck = TypeCompiler.Compile(batchReportSchema);
export const captureTargetCheck = TypeCompiler.Compile(targetSchema);
export const captureActionCheck = TypeCompiler.Compile(action);

export type Flow = Static<typeof flowSchema>;
export type Action = Static<typeof action>;
export type ClickAction = Extract<Action, { kind: 'click' }>;
export type ScrollAction = Extract<Action, { kind: 'scroll' }>;
export type DragAction = Extract<Action, { kind: 'drag' }>;
export type HoverAction = Extract<Action, { kind: 'hover' }>;
export type PasteAction = Extract<Action, { kind: 'paste' }>;
export type Setup = Static<typeof setup>;
export type Ensure = Static<typeof ensure>;
export type Locator = Static<typeof locator>;
export type ElementLocator = Static<typeof element>;
export type Check = Static<typeof check>;
export type Target = Static<typeof targetSchema>;
export type Report = Static<typeof reportSchema>;
export type ImeWarningReport = NonNullable<Report['warnings']>[number];
export type ImeSummaryReport = NonNullable<Report['ime']>;
export type AppIdentity = Static<typeof appIdentity>;
export type AppIdentityReason =
  | 'invalid_bundle_path' | 'bundle_id_mismatch' | 'unsupported_path_platform'
  | 'path_mismatch' | 'multiple_instances' | 'multiple_installed_copies'
  | 'identity_unproven' | 'instance_changed' | 'driver_target_unconfirmed'
  | 'fixture_path_mismatch' | 'untargeted_input' | 'preflight_deferred';
export type BatchReport = Static<typeof batchReportSchema>;
export type Entry = Static<typeof entry>;
export type AssertCheck = Static<typeof assertCheck>;
export type WindowTarget = Static<typeof windowTarget>;
export type ElementExpectation = Static<typeof elementExpectation>;
export type WindowExpectation = Static<typeof windowExpectation>;
export type ElementAssertCheck = { target: ElementLocator; expect: ElementExpectation };
export type WindowAssertCheck = { target: WindowTarget; expect: WindowExpectation };
export type StringExpectation = Static<ReturnType<typeof stringExpectation>>;
export type ScreenshotExpectation = Static<typeof screenshotExpectation>;
export type AssertionResult = Static<typeof assertionResult>;
export type ScreenshotActual = Static<typeof screenshotActual>;
export type Normalize = Static<typeof normalize>;
export type ShellStep = Static<typeof shellStep>;
export type ShellEnv = NonNullable<Static<typeof shellEnv>>;
export type ShellOutput = Static<typeof shellOutput>;
export type ShellResult = Static<typeof shellResult>;
export type ShellEntry = Extract<Entry, { kind: 'shell' }>;
export type Delivery = Static<typeof deliveryState>;
