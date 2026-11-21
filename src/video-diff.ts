import { defaultVideoSampling } from './video.js';
import type { VideoSamplingOptions } from './video.js';

/** One captured frame, 32-bit BGRA, tightly packed (stride = width * 4). */
export interface BgraFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export type SampleReason = 'first' | 'structural' | 'churn' | 'unchanged' | 'rate_limited';

export interface SampleDecision {
  emit: boolean;
  reason: SampleReason;
  changedBlocks: number;
  maxBlockDelta: number;
}

export interface BlockDiff {
  changedBlocks: number;
  maxBlockDelta: number;
  blocks: number;
}

/**
 * Reference implementation of the 160x90 luma thumbnail described in
 * docs/session-video.md. The native capture uses CoreGraphics to draw the same
 * downsampled image; this version is what unit tests assert against.
 */
export function grayscaleThumbnail(frame: BgraFrame, sampling: VideoSamplingOptions = defaultVideoSampling): Uint8Array {
  const { width, height, data } = frame;
  const { thumbnailWidth, thumbnailHeight } = sampling;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Frame dimensions must be positive integers');
  }
  if (data.length < width * height * 4) throw new Error('Frame buffer is smaller than width * height * 4');
  const gray = new Uint8Array(thumbnailWidth * thumbnailHeight);
  for (let oy = 0; oy < thumbnailHeight; oy += 1) {
    const y0 = Math.floor(oy * height / thumbnailHeight);
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * height / thumbnailHeight));
    for (let ox = 0; ox < thumbnailWidth; ox += 1) {
      const x0 = Math.floor(ox * width / thumbnailWidth);
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * width / thumbnailWidth));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        let index = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          blue += data[index];
          green += data[index + 1];
          red += data[index + 2];
          index += 4;
          count += 1;
        }
      }
      // BT.601 integer luma, matching the design and the native implementation.
      gray[oy * thumbnailWidth + ox] = (77 * (red / count) + 150 * (green / count) + 29 * (blue / count)) >> 8;
    }
  }
  return gray;
}

/**
 * Splits the thumbnail into 8x8 cells and counts cells whose *maximum* luma
 * delta reaches the threshold. Max instead of mean keeps a one-character stroke
 * from being averaged away.
 */
export function blockDiff(left: Uint8Array, right: Uint8Array, sampling: VideoSamplingOptions = defaultVideoSampling): BlockDiff {
  const { thumbnailWidth, thumbnailHeight, blockSize, blockThreshold } = sampling;
  if (left.length !== thumbnailWidth * thumbnailHeight || right.length !== left.length) {
    throw new Error('Thumbnail size does not match the sampling configuration');
  }
  const columns = Math.ceil(thumbnailWidth / blockSize);
  const rows = Math.ceil(thumbnailHeight / blockSize);
  let changedBlocks = 0;
  let maxBlockDelta = 0;
  for (let row = 0; row < rows; row += 1) {
    const yEnd = Math.min((row + 1) * blockSize, thumbnailHeight);
    for (let column = 0; column < columns; column += 1) {
      const xEnd = Math.min((column + 1) * blockSize, thumbnailWidth);
      let localMax = 0;
      for (let y = row * blockSize; y < yEnd; y += 1) {
        const base = y * thumbnailWidth;
        for (let x = column * blockSize; x < xEnd; x += 1) {
          const delta = Math.abs(left[base + x] - right[base + x]);
          if (delta > localMax) localMax = delta;
        }
      }
      if (localMax >= blockThreshold) changedBlocks += 1;
      if (localMax > maxBlockDelta) maxBlockDelta = localMax;
    }
  }
  return { changedBlocks, maxBlockDelta, blocks: columns * rows };
}

/**
 * Pure sampling decision:
 *   0 changed cells           -> drop (idle, or only a blinking caret)
 *   >= structuralBlocks       -> emit, at most maxFps frames per second
 *   1 .. structuralBlocks - 1 -> emit, at most one frame per churnMinIntervalMs
 */
export function decideSample(
  changedBlocks: number,
  ptsMs: number,
  lastEmittedMs: number | undefined,
  lastChurnMs: number | undefined,
  sampling: VideoSamplingOptions = defaultVideoSampling,
): SampleDecision {
  if (changedBlocks <= 0) return { emit: false, reason: 'unchanged', changedBlocks, maxBlockDelta: 0 };
  if (changedBlocks >= sampling.structuralBlocks) {
    const interval = 1000 / sampling.maxFps;
    if (lastEmittedMs !== undefined && ptsMs - lastEmittedMs < interval) {
      return { emit: false, reason: 'rate_limited', changedBlocks, maxBlockDelta: 0 };
    }
    return { emit: true, reason: 'structural', changedBlocks, maxBlockDelta: 0 };
  }
  if (lastChurnMs !== undefined && ptsMs - lastChurnMs < sampling.churnMinIntervalMs) {
    return { emit: false, reason: 'rate_limited', changedBlocks, maxBlockDelta: 0 };
  }
  return { emit: true, reason: 'churn', changedBlocks, maxBlockDelta: 0 };
}

/**
 * Stateful sampler. Every frame is compared against the last *kept* frame, so
 * a change that is too small or too soon is re-detected on the next frame
 * instead of silently disappearing.
 */
export class VideoDiffSampler {
  readonly sampling: VideoSamplingOptions;
  private previous: Uint8Array | undefined;
  private lastEmittedMs: number | undefined;
  private lastChurnMs: number | undefined;

  constructor(sampling: VideoSamplingOptions = defaultVideoSampling) {
    this.sampling = sampling;
  }

  observe(frame: BgraFrame, ptsMs: number): SampleDecision {
    if (!Number.isFinite(ptsMs) || ptsMs < 0) throw new Error('Frame PTS must be a finite, non-negative number');
    if (this.lastEmittedMs !== undefined && ptsMs < this.lastEmittedMs) {
      throw new Error('Frame PTS must not move backwards');
    }
    const thumbnail = grayscaleThumbnail(frame, this.sampling);
    if (this.previous === undefined) {
      this.previous = thumbnail;
      this.lastEmittedMs = ptsMs;
      return { emit: true, reason: 'first', changedBlocks: 0, maxBlockDelta: 0 };
    }
    const diff = blockDiff(this.previous, thumbnail, this.sampling);
    const decision = decideSample(
      diff.changedBlocks, ptsMs, this.lastEmittedMs, this.lastChurnMs, this.sampling,
    );
    if (!decision.emit) return { ...decision, maxBlockDelta: diff.maxBlockDelta };
    this.previous = thumbnail;
    this.lastEmittedMs = ptsMs;
    if (decision.reason === 'churn') this.lastChurnMs = ptsMs;
    return { ...decision, maxBlockDelta: diff.maxBlockDelta };
  }

  /** Idle interval since the last kept frame, or undefined when a frame is still fresh. */
  idleGap(nowMs: number): { fromMs: number; toMs: number; reason: 'unchanged' } | undefined {
    if (this.lastEmittedMs === undefined || nowMs <= this.lastEmittedMs) return undefined;
    return { fromMs: this.lastEmittedMs, toMs: nowMs, reason: 'unchanged' };
  }

  get lastFrameMs(): number | undefined {
    return this.lastEmittedMs;
  }
}
