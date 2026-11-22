import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGaps, samplingRecord, videoArtifactCheck } from './video.js';
import type {
  MaskedRegion, SkippedVideo, VideoArtifact, VideoCode, VideoGap, VideoGapReason, VideoSamplingOptions,
} from './video.js';
import { defaultVideoSampling } from './video.js';
import type { RawAsset } from './assets.js';

export const videoFile = 'session.mp4';
export const videoPartialFile = 'session.partial.mp4';
export const videoSidecarFile = 'video.json';

/** One process line from the native helper. Unknown fields are ignored, unknown kinds rejected. */
export type VideoEvent =
  | { kind: 'ready'; width: number; height: number }
  | { kind: 'sample'; ptsMs: number; changedBlocks?: number }
  | { kind: 'gap'; fromMs: number; toMs: number; reason: VideoGapReason }
  | { kind: 'paused' | 'resumed'; atMs: number }
  | { kind: 'finalized'; payload: FinalizedPayload };

export interface FinalizedPayload {
  status?: 'complete' | 'truncated' | 'skipped';
  code?: VideoCode;
  durationMs?: number;
  frames?: number;
  timescale?: number;
  firstPtsMs?: number;
  width?: number;
  height?: number;
  codec?: 'h264' | 'hevc';
  /** Wall-clock time of the first kept sample, from the helper's host-clock offset. */
  firstSampleWallMs?: number;
  truncatedAtMs?: number;
  pausedMs?: number;
}

export interface VideoCaptureOptions {
  /** CGWindowID of the replay target (`w-123` or `123`); capture is window-scoped, never full screen. */
  windowId: number | string;
  /** ISO timestamp of report.startedAt, the zero of the report's `atMs` axis. */
  reportStartedAt: string;
  /** Directory receiving the movie and its sidecar. */
  mediaDir: string;
  /**
   * Real window capture stays closed until the release is signed. The operator
   * opens it per machine with `CUEKEEPER_VIDEO_CAPTURE=1`; the synthetic
   * `--self-test` path never goes through this gate.
   */
  allowCapture?: boolean;
  /** Override for tests; production uses the sibling `dist/cuekeeper-video`. */
  helper?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  sampling?: VideoSamplingOptions;
  masks?: MaskedRegion[];
  /** Read-only permission probe timeout. */
  preflightTimeoutMs?: number;
  /** How long the helper may take to report `ready`. */
  startTimeoutMs?: number;
  /** How long finalize may take after `stop`. */
  stopTimeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: VideoEvent) => void;
}

export interface VideoCaptureSession {
  readonly kind: 'capturing' | 'stopped' | 'unavailable';
  /** Resolves exactly once, after the helper finalizes or the capture fails closed. */
  stop(): Promise<VideoArtifact>;
  pause(): boolean;
  resume(): boolean;
}

export function defaultVideoHelper(env: NodeJS.ProcessEnv = process.env): string {
  return env.CUEKEEPER_VIDEO ?? join(fileURLToPath(new URL('.', import.meta.url)), 'cuekeeper-video');
}

export function skippedVideo(code: VideoCode): SkippedVideo {
  return { kind: 'video', status: 'skipped', code };
}

function notAuthorized(): VideoCaptureSession {
  return {
    kind: 'unavailable',
    stop: async () => skippedVideo('SCREEN_CAPTURE_NOT_AUTHORIZED'),
    pause: () => false,
    resume: () => false,
  };
}

function failed(code: VideoCode): VideoCaptureSession {
  return {
    kind: 'unavailable',
    stop: async () => skippedVideo(code),
    pause: () => false,
    resume: () => false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function helperCode(text: string): VideoCode | undefined {
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const error = isRecord(parsed.error) ? parsed.error.code : parsed.code;
      if (typeof error === 'string' && error.length) return error as VideoCode;
    } catch {
      // Plain diagnostic lines are expected too; only structured codes are used.
    }
  }
  return undefined;
}

function runHelper(helper: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(-1);
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      stderr += error.message;
      finish(-1);
    });
    child.once('close', code => finish(code ?? -1));
  });
}

/**
 * Replay window IDs are `w-<CGWindowID>`. Anything else cannot be handed to
 * ScreenCaptureKit, so capture fails closed instead of guessing a window.
 */
