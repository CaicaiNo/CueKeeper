import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Runtime values for `type` steps live next to the flow, never inside it: the
// flow, its hash, its revisions and every report stay free of the text the
// operator typed. One file per flow, `0600`, replaced atomically. A flow without
// the file behaves exactly as before this module existed.

/** Hard limits; a document past any of them is treated as unusable, not trimmed. */
export const inputValuesLimits = {
  maxParameters: 64,
  maxValueLength: 4000,
  maxSteps: 500,
  maxBytes: 256 * 1024,
} as const;

export const inputValueIssues = ['chars_missing', 'backlog_dropped', 'truncated'] as const;
export type InputValueIssue = typeof inputValueIssues[number];

const parameterNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const flowIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface InputValueTarget {
  role: string;
  name?: string;
}

/** One parameter's recorded value plus how completely it was read. */
export interface InputValueEntry {
  /** The recorded text, verbatim (leading and trailing spaces kept). */
  value?: string;
  /** A secure control never stores a value; the entry only says it existed. */
  sensitive?: boolean;
  /** Every character of the burst was seen. */
  complete: boolean;
  issues?: InputValueIssue[];
  /** The `type` steps that used this parameter while recording. */
  steps?: string[];
  /** The controls those steps targeted, for the "target changed" hint. */
  targets?: InputValueTarget[];
}

export interface InputValuesDocument {
  version: 1;
  flowId: string;
  /** Traceability only; it never invalidates the values. */
  recordedFlowSha256?: string;
  updatedAt: string;
  values: Record<string, InputValueEntry>;
}

export interface InputValuesRead {
  path: string;
  doc?: InputValuesDocument;
  /** A human-readable reason the file was ignored; the run continues without it. */
  warning?: string;
  missing?: boolean;
}

export class InputValuesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The sidecar path for a flow: the file name's trailing `.json` becomes
 * `.values.json`. A name without that suffix still gets one, so two flows can
 * never share a sidecar by accident.
 */
export function valuesPath(flowPath: string): string {
  const name = basename(flowPath);
  const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  return join(dirname(flowPath), `${stem}.values.json`);
}

function issueList(value: unknown): InputValueIssue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InputValuesError('INPUT_VALUES_INVALID', 'values[].issues must be an array');
  const issues: InputValueIssue[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(inputValueIssues as readonly string[]).includes(item)) {
      throw new InputValuesError('INPUT_VALUES_INVALID', `unknown input value issue ${String(item)}`);
    }
    if (!issues.includes(item as InputValueIssue)) issues.push(item as InputValueIssue);
  }
  return issues;
}

function stringList(value: unknown, limit: number, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string')) {
    throw new InputValuesError('INPUT_VALUES_INVALID', `${what} must be an array of at most ${limit} strings`);
  }
  return [...value] as string[];
}

function targetList(value: unknown): InputValueTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > inputValuesLimits.maxSteps) {
    throw new InputValuesError('INPUT_VALUES_INVALID', 'values[].targets must be an array');
  }
  return value.map(item => {
    if (!isObject(item) || typeof item.role !== 'string' || !item.role) {
      throw new InputValuesError('INPUT_VALUES_INVALID', 'values[].targets[] needs a role');
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      throw new InputValuesError('INPUT_VALUES_INVALID', 'values[].targets[].name must be a string');
    }
    return { role: item.role, ...(item.name === undefined ? {} : { name: item.name }) };
  });
}

function parseEntry(name: string, raw: unknown): InputValueEntry {
  if (!isObject(raw)) throw new InputValuesError('INPUT_VALUES_INVALID', `value ${name} must be an object`);
  if (raw.sensitive !== undefined && typeof raw.sensitive !== 'boolean') {
    throw new InputValuesError('INPUT_VALUES_INVALID', `value ${name}: sensitive must be a boolean`);
  }
  if (raw.complete !== undefined && typeof raw.complete !== 'boolean') {
    throw new InputValuesError('INPUT_VALUES_INVALID', `value ${name}: complete must be a boolean`);
  }
  const sensitive = raw.sensitive === true;
  // A sensitive entry never carries text; strip one if an older writer left it,
  // so reading a file can never hand a secure value to the page or a run.
  let value: string | undefined;
  if (raw.value !== undefined) {
    if (typeof raw.value !== 'string') {
      throw new InputValuesError('INPUT_VALUES_INVALID', `value ${name} must be a string`);
    }
    if (raw.value.length > inputValuesLimits.maxValueLength) {
      throw new InputValuesError('INPUT_VALUES_TOO_LONG',
        `value ${name} is ${raw.value.length} characters, over the ${inputValuesLimits.maxValueLength} limit`);
    }
    if (!sensitive) value = raw.value;
  }
  const issues = issueList(raw.issues);
  const steps = stringList(raw.steps, inputValuesLimits.maxSteps, `values.${name}.steps`);
  const targets = targetList(raw.targets);
  return {
    ...(value === undefined ? {} : { value }),
    ...(sensitive ? { sensitive: true } : {}),
    // `complete` is stored explicitly: an older writer may not know an issue
    // code, and deriving it from `issues` would silently mark that value whole.
    complete: raw.complete !== false,
    ...(issues?.length ? { issues } : {}),
    ...(steps?.length ? { steps } : {}),
    ...(targets?.length ? { targets } : {}),
  };
}

