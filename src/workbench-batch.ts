import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import type { FlowV2 } from './contracts-v2.js';
import { flowV2Check } from './contracts-v2.js';
import { isFlowV2 } from './flow-v2.js';
import { object } from './locator.js';
import { parseTestItem } from './test-item.js';
import { plan } from './flow.js';
import { effectiveRootMode, reachableShells, shellPrivilege } from './shell.js';
import { agentDesktopVersion } from './desktop.js';
import { buildInfo } from './version.js';
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
  /** An interactive `root` step needs a password dialog, which a batch cannot show. */
  rootPrompt: boolean;
  modifiedAt: number;
}

export type BatchRunStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';

/**
 * The first thing someone reads when a row turns red. The category groups the
 * failure by what to check next; the code keeps the exact driver/runner fault.
 */
export type FailureCategory =
  | 'assertion' | 'locator' | 'focus' | 'permission' | 'timeout'
  | 'identity' | 'driver' | 'artifact' | 'shell' | 'unknown';

export interface BatchFailure {
  category: FailureCategory;
  code?: string;
  stepId?: string;
  stepKind?: string;
  message?: string;
  /** Assertion evidence, kept as the report wrote it. */
  expected?: unknown;
  actual?: unknown;
  screenshots?: { baseline?: string; actual?: string };
}

export interface BatchStepResult {
  id: string;
  kind?: string;
  status: string;
  code?: string;
}

export interface BatchRunSummary {
  /** 1-based position of this run in the batch. */
  run: number;
  round: number;
  status: BatchRunStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  failure?: BatchFailure;
  /** Per-run report path, relative to the batch directory. */
  report?: string;
  /** Step results are kept for a run that needs investigation, not for passes. */
  steps?: BatchStepResult[];
}

export interface BatchRunDetail extends BatchRunSummary {
  /** Absolute path the page reads through /api/batch/report. */
  reportPath: string;
  /** Every entry the CLI wrote, for the live detail pane. */
  entries: BatchStepResult[];
}

export interface BatchItemState extends BatchCandidate {
  selected: boolean;
  runs: BatchRunDetail[];
  last?: BatchRunDetail;
  /** A ready-to-paste replay command for one item. */
  reproduce: string;
}

export interface BatchLogEntry {
  at: number;
  run: number;
  name: string;
  round: number;
  status: BatchRunStatus;
  durationMs: number;
  failure?: BatchFailure;
}

export interface BatchConfig {
  rounds: number;
  intervalMs: number;
  continueOnFailure: boolean;
  stopAt?: number;
}

export interface BatchCounts {
  planned: number;
  completed: number;
  passed: number;
  failed: number;
  blocked: number;
  error: number;
  interrupted: number;
  notCompleted: number;
}

export interface BatchFirstFailure {
  run: number;
  path: string;
  item: string;
  round: number;
  status: BatchRunStatus;
  failure: BatchFailure;
}

export interface BatchSnapshot {
  running: boolean;
  allowLive: boolean;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  config?: BatchConfig;
  items: BatchItemState[];
  log: BatchLogEntry[];
  counts: BatchCounts;
  failureCounts: Partial<Record<FailureCategory, number>>;
  firstFailure?: BatchFirstFailure;
  summaryPath?: string;
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'stopped';
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
      rootPrompt: false,
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
    rootPrompt: reachableShells(plan(flow)).some(({ action }) =>
      shellPrivilege(action) === 'root' && effectiveRootMode(action) === 'prompt'),
  };
}

/**
 * Maps the runner's fault to the place an operator should look first. Codes
 * come from the driver, the flow runner or this batch runner; an unknown code
 * stays unknown instead of being forced into a wrong bucket.
 */
export function failureCategory(code: string | undefined): FailureCategory {
  if (!code) return 'unknown';
  if (/^(ASSERTION_|SCREENSHOT_)/.test(code) || code === 'BASELINE_MISSING') return 'assertion';
  if (['WINDOW_NOT_FOUND', 'APP_NOT_FOUND', 'ELEMENT_NOT_FOUND', 'TARGET_NOT_FOUND',
    'AMBIGUOUS_TARGET', 'WINDOW_CHANGED', 'UNSAFE_POINT', 'STALE_REF'].includes(code)) return 'locator';
  if (['FOCUS_INTERRUPTED', 'ACTION_FAILED', 'HEADED_REQUIRED', 'WINDOW_MISMATCH'].includes(code)) return 'focus';
  if (code === 'SECURE_INPUT' || /^(PERM_|PERMISSION_|ACCESSIBILITY_|INPUT_MONITORING_)/.test(code)) return 'permission';
  if (/_TIMEOUT$/.test(code) || code === 'LAUNCH_TIMEOUT') return 'timeout';
  if (/^IDENTITY_/.test(code) || ['APP_AMBIGUOUS', 'APP_PATH_INVALID', 'APP_UNVERIFIED'].includes(code)) return 'identity';
  if (/^(SHELL_|SUDO_)/.test(code)) return 'shell';
  if (code === 'REPORT_WRITE_FAILED' || code === 'NO_REPORT') return 'artifact';
  if (/^DRIVER_/.test(code) || ['RUN_FAILED', 'BAD_RESPONSE', 'APP_UNRESPONSIVE'].includes(code)) return 'driver';
  return 'unknown';
}