export function cgWindowId(windowId: number | string): number | undefined {
  if (typeof windowId === 'number') {
    return Number.isInteger(windowId) && windowId > 0 ? windowId : undefined;
  }
  const match = /^(?:w-)?(\d+)$/.exec(windowId);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Starts an optional window capture. Every environmental failure is returned as
 * a `skipped` artifact: a missing permission, a missing helper or a dead encoder
 * must never fail the replay run or leave a half-written movie behind.
 */
export async function startVideoCapture(options: VideoCaptureOptions): Promise<VideoCaptureSession> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const helper = options.helper ?? defaultVideoHelper(env);
  const sampling = options.sampling ?? defaultVideoSampling;
  const reportStartedMs = Date.parse(options.reportStartedAt);
  const windowId = cgWindowId(options.windowId);
  if (windowId === undefined) return failed('ENCODE_UNAVAILABLE');
  if (!Number.isFinite(reportStartedMs)) throw new Error('Video capture needs a valid report start time');

  // Screen recording is macOS-only and lives in its own helper binary. On any
  // other platform the feature fails closed instead of pretending to record.
  if (platform !== 'darwin') return failed('ENCODE_UNAVAILABLE');

  // The pre-signing build has no operator-visible capture switch in the CLI or
  // the workbench: the real entry is closed unless the machine opted in.
  const allowCapture = options.allowCapture ?? env.CUEKEEPER_VIDEO_CAPTURE === '1';
  if (!allowCapture) return failed('CAPTURE_DISABLED');
  // The helper checks the same variable; keep an explicit `allowCapture` and
  // the child environment from disagreeing.
  const childEnv = { ...env, CUEKEEPER_VIDEO_CAPTURE: '1' };

  await mkdir(options.mediaDir, { recursive: true, mode: 0o700 });

  // Only CGPreflightScreenCaptureAccess is allowed here: it never shows a TCC
  // dialog. Requesting access is the user's explicit action, not the runner's.
  const preflight = await runHelper(helper, ['--preflight'], options.preflightTimeoutMs ?? 5000, childEnv);
  if (preflight.code !== 0) return failed('ENCODE_UNAVAILABLE');
  let permission = false;
  try {
    const probe: unknown = JSON.parse(preflight.stdout);
    permission = isRecord(probe) && probe.screenRecording === true;
  } catch {
    return failed('ENCODE_UNAVAILABLE');
  }
  if (!permission) return notAuthorized();

  const partialPath = join(options.mediaDir, videoPartialFile);
  const finalPath = join(options.mediaDir, videoFile);
  const args = [
    '--capture',
    '--window-id', String(windowId),
    '--out', partialPath,
    '--max-fps', String(sampling.maxFps),
  ];
  for (const mask of options.masks ?? []) {
    args.push('--mask', `${mask.x},${mask.y},${mask.width},${mask.height}`);
  }
  let child: ChildProcess;
  try {
    child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  } catch {
    return failed('ENCODE_UNAVAILABLE');
  }
  child.stdin?.on('error', () => { /* the helper may already have exited */ });

  const gaps: VideoGap[] = [];
  let finalized: FinalizedPayload | undefined;
  let reportedCode: VideoCode | undefined;
  let stderr = '';
  let exitCode: number | undefined;
  let settled = false;
  let ready = false;
  let resolveArtifact!: (artifact: VideoArtifact) => void;
  const artifact = new Promise<VideoArtifact>(resolve => { resolveArtifact = resolve; });

  let resolveReady!: () => void;
  const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
  let startTimer: NodeJS.Timeout | undefined;

  const emit = (event: VideoEvent) => options.onEvent?.(event);

  const settle = async (payload: FinalizedPayload | undefined, code: VideoCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(startTimer);
    resolveReady();
    const result = await buildArtifact({
      payload, code, partialPath, finalPath, reportStartedMs, sampling,
      gaps, masks: options.masks ?? [],
    });
    resolveArtifact(result);
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.kind !== 'string') {
      // The helper reports a startup failure as {"error":{"code":...}} before
      // it can finalize anything; keep that code for the fail-closed artifact.
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === 'string') {
        reportedCode = parsed.error.code as VideoCode;
      }
      return;
    }
    switch (parsed.kind) {
      case 'ready': {
        ready = true;
        resolveReady();
        emit({ kind: 'ready', width: numberOr(parsed.width, 0), height: numberOr(parsed.height, 0) });
        break;
      }
      case 'sample': {
        emit({ kind: 'sample', ptsMs: numberOr(parsed.ptsMs, 0), changedBlocks: optionalNumber(parsed.changedBlocks) });
        break;
      }
      case 'gap': {
        const gap: VideoGap = {
          fromMs: numberOr(parsed.fromMs, 0), toMs: numberOr(parsed.toMs, 0),
          reason: gapReason(parsed.reason),
        };
        gaps.push(gap);
        emit({ kind: 'gap', ...gap });
        break;
      }
      case 'paused':
        emit({ kind: 'paused', atMs: numberOr(parsed.atMs, 0) });
        break;
      case 'resumed':
        emit({ kind: 'resumed', atMs: numberOr(parsed.atMs, 0) });
        break;
      case 'finalized': {
        finalized = isRecord(parsed.payload) ? parsed.payload as FinalizedPayload : {};
        void settle(finalized, codeFromPayload(finalized));
        break;
      }
      default:
        break;
    }
  };

  let buffer = '';
  child.stdout?.on('data', chunk => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.once('error', () => { void settle(undefined, 'ENCODE_UNAVAILABLE'); });
  child.once('close', code => {
    exitCode = code ?? -1;
    if (buffer.trim()) handleLine(buffer);
    if (!settled) void settle(finalized, reportedCode ?? helperCode(stderr) ?? 'ENCODE_FAILED');
  });

  startTimer = setTimeout(() => {
    if (!ready) {
      // No ready line means the helper never proved it could reach the window.
      child.kill('SIGTERM');
      void settle(undefined, reportedCode ?? helperCode(stderr) ?? 'WINDOW_CLOSED');
    }
  }, options.startTimeoutMs ?? 15000);

  const abort = () => { void session.stop(); };
  options.signal?.addEventListener('abort', abort, { once: true });

  const stop = async (): Promise<VideoArtifact> => {
    if (settled) return artifact;
    try { child.stdin?.write('stop\n'); } catch { /* ignore */ }
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timeoutHandle = setTimeout(() => resolve('timeout'), options.stopTimeoutMs ?? 15000);
      timeoutHandle.unref();
    });
    const winner = await Promise.race([artifact.then(value => ({ value })), timeout]);
    clearTimeout(timeoutHandle);
    if (winner === 'timeout') {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        if (exitCode !== undefined) { resolve(); return; }
        const timer = setTimeout(resolve, 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
      await settle(undefined, 'ENCODE_FAILED');
    }
    options.signal?.removeEventListener('abort', abort);
    return artifact;
  };

  const session: VideoCaptureSession = {
    kind: 'capturing',
    stop,
    pause: () => write(child, 'pause\n'),
    resume: () => write(child, 'resume\n'),
  };

  // Wait for ready before handing the session back, so a window that vanished
  // before the first frame becomes a clean skipped artifact, not a race.
  await Promise.race([
    readyPromise,
    new Promise<void>(resolve => {
      if (settled) resolve();
      else {
        const poll = setInterval(() => {
          if (settled || ready) { clearInterval(poll); resolve(); }
        }, 25);
        poll.unref();
      }
    }),
  ]);
  return session;
}