/** Parse and validate one sidecar document. Throws `InputValuesError`. */
export function parseInputValues(raw: unknown): InputValuesDocument {
  if (!isObject(raw)) throw new InputValuesError('INPUT_VALUES_INVALID', 'the value file must be a JSON object');
  if (raw.version !== 1) {
    throw new InputValuesError('INPUT_VALUES_VERSION',
      `unsupported value file version ${String(raw.version)}; only version 1 is understood`);
  }
  if (typeof raw.flowId !== 'string' || !flowIdPattern.test(raw.flowId)) {
    throw new InputValuesError('INPUT_VALUES_INVALID', 'flowId must name the flow these values belong to');
  }
  if (typeof raw.updatedAt !== 'string' || Number.isNaN(Date.parse(raw.updatedAt))) {
    throw new InputValuesError('INPUT_VALUES_INVALID', 'updatedAt must be an ISO timestamp');
  }
  if (raw.recordedFlowSha256 !== undefined &&
      (typeof raw.recordedFlowSha256 !== 'string' || !sha256Pattern.test(raw.recordedFlowSha256))) {
    throw new InputValuesError('INPUT_VALUES_INVALID', 'recordedFlowSha256 must be a SHA-256 digest');
  }
  if (!isObject(raw.values)) throw new InputValuesError('INPUT_VALUES_INVALID', 'values must be an object');
  const names = Object.keys(raw.values);
  if (names.length > inputValuesLimits.maxParameters) {
    throw new InputValuesError('INPUT_VALUES_TOO_MANY',
      `${names.length} parameters is over the ${inputValuesLimits.maxParameters} limit`);
  }
  const values: Record<string, InputValueEntry> = {};
  for (const name of names) {
    if (!parameterNamePattern.test(name)) {
      throw new InputValuesError('INPUT_VALUES_INVALID', `${name} is not a parameter name`);
    }
    values[name] = parseEntry(name, raw.values[name]);
  }
  return {
    version: 1,
    flowId: raw.flowId,
    ...(raw.recordedFlowSha256 === undefined ? {} : { recordedFlowSha256: raw.recordedFlowSha256 }),
    updatedAt: raw.updatedAt,
    values,
  };
}

/** Read one file. A missing file is not an error; a broken one is a warning. */
export async function readValuesFile(path: string): Promise<InputValuesRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { path, missing: true };
    // Only the path and a fixed reason: a read error can never be allowed to
    // carry file content into stderr, a log or the page.
    return { path, warning: `无法读取已存参数值文件 ${path}（${code ?? 'READ_FAILED'}），已忽略` };
  }
  if (bytes.byteLength > inputValuesLimits.maxBytes) {
    return { path, warning: `已存参数值文件 ${path} 超过 ${inputValuesLimits.maxBytes} 字节，已忽略` };
  }
  try {
    return { path, doc: parseInputValues(JSON.parse(bytes.toString('utf8'))) };
  } catch (error) {
    // A JSON parser message quotes the offending text and a schema message can
    // name a raw field; neither may travel with the warning. Keep the stable
    // code only, so the operator still knows file and cause without seeing a
    // byte of the value.
    const code = error instanceof InputValuesError ? error.code : 'INPUT_VALUES_UNREADABLE';
    return { path, warning: `已存参数值文件 ${path} 无效（${code}），已忽略` };
  }
}

/**
 * Find the values for one flow. The same-name sidecar wins; a revision or a
 * renamed copy falls back to the newest file in the same directory whose flowId
 * matches. A file for another flow is ignored, never applied.
 */
export async function resolveValues(flowPath: string, flowId: string): Promise<InputValuesRead> {
  const exact = valuesPath(flowPath);
  const same = await readValuesFile(exact);
  if (same.doc?.flowId === flowId) return same;
  // A broken same-name file is reported instead of silently scanning past it:
  // the operator has to know why the prefill disappeared.
  if (same.warning) return same;
  let candidates: string[] = [];
  try {
    candidates = (await readdir(dirname(flowPath)))
      .filter(name => name.endsWith('.values.json'))
      .map(name => join(dirname(flowPath), name))
      .filter(path => path !== exact);
  } catch {
    return { path: exact, missing: true };
  }
  let best: InputValuesRead | undefined;
  let warning: string | undefined;
  for (const path of candidates) {
    const candidate = await readValuesFile(path);
    if (candidate.warning) {
      warning ??= candidate.warning;
      continue;
    }
    if (candidate.doc?.flowId !== flowId) continue;
    if (!best?.doc || Date.parse(candidate.doc.updatedAt) > Date.parse(best.doc.updatedAt)) best = candidate;
  }
  if (best) return best;
  return { path: exact, missing: true, ...(warning ? { warning } : {}) };
}

