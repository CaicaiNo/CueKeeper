import { Fault, object } from './locator.js';

// The global capture helper (`native/recorder.swift --global`) names the app
// and native window for every event, together with the evidence it used. The
// TypeScript side never trusts that decision blindly: it re-checks the evidence
// and may downgrade an event to a capture gap. Nothing in this protocol carries
// a screen element tree or window title into a flow by itself.

export const captureGapCodes = [
  'CAPTURE_SCOPE_UNVERIFIED',
  'STALE_CAPTURE',
  'CROSS_SCOPE_GESTURE',
  'PRIVACY_REDACTED',
  'SECURE_INPUT',
  'IME_COMMIT_UNVERIFIED',
  'CAPTURE_GAP',
] as const;
export type CaptureGapCode = typeof captureGapCodes[number];

const gapCodeSet = new Set<string>(captureGapCodes);

/**
 * Why the helper treated an event as secure. The system flag means macOS
 * disabled event delivery to other processes; the control flag means the AX
 * element itself is a protected input. Either one ends automatic capture.
 */
export const secureEvidenceKinds = ['system_secure_input', 'secure_control'] as const;
export type SecureEvidence = typeof secureEvidenceKinds[number];
const secureEvidenceSet = new Set<string>(secureEvidenceKinds);

/** A point in Quartz screen coordinates: top-left origin, whole pixels. */
export type CapturePoint = [number, number];

/** A rectangle in Quartz screen coordinates: x, y, width, height. */
export type CaptureBounds = [number, number, number, number];

/**
 * What the helper read from the accessibility focused element at event time.
 * These are single-attribute reads, never a tree walk: they exist so a text or
 * key event does not need a window snapshot to name its target. The helper never
 * reads a control's value, and a secure control contributes no label.
 */
export interface CaptureFocus {
  /** AX role, spelled the AX way (`AXTextField`). */
  role?: string;
  /** AX title or description of the focused element. */
  name?: string;
  /** Screen frame of the focused element. */
  bounds?: CaptureBounds;
  /** The focused element accepts typed text. */
  editable?: boolean;
  /** The focused element is a protected input; its label is withheld. */
  secure?: boolean;
}

export const captureModifiers = ['meta', 'ctrl', 'alt', 'shift'] as const;
export type CaptureModifier = typeof captureModifiers[number];
const modifierSet = new Set<string>(captureModifiers);

/**
 * What the helper proved about the owner of one event. Every field is optional
 * because the helper reports what it could observe: a missing window number is
 * evidence loss, not a reason to guess.
 */
export interface CaptureOwner {
  /** Resolved bundle ID of the owning process. */
  app?: string;
  pid?: number;
  /** Process launch time in ms; distinguishes a new process that reused a PID. */
  processInstance?: number;
  /** Native macOS window number (CGWindowID). */
  windowNumber?: number;
  windowTitle?: string;
  /** AX role of the element under a pointer event. */
  role?: string;
  /** AX title/description of that element, for diagnosis only. */
  name?: string;
  /** Whether the AX element advertises a press action. */
  pressable?: boolean;
  /** The owner is the system authorization UI, not the app that opened it. */
  securityAgent?: boolean;
}

interface CaptureEventBase {
  /** Milliseconds since capture start. */
  t: number;
  /** Wall-clock milliseconds when the helper emitted the event. */
  seen: number;
  /** Monotonic focus counter; advances when the front app or window changes. */
  focusGeneration: number;
  /** System secure input was active, or the focused control is protected. */
  secure: boolean;
  /** Why the event was secure; absent when `secure` is false. */
  secureEvidence?: SecureEvidence[];
  owner?: CaptureOwner;
  /** The accessibility focused element at event time, when the helper could read it. */
  focus?: CaptureFocus;
  decision?: 'record' | 'navigate' | 'gap';
  gapCode?: CaptureGapCode;
}

export type CaptureEvent =
  | (CaptureEventBase & {
    kind: 'click'; point: CapturePoint; count?: number; button?: 'left' | 'right';
  })
  | (CaptureEventBase & {
    kind: 'scroll'; point: CapturePoint; deltaX: number; deltaY: number;
  })
  | (CaptureEventBase & { kind: 'hover'; point: CapturePoint; dwellMs: number })
  | (CaptureEventBase & {
    kind: 'drag'; from: CapturePoint; to: CapturePoint; path: CapturePoint[];
    durationMs: number; button: 'left' | 'right'; modifiers: CaptureModifier[];
    fromWindowNumber?: number; toWindowNumber?: number;
  })
  | (CaptureEventBase & { kind: 'text'; chars?: string; ime?: boolean })
  | (CaptureEventBase & { kind: 'key'; key: string; modifiers: CaptureModifier[] })
  | (CaptureEventBase & { kind: 'focus' })
  | (CaptureEventBase & { kind: 'system_dialog'; visible: boolean })
  /**
   * `detail` is the helper's own bounded reason for a gap (`tap_interrupted`,
   * `event_lag`, ...). It is optional so helpers that predate it still parse,
   * and it never changes what a gap blocks.
   */
  | (CaptureEventBase & { kind: 'gap'; gapCode: CaptureGapCode; detail?: string });

