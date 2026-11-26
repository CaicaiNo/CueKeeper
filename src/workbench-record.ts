import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingFileName, recordingsDirectory } from './recording-output.js';
import { workdirEnv } from './workdir.js';

/** Only the CLI's final `--json` line is parsed; nothing here is logged. */
const stdoutLimit = 64 * 1024;
const defaultCountdown = 3;
const bundleIdPattern = /^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i;
const excludeLimit = 32;

export interface RecordStartRequest {
  mode?: unknown;
  exclude?: unknown;
  maxSeconds?: unknown;
  countdown?: unknown;
}

export interface RecordWarning {
  code: string;
  message: string;
}

export interface RecordFault {
  code: string;
  message: string;
}

/** Where a running recording is: before the CLI starts its countdown, and after. */
export type RecordPhase = 'starting' | 'countdown' | 'preparing' | 'recording';

export interface RecordStatus {
  recording: boolean;
  /**
   * Stage of a running recording. `starting`, `countdown` and `preparing` have
   * not captured anything yet, so `startedAt`/`elapsedMs` say nothing about them.
   */
  phase?: RecordPhase;
  /** Absolute path of the flow the CLI writes when it stops. */
  flowPath?: string;
  /** Epoch the helper began capturing (its `readyAt`), not the process start. */
  startedAt?: string;
  /** Milliseconds captured so far; zero until the helper is really reading input. */
  elapsedMs: number;
  /** Countdown before the first captured event, in milliseconds. */
  countdownMs?: number;
  /**
   * While the countdown runs: epoch ms it ends at, as the CLI reports it. It is
   * absent until the CLI says its countdown started, so the page never counts
   * down before the recorder does.
   */
  countdownEndsAt?: string;
  /** Steps the CLI reported for the saved flow. */
  steps?: number;
  /** The saved flow is incomplete: interrupted, or killed after a stop timeout. */
  partial?: boolean;
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  warnings: RecordWarning[];
  error?: RecordFault;
}

interface Recording {
  child: ChildProcess;
  flowPath: string;
  /** Countdown end in epoch ms; only the CLI's report sets it. */
  countdownEndsAt?: number;
  countdownMs: number;
  phase: RecordPhase;
  /** Epoch ms the helper reported it was ready; absent until then. */
  captureStartedAt?: number;
  output: string;
  /** Partial line from the CLI's stage-report descriptor. */
  stageBuffer: string;
  stopping: boolean;
  settled?: RecordStatus;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface RecordControllerOptions {
  /** Absolute path of the CLI entry point that owns `record --global`. */
  cli: string;
  /** Directory that receives web-started recordings. */
  recordings?: string;
  /** How long a stop waits for the CLI to exit before it is killed. */
  stopTimeoutMs?: number;
  /** Durable root for the recorder's per-run desktop state. */
  workRoot?: string;
  /** True while the workbench is running a test. */
  busy?: () => boolean;
}

function wholeNumber(value: unknown, fallback: number, low: number, high: number, label: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    throw new Error(`${label} must be an integer from ${low} to ${high}`);
  }
  return value;
}

function excludeList(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > excludeLimit) {
    throw new Error(`exclude must be an array of at most ${excludeLimit} bundle IDs`);
  }
  const entries = value.map(entry => {
    if (typeof entry !== 'string' || !bundleIdPattern.test(entry)) {
      throw new Error(`exclude entry ${String(entry)} is not a bundle ID such as com.apple.TextEdit`);
    }
    return entry;
  });
  return [...new Set(entries)];
}

/**
 * A timestamped name that is still free. The CLI refuses to replace an
 * existing file, so the check is a courtesy that keeps the collision out of
 * the recording itself.
 */
async function freeFlowPath(directory: string) {
  const name = recordingFileName(new Date());
  const stem = name.replace(/\.flow\.json$/i, '');
  for (let nth = 1; nth <= 100; nth++) {
    const path = join(directory, nth === 1 ? name : `${stem}-${nth}.flow.json`);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
      throw error;
    }
  }
  throw new Error(`No free recording name left in ${directory}`);
}

function record(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function readText(value: unknown, limit: number) {
  return typeof value === 'string' && value.trim() ? value.slice(0, limit) : undefined;
}

function readFault(value: unknown): RecordFault | undefined {
  const fault = record(value);
  if (!fault) return undefined;
  const code = readText(fault.code, 64) ?? 'RECORD_FAILED';
  const message = readText(fault.message, 2000) ?? 'The recorder failed';
  return { code, message };
}

function readWarnings(value: unknown): RecordWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: RecordWarning[] = [];
  for (const item of value.slice(0, 20)) {
    const warning = record(item);
    const message = readText(warning?.message, 500);
    if (message) warnings.push({ code: readText(warning?.code, 64) ?? 'RECORD_WARNING', message });
  }
  return warnings;
}

