import { Type as T } from '@sinclair/typebox';
import type { Static, TProperties } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

const object = <P extends TProperties>(properties: P) =>
  T.Object(properties, { additionalProperties: false });
const timestamp = T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const mediaPath = T.String({ pattern: '^media/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\.mp4$' });
const codec = T.Union([T.Literal('h264'), T.Literal('hevc')]);

/**
 * Closed set of outcome codes. A skipped or truncated video always says why;
 * free-text reasons are not part of the contract.
 */
export const videoCodes = [
  'SCREEN_CAPTURE_NOT_AUTHORIZED',
  'SCREEN_CAPTURE_LOST',
  'WINDOW_CLOSED',
  'WINDOW_NOT_DRAWING',
  'ENCODE_UNAVAILABLE',
  'ENCODE_FAILED',
  'DISK_FULL',
  'TRUNCATED',
] as const;
export type VideoCode = typeof videoCodes[number];

const videoCode = T.Union([
  T.Literal('SCREEN_CAPTURE_NOT_AUTHORIZED'), T.Literal('SCREEN_CAPTURE_LOST'),
  T.Literal('WINDOW_CLOSED'), T.Literal('WINDOW_NOT_DRAWING'),
  T.Literal('ENCODE_UNAVAILABLE'), T.Literal('ENCODE_FAILED'),
  T.Literal('DISK_FULL'), T.Literal('TRUNCATED'),
]);

export const videoGapReasons = ['unchanged', 'window_not_drawing', 'paused', 'capture_stalled'] as const;
export type VideoGapReason = typeof videoGapReasons[number];

/** Thresholds are recorded next to the artifact so a surprising movie can be argued about. */
export interface VideoSamplingOptions {
  thumbnailWidth: number;
  thumbnailHeight: number;
  blockSize: number;
  blockThreshold: number;
  structuralBlocks: number;
  maxFps: number;
  churnMinIntervalMs: number;
}

export const defaultVideoSampling: VideoSamplingOptions = {
  thumbnailWidth: 160, thumbnailHeight: 90, blockSize: 8,
  blockThreshold: 24, structuralBlocks: 4, maxFps: 10, churnMinIntervalMs: 500,
};

const sampling = object({
  thumbnail: T.String({ pattern: '^[0-9]{2,4}x[0-9]{2,4}$' }),
  blockThreshold: T.Integer({ minimum: 1, maximum: 255 }),
  structuralBlocks: T.Integer({ minimum: 1, maximum: 10_000 }),
  maxFps: T.Integer({ minimum: 1, maximum: 30 }),
  churnMinIntervalMs: T.Integer({ minimum: 0, maximum: 60_000 }),
});

const anchor = object({
  reportStartedAt: timestamp,
  videoStartOffsetMs: T.Integer({ minimum: -5000, maximum: 60_000 }),
  method: T.Literal('host_clock'),
});

const gap = object({
  fromMs: T.Integer({ minimum: 0 }),
  toMs: T.Integer({ minimum: 0 }),
  reason: T.Union([
    T.Literal('unchanged'), T.Literal('window_not_drawing'),
    T.Literal('paused'), T.Literal('capture_stalled'),
  ]),
});

const timebase = object({
  timescale: T.Integer({ minimum: 1, maximum: 100_000 }),
  firstPtsMs: T.Integer({ minimum: 0 }),
});

const mask = object({
  x: T.Integer({ minimum: 0 }), y: T.Integer({ minimum: 0 }),
  width: T.Integer({ minimum: 1 }), height: T.Integer({ minimum: 1 }),
});

const captured = {
  path: mediaPath,
  bytes: T.Integer({ minimum: 0 }),
  durationMs: T.Integer({ minimum: 0 }),
  frames: T.Integer({ minimum: 0 }),
  codec,
  container: T.Literal('mp4'),
  width: T.Integer({ minimum: 16, maximum: 4096 }),
  height: T.Integer({ minimum: 16, maximum: 4096 }),
  timebase,
  anchor,
  sampling,
  gaps: T.Optional(T.Array(gap, { maxItems: 64 })),
  pausedMs: T.Optional(T.Integer({ minimum: 0 })),
  maskedRegions: T.Optional(T.Array(mask, { maxItems: 16 })),
};

