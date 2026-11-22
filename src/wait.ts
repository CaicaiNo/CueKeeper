import { Fault } from './locator.js';
import { maxWaitTimeoutMs } from './contracts-v2.js';

// One conditional wait: a read-only observation of current state, repeated until
// it matches or a monotonic deadline passes. Downloads, installs and uninstalls
// are driven by this instead of a fixed sleep, so a wait never starts, focuses
// or clicks while it observes.

/** Poll intervals stay bounded: notifications do the fast path, polling补漏. */
export const defaultWaitPollMs = 100;
export const maxWaitPollMs = 500;

const supportedWaitChecks = new Set([
  'window_exists', 'element_enabled', 'element', 'window', 'app_running', 'app_installed',
  'file_exists', 'file_stable',
]);

/** A wait condition whose kind the runner does not implement is a hard stop. */
export function assertWaitCheckSupported(kind: string): void {
  if (!supportedWaitChecks.has(kind)) {
    throw new Fault('WAIT_UNSUPPORTED', `Wait condition ${kind} is not supported; the run does not guess it`);
  }
}

/** The result of one read-only observation. */
export interface WaitObservation {
  matched: boolean;
  /** Safe detail used in the timeout message; never carries captured content. */
  detail?: string;
}

export interface WaitCondition {
  /** Label used in wait errors, e.g. `wait-installed (app_installed = true)`. */
  describe(): string;
  observe(): Promise<WaitObservation>;
}

export interface WaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Subscribe to state notifications. The engine still checks current state and
   * keeps a bounded poll, so a missed notification cannot stall the wait.
   */
  subscribe?(notify: () => void): () => void;
  pollMs?: number;
  maxPollMs?: number;
  /** Monotonic clock; production uses performance.now. */
  now?(): number;
  /** Observation errors that mean "not yet" instead of "stop". */
  transient?(error: unknown): boolean;
}

export interface WaitOutcome {
  /** Time spent waiting, measured on the monotonic clock. */
  durationMs: number;
  /** Full read-only observations performed, including the first one. */
  polls: number;
}

function cancelled(signal: AbortSignal): Fault {
  const reason = signal.reason;
  const detail = reason instanceof Error && reason.message ? `: ${reason.message}` : '';
  return new Fault('WAIT_CANCELLED', `Wait was cancelled${detail}`);
}

function describeError(error: unknown): string {
  if (error instanceof Fault) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'unknown observation error';
}

/**
 * Waits for one condition. The first observation happens immediately, so a wait
 * that is already satisfied costs one read and no timer. A notification wakes
 * the loop early; otherwise it polls at a bounded, slowly growing interval.
 */
export async function waitFor(
  condition: WaitCondition,
  options: WaitOptions,
): Promise<WaitOutcome> {
  const { timeoutMs } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxWaitTimeoutMs) {
    throw new Fault('WAIT_TIMEOUT_INVALID',
      `Wait timeout must be an integer from 1 to ${maxWaitTimeoutMs} ms`);
  }
  const now = options.now ?? (() => performance.now());
  const signal = options.signal;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const pollMs = Math.max(1, options.pollMs ?? defaultWaitPollMs);
  const maxPollMs = Math.max(pollMs, options.maxPollMs ?? maxWaitPollMs);

  let pending = false;
  let wake: (() => void) | undefined;
  const unsubscribe = options.subscribe?.(() => {
    pending = true;
    wake?.();
  });

  let polls = 0;
  let interval = pollMs;
  let lastDetail: string | undefined;
  let lastError: string | undefined;
  const describeFailure = () => {
    const detail = lastDetail ?? lastError;
    return detail ? ` (last observation: ${detail})` : '';
  };

  try {
    for (;;) {
      if (signal?.aborted) throw cancelled(signal);
      polls += 1;
      try {
        const observation = await condition.observe();
        if (observation.matched) return { durationMs: Math.round(now() - startedAt), polls };
        lastDetail = observation.detail;
        lastError = undefined;
      } catch (error) {
        if (signal?.aborted) throw cancelled(signal);
        if (!options.transient?.(error)) {
          // A non-transient observation error already has its own code; only an
          // unclassified failure becomes a wait error.
          if (error instanceof Fault) throw error;
          throw new Fault('WAIT_OBSERVER_FAILED',
            `Wait ${condition.describe()} could not be observed: ${describeError(error)}`);
        }
        lastError = describeError(error);
        lastDetail = undefined;
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Fault('WAIT_TIMEOUT',
          `Wait ${condition.describe()} did not match before its ${timeoutMs} ms deadline${describeFailure()}`);
      }
      const pauseMs = Math.min(interval, remaining);
      await pause(pauseMs, signal, () => {
        if (pending) {
          pending = false;
          return true;
        }
        return false;
      }, resolver => { wake = resolver; });
      wake = undefined;
      interval = Math.min(maxPollMs, Math.round(interval * 1.5));
    }
  } finally {
    unsubscribe?.();
  }
}

/**
 * Sleeps up to `ms`, or less when a notification arrives. Aborting rejects with
 * the wait's own `WAIT_CANCELLED` fault so a cancelled wait is distinguishable
 * from a timeout.
 */
function pause(
  ms: number,
  signal: AbortSignal | undefined,
  consumeNotification: () => boolean,
  registerWake: (resolve: (() => void) | undefined) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      registerWake(undefined);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      // A notification that arrived during the pause is consumed here; the next
      // loop iteration re-checks current state either way.
      consumeNotification();
      finish();
    }, ms);
    const onAbort = () => finish(signal ? cancelled(signal) : undefined);
    signal?.addEventListener('abort', onAbort, { once: true });
    registerWake(() => {
      consumeNotification();
      finish();
    });
    // A notification may have arrived between the last observation and the
    // registration; consume it now instead of sleeping a full interval.
    if (consumeNotification()) {
      finish();
      return;
    }
    if (signal?.aborted) finish(cancelled(signal));
  });
}