/** The last `--json` line the CLI printed, if the run reached that point. */
function readOutcome(output: string) {
  const lines = output.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = record(JSON.parse(line));
      if (parsed && 'ok' in parsed) {
        return { data: record(parsed.data), error: readFault(parsed.error) };
      }
    } catch {
      // Progress lines are not JSON; only the final envelope matters.
    }
  }
  return { data: undefined, error: undefined };
}

/**
 * One stage report the CLI wrote on its descriptor. This is display state, not
 * a result: a malformed or late line is ignored, a stage never moves backwards,
 * and the flow's contents still come only from the final envelope.
 */
function applyStage(recording: Recording, line: string) {
  let data: Record<string, unknown> | undefined;
  try {
    data = record(JSON.parse(line));
  } catch {
    return;
  }
  if (data?.stage === 'countdown') {
    // The CLI starts its own countdown only after its preflight and input-source
    // preparation, so this is the first moment a countdown may be shown. A late
    // report must not pull a running capture back to the countdown.
    if (recording.phase !== 'starting' && recording.phase !== 'countdown') return;
    const endsAt = data.endsAt;
    if (typeof endsAt === 'number' && Number.isFinite(endsAt) && endsAt > 0) {
      recording.countdownEndsAt = endsAt;
      recording.phase = 'countdown';
    }
    return;
  }
  if (data?.stage === 'preparing') {
    if (recording.phase !== 'recording') recording.phase = 'preparing';
    return;
  }
  if (data?.stage === 'recording') {
    // The helper's own ready moment, sanity-checked against this clock; an
    // impossible value falls back to when the report arrived.
    const readyAt = data.readyAt;
    recording.captureStartedAt = typeof readyAt === 'number' && Number.isSafeInteger(readyAt) &&
      readyAt > 0 && readyAt <= Date.now() + 1000 ? readyAt : Date.now();
    recording.phase = 'recording';
  }
}

/**
 * Owns the one global `record --global` child the workbench may have. Every
 * route reads its state here, so a crashed child can never look like it is
 * still recording, and stop is the only place that imports the result.
 */