const completeVideo = object({
  kind: T.Literal('video'),
  status: T.Literal('complete'),
  ...captured,
});
const truncatedVideo = object({
  kind: T.Literal('video'),
  status: T.Literal('truncated'),
  code: videoCode,
  truncatedAtMs: T.Integer({ minimum: 0 }),
  ...captured,
});
const skippedVideo = object({
  kind: T.Literal('video'),
  status: T.Literal('skipped'),
  code: videoCode,
});

export const videoArtifactSchema = T.Union([completeVideo, truncatedVideo, skippedVideo]);
export const videoArtifactCheck = TypeCompiler.Compile(videoArtifactSchema);

export type VideoArtifact = Static<typeof videoArtifactSchema>;
export type PlayableVideo = Static<typeof completeVideo> | Static<typeof truncatedVideo>;
export type SkippedVideo = Static<typeof skippedVideo>;
export type VideoGap = Static<typeof gap>;
export type MaskedRegion = Static<typeof mask>;

export function isPlayableVideo(video: VideoArtifact | undefined): video is PlayableVideo {
  return video !== undefined && (video.status === 'complete' || video.status === 'truncated');
}

/** `videoPtsMs = reportAtMs - videoStartOffsetMs` from the design. */
export function videoPtsMs(video: PlayableVideo, atMs: number): number {
  return Math.max(0, atMs - video.anchor.videoStartOffsetMs);
}

/** Playback position for one report entry, clamped so a step past the end shows the last frame. */
export function videoSeekMs(video: PlayableVideo, atMs: number): number {
  return Math.min(video.durationMs, videoPtsMs(video, atMs));
}

export function samplingRecord(sampling: VideoSamplingOptions) {
  return {
    thumbnail: `${sampling.thumbnailWidth}x${sampling.thumbnailHeight}`,
    blockThreshold: sampling.blockThreshold,
    structuralBlocks: sampling.structuralBlocks,
    maxFps: sampling.maxFps,
    churnMinIntervalMs: sampling.churnMinIntervalMs,
  } as const;
}

/**
 * Gaps are advisory: the list is capped and adjacent intervals with the same
 * reason are merged so a 10 minute idle session costs one entry, not 6000.
 */
export function normalizeGaps(gaps: VideoGap[]): VideoGap[] {
  const sorted = gaps
    .filter(gap => gap.toMs > gap.fromMs)
    .sort((left, right) => left.fromMs - right.fromMs);
  const merged: VideoGap[] = [];
  for (const gap of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.reason === gap.reason && gap.fromMs <= previous.toMs + 1000) {
      previous.toMs = Math.max(previous.toMs, gap.toMs);
      continue;
    }
    if (merged.length < 64) merged.push({ ...gap });
  }
  return merged;
}

export const videoCodeLabels: Record<VideoCode, string> = {
  SCREEN_CAPTURE_NOT_AUTHORIZED: '未授权屏幕录制，未录制视频；本轮结果不受影响',
  SCREEN_CAPTURE_LOST: '录制中屏幕捕捉中断，已保留中断前的画面',
  WINDOW_CLOSED: '目标窗口已关闭，录制提前结束，已保留结束前的画面',
  WINDOW_NOT_DRAWING: '目标窗口停止绘制，空闲段保留最后一帧',
  ENCODE_UNAVAILABLE: '本机没有可用的视频编码器，未录制视频',
  ENCODE_FAILED: '编码失败，已丢弃不完整的视频文件',
  DISK_FULL: '磁盘空间不足，录制提前结束',
  TRUNCATED: '录制被中断，已保留中断前的画面',
};
