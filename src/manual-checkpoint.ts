import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultCheckpointTimeoutMs } from './contracts-v2.js';
import type { ReportV2Entry, WindowScope } from './contracts-v2.js';
import { Fault } from './locator.js';

// A manual checkpoint is the only way a secure interval continues: recording
// collapses it into one step, replay pauses and the operator works in the real
// app or system dialog. CueKeeper never reads, stores or forwards a password;
// it only waits for an independent confirmation and proves that secure input
// has cleared together with the declared resume condition.

export type CheckpointMetadata = NonNullable<ReportV2Entry['checkpoint']>;

export interface CheckpointRequest {
  stepId: string;
  triggerStepId: string;
  scope: WindowScope;
  timeoutMs: number;
  reason: CheckpointMetadata['reason'];
}

export type CheckpointAnswer = 'continue' | 'cancel';

/** The independent session control: a terminal prompt, never the target app. */
export interface CheckpointChannel {
  /** Tells the operator what to do and where; carries no secret content. */
  announce(request: CheckpointRequest): Promise<void>;
  /** Resolves when the operator confirms or cancels the hand-off. */
  confirm(request: CheckpointRequest, signal: AbortSignal): Promise<CheckpointAnswer>;
}

export interface CheckpointProbe {
  /** True while macOS secure event input is active. */
  secureInput(): Promise<boolean>;
  /** True while a supported macOS system dialog is visible. */
  systemDialogVisible?(): Promise<boolean>;
  /** True when the flow's declared resume condition still holds. */
  resume(): Promise<boolean>;
}

export interface HandOffOptions {
  request: CheckpointRequest;
  channel: CheckpointChannel;
  probe: CheckpointProbe;
  signal: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** A checkpoint failure still carries the metadata the report keeps. */
export class CheckpointFault extends Fault {
  constructor(
    code: string,
    message: string,
    readonly checkpoint: CheckpointMetadata,
    dependency = false,
  ) {
    super(code, message, dependency);
  }
}

function metadata(request: CheckpointRequest, timeoutMs: number): CheckpointMetadata {
  return { reason: request.reason, triggerStepId: request.triggerStepId, timeoutMs };
}

/** Waits for the operator's answer, bounded by the hand-off budget. */
function answerWithin(
  channel: CheckpointChannel,
  request: CheckpointRequest,
  signal: AbortSignal,
  budgetMs: number,
): Promise<CheckpointAnswer> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return new Promise<CheckpointAnswer>((resolve, reject) => {
    let settled = false;
    const finish = (answer: CheckpointAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(answer);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(error);
    };
    const timer = setTimeout(() => {
      controller.abort(new Error('checkpoint deadline'));
      fail(new CheckpointFault(
        'MANUAL_CHECKPOINT_TIMEOUT',
        `Manual checkpoint ${request.stepId} was not confirmed within ${request.timeoutMs} ms`,
        metadata(request, request.timeoutMs),
      ));
    }, budgetMs);
    channel.confirm(request, controller.signal).then(finish, error => {
      if (signal.aborted) fail(signal.reason ?? error);
      else fail(error);
    });
  });
}

/**
 * A system dialog checkpoint first proves the dialog appeared. Both checkpoint
 * types require independent confirmation before checking the resume condition.
 */
export async function runHandOff(options: HandOffOptions): Promise<CheckpointMetadata> {
  const { request, channel, probe, signal } = options;
  const timeoutMs = options.timeoutMs ?? request.timeoutMs ?? defaultCheckpointTimeoutMs;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? (() => performance.now());
  const wait = options.sleep ??
    ((ms: number, inner: AbortSignal) => sleep(ms, undefined, { signal: inner }).then(() => undefined));
  const deadline = now() + timeoutMs;
  let last = 'secure input is still active';
  const failure = () => new CheckpointFault(
    'MANUAL_CHECKPOINT_TIMEOUT',
    `Manual checkpoint ${request.stepId} could not be proven resumed within ${timeoutMs} ms: ${last}`,
    metadata(request, timeoutMs),
  );
  const remaining = () => deadline - now();
  const poll = async () => {
    if (remaining() <= 0) throw failure();
    await wait(Math.max(1, Math.min(pollMs, remaining())), signal);
  };

  signal.throwIfAborted();
  const dialogVisible = request.reason === 'system_dialog' ? probe.systemDialogVisible?.bind(probe) : undefined;
  if (request.reason === 'system_dialog' && !dialogVisible) {
    throw new CheckpointFault('MANUAL_CHECKPOINT_REQUIRED',
      'A system dialog checkpoint needs the native dialog visibility probe', metadata(request, timeoutMs), true);
  }
  await channel.announce(request);
  if (dialogVisible) {
    last = 'the expected macOS system dialog did not appear';
    for (;;) {
      signal.throwIfAborted();
      if (remaining() <= 0) throw failure();
      if (await dialogVisible()) break;
      await poll();
    }
  }
  if (remaining() <= 0) throw failure();
  const answer = await answerWithin(channel, request, signal, Math.max(1, remaining()));
  if (answer === 'cancel') {
    throw new CheckpointFault(
      'MANUAL_CHECKPOINT_CANCELLED',
      `The operator cancelled manual checkpoint ${request.stepId}; later steps do not run`,
      metadata(request, timeoutMs),
    );
  }

  for (;;) {
    signal.throwIfAborted();
    if (remaining() <= 0) throw failure();
    let secure = true;
    try {
      secure = await probe.secureInput();
      if (secure) last = 'secure input is still active';
    } catch {
      // An unverifiable secure state never counts as cleared.
      secure = true;
      last = 'secure input state is unverifiable';
    }
    if (!secure && dialogVisible && await dialogVisible()) {
      last = 'the macOS system dialog is still visible';
    } else if (!secure) {
      try {
        if (await probe.resume() && remaining() > 0) {
          return { ...metadata(request, timeoutMs), confirmedBy: 'operator' };
        }
        last = 'the resume condition does not hold yet';
      } catch (error) {
        last = error instanceof Error ? error.message : 'the resume condition is unverifiable';
      }
    }
    await poll();
  }
}