export function createRecordController(options: RecordControllerOptions) {
  const recordings = options.recordings ?? recordingsDirectory();
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  let active: Recording | undefined;
  let stopping: Promise<RecordStatus> | undefined;
  let last: RecordStatus | undefined;

  function settle(recording: Recording, exitCode: number | null, signal: NodeJS.Signals | null,
    timedOut: boolean): RecordStatus {
    if (recording.settled) return recording.settled;
    const { data, error: cliError } = readOutcome(recording.output);
    const steps = data && Number.isInteger(data.actions) ? data.actions as number : undefined;
    const partial = data?.partial === true;
    let error: RecordFault | undefined;
    if (timedOut) {
      error = {
        code: 'RECORD_STOP_TIMEOUT',
        message: `The recorder did not stop within ${stopTimeoutMs} ms and was killed; ` +
          'the flow it had not written yet is lost.',
      };
    } else if (cliError && cliError.code !== 'INTERRUPTED') {
      // A normal stop ends in INTERRUPTED; any other fault is a real failure.
      error = cliError;
    } else if (exitCode !== 0 && exitCode !== 130) {
      error = {
        code: 'RECORD_FAILED',
        message: signal
          ? `The recorder stopped with signal ${signal}`
          : `The recorder exited with code ${exitCode ?? 'unknown'}`,
      };
    }
    const status: RecordStatus = {
      recording: false,
      flowPath: recording.flowPath,
      ...(recording.captureStartedAt === undefined ? {} : {
        startedAt: new Date(recording.captureStartedAt).toISOString(),
      }),
      elapsedMs: recording.captureStartedAt === undefined ? 0
        : Math.max(0, Date.now() - recording.captureStartedAt),
      countdownMs: recording.countdownMs,
      ...(steps !== undefined ? { steps } : {}),
      partial: partial || timedOut,
      ...(timedOut ? { timedOut: true } : {}),
      exitCode,
      signal,
      warnings: readWarnings(data?.warnings),
      ...(error ? { error } : {}),
    };
    recording.settled = status;
    if (active === recording) active = undefined;
    last = status;
    return status;
  }

  function status(): RecordStatus {
    if (active) {
      return {
        recording: true,
        phase: active.phase,
        flowPath: active.flowPath,
        ...(active.captureStartedAt === undefined ? {} : {
          startedAt: new Date(active.captureStartedAt).toISOString(),
        }),
        elapsedMs: active.captureStartedAt === undefined ? 0
          : Math.max(0, Date.now() - active.captureStartedAt),
        countdownMs: active.countdownMs,
        ...(active.phase === 'countdown' && active.countdownEndsAt !== undefined
          ? { countdownEndsAt: new Date(active.countdownEndsAt).toISOString() } : {}),
        warnings: [],
      };
    }
    return last ?? { recording: false, elapsedMs: 0, warnings: [] };
  }

  async function start(request: RecordStartRequest): Promise<RecordStatus> {
    if (active || stopping) throw new Error('A recording is already in progress');
    if (options.busy?.()) throw new Error('A test is running; stop it before recording');
    const mode = request.mode ?? 'global';
    if (mode !== 'global') throw new Error('Only a global desktop recording is supported');
    const countdown = wholeNumber(request.countdown, defaultCountdown, 0, 60, 'countdown');
    const maxSeconds = request.maxSeconds === undefined
      ? undefined : wholeNumber(request.maxSeconds, 600, 1, 3600, 'maxSeconds');
    const exclude = excludeList(request.exclude);
    await mkdir(recordings, { recursive: true, mode: 0o700 });
    const flowPath = await freeFlowPath(recordings);
    const args = [
      options.cli, 'record', '--global', '--out', flowPath,
      '--countdown', String(countdown), '--json',
    ];
    if (maxSeconds !== undefined) args.push('--max-seconds', String(maxSeconds));
    if (exclude.length) args.push('--exclude', exclude.join(','));

    // The recorder inherits this process's environment, including a TMPDIR
    // that may already be gone; give it the durable root explicitly.
    const env = options.workRoot ? { ...process.env, [workdirEnv]: options.workRoot } : process.env;
    // Descriptor 3 carries stage reports. The CLI's stdout keeps its one-line
    // result envelope, so nothing that already reads it has to change.
    args.push('--progress-fd', '3');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env });
    const recording: Recording = {
      child, flowPath,
      countdownMs: countdown * 1000,
      // The CLI has its own preflight and input-source work before its countdown
      // starts. Nothing is shown counting down until it reports that moment, so
      // a slow start cannot make the page count down twice or jump back.
      phase: 'starting',
      output: '', stageBuffer: '', stopping: false,
      done: new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
    };
    child.stderr?.resume();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (recording.output.length < stdoutLimit) {
        recording.output = (recording.output + chunk).slice(0, stdoutLimit);
      }
    });
    const stages = child.stdio[3] as Readable | null | undefined;
    stages?.setEncoding('utf8');
    stages?.on('data', (chunk: string) => {
      recording.stageBuffer += chunk;
      const lines = recording.stageBuffer.split('\n');
      recording.stageBuffer = lines.pop() ?? '';
      for (const line of lines) applyStage(recording, line);
    });
    // A failed spawn emits `error` and then `close`; keep the error handled.
    child.on('error', () => { /* settled by close */ });
    recording.done.then(({ code, signal }) => {
      if (active === recording && !recording.stopping) settle(recording, code, signal, false);
    });
    active = recording;
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      if (active === recording) active = undefined;
      const detail = error instanceof Error ? error.message : 'unknown error';
      last = {
        recording: false, flowPath, elapsedMs: 0, countdownMs: recording.countdownMs, warnings: [],
        error: { code: 'RECORD_SPAWN_FAILED', message: `Could not start the recorder: ${detail}` },
      };
      throw new Error(last.error!.message);
    }
    return status();
  }

  async function stop(): Promise<RecordStatus> {
    if (stopping) return stopping;
    const recording = active;
    if (!recording) {
      // The child may already have exited on its own; stopping then means
      // "finish and import", so the last outcome is the answer.
      if (last) return last;
      throw new Error('No recording is in progress');
    }
    recording.stopping = true;
    stopping = (async () => {
      try {
        let timedOut = false;
        if (recording.child.exitCode === null && recording.child.signalCode === null) {
          recording.child.kill('SIGINT');
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
          });
          const first = await Promise.race([recording.done.then(() => 'exit' as const), late]);
          if (timer) clearTimeout(timer);
          if (first === 'timeout') {
            timedOut = true;
            recording.child.kill('SIGKILL');
          }
        }
        const { code, signal } = await recording.done;
        return settle(recording, code, signal, timedOut);
      } finally {
        recording.stopping = false;
        stopping = undefined;
      }
    })();
    return stopping;
  }

  return {
    start,
    stop,
    status,
    /** Server shutdown: stop the child without waiting for a flow. */
    cancel() {
      const recording = active;
      if (!recording || recording.settled) return;
      recording.stopping = true;
      recording.child.kill('SIGINT');
      const kill = setTimeout(() => recording.child.kill('SIGKILL'), stopTimeoutMs);
      kill.unref();
    },
    get recording() { return Boolean(active); },
  };
}

export type RecordController = ReturnType<typeof createRecordController>;
