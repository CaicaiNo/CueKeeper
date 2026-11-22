import { Type as T } from '@sinclair/typebox';
import type { Static, TProperties } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { appPathPattern } from './contracts.js';

// Flow version 2 is the global recording contract. It has no flow-level target:
// every step names its own scope, and a window scope binds one app for the whole
// flow through a stable `windowKey`. Version 1 stays a separate closed object so
// existing files keep their parser, hash and report.

const object = <P extends TProperties>(properties: P) =>
  T.Object(properties, { additionalProperties: false });
const label = T.String({ minLength: 1, maxLength: 256 });
const id = T.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' });
const bundleId = T.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9][A-Za-z0-9-]*)+$' });
const windowKey = T.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' });
const parameterName = T.String({ pattern: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$' });
const text = T.String({ maxLength: 4000 });
const digest = T.String({ pattern: '^[a-f0-9]{64}$' });
const timestamp = T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const pixel = T.Integer({ minimum: 1, maximum: 8192 });
const ratio = T.Number({ minimum: 0, maximum: 1 });

export const defaultWaitTimeoutMs = 15_000;
export const maxWaitTimeoutMs = 1_800_000;
export const defaultCheckpointTimeoutMs = 120_000;
/** A download counts as finished once its size and mtime stay quiet this long. */
export const defaultFileQuietMs = 1000;

const element = object({
  kind: T.Literal('element'),
  role: label,
  name: T.Optional(T.String({ maxLength: 256 })),
  path: T.Optional(T.Array(label, { minItems: 1, maxItems: 51 })),
  index: T.Optional(T.Integer({ minimum: 0 })),
});

// A click may keep a screen point as its target when the window tree could not
// name the element under the pointer. It stays a window-scoped, editable step:
// replay delivers it only as physical input, and the workbench can turn it into
// an element target. Every other input step still requires an element.
const clickPoint = T.Tuple([
  T.Integer({ minimum: -100_000, maximum: 100_000 }),
  T.Integer({ minimum: -100_000, maximum: 100_000 }),
]);
const pointTarget = object({ kind: T.Literal('point'), point: clickPoint });
const clickTarget = T.Union([element, pointTarget]);

// The raw-coordinate locator is refused everywhere else: a global flow stays
// bound to a scope and an element, and only a recorded click may fall back.
const windowScope = object({
  kind: T.Literal('window'), app: bundleId, windowKey, windowTitle: label,
});
const appScope = object({ kind: T.Literal('app'), app: bundleId });
const surfaceKind = T.Union([
  T.Literal('dock'), T.Literal('app_menu_bar'), T.Literal('app_context_menu'),
  T.Literal('menu_bar_extras'), T.Literal('spotlight'),
]);
// App menu bars belong to an app. A context menu additionally belongs to the
// window that opened it. The other system surfaces carry no app identity.
const surfaceScope = T.Union([
  object({ kind: T.Literal('surface'), surface: T.Union([
    T.Literal('dock'), T.Literal('menu_bar_extras'), T.Literal('spotlight'),
  ]) }),
  object({ kind: T.Literal('surface'), surface: T.Literal('app_menu_bar'), app: bundleId }),
  object({
    kind: T.Literal('surface'), surface: T.Literal('app_context_menu'),
    app: bundleId, windowKey, windowTitle: label,
  }),
]);
// A file scope names a local directory and exactly one file: either the exact
// name or an installer-assigned suffix such as `pkg (1).pkg`. Only a wait uses
// it; the file is read, never written, moved or deleted.
const fileDirectory = T.String({
  minLength: 1, maxLength: 4096, pattern: appPathPattern,
});
const fileName = T.String({ minLength: 1, maxLength: 255, pattern: '^[^/\\\\]+$' });
const fileScope = T.Union([
  object({ kind: T.Literal('file'), directory: fileDirectory, name: fileName }),
  object({ kind: T.Literal('file'), directory: fileDirectory, suffix: fileName }),
]);
export const scopeSchema = T.Union([windowScope, appScope, surfaceScope, fileScope]);
const focusAfter = T.Optional(T.Union([windowScope, appScope]));

const comparator = T.Union([T.Literal('equals'), T.Literal('contains'), T.Literal('matches')]);
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
const region = object({
  x: T.Integer({ minimum: 0, maximum: 8191 }),
  y: T.Integer({ minimum: 0, maximum: 8191 }),
  width: pixel,
  height: pixel,
});
const screenshotExpectation = object({
  property: T.Literal('screenshot'),
  region,
  baseline: object({ sha256: digest, frameWidth: pixel, frameHeight: pixel }),
  maxDiffRatio: ratio,
});
const windowTarget = object({ kind: T.Literal('window') });
const windowExpectation = T.Union([
  object({ property: T.Literal('exists'), equals: T.Boolean() }),
  stringExpectation('title'),
  screenshotExpectation,
]);
const assertCheck = T.Union([
  object({ target: element, expect: elementExpectation }),
  object({ target: windowTarget, expect: windowExpectation }),
]);
const appAssertCheck = object({
  target: windowTarget,
  expect: object({ property: T.Literal('exists'), equals: T.Boolean() }),
});

// A wait reads only; its condition names the kind of state it observes.
const windowWaitCheck = T.Union([
  object({ kind: T.Literal('window_exists'), equals: T.Boolean() }),
  object({ kind: T.Literal('element_enabled'), target: element, equals: T.Boolean() }),
  object({
    kind: T.Literal('element'), target: element,
    expect: T.Union([booleanExpectation, stringExpectation('text'), stringExpectation('value')]),
  }),
  object({
    kind: T.Literal('window'), expect: T.Union([
      object({ property: T.Literal('exists'), equals: T.Boolean() }),
      stringExpectation('title'),
    ]),
  }),
]);
const appWaitCheck = T.Union([
  object({ kind: T.Literal('app_running'), equals: T.Boolean() }),
  object({ kind: T.Literal('app_installed'), equals: T.Boolean() }),
]);
// A file wait reads the download directory: a matching file exists, or it has
// finished writing (its size and mtime have been quiet for `quietMs`).
const fileWaitCheck = T.Union([
  object({ kind: T.Literal('file_exists'), equals: T.Boolean() }),
  object({
    kind: T.Literal('file_stable'),
    quietMs: T.Optional(T.Integer({
      minimum: 100, maximum: 60_000, default: defaultFileQuietMs,
    })),
  }),
]);
const waitTimeout = T.Optional(T.Integer({
  minimum: 1000, maximum: maxWaitTimeoutMs, default: defaultWaitTimeoutMs,
}));
const checkpointTimeout = T.Optional(T.Integer({
  minimum: 1000, maximum: maxWaitTimeoutMs, default: defaultCheckpointTimeoutMs,
}));

const clickCount = T.Optional(T.Integer({ minimum: 1, maximum: 3 }));
const clickButton = T.Optional(T.Union([T.Literal('left'), T.Literal('right')]));
const scrollDelta = T.Integer({ minimum: -1000, maximum: 1000 });
const scrollDuration = T.Optional(T.Integer({ minimum: 0, maximum: 60_000 }));
const dragPoint = T.Tuple([T.Integer(), T.Integer()]);
const keyName = T.String({
  pattern: '^(?:[a-z0-9]|space|return|tab|escape|delete|backspace|forwarddelete|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])$',
});
const modifiers = T.Optional(T.Array(T.Union([
  T.Literal('meta'), T.Literal('ctrl'), T.Literal('alt'), T.Literal('shift'),
]), { uniqueItems: true, maxItems: 4 }));
const stepId = { id };

const clickStep = object({
  ...stepId, kind: T.Literal('click'), scope: windowScope, focusAfter,
  target: clickTarget, count: clickCount, button: clickButton,
});
// `text` is an explicit literal; `input` names a runtime parameter. A step has
// exactly one of them, which the two closed variants enforce.
const typeStep = T.Union([
  object({
    ...stepId, kind: T.Literal('type'), scope: windowScope, focusAfter,
    target: element, text: T.String({ minLength: 1, maxLength: 4000 }), ime: T.Optional(T.Boolean()),
  }),
  object({
    ...stepId, kind: T.Literal('type'), scope: windowScope, focusAfter,
    target: element, input: parameterName, ime: T.Optional(T.Boolean()),
  }),
]);
const keyStep = object({
  ...stepId, kind: T.Literal('key'), scope: windowScope, focusAfter,
  key: keyName, modifiers,
});
const scrollStep = T.Union([
  object({
    ...stepId, kind: T.Literal('scroll'), scope: windowScope, focusAfter,
    target: element, deltaX: scrollDelta, deltaY: scrollDelta, durationMs: scrollDuration,
  }),
  object({
    ...stepId, kind: T.Literal('scroll'), scope: windowScope, focusAfter,
    target: element, direction: T.Union([
      T.Literal('up'), T.Literal('down'), T.Literal('left'), T.Literal('right'),
    ]), amount: T.Integer({ minimum: 1, maximum: 1000 }), durationMs: scrollDuration,
  }),
]);
const dragStep = object({
  ...stepId, kind: T.Literal('drag'), scope: windowScope, focusAfter,
  from: element, to: element, durationMs: T.Integer({ minimum: 0, maximum: 60_000 }),
  path: T.Optional(T.Array(dragPoint, { maxItems: 64 })), button: clickButton,
});
const hoverStep = object({
  ...stepId, kind: T.Literal('hover'), scope: windowScope, focusAfter,
  target: element, durationMs: T.Integer({ minimum: 0, maximum: 60_000 }),
});
// Paste never embeds clipboard content in v2: it names the earlier copy step or
// a runtime input parameter.
const pasteStep = object({
  ...stepId, kind: T.Literal('paste'), scope: windowScope, focusAfter,
  target: element,
  source: T.Union([
    object({ kind: T.Literal('copy'), stepId: id }),
    object({ kind: T.Literal('input'), input: parameterName }),
  ]),
});
const waitStep = T.Union([
  object({
    ...stepId, kind: T.Literal('wait'), scope: windowScope, focusAfter,
    check: windowWaitCheck, timeoutMs: waitTimeout,
  }),
  object({
    ...stepId, kind: T.Literal('wait'), scope: appScope, focusAfter,
    check: appWaitCheck, timeoutMs: waitTimeout,
  }),
  object({
    ...stepId, kind: T.Literal('wait'), scope: fileScope,
    check: fileWaitCheck, timeoutMs: waitTimeout,
  }),
]);
const assertStep = T.Union([
  object({ ...stepId, kind: T.Literal('assert'), scope: windowScope, check: assertCheck }),
  object({ ...stepId, kind: T.Literal('assert'), scope: appScope, check: appAssertCheck }),
]);
const launchApp = object({
  ...stepId, kind: T.Literal('launch_app'), scope: appScope, focusAfter,
});
const activateApp = object({
  ...stepId, kind: T.Literal('activate_app'), scope: appScope, focusAfter,
});
const focusWindow = object({
  ...stepId, kind: T.Literal('focus_window'), scope: windowScope,
});
const openSystemSurface = object({
  ...stepId, kind: T.Literal('open_system_surface'), scope: surfaceScope, focusAfter,
});
// A surface press selects by meaning, never by position: a Dock icon by bundle
// ID, a menu item by its unique path, a status item by a verified identifier.
const dockItem = object({ kind: T.Literal('dock_item'), bundleId });
const menuItem = object({ kind: T.Literal('menu_item'), path: T.Array(label, { minItems: 1, maxItems: 8 }) });
const statusItem = object({ kind: T.Literal('status_item'), identifier: label });
const spotlightResult = object({ kind: T.Literal('spotlight_result'), bundleId });
const surfacePress = object({
  ...stepId, kind: T.Literal('surface_press'), scope: surfaceScope,
  selector: T.Union([dockItem, menuItem, statusItem, spotlightResult]),
});
const manualCheckpoint = object({
  ...stepId, kind: T.Literal('manual_checkpoint'), scope: windowScope,
  triggerStepId: id, reason: T.Literal('secure_input'),
  resume: object({ scope: windowScope, check: windowWaitCheck }),
  timeoutMs: checkpointTimeout,
});
const gapCodes = T.Union([
  T.Literal('CAPTURE_SCOPE_UNVERIFIED'), T.Literal('STALE_CAPTURE'),
  T.Literal('CROSS_SCOPE_GESTURE'), T.Literal('PRIVACY_REDACTED'),
  T.Literal('SECURE_INPUT'), T.Literal('IME_COMMIT_UNVERIFIED'), T.Literal('CAPTURE_GAP'),
]);
const gapStep = object({ ...stepId, kind: T.Literal('gap'), code: gapCodes });

const step = T.Union([
  clickStep, typeStep, keyStep, scrollStep, dragStep, hoverStep, pasteStep,
  waitStep, assertStep, launchApp, activateApp, focusWindow, openSystemSurface,
  surfacePress, manualCheckpoint, gapStep,
]);

const intent = object({
  id, action: label,
  params: T.Record(parameterName, text, { additionalProperties: false, maxProperties: 32 }),
  sourceStepIds: T.Array(id, { minItems: 1, maxItems: 500 }),
  equivalence: T.Union([T.Literal('same_ui'), T.Literal('same_end_state')]),
  skippedUiStepIds: T.Optional(T.Array(id, { maxItems: 500 })),
  observableEffects: T.Array(object({
    kind: label, scope: scopeSchema, check: T.Union([windowWaitCheck, appWaitCheck]),
  }), { minItems: 1, maxItems: 10 }),
});

const appPath = T.String({ minLength: 1, maxLength: 4096, pattern: appPathPattern });
export const flowV2Schema = object({
  version: T.Literal(2), id, name: label,
  appPaths: T.Optional(T.Record(bundleId, appPath, { additionalProperties: false, maxProperties: 32 })),
  inputs: T.Optional(T.Array(parameterName, { uniqueItems: true, maxItems: 64 })),
  intents: T.Optional(T.Array(intent, { maxItems: 100 })),
  steps: T.Array(step, { minItems: 1, maxItems: 500 }),
});

const resultStatus = T.Union([
  T.Literal('passed'), T.Literal('failed'), T.Literal('blocked'),
  T.Literal('skipped'), T.Literal('resolved'),
]);
const deliveryState = T.Union([
  T.Literal('delivered_verified'), T.Literal('delivered_unverified'),
  T.Literal('delivery_uncertain'), T.Literal('not_delivered'), T.Literal('unknown'),
]);
const phase = T.Union([
  T.Literal('prepare'), T.Literal('observe'), T.Literal('dispatch'),
  T.Literal('verify'), T.Literal('handoff'),
]);
const entryId = T.String({ minLength: 1, maxLength: 196 });
const entryKind = T.Union([
  T.Literal('click'), T.Literal('type'), T.Literal('key'), T.Literal('scroll'),
  T.Literal('drag'), T.Literal('hover'), T.Literal('paste'), T.Literal('wait'),
  T.Literal('assert'), T.Literal('launch_app'), T.Literal('activate_app'),
  T.Literal('focus_window'), T.Literal('open_system_surface'), T.Literal('surface_press'),
  T.Literal('manual_checkpoint'), T.Literal('gap'),
]);
const effectResult = object({
  kind: label,
  status: T.Union([T.Literal('verified'), T.Literal('failed'), T.Literal('unverified')]),
});
// A semantic result records which intent ran, the original range, the adopted
// equivalence and the verified effects. A fallback names the rejected candidate.
const intentResult = object({
  intentId: id,
  sourceStepIds: T.Array(id, { minItems: 1, maxItems: 500 }),
  equivalence: T.Union([T.Literal('same_ui'), T.Literal('same_end_state')]),
  skippedUiStepIds: T.Optional(T.Array(id, { maxItems: 500 })),
  effects: T.Array(effectResult, { maxItems: 10 }),
});
const fallbackResult = object({
  reason: label,
  candidateIntentId: T.Optional(id),
});
// Report entries never carry the typed text or a password. They may carry
// safe metadata that explains whether a text step used a literal or a runtime
// parameter, and how a manual checkpoint was resolved.
const textMode = T.Union([T.Literal('literal'), T.Literal('input')]);
const checkpointResult = object({
  reason: T.Literal('secure_input'),
  triggerStepId: id,
  confirmedBy: T.Optional(T.Literal('operator')),
  timeoutMs: T.Optional(T.Integer({ minimum: 1_000, maximum: maxWaitTimeoutMs })),
});
const entry = object({
  id: entryId, kind: entryKind,
  scope: T.Optional(scopeSchema),
  status: resultStatus,
  atMs: T.Integer({ minimum: 0 }),
  durationMs: T.Integer({ minimum: 0 }),
  message: T.Optional(T.String()),
  code: T.Optional(T.String()),
  phase: T.Optional(phase),
  delivery: T.Optional(deliveryState),
  // The scope a step asked to leave in front, recorded after the step so a
  // later focus loss can be told apart from the step's own hand-off.
  focusAfter: T.Optional(T.Union([windowScope, appScope])),
  textMode: T.Optional(textMode),
  input: T.Optional(parameterName),
  checkpoint: T.Optional(checkpointResult),
  intent: T.Optional(intentResult),
  fallback: T.Optional(fallbackResult),
});
const identityStatus = T.Union([
  T.Literal('verified'), T.Literal('offline_unverified'), T.Literal('blocked'),
]);
const appIdentity = object({
  app: bundleId,
  mode: T.Union([T.Literal('bundle_path'), T.Literal('legacy_bundle_id')]),
  status: identityStatus,
  code: T.Optional(T.String()),
  reason: T.Optional(T.String()),
  entryId: T.Optional(entryId),
});
// A v2 report keeps one identity record per app instead of the single v1
// `appIdentity`, and never repeats input text or absolute app paths.
export const reportV2Schema = object({
  version: T.Literal(2), flowId: id, flowSha256: digest, startedAt: timestamp,
  mode: T.Union([T.Literal('replay'), T.Literal('dry-run')]),
  status: T.Union([T.Literal('passed'), T.Literal('failed'), T.Literal('blocked')]),
  appIdentities: T.Optional(T.Array(appIdentity, { maxItems: 32 })),
  entries: T.Array(entry, { minItems: 1 }),
});

export const schemasV2 = {
  'flow-v2': flowV2Schema,
  'report-v2': reportV2Schema,
};
export const flowV2Check = TypeCompiler.Compile(flowV2Schema);
export const reportV2Check = TypeCompiler.Compile(reportV2Schema);

export type FlowV2 = Static<typeof flowV2Schema>;
export type Scope = Static<typeof scopeSchema>;
export type WindowScope = Static<typeof windowScope>;
export type AppScope = Static<typeof appScope>;
export type SurfaceScope = Static<typeof surfaceScope>;
export type SurfaceKind = Static<typeof surfaceKind>;
export type StepV2 = Static<typeof step>;
export type IntentV2 = Static<typeof intent>;
export type ReportV2 = Static<typeof reportV2Schema>;
export type ReportV2Entry = Static<typeof entry>;
export type WindowWaitCheck = Static<typeof windowWaitCheck>;
export type AppWaitCheck = Static<typeof appWaitCheck>;
export type FileWaitCheck = Static<typeof fileWaitCheck>;
export type FileScope = Static<typeof fileScope>;
export type AssertCheckV2 = Static<typeof assertCheck>;
export type ElementV2 = Static<typeof element>;
export type DeliveryV2 = Static<typeof deliveryState>;