export type CaptureEventKind = CaptureEvent['kind'];

const kinds = new Set<CaptureEventKind>([
  'click', 'scroll', 'hover', 'drag', 'text', 'key', 'focus', 'system_dialog', 'gap',
]);

function fail(what: string): never {
  throw new Fault('CAPTURE_PROTOCOL', `Invalid global capture event: ${what}`);
}

function integer(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${what} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalInteger(value: unknown, what: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, what, min, max);
}

function point(value: unknown, what: string): CapturePoint {
  if (!Array.isArray(value) || value.length !== 2) fail(`${what} must be a two-number point`);
  return [
    integer(value[0], `${what} x`, -100_000, 100_000),
    integer(value[1], `${what} y`, -100_000, 100_000),
  ];
}

function modifiers(value: unknown): CaptureModifier[] {
  if (!Array.isArray(value) || value.length > 4 ||
      !value.every(entry => typeof entry === 'string' && modifierSet.has(entry))) {
    fail('modifiers must be a short list of meta, ctrl, alt or shift');
  }
  return value as CaptureModifier[];
}

function owner(value: unknown): CaptureOwner | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  const parsed: CaptureOwner = {};
  if (input.app !== undefined) {
    if (typeof input.app !== 'string' || input.app.length > 256) fail('owner.app must be a short string');
    parsed.app = input.app;
  }
  if (input.pid !== undefined) parsed.pid = integer(input.pid, 'owner.pid', 1, 2 ** 31 - 1);
  if (input.processInstance !== undefined) {
    parsed.processInstance = integer(input.processInstance, 'owner.processInstance', 0, Number.MAX_SAFE_INTEGER);
  }
  if (input.windowNumber !== undefined) {
    parsed.windowNumber = integer(input.windowNumber, 'owner.windowNumber', 1, 2 ** 31 - 1);
  }
  if (input.windowTitle !== undefined) {
    if (typeof input.windowTitle !== 'string' || input.windowTitle.length > 2048) {
      fail('owner.windowTitle must be a short string');
    }
    parsed.windowTitle = input.windowTitle;
  }
  if (input.role !== undefined) {
    if (typeof input.role !== 'string' || input.role.length > 128) fail('owner.role must be a short string');
    parsed.role = input.role;
  }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > 512) fail('owner.name must be a short string');
    parsed.name = input.name;
  }
  if (input.pressable !== undefined) {
    if (typeof input.pressable !== 'boolean') fail('owner.pressable must be a boolean');
    parsed.pressable = input.pressable;
  }
  if (input.securityAgent !== undefined) {
    if (typeof input.securityAgent !== 'boolean') fail('owner.securityAgent must be a boolean');
    parsed.securityAgent = input.securityAgent;
  }
  return parsed;
}

function secureEvidence(value: unknown): SecureEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2 ||
      !value.every(entry => typeof entry === 'string' && secureEvidenceSet.has(entry))) {
    fail('secureEvidence must list system_secure_input and/or secure_control');
  }
  return [...new Set(value)] as SecureEvidence[];
}

function bounds(value: unknown): CaptureBounds {
  if (!Array.isArray(value) || value.length !== 4) fail('focus.bounds must be x, y, width, height');
  const [x, y, width, height] = value;
  return [
    integer(x, 'focus.bounds x', -100_000, 100_000),
    integer(y, 'focus.bounds y', -100_000, 100_000),
    integer(width, 'focus.bounds width', 1, 100_000),
    integer(height, 'focus.bounds height', 1, 100_000),
  ];
}

function focusEvidence(value: unknown): CaptureFocus {
  const input = object(value);
  const parsed: CaptureFocus = {};
  if (input.role !== undefined) {
    if (typeof input.role !== 'string' || !input.role) fail('focus.role must be a short string');
    parsed.role = input.role.length > 128 ? input.role.slice(0, 128) : input.role;
  }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length > 512) fail('focus.name must be a short string');
    const name = input.name.trim();
    if (name) parsed.name = name.length > 256 ? name.slice(0, 256) : name;
  }
  if (input.bounds !== undefined) parsed.bounds = bounds(input.bounds);
  if (input.editable !== undefined) {
    if (typeof input.editable !== 'boolean') fail('focus.editable must be a boolean');
    parsed.editable = input.editable;
  }
  if (input.secure !== undefined) {
    if (typeof input.secure !== 'boolean') fail('focus.secure must be a boolean');
    parsed.secure = input.secure;
  }
  return parsed;
}

/**
 * Validates one helper line. Text content is accepted but never stored by the
 * engine; it exists only so the helper can describe a printable event.
 */