function write(child: ChildProcess, text: string): boolean {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
  try {
    child.stdin.write(text);
    return true;
  } catch {
    return false;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function gapReason(value: unknown): VideoGapReason {
  return value === 'window_not_drawing' || value === 'paused' || value === 'capture_stalled'
    ? value : 'unchanged';
}

function codeFromPayload(payload: FinalizedPayload): VideoCode {
  const known: VideoCode[] = [
    'CAPTURE_DISABLED', 'SCREEN_CAPTURE_NOT_AUTHORIZED', 'SCREEN_CAPTURE_LOST',
    'WINDOW_CLOSED', 'WINDOW_NOT_DRAWING', 'ENCODE_UNAVAILABLE', 'ENCODE_FAILED',
    'DISK_FULL', 'TRUNCATED',
  ];
  return payload.code && known.includes(payload.code) ? payload.code : 'TRUNCATED';
}

async function buildArtifact(input: {
  payload: FinalizedPayload | undefined;
  code: VideoCode;
  partialPath: string;
  finalPath: string;
  reportStartedMs: number;
  sampling: VideoSamplingOptions;
  gaps: VideoGap[];
  masks: MaskedRegion[];
}): Promise<VideoArtifact> {
  const { payload, partialPath, finalPath } = input;
  if (!payload || !payload.status || payload.status === 'skipped') {
    await remove(partialPath);
    return skippedVideo(payload?.code ? codeFromPayload(payload) : input.code);
  }
  if (payload.status !== 'complete' && payload.status !== 'truncated') {
    await remove(partialPath);
    return skippedVideo('ENCODE_FAILED');
  }
  let bytes: number;
  try {
    bytes = (await stat(finalPath)).size;
  } catch {
    // The helper only renames a finished movie. A leftover `.partial.mp4` is
    // discarded: publishing a half file is worse than reporting no video.
    await remove(partialPath);
    return skippedVideo('ENCODE_FAILED');
  }
  if (bytes < 1024) {
    await rm(finalPath, { force: true });
    return skippedVideo('ENCODE_FAILED');
  }
  // PTS 0 is the first kept sample. The helper reports that sample's wall time
  // from a single host-clock/wall-clock offset, so the anchor converts the
  // report's monotonic `atMs` axis through one instant instead of guessing the
  // start from the stop time. A movie without that instant cannot be anchored
  // and is discarded rather than played out of sync.
  const firstSampleWallMs = payload.firstSampleWallMs;
  if (firstSampleWallMs === undefined || !Number.isFinite(firstSampleWallMs)) {
    await rm(finalPath, { force: true });
    return skippedVideo('ENCODE_FAILED');
  }
  // videoStartOffsetMs is the report-relative time of video PTS 0:
  // videoPtsMs = entry.atMs - videoStartOffsetMs. Capture usually starts after
  // the report, so the value is positive; negative means it started earlier.
  const offset = Math.min(60_000, Math.max(-5_000, Math.round(firstSampleWallMs - input.reportStartedMs)));
  const gaps = normalizeGaps(input.gaps);
  const common = {
    kind: 'video' as const,
    path: `media/${videoFile}` as const,
    bytes,
    durationMs: Math.max(0, Math.round(payload.durationMs ?? 0)),
    frames: Math.max(0, Math.round(payload.frames ?? 0)),
    codec: payload.codec ?? 'h264' as const,
    container: 'mp4' as const,
    width: Math.max(16, Math.min(4096, Math.round(payload.width ?? 16))),
    height: Math.max(16, Math.min(4096, Math.round(payload.height ?? 16))),
    timebase: {
      timescale: Math.max(1, Math.round(payload.timescale ?? 600)),
      firstPtsMs: Math.max(0, Math.round(payload.firstPtsMs ?? 0)),
    },
    anchor: {
      reportStartedAt: new Date(input.reportStartedMs).toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z'),
      videoStartOffsetMs: offset,
      method: 'host_clock' as const,
    },
    sampling: samplingRecord(input.sampling),
    ...(gaps.length ? { gaps } : {}),
    ...(payload.pausedMs ? { pausedMs: Math.round(payload.pausedMs) } : {}),
    ...(input.masks.length ? { maskedRegions: input.masks } : {}),
  };
  const artifact: VideoArtifact = payload.status === 'truncated'
    ? {
      ...common, status: 'truncated', code: codeFromPayload(payload),
      truncatedAtMs: Math.max(0, Math.round(payload.truncatedAtMs ?? common.durationMs)),
    }
    : { ...common, status: 'complete' };
  if (!videoArtifactCheck.Check(artifact)) {
    await rm(finalPath, { force: true });
    return skippedVideo('ENCODE_FAILED');
  }
  return artifact;
}

async function remove(path: string) {
  await rm(path, { force: true }).catch(() => undefined);
}

/** Media are archive-relative so report packing can place them under `media/`. */
export async function loadVideoArtifact(mediaDir: string): Promise<{ video?: VideoArtifact; media: RawAsset[] }> {
  let raw: string;
  try {
    raw = await readFile(join(mediaDir, videoSidecarFile), 'utf8');
  } catch {
    return { media: [] };
  }
  let artifact: unknown;
  try {
    artifact = JSON.parse(raw);
  } catch {
    throw new Error('Invalid video manifest: not JSON');
  }
  if (!videoArtifactCheck.Check(artifact)) throw new Error('Invalid video manifest');
  const video = artifact as VideoArtifact;
  if (video.status === 'skipped') return { video, media: [] };
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(mediaDir, video.path.slice('media/'.length)));
  } catch {
    throw new Error(`Video artifact is missing: ${video.path}`);
  }
  if (bytes.length !== video.bytes) throw new Error('Video artifact size does not match the manifest');
  return { video, media: [{ path: video.path, bytes }] };
}
