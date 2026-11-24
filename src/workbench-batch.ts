import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowV2 } from './contracts-v2.js';
import { isFlowV2 } from './flow-v2.js';
import { flowV2Check } from './contracts-v2.js';
import { object } from './locator.js';
import { parseTestItem } from './test-item.js';
import { workdirEnv } from './workdir.js';

/**
 * One queue row: a saved test item on disk. The workbench batch view queues
 * saved artifacts only — a draft that was never saved has no path to replay.
 */
export interface BatchCandidate {
  path: string;
  file: string;
  name: string;
  app: string;
  window: string;
  version: number;
  steps: number;
  /** A manual checkpoint has no operator in an unattended batch. */
  checkpoint: boolean;
  modifiedAt: number;
}

export type BatchRunStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';

export interface BatchRunSummary {
  round: number;
  status: BatchRunStatus;
  durationMs: number;
  at: number;
  stepId?: string;
  code?: string;
  message?: string;
}

export interface BatchRunDetail extends BatchRunSummary {
  entries: { id: string; kind?: string; status: string; code?: string }[];
  /** The per-run report the CLI wrote, so the page can read its full JSON. */
  reportPath: string;
}

export interface BatchItemState extends BatchCandidate {
  selected: boolean;
  runs: BatchRunSummary[];
  last?: BatchRunDetail;
}

export interface BatchLogEntry {
  at: number;
  name: string;
  round: number;
  status: BatchRunStatus;
  durationMs: number;
  detail?: string;
}

export interface BatchConfig {
  rounds: number;
  intervalMs: number;
  continueOnFailure: boolean;
  stopAt?: number;
}

export interface BatchSnapshot {
  running: boolean;
  allowLive: boolean;
  startedAt?: number;
  finishedAt?: number;
  config?: BatchConfig;
  items: BatchItemState[];
  log: BatchLogEntry[];
  counts: { total: number; passed: number; failed: number; blocked: number; error: number; pending: number };
  summaryPath?: string;
  stopReason?: 'operator' | 'time' | 'complete' | 'failure';
  error?: string;
}

export class BatchError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Saved artifacts the batch view can queue, newest first. */
export async function listBatchCandidates(directory: string): Promise<BatchCandidate[]> {
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() &&
        (/^test-.+\.(test|flow)\.json$/i.test(entry.name) || /^flow\.edited-.+\.json$/i.test(entry.name)))
      .map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = await Promise.all(names.map(async name => {
    const path = join(directory, name);
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
    try {
      return candidateOf(path, name, document, (await stat(path)).mtimeMs);
    } catch {
      return undefined;
    }
  }));
  return parsed
    .filter((item): item is BatchCandidate => item !== undefined)
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.file.localeCompare(b.file));
}

function candidateOf(path: string, file: string, document: unknown, modifiedAt: number): BatchCandidate | undefined {
  if (isFlowV2(document)) {
    if (!flowV2Check.Check(document)) return undefined;
    const flow = document as FlowV2;
    const scopes = flow.steps.flatMap(step => 'scope' in step ? [step.scope] : []);
    const apps = [...new Set(scopes.flatMap(scope => 'app' in scope && scope.app ? [scope.app] : []))];
    const windows = [...new Set(scopes.flatMap(scope =>
      scope.kind === 'window' ? [scope.windowTitle] : []))];
    return {
      path, file, modifiedAt,
      name: flow.name,
      app: apps.join(' / '),
      window: windows.join(' / '),
      version: 2,
      steps: flow.steps.length,
      checkpoint: flow.steps.some(step => step.kind === 'manual_checkpoint'),
    };
  }
  const { flow } = parseTestItem(document);
  return {
    path, file, modifiedAt,
    name: flow.name,
    app: flow.target.app,
    window: flow.target.window,
    version: flow.version,
    steps: flow.steps.length,
    // Version 1 has no manual checkpoint action; only v2 steps wait for a person.
    checkpoint: false,
  };
}

function parseReport(stdout: string, reportPath: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (line) {
    try {
      const envelope = object(JSON.parse(line));
      if (envelope.data !== undefined) return object(envelope.data);
    } catch {
      // Fall through to the report file the CLI was asked to write.
    }
  }
  return undefined;
}