function parseReport(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) return undefined;
  try {
    const envelope = object(JSON.parse(line));
    return envelope.data === undefined ? undefined : object(envelope.data);
  } catch {
    return undefined;
  }
}

function stepsOf(report: Record<string, unknown>): BatchStepResult[] {
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

function textOf(value: unknown, max = 1000) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** Assertion evidence is kept exactly as the report wrote it; the page formats it. */
function assertionOf(entry: Record<string, unknown>) {
  const assertion = entry.assertion;
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return {};
  const value = assertion as Record<string, unknown>;
  const screenshots = value.screenshots;
  return {
    ...(value.expected === undefined ? {} : { expected: value.expected }),
    ...(value.actual === undefined ? {} : { actual: value.actual }),
    ...(screenshots && typeof screenshots === 'object' && !Array.isArray(screenshots) &&
      (typeof (screenshots as Record<string, unknown>).baseline === 'string' ||
        typeof (screenshots as Record<string, unknown>).actual === 'string')
      ? {
        screenshots: {
          ...(typeof (screenshots as Record<string, unknown>).baseline === 'string'
            ? { baseline: (screenshots as Record<string, string>).baseline } : {}),
          ...(typeof (screenshots as Record<string, unknown>).actual === 'string'
            ? { actual: (screenshots as Record<string, string>).actual } : {}),
        },
      }
      : {}),
  };
}

/** The first non-passing entry explains a run; later failures are usually fallout. */
function failureOf(
  report: Record<string, unknown> | undefined,
  code: number | null,
  stderr: string,
): BatchFailure | undefined {
  if (report) {
    const entries = Array.isArray(report.entries) ? report.entries : [];
    for (const raw of entries) {
      try {
        const entry = object(raw);
        if (entry.status !== 'failed' && entry.status !== 'blocked') continue;
        const codeText = textOf(entry.code);
        return {
          category: failureCategory(codeText),
          ...(codeText ? { code: codeText } : {}),
          ...(typeof entry.id === 'string' ? { stepId: entry.id } : {}),
          ...(typeof entry.kind === 'string' ? { stepKind: entry.kind } : {}),
          ...(textOf(entry.message) ? { message: textOf(entry.message)! } : {}),
          ...assertionOf(entry),
        };
      } catch {
        // Keep looking for the first entry that can be read.
      }
    }
    return undefined;
  }
  const detail = stderr.trim().split('\n').at(-1);
  const fallback = code === 0 ? 'NO_REPORT' : 'RUN_FAILED';
  return {
    category: failureCategory(fallback),
    code: fallback,
    ...(detail ? { message: textOf(detail) ?? detail } : {}),
  };
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function relativeReport(batchDirectory: string, path: string) {
  return relative(batchDirectory, path).split('\\').join('/');
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
  private sequence = 0;
  private finishing = false;
  private work: { begin: () => void; end: () => void };
  private host = {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    node: process.version,
    cuekeeper: buildInfo().version,
    driver: `agent-desktop ${agentDesktopVersion}`,
  };

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
    this.state = emptyState(options.allowLive());
  }

  get running() {
    return this.state.running;
  }

  /** A batch belongs to the session directory it started in; a new import clears it. */
  reset() {
    if (this.state.running) return;
    this.state = emptyState(this.options.allowLive());
  }

  async snapshot(): Promise<BatchSnapshot> {
    const directory = this.options.directory();
    const candidates = await listBatchCandidates(directory);
    // Keep the existing row objects: a run in flight holds the same reference
    // while it records its result, so rebuilding the array would drop it.
    const previous = new Map(this.state.items.map(item => [item.path, item]));
    this.state.items = candidates.map(candidate => {
      const saved = previous.get(candidate.path);
      const row = saved ?? {
        ...candidate, selected: true, runs: [],
        reproduce: this.reproduceCommand(candidate),
      };
      if (saved) {
        saved.file = candidate.file;
        saved.name = candidate.name;
        saved.app = candidate.app;
        saved.window = candidate.window;
        saved.steps = candidate.steps;
        saved.checkpoint = candidate.checkpoint;
        saved.rootPrompt = candidate.rootPrompt;
        saved.modifiedAt = candidate.modifiedAt;
        saved.reproduce = this.reproduceCommand(candidate);
      }
      return row;
    });
    this.state.allowLive = this.options.allowLive();
    this.state.counts = countsOf(this.state);
    this.state.firstFailure = firstFailureOf(this.state);
    this.state.failureCounts = failureCountsOf(this.state);
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
    // Batch always runs the CLI with --json, which cannot be combined with
    // --interactive; a prompt-mode root step would block every night. Refuse
    // it up front, before any replay starts.
    const interactiveRoot = selected.filter(item => item.rootPrompt);
    if (interactiveRoot.length) {
      throw new BatchError('ROOT_PROMPT_ITEM',
        `${interactiveRoot.map(item => item.name).join('、')} 含交互式 root 步骤；批量只能跑 keychain 模式或预配置 sudoers`);
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
    const config: BatchConfig = {
      rounds, intervalMs, continueOnFailure: input.continueOnFailure !== false,
      ...(stopAt ? { stopAt } : {}),
    };
    this.sequence = 0;
    this.finishing = false;
    this.state = {
      running: true,
      allowLive: true,
      startedAt: Date.now(),
      config,
      items: candidates.map(candidate => ({
        ...candidate,
        selected: selected.some(item => item.path === candidate.path),
        runs: [],
        reproduce: this.reproduceCommand(candidate),
      })),
      log: [],
      counts: { planned: selected.length * rounds, completed: 0, passed: 0, failed: 0, blocked: 0, error: 0, interrupted: 0, notCompleted: selected.length * rounds },
      failureCounts: {},
      status: 'running',
      summaryPath: join(batchDirectory, 'batch.json'),
    };
    this.stopRequested = false;
    this.work.begin();
    await this.writeSummary();
    void this.run(selected, batchDirectory, config);
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
      await this.finish('operator');
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

  private async runOne(
    item: BatchCandidate, round: number, index: number, batchDirectory: string,
  ): Promise<BatchRunDetail> {
    const row = this.state.items.find(entry => entry.path === item.path);
    const runDirectory = join(batchDirectory, `round-${pad(round)}-${pad(index + 1)}`);
    const reportPath = join(runDirectory, 'report.json');
    const startedAt = Date.now();
    this.sequence += 1;
    const args = ['run', item.path, '--headed', '--json', '--report', reportPath];
    if (item.version === 2) args.push('--foreground');
    if (this.options.allowShell()) args.push('--allow-shell');
    if (this.options.allowSudo()) args.push('--allow-sudo');
    let detail: BatchRunDetail;
    try {
      await mkdir(runDirectory, { recursive: true });
      const result = await this.spawnCli(args);
      const report = parseReport(result.stdout) ?? await readReport(reportPath);
      const status = report ? statusOf(report) : (result.code === 0 ? 'passed' : 'error');
      const failure = status === 'passed' ? undefined : failureOf(report, result.code, result.stderr);
      const entries = report ? stepsOf(report) : [];
      detail = {
        run: this.sequence,
        round,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        status,
        exitCode: result.code,
        signal: result.signal,
        entries,
        reportPath,
        report: relativeReport(batchDirectory, reportPath),
        ...(failure ? { failure } : {}),
        ...(failure ? { steps: entries.map(entry => ({ ...entry })) } : {}),
      };
    } catch (error) {
      detail = {
        run: this.sequence,
        round,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        status: this.stopRequested ? 'interrupted' : 'error',
        exitCode: null,
        signal: null,
        entries: [],
        reportPath,
        report: relativeReport(batchDirectory, reportPath),
        failure: {
          category: 'driver',
          code: 'RUN_FAILED',
          message: error instanceof Error ? error.message : 'The replay process could not start',
        },
      };
    }
    if (this.stopRequested && detail.status !== 'passed') detail.status = 'interrupted';
    if (detail.status === 'passed') delete detail.steps;
    this.record(item, row, detail);
    await this.writeSummary();
    return detail;
  }

  private record(item: BatchCandidate, row: BatchItemState | undefined, detail: BatchRunDetail) {
    if (row) {
      row.runs.push(detail);
      row.last = detail;
    }
    this.state.log.push({
      at: detail.startedAt,
      run: detail.run,
      name: item.name,
      round: detail.round,
      status: detail.status,
      durationMs: detail.durationMs,
      ...(detail.failure ? { failure: detail.failure } : {}),
    });
    if (this.state.log.length > 2000) this.state.log.splice(0, this.state.log.length - 2000);
    this.state.counts = countsOf(this.state);
    this.state.firstFailure = firstFailureOf(this.state);
    this.state.failureCounts = failureCountsOf(this.state);
  }

  private async finish(reason: 'operator' | 'time' | 'complete' | 'failure') {
    this.state.finishedAt = Date.now();
    this.state.durationMs = this.state.startedAt === undefined ? undefined : this.state.finishedAt - this.state.startedAt;
    this.state.stopReason = reason;
    this.state.counts = countsOf(this.state);
    this.state.firstFailure = firstFailureOf(this.state);
    this.state.failureCounts = failureCountsOf(this.state);
    this.state.status = rootStatus(this.state);
    // Keep the batch "running" until the final summary is on disk: a page that
    // sees running=false must be able to read the finished report immediately.
    this.finishing = true;
    await this.writeSummary();
    this.state.running = false;
    this.finishing = false;
    this.work.end();
  }

  /**
   * The summary is rewritten after every run, not only at the end: a machine
   * that sleeps, crashes or is stopped still leaves the rows that already ran.
   */
  private async writeSummary() {
    const summaryPath = this.state.summaryPath;
    if (!summaryPath) return;
    const batchDirectory = dirname(summaryPath);
    const payload = {
      format: 'cuekeeper-workbench-batch',
      version: 2,
      id: basename(batchDirectory.replace(/[\\/]$/, '')),
      status: this.state.running && !this.finishing ? 'running' : this.state.status,
      stopReason: this.state.stopReason,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      durationMs: this.state.durationMs,
      host: this.host,
      config: this.state.config,
      counts: this.state.counts,
      failureCounts: this.state.failureCounts,
      firstFailure: this.state.firstFailure,
      error: this.state.error,
      items: this.state.items.map(item => ({
        name: item.name,
        file: item.file,
        path: item.path,
        version: item.version,
        app: item.app,
        window: item.window,
        selected: item.selected,
        reproduce: item.reproduce,
        runs: item.runs.map(run => ({
          run: run.run,
          round: run.round,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          signal: run.signal,
          ...(run.failure ? { failure: run.failure } : {}),
          ...(run.report ? { report: run.report } : {}),
          ...(run.steps ? { steps: run.steps } : {}),
        })),
      })),
      log: this.state.log,
    };
    try {
      await mkdir(batchDirectory, { recursive: true });
      const temporary = `${summaryPath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(temporary, summaryPath);
    } catch (error) {
      this.state.error = `批次汇总写入失败：${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  private reproduceCommand(item: BatchCandidate) {
    const flags = [item.version === 2 ? '--foreground' : '', '--headed', '--json',
      this.options.allowShell() ? '--allow-shell' : '',
      this.options.allowSudo() ? '--allow-sudo' : ''].filter(Boolean).join(' ');
    return `cuekeeper run ${JSON.stringify(item.path)} ${flags}`;
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

function emptyState(allowLive: boolean): BatchSnapshot {
  return {
    running: false, allowLive, items: [], log: [],
    counts: { planned: 0, completed: 0, passed: 0, failed: 0, blocked: 0, error: 0, interrupted: 0, notCompleted: 0 },
    failureCounts: {}, status: 'passed',
  };
}

function countsOf(state: BatchSnapshot): BatchCounts {
  const selected = state.items.filter(item => item.selected);
  const planned = selected.length * (state.config?.rounds ?? 0);
  const counts: BatchCounts = {
    planned, completed: 0, passed: 0, failed: 0, blocked: 0, error: 0, interrupted: 0,
    notCompleted: planned,
  };
  for (const item of selected) {
    for (const run of item.runs) {
      counts.completed += 1;
      if (run.status === 'passed') counts.passed += 1;
      else if (run.status === 'blocked') counts.blocked += 1;
      else if (run.status === 'interrupted') counts.interrupted += 1;
      else if (run.status === 'failed') counts.failed += 1;
      else counts.error += 1;
    }
  }
  counts.notCompleted = Math.max(0, planned - counts.completed);
  return counts;
}

function firstFailureOf(state: BatchSnapshot): BatchFirstFailure | undefined {
  let first: BatchFirstFailure | undefined;
  for (const item of state.items) {
    for (const run of item.runs) {
      if (run.status === 'passed' || !run.failure) continue;
      if (!first || run.run < first.run) {
        first = {
          run: run.run, path: item.path, item: item.name, round: run.round,
          status: run.status, failure: run.failure,
        };
      }
    }
  }
  return first;
}

function failureCountsOf(state: BatchSnapshot): Partial<Record<FailureCategory, number>> {
  const counts: Partial<Record<FailureCategory, number>> = {};
  for (const item of state.items) {
    for (const run of item.runs) {
      if (!run.failure) continue;
      counts[run.failure.category] = (counts[run.failure.category] ?? 0) + 1;
    }
  }
  return counts;
}

function rootStatus(state: BatchSnapshot): BatchSnapshot['status'] {
  if (state.running && state.finishedAt === undefined) return 'running';
  if (state.stopReason === 'operator' || state.stopReason === 'time') return 'stopped';
  if (state.counts.failed > 0 || state.counts.error > 0) return 'failed';
  if (state.counts.blocked > 0) return 'blocked';
  return 'passed';
}

async function readReport(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}
