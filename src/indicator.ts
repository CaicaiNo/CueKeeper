import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ReplayIndicator {
  /** Removes the overlay; safe to call more than once. */
  stop(): void;
}

/**
 * The blue replay overlay. It is the same capture binary the recorder uses, so
 * it inherits the existing Accessibility and Input Monitoring grants; the
 * binary runs a tiny mode that draws the edge glow and listens for ⌃⌥X.
 */
export function startReplayIndicator(options: {
  onCancel: () => void;
  enabled?: boolean;
  /** Tests point this at a stand-in; the release uses the shipped helper. */
  helper?: string;
}): ReplayIndicator {
  const helper = options.helper ?? fileURLToPath(new URL('./cuekeeper-capture', import.meta.url));
  if (options.enabled === false || process.platform !== 'darwin' ||
      process.env.CUEKEEPER_NO_INDICATOR === '1' || !existsSync(helper)) {
    return { stop() {} };
  }
  let child: ChildProcess | undefined;
  try {
    child = spawn(helper, ['--replay-indicator'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { stop() {} };
  }
  let pending = '';
  let cancelled = false;
  child.stdout?.on('data', chunk => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (cancelled || !line.includes('"event":"cancel"')) continue;
      cancelled = true;
      options.onCancel();
    }
  });
  // A missing or unrunnable helper never blocks the replay; the page and the
  // terminal still stop it through their own controls.
  child.once('error', () => {});
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child?.kill('SIGTERM');
      } catch {
        // The helper is already gone.
      }
    },
  };
}