function resultOf(report: Record<string, unknown>): BatchRunDetail['entries'] {
  const entries = Array.isArray(report.entries) ? report.entries : [];
  return entries.flatMap(raw => {
    try {
      const entry = object(raw);
      if (typeof entry.id !== 'string') return [];
      return [{
        id: entry.id,
        status: typeof entry.status === 'string' ? entry.status : 'unknown',
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
        ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
      }];
    } catch {
      return [];
    }
  });
}

function statusOf(report: Record<string, unknown>): BatchRunStatus {
  const status = report.status;
  return status === 'passed' || status === 'failed' || status === 'blocked' ||
    status === 'error' || status === 'interrupted' ? status : 'error';
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Serial queue over saved test items. It never runs more than one replay at a
 * time: every replay owns the foreground desktop, so overlapping rows would
 * steal focus from each other and make both results meaningless.
 */
export class BatchRunner {
  private state: BatchSnapshot;
  private child: ChildProcess | undefined;
  private stopRequested = false;
  private wake: (() => void) | undefined;
  private work: { begin: () => void; end: () => void };

  constructor(private options: {
    directory: () => string;
    cliPath: string;
    workRoot: string;
    allowLive: () => boolean;
    allowShell: () => boolean;
    allowSudo: () => boolean;
    begin: () => void;
    end: () => void;
  }) {
    this.work = { begin: options.begin, end: options.end };
    this.state = {
      running: false, allowLive: options.allowLive(), items: [], log: [],
      counts: { total: 0, passed: 0, failed: 0, blocked: 0, error: 0, pending: 0 },
    };
  }

  get running() {
    return this.state.running;
  }

  /** A batch belongs to the session directory it started in; a new import clears it. */
  reset() {
    if (this.state.running) return;
    this.state = {
      running: false, allowLive: this.options.allowLive(), items: [], log: [],
      counts: { total: 0, passed: 0, failed: 0, blocked: 0, error: 0, pending: 0 },
    };
  }

  async snapshot(): Promise<BatchSnapshot> {
    const directory = this.options.directory();
    const candidates = await listBatchCandidates(directory);
    // Keep the existing row objects: a run in flight holds the same reference
    // while it records its result, so rebuilding the array would drop it.
    const previous = new Map(this.state.items.map(item => [item.path, item]));
    this.state.items = candidates.map(candidate => {
      const saved = previous.get(candidate.path);
      if (saved) {
        saved.file = candidate.file;
        saved.name = candidate.name;
        saved.app = candidate.app;
        saved.window = candidate.window;
        saved.steps = candidate.steps;
        saved.checkpoint = candidate.checkpoint;
        saved.modifiedAt = candidate.modifiedAt;
        return saved;
      }
      return { ...candidate, selected: true, runs: [] };
    });
    this.state.allowLive = this.options.allowLive();
    this.state.counts = countsOf(this.state.items);
    return this.state;
  }

  async start(input: Record<string, unknown>): Promise<BatchSnapshot> {
    if (this.state.running) throw new BatchError('BATCH_RUNNING', 'A batch is already running');
    if (!this.options.allowLive()) {
      throw new BatchError('LIVE_DISABLED', 'Live replay needs --allow-live-replay when the workbench starts');
    }
    const directory = this.options.directory();
    const candidates = await listBatchCandidates(directory);
    if (!candidates.length) throw new BatchError('NO_ITEMS', 'Save a test item before starting a batch');
    const requested = Array.isArray(input.items) ? input.items : [];
    if (!requested.length) throw new BatchError('NO_SELECTION', 'Select at least one workflow');
    const byPath = new Map(candidates.map(candidate => [candidate.path, candidate]));
    const selected = requested.map(raw => {
      if (typeof raw !== 'string' || !byPath.has(raw)) {
        throw new BatchError('UNKNOWN_ITEM', 'The queue changed; reload the batch view');
      }
      return byPath.get(raw)!;
    });
    const blocked = selected.filter(item => item.checkpoint);
    if (blocked.length) {
      throw new BatchError('CHECKPOINT_ITEM',
        `${blocked.map(item => item.name).join('、')} 含需要人工确认的步骤，不能放进无人值守批次`);
    }
    const rounds = input.rounds;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 500) {
      throw new BatchError('BAD_ROUNDS', 'Rounds must be a whole number between 1 and 500');
    }
    const intervalMs = input.intervalMs === undefined ? 0 : input.intervalMs;
    if (typeof intervalMs !== 'number' || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 3_600_000) {
      throw new BatchError('BAD_INTERVAL', 'The interval must be 0 to 3600000 ms');
    }
    if (input.stopAt !== undefined && (typeof input.stopAt !== 'number' || !Number.isFinite(input.stopAt))) {
      throw new BatchError('BAD_STOP_AT', 'Stop time must be a timestamp');
    }
    const stopAt = input.stopAt as number | undefined;
    if (stopAt !== undefined && stopAt <= Date.now()) {
      throw new BatchError('BAD_STOP_AT', 'The stop time has already passed');
    }
    const batchDirectory = join(directory, `batch-${stamp()}-${randomUUID().slice(0, 8)}`);
    this.state = {
      running: true,
      allowLive: true,
      startedAt: Date.now(),
      config: { rounds, intervalMs, continueOnFailure: input.continueOnFailure !== false, ...(stopAt ? { stopAt } : {}) },
      items: candidates.map(candidate => ({
        ...candidate,
        selected: selected.some(item => item.path === candidate.path),
        runs: [],
      })),
      log: [],
      counts: countsOf(candidates.map(candidate => ({
        ...candidate, selected: selected.some(item => item.path === candidate.path), runs: [],
      }))),
      summaryPath: join(batchDirectory, 'batch.json'),
    };
    this.stopRequested = false;
    this.work.begin();
    void this.run(selected, batchDirectory, { rounds, intervalMs, continueOnFailure: input.continueOnFailure !== false, stopAt });
    return this.state;
  }

  stop() {
    if (!this.state.running) return false;
    this.stopRequested = true;
    this.child?.kill('SIGINT');
    this.wake?.();
    return true;
  }

  private async run(selected: BatchCandidate[], batchDirectory: string, config: BatchConfig) {
    try {
      await mkdir(batchDirectory, { recursive: true });
    } catch (error) {
      this.state.error = `无法创建批次目录：${error instanceof Error ? error.message : 'unknown error'}`;
      this.finish('operator');
      return;
    }
    for (let round = 1; round <= config.rounds; round += 1) {
      for (const [index, item] of selected.entries()) {
        if (this.stopRequested) return this.finish('operator');
        if (config.stopAt !== undefined && Date.now() >= config.stopAt) return this.finish('time');
        const detail = await this.runOne(item, round, index, batchDirectory);
        if (!config.continueOnFailure && detail.status !== 'passed') return this.finish('failure');
        if (config.stopAt !== undefined && Date.now() >= config.stopAt) return this.finish('time');
        if (this.stopRequested) return this.finish('operator');
        if (config.intervalMs > 0 && !(round === config.rounds && index === selected.length - 1)) {
          await this.sleep(config.intervalMs);
        }
      }
    }
    return this.finish('complete');
  }

  private async runOne(item: BatchCandidate, round: number, index: number, batchDirectory: string): Promise<BatchRunDetail> {
    const row = this.state.items.find(entry => entry.path === item.path);
    const runDirectory = join(batchDirectory, `round-${pad(round)}-${pad(index + 1)}`);
    const reportPath = join(runDirectory, 'report.json');
    const startedAt = Date.now();
    const args = ['run', item.path, '--headed', '--json', '--report', reportPath];
    if (item.version === 2) args.push('--foreground');
    if (this.options.allowShell()) args.push('--allow-shell');
    if (this.options.allowSudo()) args.push('--allow-sudo');
    let detail: BatchRunDetail;
    try {
      await mkdir(runDirectory, { recursive: true });
      const result = await this.spawnCli(args);
      const report = parseReport(result.stdout, reportPath) ??
        await readReport(reportPath);
      detail = {
        round,
        at: startedAt,
        durationMs: Date.now() - startedAt,
        status: report ? statusOf(report) : (result.code === 0 ? 'passed' : 'error'),
        entries: report ? resultOf(report) : [],
        reportPath,
        ...failureOf(report, result),
      };
    } catch (error) {
      detail = {
        round,
        at: startedAt,
        durationMs: Date.now() - startedAt,
        status: this.stopRequested ? 'interrupted' : 'error',
        entries: [],
        reportPath,
        code: 'RUN_FAILED',
        message: error instanceof Error ? error.message : 'The replay process could not start',
      };
    }
    if (this.stopRequested && detail.status !== 'interrupted') detail.status = 'interrupted';
    this.record(item, row, detail);
    return detail;
  }

  private record(item: BatchCandidate, row: BatchItemState | undefined, detail: BatchRunDetail) {
    const summary: BatchRunSummary = {
      round: detail.round, status: detail.status, durationMs: detail.durationMs, at: detail.at,
      ...(detail.stepId ? { stepId: detail.stepId } : {}),
      ...(detail.code ? { code: detail.code } : {}),
      ...(detail.message ? { message: detail.message } : {}),
    };
    if (row) {
      row.runs.push(summary);
      row.last = detail;
    }
    this.state.log.push({
      at: detail.at, name: item.name, round: detail.round, status: detail.status,
      durationMs: detail.durationMs,
      ...(detail.stepId ? { detail: `${detail.stepId}${detail.code ? ` · ${detail.code}` : ''}` } : {}),
      ...(!detail.stepId && detail.message ? { detail: detail.message } : {}),
    });
    if (this.state.log.length > 2000) this.state.log.splice(0, this.state.log.length - 2000);
    this.state.counts = countsOf(this.state.items);
  }

  private async finish(reason: 'operator' | 'time' | 'complete' | 'failure') {
    this.state.running = false;
    this.state.finishedAt = Date.now();
    this.state.stopReason = reason;
    this.state.counts = countsOf(this.state.items);
    this.work.end();
    const summaryPath = this.state.summaryPath;
    if (summaryPath) {
      try {
        await writeFile(summaryPath, `${JSON.stringify({
          format: 'cuekeeper-workbench-batch', version: 1,
          startedAt: this.state.startedAt, finishedAt: this.state.finishedAt,
          stopReason: reason, config: this.state.config,
          counts: this.state.counts,
          items: this.state.items.map(item => ({
            name: item.name, file: item.file, app: item.app, version: item.version,
            selected: item.selected, runs: item.runs,
          })),
          log: this.state.log,
        }, null, 2)}\n`);
      } catch (error) {
        this.state.error = `批次汇总写入失败：${error instanceof Error ? error.message : 'unknown error'}`;
      }
    }
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private spawnCli(args: string[]) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
      (resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [this.options.cliPath, ...args], {
          cwd: this.options.directory(),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, [workdirEnv]: this.options.workRoot },
        });
        this.child = child;
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.once('error', error => {
          this.child = undefined;
          rejectRun(error);
        });
        child.once('close', (code, signal) => {
          this.child = undefined;
          resolveRun({ code, signal, stdout, stderr });
        });
      },
    );
  }
}