/**
 * The CLI channel. The prompt and the confirmation both live in the terminal
 * session, never in the app that asked for a password.
 */
export function terminalCheckpointChannel(options: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): CheckpointChannel {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  return {
    async announce(request) {
      const seconds = Math.round(request.timeoutMs / 1000);
      const systemDialog = request.reason === 'system_dialog';
      const label = systemDialog ? 'macOS 系统弹框' : '安全输入';
      const instructions = systemDialog
        ? '等待检测到系统弹框后，请在桌面上处理弹框，再回到此终端确认。'
        : `请在目标界面完成授权或输入密码：${request.scope.app} · ${request.scope.windowTitle}\n完成后再回到此终端确认。`;
      output.write([
        `人工检查点 ${request.stepId} · ${label}（触发步骤 ${request.triggerStepId}）`,
        instructions,
        `等待上限 ${seconds} 秒，超时或取消都会停在这里，后续步骤不执行。`,
        '',
      ].join('\n'));
    },
    confirm(request, signal) {
      return new Promise<CheckpointAnswer>((resolve, reject) => {
        const reader = createInterface({ input, terminal: false });
        let settled = false;
        const finish = (answer: CheckpointAnswer) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          reader.close();
          resolve(answer);
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          reader.close();
          reject(signal.reason ?? new Error('checkpoint aborted'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        output.write('完成后输入 continue 继续，或输入 cancel 放弃：');
        reader.on('line', line => {
          const token = line.trim().toLowerCase();
          if (token === 'continue' || token === 'yes') finish('continue');
          else if (token === 'cancel' || token === 'quit') finish('cancel');
          else output.write('请输入 continue 或 cancel。\n');
        });
        // A closed stdin has no operator to confirm; treat it as a refusal.
        reader.on('close', () => finish('cancel'));
      });
    },
  };
}

/** The fixed stderr line the workbench parses while a checkpoint is waiting. */
export const checkpointWaitMarker = 'CHECKPOINT_WAIT';

export interface CheckpointWaitEvent {
  stepId: string;
  triggerStepId: string;
  timeoutMs: number;
}

/** Parses one stderr line; anything else is not a checkpoint event. */
export function parseCheckpointWait(line: string): CheckpointWaitEvent | undefined {
  const match = /^CHECKPOINT_WAIT (\S+) (\S+) (\d+)$/.exec(line.trim());
  if (!match) return undefined;
  const timeoutMs = Number(match[3]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return undefined;
  return { stepId: match[1], triggerStepId: match[2], timeoutMs };
}

/**
 * The machine channel a parent process (the workbench) drives. The announcement
 * is the fixed stderr marker, so the page knows which step waits and for how
 * long; the answer is one `continue` or `cancel` line on stdin. The channel
 * carries no secret and never writes to stdout, leaving the `--json` report
 * intact.
 */
export function eventsCheckpointChannel(options: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): CheckpointChannel {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  return {
    async announce(request) {
      output.write(`${checkpointWaitMarker} ${request.stepId} ${request.triggerStepId} ${request.timeoutMs}\n`);
    },
    confirm(request, signal) {
      return new Promise<CheckpointAnswer>((resolve, reject) => {
        const reader = createInterface({ input, terminal: false });
        let settled = false;
        const finish = (answer: CheckpointAnswer) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          reader.close();
          resolve(answer);
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          reader.close();
          reject(signal.reason ?? new Error('checkpoint aborted'));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        reader.on('line', line => {
          const token = line.trim().toLowerCase();
          if (token === 'continue' || token === 'cancel') finish(token);
        });
        // A closed stdin has no parent to answer; treat it as a refusal, so the
        // report ends with MANUAL_CHECKPOINT_CANCELLED instead of hanging.
        reader.on('close', () => finish('cancel'));
      });
    },
  };
}

/** The helper bundled next to the CLI, or an explicit override. */
export function captureHelperPath() {
  return process.env.CUEKEEPER_RECORDER?.trim() ||
    fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
}

/**
 * Reads the system secure input flag from the native helper. The probe starts no
 * capture session: it prints one JSON line and exits.
 */
export function nativeSecureInputProbe(executable = captureHelperPath(), timeoutMs = 2_000) {
  return nativeBooleanProbe(executable, timeoutMs, '--secure-state', 'secure',
    'SECURE_STATE_UNAVAILABLE', 'system secure input state');
}

export function nativeSystemDialogProbe(executable = captureHelperPath(), timeoutMs = 2_000) {
  return nativeBooleanProbe(executable, timeoutMs, '--system-dialog-state', 'visible',
    'SYSTEM_DIALOG_STATE_UNAVAILABLE', 'macOS system dialog state');
}

function nativeBooleanProbe(
  executable: string, timeoutMs: number, command: string, flag: string, code: string, description: string,
) {
  return (): Promise<boolean> => new Promise<boolean>((resolve, reject) => {
    execFile(executable, [command], { encoding: 'utf8', timeout: timeoutMs },
      (error, stdout) => {
        if (error) {
          reject(new Fault(code,
            `Could not read the ${description}; rebuild the capture helper with pnpm build:recorder`, true));
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout)[flag];
          if (typeof value !== 'boolean') throw new Error('missing boolean flag');
          resolve(value);
        } catch {
          reject(new Fault(code, `The capture helper returned an invalid ${description}`, true));
        }
      });
  });
}