export function parseCaptureEvent(value: unknown): CaptureEvent {
  const input = object(value);
  const kind = input.kind;
  if (typeof kind !== 'string' || !kinds.has(kind as CaptureEventKind)) fail('unknown kind');
  const t = integer(input.t, 't', 0, Number.MAX_SAFE_INTEGER);
  const seen = integer(input.seen, 'seen', 0, Number.MAX_SAFE_INTEGER);
  const focusGeneration = integer(input.focusGeneration, 'focusGeneration', 0, Number.MAX_SAFE_INTEGER);
  if (typeof input.secure !== 'boolean') fail('secure must be a boolean');
  const evidence = secureEvidence(input.secureEvidence);
  if (input.secure === false && evidence?.length) fail('secureEvidence requires secure: true');
  const base = {
    t, seen, focusGeneration, secure: input.secure,
    ...(evidence === undefined ? {} : { secureEvidence: evidence }),
    ...(input.owner === undefined ? {} : { owner: owner(input.owner) }),
    ...(input.focus === undefined ? {} : { focus: focusEvidence(input.focus) }),
    ...(input.decision === undefined ? {} : { decision: decision(input.decision) }),
    ...(input.gapCode === undefined ? {} : { gapCode: gapCode(input.gapCode) }),
  };
  switch (kind as CaptureEventKind) {
    case 'system_dialog':
      if (typeof input.visible !== 'boolean') fail('system_dialog.visible must be a boolean');
      return { t, seen, focusGeneration, secure: input.secure, kind: 'system_dialog', visible: input.visible };
    case 'click': {
      const count = optionalInteger(input.count, 'count', 1, 3);
      const button = input.button;
      if (button !== undefined && button !== 'left' && button !== 'right') fail('unknown click button');
      return {
        ...base, kind: 'click', point: point(input.point, 'point'),
        ...(count === undefined ? {} : { count }),
        ...(button === undefined ? {} : { button }),
      };
    }
    case 'scroll': {
      const deltaX = integer(input.deltaX, 'deltaX', -1000, 1000);
      const deltaY = integer(input.deltaY, 'deltaY', -1000, 1000);
      if (!deltaX && !deltaY) fail('scroll deltas must not both be zero');
      return { ...base, kind: 'scroll', point: point(input.point, 'point'), deltaX, deltaY };
    }
    case 'hover': {
      return {
        ...base, kind: 'hover', point: point(input.point, 'point'),
        dwellMs: integer(input.dwellMs, 'dwellMs', 0, 60_000),
      };
    }
    case 'drag': {
      if (!Array.isArray(input.path) || input.path.length > 64) fail('path must be a bounded point list');
      const button = input.button ?? 'left';
      if (button !== 'left' && button !== 'right') fail('unknown drag button');
      const fromWindowNumber = optionalInteger(input.fromWindowNumber, 'fromWindowNumber', 1, 2 ** 31 - 1);
      const toWindowNumber = optionalInteger(input.toWindowNumber, 'toWindowNumber', 1, 2 ** 31 - 1);
      return {
        ...base, kind: 'drag', from: point(input.from, 'from'), to: point(input.to, 'to'),
        path: input.path.map((entry, index) => point(entry, `path[${index}]`)),
        durationMs: integer(input.durationMs, 'durationMs', 0, 60_000),
        button, modifiers: modifiers(input.modifiers ?? []),
        ...(fromWindowNumber === undefined ? {} : { fromWindowNumber }),
        ...(toWindowNumber === undefined ? {} : { toWindowNumber }),
      };
    }
    case 'text': {
      let chars: string | undefined;
      if (input.chars !== undefined) {
        if (typeof input.chars !== 'string' || input.chars.length < 1 || input.chars.length > 16 ||
            /[\u0000-\u001f\u007f]/.test(input.chars)) {
          fail('chars must be a short printable string');
        }
        chars = input.chars;
      }
      if (input.ime !== undefined && typeof input.ime !== 'boolean') fail('ime must be a boolean');
      return {
        ...base, kind: 'text',
        ...(chars === undefined ? {} : { chars }),
        ...(input.ime === true ? { ime: true } : {}),
      };
    }
    case 'key': {
      if (typeof input.key !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(input.key)) fail('unknown key name');
      return { ...base, kind: 'key', key: input.key, modifiers: modifiers(input.modifiers ?? []) };
    }
    case 'focus':
      return { ...base, kind: 'focus' };
    case 'gap': {
      const code = gapCode(input.gapCode);
      const detail = gapDetail(input.detail);
      return { ...base, kind: 'gap', gapCode: code, ...(detail === undefined ? {} : { detail }) };
    }
  }
}

function gapCode(value: unknown): CaptureGapCode {
  if (typeof value !== 'string' || !gapCodeSet.has(value)) fail('unknown gap code');
  return value as CaptureGapCode;
}

/**
 * The helper's reason for a gap. It is diagnostic only: a short identifier is
 * accepted so a newer helper can explain itself without breaking this parser,
 * and no reason ever changes how many gaps a flow has.
 */
function gapDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(value)) fail('gap detail must be a short reason');
  return value;
}

function decision(value: unknown): 'record' | 'navigate' | 'gap' {
  if (value !== 'record' && value !== 'navigate' && value !== 'gap') fail('unknown decision');
  return value;
}