function countsOf(items: BatchItemState[]): BatchSnapshot['counts'] {
  const counts = { total: 0, passed: 0, failed: 0, blocked: 0, error: 0, pending: 0 };
  for (const item of items) {
    if (!item.selected) continue;
    for (const run of item.runs) {
      counts.total += 1;
      if (run.status === 'passed') counts.passed += 1;
      else if (run.status === 'blocked') counts.blocked += 1;
      else if (run.status === 'failed' || run.status === 'interrupted') counts.failed += 1;
      else counts.error += 1;
    }
  }
  counts.pending = items.filter(item => item.selected && !item.runs.length).length;
  return counts;
}

function failureOf(
  report: Record<string, unknown> | undefined,
  result: { code: number | null; stderr: string },
): Pick<BatchRunDetail, 'stepId' | 'code' | 'message'> {
  if (report) {
    const entries = Array.isArray(report.entries) ? report.entries : [];
    for (const raw of entries) {
      try {
        const entry = object(raw);
        if (entry.status !== 'failed' && entry.status !== 'blocked') continue;
        return {
          ...(typeof entry.id === 'string' ? { stepId: entry.id } : {}),
          ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
          ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
        };
      } catch {
        // Ignore a malformed entry and keep looking for the first real failure.
      }
    }
    return {};
  }
  const detail = result.stderr.trim().split('\n').at(-1);
  return {
    code: result.code === 0 ? 'NO_REPORT' : 'RUN_FAILED',
    ...(detail ? { message: detail } : {}),
  };
}

async function readReport(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}