/** Write atomically with `0600`, so no half-written file ever becomes readable. */
export async function writeValues(path: string, doc: InputValuesDocument): Promise<void> {
  // Re-validate on the way out: the writer and the reader share one contract,
  // and a value past the limit must fail before it reaches the disk.
  const normalized = parseInputValues(doc);
  const text = `${JSON.stringify(normalized, null, 2)}\n`;
  // The reader rejects a file over the byte limit, so a write that would create
  // one must fail here instead of producing a file the next run cannot read.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > inputValuesLimits.maxBytes) {
    throw new InputValuesError('INPUT_VALUES_TOO_LARGE',
      `the value file would be ${bytes} bytes, over the ${inputValuesLimits.maxBytes} byte limit`);
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Merge one patch into a document. `null` deletes an entry. A sensitive entry
 * keeps its flag and never stores text, and a value the operator typed in the
 * dialog counts as complete: they saw and confirmed it.
 */
export function mergeValues(
  existing: InputValuesDocument | undefined,
  flowId: string,
  patch: Readonly<Record<string, string | null>>,
  options: {
    recordedFlowSha256?: string;
    now?: Date;
    /** Parameter names the flow declares now; entries outside them are orphans. */
    declaredNames?: readonly string[];
  } = {},
): InputValuesDocument {
  const values: Record<string, InputValueEntry> = existing?.flowId === flowId
    ? Object.fromEntries(Object.entries(existing.values).map(([name, entry]) => [name, { ...entry }]))
    : {};
  // A rename or a deleted step leaves an old name behind. It is dropped on the
  // next explicit write instead of surviving as a value nothing can use.
  if (options.declaredNames) {
    const declared = new Set(options.declaredNames);
    for (const name of Object.keys(values)) if (!declared.has(name)) delete values[name];
  }
  for (const [name, value] of Object.entries(patch)) {
    if (!parameterNamePattern.test(name)) {
      throw new InputValuesError('INPUT_VALUES_INVALID', `${name} is not a parameter name`);
    }
    if (value === null) {
      // Clearing a sensitive entry removes its text but must keep its mark:
      // otherwise the next save would write the operator's typing to disk for
      // a parameter the recording deliberately treated as sensitive.
      if (values[name]?.sensitive) values[name] = { sensitive: true, complete: true };
      else delete values[name];
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputValuesError('INPUT_VALUES_INVALID', `a value for ${name} must be nonempty text`);
    }
    if (value.length > inputValuesLimits.maxValueLength) {
      throw new InputValuesError('INPUT_VALUES_TOO_LONG',
        `value ${name} is ${value.length} characters, over the ${inputValuesLimits.maxValueLength} limit`);
    }
    const previous = values[name];
    if (previous?.sensitive) {
      values[name] = { ...previous, complete: true };
      continue;
    }
    values[name] = {
      value,
      complete: true,
      ...(previous?.steps?.length ? { steps: previous.steps } : {}),
      ...(previous?.targets?.length ? { targets: previous.targets } : {}),
    };
  }
  if (Object.keys(values).length > inputValuesLimits.maxParameters) {
    throw new InputValuesError('INPUT_VALUES_TOO_MANY',
      `${Object.keys(values).length} parameters is over the ${inputValuesLimits.maxParameters} limit`);
  }
  // The recorded hash is provenance, not identity: whoever writes keeps the
  // one the recording stamped unless it explicitly replaces it.
  const sha = options.recordedFlowSha256 ??
    (existing?.flowId === flowId ? existing.recordedFlowSha256 : undefined);
  return {
    version: 1,
    flowId,
    ...(sha && sha256Pattern.test(sha) ? { recordedFlowSha256: sha } : {}),
    updatedAt: (options.now ?? new Date()).toISOString(),
    values,
  };
}

/**
 * The values a replay may use: declared parameters only, never a sensitive
 * entry, never one without text. Orphans in the file are ignored rather than
 * reported, because a rename or a deleted step is a normal edit.
 */
export function usableValues(
  doc: InputValuesDocument | undefined,
  declaredNames: readonly string[],
): Record<string, string> {
  const usable: Record<string, string> = {};
  if (!doc) return usable;
  for (const name of declaredNames) {
    const entry = doc.values[name];
    if (!entry || entry.sensitive || typeof entry.value !== 'string' || entry.value.length === 0) continue;
    usable[name] = entry.value;
  }
  return usable;
}
