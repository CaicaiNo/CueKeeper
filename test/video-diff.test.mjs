import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VideoDiffSampler, blockDiff, decideSample, grayscaleThumbnail,
} from '../dist/video-diff.js';
import { defaultVideoSampling } from '../dist/video.js';

// 1920x1080 keeps the synthetic geometry comparable to the capture spike in
// design/video/experiment: the same 2x28 caret, 22x14 glyph run and 14 px scroll.
const WIDTH = 1920;
const HEIGHT = 1080;

function blank() {
  return { width: WIDTH, height: HEIGHT, data: new Uint8Array(WIDTH * HEIGHT * 4).fill(255) };
}

function fill(frame, x, y, width, height, [red, green, blue]) {
  for (let row = Math.max(0, y); row < Math.min(HEIGHT, y + height); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(WIDTH, x + width); column += 1) {
      const index = (row * WIDTH + column) * 4;
      frame.data[index] = blue;
      frame.data[index + 1] = green;
      frame.data[index + 2] = red;
      frame.data[index + 3] = 255;
    }
  }
}

function screen({ scroll = 0, caret = false, glyph = false, dot = false } = {}) {
  const frame = blank();
  fill(frame, 0, 0, WIDTH, 56, [237, 237, 240]);
  fill(frame, 20, 18, 220, 18, [51, 51, 56]);
  let seed = 0x9e3779b9;
  const next = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return seed;
  };
  for (let line = 0; line < 30; line += 1) {
    const y = 90 + line * 30 - scroll;
    if (y < 80 || y > HEIGHT - 20) continue;
    let x = 40;
    const words = 3 + (line % 5);
    for (let word = 0; word < words; word += 1) {
      const width = 40 + (next() % 180);
      if (x + width > WIDTH - 40) break;
      let mark = x;
      while (mark < x + width - 3) {
        const piece = 3 + (next() % 9);
        if (mark + piece > x + width) break;
        fill(frame, mark, y, piece, 14, [64, 64, 69]);
        mark += piece + 3;
      }
      x += width + 18;
    }
  }
  if (glyph) fill(frame, 40, 95, 22, 14, [64, 64, 69]);
  if (caret) fill(frame, 620, 180, 2, 28, [0, 0, 0]);
  if (dot) fill(frame, 1500, 900, 8, 8, [255, 0, 0]);
  return frame;
}

const baseline = screen();
const baselineGray = grayscaleThumbnail(baseline);

test('thumbnail is 160x90 and follows BT.601 luma', () => {
  const gray = grayscaleThumbnail(baseline);
  assert.equal(gray.length, 160 * 90);
  assert.ok(gray[0] > 200, 'title bar is light');
  const black = blank();
  fill(black, 0, 0, WIDTH, HEIGHT, [0, 0, 0]);
  assert.equal(grayscaleThumbnail(black)[0], 0);
  const red = blank();
  fill(red, 0, 0, WIDTH, HEIGHT, [255, 0, 0]);
  assert.equal(grayscaleThumbnail(red)[0], 76);
  assert.throws(() => grayscaleThumbnail({ width: WIDTH, height: HEIGHT, data: new Uint8Array(8) }),
    /smaller than width/);
});

test('an unchanged frame has zero changed blocks and is dropped', () => {
  const diff = blockDiff(baselineGray, grayscaleThumbnail(screen()));
  assert.deepEqual(diff, { changedBlocks: 0, maxBlockDelta: 0, blocks: 240 });
  const sampler = new VideoDiffSampler();
  assert.equal(sampler.observe(baseline, 0).reason, 'first');
  const idle = sampler.observe(screen(), 100);
  assert.equal(idle.emit, false);
  assert.equal(idle.reason, 'unchanged');
  assert.deepEqual(sampler.idleGap(6100), { fromMs: 0, toMs: 6100, reason: 'unchanged' });
});

test('a scroll is structural, a single glyph and a small dot are churn', () => {
  const scroll = blockDiff(baselineGray, grayscaleThumbnail(screen({ scroll: 14 })));
  assert.ok(scroll.changedBlocks >= 100, `expected a full-window change, got ${scroll.changedBlocks}`);
  assert.equal(decideSample(scroll.changedBlocks, 0, undefined, undefined).reason, 'structural');

  const glyph = blockDiff(baselineGray, grayscaleThumbnail(screen({ glyph: true })));
  assert.ok(glyph.changedBlocks >= 1 && glyph.changedBlocks < defaultVideoSampling.structuralBlocks,
    `one typed character must stay below the structural threshold, got ${glyph.changedBlocks}`);
  assert.equal(decideSample(glyph.changedBlocks, 0, undefined, undefined).reason, 'churn');

  const dot = blockDiff(baselineGray, grayscaleThumbnail(screen({ dot: true })));
  assert.ok(dot.changedBlocks >= 1 && dot.changedBlocks < defaultVideoSampling.structuralBlocks);
  assert.equal(decideSample(dot.changedBlocks, 0, undefined, undefined).reason, 'churn');
});

test('the changed-cell threshold is inclusive at 24 and ignores 23', () => {
  const sampling = { ...defaultVideoSampling, thumbnailWidth: 8, thumbnailHeight: 8, blockSize: 8 };
  const left = new Uint8Array(64).fill(100);
  const below = new Uint8Array(64).fill(100);
  below[0] = 123;
  const at = new Uint8Array(64).fill(100);
  at[0] = 124;
  assert.deepEqual(blockDiff(left, below, sampling), { changedBlocks: 0, maxBlockDelta: 23, blocks: 1 });
  assert.deepEqual(blockDiff(left, at, sampling), { changedBlocks: 1, maxBlockDelta: 24, blocks: 1 });
});

test('structural frames respect maxFps and churn frames respect the 500 ms interval', () => {
  const sampler = new VideoDiffSampler();
  sampler.observe(baseline, 0);
  const firstScroll = sampler.observe(screen({ scroll: 14 }), 100);
  assert.equal(firstScroll.reason, 'structural');
  const tooSoon = sampler.observe(screen({ scroll: 28 }), 150);
  assert.equal(tooSoon.emit, false);
  assert.equal(tooSoon.reason, 'rate_limited');
  assert.equal(sampler.observe(screen({ scroll: 42 }), 200).reason, 'structural');

  // The last kept frame is the scroll=42 frame, so a single glyph is a churn change.
  const glyph = sampler.observe(screen({ scroll: 42, glyph: true }), 700);
  assert.equal(glyph.reason, 'churn');
  const repeated = sampler.observe(screen({ scroll: 42, glyph: true, dot: true }), 900);
  assert.equal(repeated.emit, false);
  assert.equal(repeated.reason, 'rate_limited');
  assert.equal(sampler.observe(screen({ scroll: 42, glyph: true, dot: true }), 1200).reason, 'churn');
});

test('PTS must be finite, non-negative and monotonic', () => {
  const sampler = new VideoDiffSampler();
  assert.throws(() => sampler.observe(baseline, -1), /non-negative/);
  assert.throws(() => sampler.observe(baseline, Number.NaN), /finite/);
  sampler.observe(baseline, 1000);
  assert.throws(() => sampler.observe(screen(), 999), /backwards/);
});
