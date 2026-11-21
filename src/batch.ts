import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { BatchReport, Flow, Report } from './contracts.js';
import type { Desktop } from './desktop.js';
import { writeNew } from './files.js';
import { parseFlow } from './flow.js';
import { Fault } from './locator.js';
import { runFlow } from './run.js';
import { secretName } from './test-item.js';

/** Matches the design's 16 MiB whole-file limit. */
export const dataByteLimit = 16 * 1024 * 1024;
export const cellLimit = 4000;
const columnPattern = /^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.)?[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const tableFields = new Set(['version', 'columns', 'rows']);

export class BatchError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface DataTable {
  version: 1;
  columns: string[];
  rows: Record<string, string>[];
}

export interface BoundRow {
  /** 1-based position in the data table. */
  row: number;
  /** The source test item with only this row's call arguments replaced. */
  flow: Flow;
  /** Original column names mapped to their cells. */
  parameters: Record<string, string>;
}

type Slot = {
  callId: string;
  param: string;
  /** Planned ids of every behavior action that fills this parameter. */
  actionIds: string[];
  /** Raw `args[param]` value in the source test item. */
  value: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeKey(value: string) {
  return columnPattern.test(value) || tableFields.has(value) ? ` ${JSON.stringify(value)}` : '';
}

/**
 * JSON.parse keeps the last value of a repeated key, so duplicates need a
 * separate scan before the document is accepted. Only object keys count:
 * strings inside arrays are values.
 */
export function findDuplicateKey(text: string): string | undefined {
  type Frame = { keys: Set<string> } | null;
  const stack: Frame[] = [];
  let previous = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === '\\') end++;
        else if (text[end] === '"') break;
      }
      if (end >= text.length) return undefined;
      const frame = stack[stack.length - 1];
      if (frame && (previous === '{' || previous === ',')) {
        let key: string;
        try {
          key = JSON.parse(text.slice(index, end + 1)) as string;
        } catch {
          return undefined;
        }
        if (frame.keys.has(key)) return key;
        frame.keys.add(key);
      }
      index = end;
      previous = '"';
      continue;
    }
    if (char === '{') stack.push({ keys: new Set() });
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    if (/\s/.test(char)) continue;
    previous = char;
  }
  return undefined;
}

function invalid(message: string): never {
  throw new BatchError('DATA_INVALID', message);
}

function validateTable(value: unknown): DataTable {
  if (!plainObject(value)) invalid('The data table must be a JSON object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !tableFields.has(key))) {
    invalid('The data table has an unexpected top-level field');
  }
  if (!Object.hasOwn(record, 'version') || !Object.hasOwn(record, 'columns') || !Object.hasOwn(record, 'rows')) {
    invalid('The data table needs version, columns and rows');
  }
  if (record.version !== 1) invalid('The data table version must be 1');

  const columns = record.columns;
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 64) {
    invalid('The data table needs 1–64 columns');
  }
  const seen = new Set<string>();
  columns.forEach((column, index) => {
    if (typeof column !== 'string' || !columnPattern.test(column)) {
      invalid(`Column ${index + 1} is not a valid column name`);
    }
    if (seen.has(column)) invalid(`Column ${index + 1} repeats ${JSON.stringify(column)}`);
    seen.add(column);
  });

  const rows = record.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) {
    invalid('The data table needs 1–1000 rows');
  }
  rows.forEach((row, index) => {
    if (!plainObject(row)) invalid(`Row ${index + 1} must be a JSON object`);
  });

  return { version: 1, columns: columns as string[], rows: rows as Record<string, string>[] };
}

/** Parses and structurally validates one data table. Column binding is separate. */
export function parseData(text: string): DataTable {
  if (text.startsWith('\uFEFF')) invalid('The data table must be UTF-8 without a BOM');
  const duplicate = findDuplicateKey(text);
  if (duplicate !== undefined) {
    throw new BatchError('DATA_DUPLICATE_KEY', `The data table repeats the JSON object key${safeKey(duplicate)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid('The data table is not valid JSON');
  }
  return validateTable(value);
}

/** Reads a data table, rejecting oversized files before they are parsed. */
export async function readData(path: string): Promise<DataTable> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new BatchError('DATA_INVALID', 'The data table could not be read');
  }
  if (!info.isFile()) throw new BatchError('DATA_INVALID', 'The data table is not a regular file');
  if (info.size > dataByteLimit) {
    throw new BatchError('DATA_TOO_LARGE', `The data table exceeds ${dataByteLimit} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new BatchError('DATA_INVALID', 'The data table could not be read');
  }
  if (bytes.length > dataByteLimit) {
    throw new BatchError('DATA_TOO_LARGE', `The data table exceeds ${dataByteLimit} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('The data table must be valid UTF-8');
  }
  return parseData(text);
}

/** Every call argument a behavior fills through `type.text.param`. */
function parameterSlots(flow: Flow): Slot[] {
  const behaviors = new Map((flow.behaviors ?? []).map(behavior => [behavior.id, behavior]));
  const slots = new Map<string, Slot>();
  for (const step of flow.steps) {
    if (step.kind !== 'behavior') continue;
    const behavior = behaviors.get(step.behavior);
    if (!behavior) continue;
    for (const action of behavior.steps) {
      if (action.kind !== 'type' || typeof action.text === 'string') continue;
      const key = `${step.id}\u0000${action.text.param}`;
      const slot = slots.get(key) ??
        { callId: step.id, param: action.text.param, actionIds: [], value: step.args?.[action.text.param] ?? '' };
      slot.actionIds.push(`${step.id}/${action.id}`);
      slots.set(key, slot);
    }
  }
  return [...slots.values()];
}

function secretTargets(flow: Flow) {
  const targets = new Map<string, string>();
  const behaviors = new Map((flow.behaviors ?? []).map(behavior => [behavior.id, behavior]));
  for (const step of flow.steps) {
    if (step.kind !== 'behavior') continue;
    const behavior = behaviors.get(step.behavior);
    if (!behavior) continue;
    for (const action of behavior.steps) {
      if (action.kind !== 'type' || typeof action.text === 'string') continue;
      targets.set(`${step.id}/${action.id}`, `${step.id}/${action.text.param}`);
    }
  }
  return targets;
}

/** Checks each column against the test item's calls and rows' key sets. */
function resolveColumns(flow: Flow, table: DataTable, secrets: ReadonlyMap<string, string>) {
  const slots = parameterSlots(flow);
  const bindings = new Map<string, Slot>();
  const used = new Map<string, string>();
  for (const column of table.columns) {
    const dot = column.indexOf('.');
    const prefix = dot > 0 ? column.slice(0, dot) : undefined;
    const param = dot > 0 ? column.slice(dot + 1) : column;
    const matches = slots.filter(slot => slot.param === param && (prefix === undefined || slot.callId === prefix));
    if (!matches.length) {
      throw new BatchError('DATA_UNKNOWN_COLUMN',
        `Column ${JSON.stringify(column)} does not match a behavior parameter in this test item`);
    }
    if (matches.length > 1) {
      throw new BatchError('DATA_AMBIGUOUS_COLUMN',
        `Column ${JSON.stringify(column)} matches calls ${matches.map(slot => slot.callId).join(', ')}; ` +
        'prefix it with one call step ID');
    }
    const [slot] = matches;
    const key = `${slot.callId}\u0000${slot.param}`;
    const existing = used.get(key);
    if (existing) {
      throw new BatchError('DATA_DUPLICATE_MAPPING',
        `Columns ${JSON.stringify(existing)} and ${JSON.stringify(column)} set the same parameter ` +
        JSON.stringify(`${slot.callId}.${slot.param}`));
    }
    const isSecret = slot.actionIds.some(id => secrets.has(id)) || secretName.test(slot.value);
    if (isSecret) {
      throw new BatchError('DATA_SECRET_COLUMN',
        `Column ${JSON.stringify(column)} targets secret parameter ${JSON.stringify(`${slot.callId}.${slot.param}`)}; ` +
        'secret values come from the environment');
    }
    used.set(key, column);
    bindings.set(column, slot);
  }

  for (const [index, row] of table.rows.entries()) {
    const missing = table.columns.find(column => !Object.hasOwn(row, column));
    if (missing !== undefined) {
      throw new BatchError('DATA_MISSING_COLUMN',
        `Row ${index + 1} is missing column ${JSON.stringify(missing)}`);
    }
    const extra = Object.keys(row).find(key => !table.columns.includes(key));
    if (extra !== undefined) {
      const label = columnPattern.test(extra) ? ` ${JSON.stringify(extra)}` : '';
      throw new BatchError('DATA_EXTRA_COLUMN', `Row ${index + 1} has an extra column${label}`);
    }
    for (const column of table.columns) {
      const cell = row[column];
      if (typeof cell !== 'string' || cell.length === 0) {
        throw new BatchError('DATA_INVALID_VALUE',
          `Row ${index + 1} column ${JSON.stringify(column)} must be a non-empty string`);
      }
      if (cell.length > cellLimit) {
        throw new BatchError('DATA_INVALID_VALUE',
          `Row ${index + 1} column ${JSON.stringify(column)} exceeds ${cellLimit} UTF-16 code units`);
      }
    }
  }
  return bindings;
}

/**
 * Binds every row to its own copy of the source flow. Nothing reaches the
 * desktop driver until the whole table has passed validation.
 */
export function bindRows(flow: Flow, table: DataTable, secrets: ReadonlyMap<string, string> = new Map()): BoundRow[] {
  const bindings = resolveColumns(flow, table, secrets);
  return table.rows.map((cells, index) => {
    const bound = structuredClone(flow) as Flow;
    for (const column of table.columns) {
      const slot = bindings.get(column)!;
      const step = bound.steps.find(candidate => candidate.kind === 'behavior' && candidate.id === slot.callId);
      if (!step || step.kind !== 'behavior' || !step.args) {
        throw new BatchError('DATA_UNKNOWN_COLUMN',
          `Column ${JSON.stringify(column)} does not match a behavior parameter in this test item`);
      }
      step.args[slot.param] = cells[column];
    }
    return {
      row: index + 1,
      flow: parseFlow(bound),
      parameters: Object.fromEntries(table.columns.map(column => [column, cells[column]])),
    };
  });
}

/** Resolves all secret bindings once, before the first row touches the desktop. */
export function resolveBatchSecrets(
  flow: Flow, bindings: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv,
): Map<string, string> {
  const targets = secretTargets(flow);
  const values = new Map<string, string>();
  const missing = new Set<string>();
  const involved = new Set<string>();
  for (const [id, name] of bindings) {
    const target = targets.get(id);
    if (target) involved.add(target);
    const value = env[name];
    if (!value || value.length > cellLimit) {
      missing.add(name);
      continue;
    }
    values.set(id, value);
  }
  if (missing.size) {
    const params = [...involved];
    throw new BatchError('SECRET_UNAVAILABLE',
      `Provide ${[...missing].join(', ')} with 1–4000 characters before replay` +
      (params.length ? ` for ${params.join(', ')}` : ''));
  }
  return values;
}

export interface BatchRunOptions {
  dryRun: boolean;
  signal: AbortSignal;
  baselineDir?: string;
  /** Absolute summary path. Each completed row is published under `<path>.rows/`. */
  reportPath?: string;
  secretTexts?: ReadonlyMap<string, string>;
  /** Batches with secret bindings keep assertion results but drop image evidence. */
  omitEvidence?: boolean;
  /** Rows resolve against a saved snapshot rather than the live desktop. */
  offline?: boolean;
  /** App path stored in the snapshot envelope, for fixture consistency checks. */
  fixtureAppPath?: string;
}

function rowDirectoryName(row: number) {
  return `row-${String(row).padStart(6, '0')}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function errorCode(error: unknown) {
  if (error instanceof BatchError) return error.code;
  if (error instanceof Fault) return error.code;
  return 'BATCH_FAILED';
}

function addCompletedRow(summary: BatchReport, row: BoundRow, report: Report, published?: string) {
  const directory = published ? rowDirectoryName(row.row) : undefined;
  summary.rows.push({
    row: row.row,
    status: report.status,
    parameters: row.parameters,
    issues: report.entries
      .filter(entry => entry.status === 'failed' || entry.status === 'blocked')
      .map(entry => ({ stepId: entry.id, ...(entry.code ? { code: entry.code } : {}) })),
    ...(directory ? {
      report: `${directory}/report.json`,
      flow: `${directory}/flow.json`,
    } : {}),
  });
  summary.counts[report.status]++;
}

/**
 * Replays bound rows serially. Row artifacts are staged and published per row,
 * so an interrupted batch only indexes rows whose files are complete.
 */
export async function runBatch(
  rows: BoundRow[], desktop: Desktop, options: BatchRunOptions,
): Promise<BatchReport> {
  if (!rows.length) throw new BatchError('DATA_INVALID', 'The data table needs 1–1000 rows');
  const summary: BatchReport = {
    format: 'cuekeeper-batch-report',
    version: 1,
    flowId: rows[0].flow.id,
    mode: options.dryRun ? 'dry-run' : 'replay',
    startedAt: new Date().toISOString(),
    status: 'passed',
    counts: { total: rows.length, passed: 0, failed: 0, blocked: 0, notCompleted: rows.length },
    rows: [],
  };
  let rowsDirectory: string | undefined;
  if (options.reportPath) {
    rowsDirectory = `${resolve(options.reportPath)}.rows`;
    try {
      await mkdir(rowsDirectory, { mode: 0o700 });
    } catch (error) {
      throw new BatchError('REPORT_WRITE_FAILED', `Cannot create ${rowsDirectory}: ${errorMessage(error)}`);
    }
  }

  let failure: NonNullable<BatchReport['error']> | undefined;
  try {
    for (const row of rows) {
      options.signal.throwIfAborted();
      const name = rowDirectoryName(row.row);
      const staging = rowsDirectory ? join(rowsDirectory, `.${name}.tmp`) : undefined;
      const published = rowsDirectory ? join(rowsDirectory, name) : undefined;
      let report: Report;
      try {
        report = await runFlow(row.flow, desktop, {
          dryRun: options.dryRun,
          signal: options.signal,
          ...(options.offline ? { offline: true } : {}),
          ...(options.fixtureAppPath ? { fixtureAppPath: options.fixtureAppPath } : {}),
          ...(options.baselineDir ? { baselineDir: options.baselineDir } : {}),
          ...(options.secretTexts ? { secretTexts: options.secretTexts } : {}),
          ...(staging && !options.omitEvidence ? { evidenceDir: staging } : {}),
        });
        if (staging && published) {
          try {
            await mkdir(staging, { recursive: true, mode: 0o700 });
            await writeFile(join(staging, 'flow.json'), JSON.stringify(row.flow, null, 2) + '\n', { mode: 0o600 });
            await writeFile(join(staging, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
            await rename(staging, published);
          } catch (error) {
            throw new BatchError('REPORT_WRITE_FAILED',
              `Row ${row.row} artifacts could not be written: ${errorMessage(error)}`);
          }
        }
      } catch (error) {
        if (staging) await rm(staging, { recursive: true, force: true });
        throw error;
      }
      addCompletedRow(summary, row, report, published);
    }
  } catch (error) {
    const next = summary.rows.length + 1;
    failure = options.signal.aborted
      ? { code: 'INTERRUPTED', message: 'Interrupted', ...(next <= rows.length ? { row: next } : {}) }
      : { code: errorCode(error), message: errorMessage(error), ...(next <= rows.length ? { row: next } : {}) };
    summary.status = options.signal.aborted ? 'interrupted' : 'error';
  }
  summary.counts.notCompleted = summary.counts.total - summary.rows.length;

  if (!failure) {
    if (summary.counts.failed > 0) summary.status = 'failed';
    else if (summary.counts.blocked > 0) summary.status = 'blocked';
  } else {
    summary.error = failure;
  }

  if (options.reportPath) {
    const relative = `${basename(resolve(options.reportPath))}.rows`;
    for (const row of summary.rows) {
      if (row.report) row.report = `${relative}/${row.report}`;
      if (row.flow) row.flow = `${relative}/${row.flow}`;
    }
    try {
      await writeNew(options.reportPath, JSON.stringify(summary, null, 2) + '\n');
    } catch (error) {
      if (summary.status !== 'interrupted') {
        summary.status = 'error';
        summary.error = {
          code: 'REPORT_WRITE_FAILED',
          message: `The batch summary could not be written: ${errorMessage(error)}`,
        };
      }
    }
  }
  return summary;
}

/** Maps a finished batch to the CLI's documented exit codes. */
export function batchExitCode(summary: BatchReport) {
  switch (summary.status) {
    case 'passed': return 0;
    case 'failed':
    case 'blocked': return 1;
    case 'interrupted': return 130;
    default: return 2;
  }
}
