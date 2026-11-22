import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';

// Keep the native identity helper out of stubbed runs, matching viewer.test.mjs.
process.env.CUEKEEPER_APP_IDENTITY = '/nonexistent/cuekeeper-identity';

import { packReport, mediaLimitBytes, verifyManifestFiles } from '../dist/report.js';
import { manifestCheck } from '../dist/contracts.js';
import { parseFlow } from '../dist/flow.js';
import {
  cgWindowId, loadVideoArtifact, startVideoCapture, videoFile, videoSidecarFile,
} from '../dist/video-capture.js';
import { defaultVideoSampling, videoArtifactCheck } from '../dist/video.js';

const example = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));

/** A stand-in for dist/cuekeeper-video. It never touches ScreenCaptureKit. */
const helperSource = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--preflight')) {
  console.log(JSON.stringify({ screenRecording: process.env.FAKE_VIDEO_PERMISSION === 'yes' }));
  process.exit(0);
}
const out = args[args.indexOf('--out') + 1];
if (process.env.FAKE_VIDEO_LOG) fs.appendFileSync(process.env.FAKE_VIDEO_LOG, 'capture\\n');
const mode = process.env.FAKE_VIDEO_MODE || 'complete';
if (mode === 'exit') {
  console.error(JSON.stringify({ error: { code: 'WINDOW_CLOSED' } }));
  process.exit(3);
}
if (mode === 'startup') {
  console.log(JSON.stringify({ error: { code: 'WINDOW_CLOSED', message: 'window vanished' } }));
  process.exit(3);
}
fs.writeFileSync(out, Buffer.alloc(4096, 7));
console.log(JSON.stringify({ kind: 'ready', width: 800, height: 600 }));
if (mode === 'partial') process.exit(0);
function finalize() {
  const final = out.replace(/[.]partial[.]mp4$/, '.mp4');
  if (mode === 'tiny') fs.writeFileSync(final, Buffer.alloc(10));
  else fs.renameSync(out, final);
  console.log(JSON.stringify({ kind: 'gap', fromMs: 1500, toMs: 3000, reason: 'unchanged' }));
  console.log(JSON.stringify({ kind: 'gap', fromMs: 3200, toMs: 5000, reason: 'unchanged' }));
  console.log(JSON.stringify({ kind: 'finalized', payload: {
    status: mode === 'truncated' ? 'truncated' : 'complete',
    ...(mode === 'truncated' ? { code: 'WINDOW_CLOSED', truncatedAtMs: 4200 } : {}),
    durationMs: 5000, frames: 3, timescale: 600, firstPtsMs: 0, width: 800, height: 600,
    firstSampleWallMs: Number(process.env.FAKE_VIDEO_WALL_START || (Date.now() - 500)),
  }}));
  process.exit(0);
}
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line === 'pause') console.log(JSON.stringify({ kind: 'paused', atMs: 100 }));
    else if (line === 'resume') console.log(JSON.stringify({ kind: 'resumed', atMs: 200 }));
    else if (line === 'stop') finalize();
  }
});
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-video-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, 'cuekeeper-video');
  writeFileSync(helper, helperSource, { mode: 0o755 });
  chmodSync(helper, 0o755);
  return { root, helper, media: join(root, 'media') };
}

async function capture(t, options = {}) {
  const { root, helper, media } = fixture(t);
  const env = {
    ...process.env,
    CUEKEEPER_VIDEO_CAPTURE: '1',
    FAKE_VIDEO_PERMISSION: 'yes',
    FAKE_VIDEO_MODE: options.mode ?? 'complete',
    ...(options.wallStart ? { FAKE_VIDEO_WALL_START: String(options.wallStart) } : {}),
    ...(options.log ? { FAKE_VIDEO_LOG: options.log } : {}),
  };
  const startedAt = new Date((options.wallStart ?? Date.now()) + 1500).toISOString();
  const session = await startVideoCapture({
    windowId: options.windowId ?? 'w-4242',
    reportStartedAt: startedAt,
    mediaDir: media,
    helper: options.helper ?? helper,
    env,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.masks ? { masks: options.masks } : {}),
    stopTimeoutMs: 5000,
  });
  const artifact = await session.stop();
  return { root, helper, media, session, artifact, startedAt };
}

test('window ids map to CGWindowID or fail closed', () => {
  assert.equal(cgWindowId('w-4242'), 4242);
  assert.equal(cgWindowId(17), 17);
  assert.equal(cgWindowId('w-not-a-number'), undefined);
  assert.equal(cgWindowId(0), undefined);
});

test('a denied screen-recording permission skips capture without spawning it', async t => {
  const { root, helper, media } = fixture(t);
  const log = join(root, 'spawned.log');
  const session = await startVideoCapture({
    windowId: 'w-1', reportStartedAt: new Date().toISOString(), mediaDir: media,
    helper, env: { ...process.env, CUEKEEPER_VIDEO_CAPTURE: '1', FAKE_VIDEO_PERMISSION: 'no', FAKE_VIDEO_LOG: log },
    stopTimeoutMs: 1000,
  });
  assert.equal(session.kind, 'unavailable');
  assert.deepEqual(await session.stop(), {
    kind: 'video', status: 'skipped', code: 'SCREEN_CAPTURE_NOT_AUTHORIZED',
  });
  assert.equal(existsSync(log), false, 'permission is checked before the capture process starts');
  assert.equal(existsSync(join(media, videoFile)), false);
});

test('a non-macOS platform or a missing helper fails closed', async t => {
  const { media } = fixture(t);
  const other = await startVideoCapture({
    windowId: 'w-1', reportStartedAt: new Date().toISOString(), mediaDir: media,
    platform: 'linux', helper: '/nonexistent/cuekeeper-video',
  });
  assert.equal((await other.stop()).code, 'ENCODE_UNAVAILABLE');

  const missing = await startVideoCapture({
    windowId: 'w-1', reportStartedAt: new Date().toISOString(), mediaDir: media,
    helper: '/nonexistent/cuekeeper-video', allowCapture: true,
  });
  assert.equal((await missing.stop()).code, 'ENCODE_UNAVAILABLE');
});

test('real capture stays closed until the machine opts in', async t => {
  const { root, helper, media } = fixture(t);
  const log = join(root, 'spawned.log');
  const env = { ...process.env, FAKE_VIDEO_PERMISSION: 'yes', FAKE_VIDEO_LOG: log };
  delete env.CUEKEEPER_VIDEO_CAPTURE;
  const session = await startVideoCapture({
    windowId: 'w-1', reportStartedAt: new Date().toISOString(), mediaDir: media, helper, env,
  });
  assert.equal(session.kind, 'unavailable');
  assert.deepEqual(await session.stop(), {
    kind: 'video', status: 'skipped', code: 'CAPTURE_DISABLED',
  });
  assert.equal(existsSync(log), false, 'the pre-signing gate runs before any helper spawn');
  assert.equal(existsSync(media), false, 'a closed gate creates no media directory');
});

test('a finalized capture becomes a playable artifact with merged idle gaps', async t => {
  const wallStart = Date.now() - 1000;
  const result = await capture(t, { wallStart });
  assert.equal(result.session.kind, 'capturing');
  assert.equal(result.artifact.status, 'complete');
  assert.equal(result.artifact.path, 'media/session.mp4');
  assert.equal(result.artifact.bytes, 4096);
  assert.equal(result.artifact.frames, 3);
  assert.equal(result.artifact.durationMs, 5000);
  assert.equal(result.artifact.timebase.timescale, 600);
  assert.equal(result.artifact.anchor.videoStartOffsetMs, -1500);
  assert.equal(result.artifact.anchor.method, 'host_clock');
  assert.deepEqual(result.artifact.gaps, [{ fromMs: 1500, toMs: 5000, reason: 'unchanged' }]);
  assert.ok(videoArtifactCheck.Check(result.artifact));
  assert.ok(existsSync(join(result.media, videoFile)));
  assert.equal(existsSync(join(result.media, 'session.partial.mp4')), false);
  assert.equal(readFileSync(join(result.media, videoFile)).length, 4096);
});

test('configured mask rectangles are recorded with the artifact', async t => {
  const masks = [{ x: 40, y: 60, width: 200, height: 24 }];
  const result = await capture(t, { masks });
  assert.deepEqual(result.artifact.maskedRegions, masks);
});

test('a truncated capture keeps the movie and records where it stopped', async t => {
  const result = await capture(t, { mode: 'truncated' });
  assert.equal(result.artifact.status, 'truncated');
  assert.equal(result.artifact.code, 'WINDOW_CLOSED');
  assert.equal(result.artifact.truncatedAtMs, 4200);
  assert.ok(existsSync(join(result.media, videoFile)));
});

test('an encoder that dies, or leaves a partial or tiny file, publishes nothing', async t => {
  const died = await capture(t, { mode: 'exit' });
  assert.deepEqual(died.artifact, { kind: 'video', status: 'skipped', code: 'WINDOW_CLOSED' });
  assert.equal(existsSync(join(died.media, 'session.partial.mp4')), false);

  // The native helper reports a missing window as a structured line on stdout
  // before it ever writes a file; that code must reach the artifact.
  const vanished = await capture(t, { mode: 'startup' });
  assert.deepEqual(vanished.artifact, { kind: 'video', status: 'skipped', code: 'WINDOW_CLOSED' });
  assert.equal(existsSync(join(vanished.media, 'session.partial.mp4')), false);

  const partial = await capture(t, { mode: 'partial' });
  assert.equal(partial.artifact.code, 'ENCODE_FAILED');
  assert.equal(existsSync(join(partial.media, 'session.partial.mp4')), false);
  assert.equal(existsSync(join(partial.media, videoFile)), false);

  const tiny = await capture(t, { mode: 'tiny' });
  assert.equal(tiny.artifact.code, 'ENCODE_FAILED');
  assert.equal(existsSync(join(tiny.media, videoFile)), false);
});

test('the video artifact schema rejects a complete movie without timing metadata', () => {
  const base = {
    kind: 'video', status: 'complete', path: 'media/session.mp4', bytes: 100,
    durationMs: 1000, frames: 2, codec: 'h264', container: 'mp4',
    width: 800, height: 600,
    anchor: { reportStartedAt: '2026-01-01T00:00:00.000Z', videoStartOffsetMs: 0, method: 'host_clock' },
    sampling: {
      thumbnail: '160x90', blockThreshold: defaultVideoSampling.blockThreshold,
      structuralBlocks: 4, maxFps: 10, churnMinIntervalMs: 500,
    },
  };
  assert.equal(videoArtifactCheck.Check(base), false, 'timebase is required');
  assert.equal(videoArtifactCheck.Check({ ...base, timebase: { timescale: 600, firstPtsMs: 0 } }), true);
  assert.equal(videoArtifactCheck.Check({ kind: 'video', status: 'skipped', code: 'ENCODE_FAILED' }), true);
  assert.equal(videoArtifactCheck.Check({
    kind: 'video', status: 'skipped', code: 'ENCODE_FAILED', path: 'media/session.mp4',
  }), false, 'a skipped movie may not point at a file');
});

test('the manifest schema covers the archive index and packing verifies bytes and digests', () => {
  const flow = parseFlow(example('textedit.flow'));
  const report = example('textedit.report');
  const packed = unzipSync(packReport(report, flow));
  const manifest = JSON.parse(strFromU8(packed['manifest.json']));
  assert.ok(manifestCheck.Check(manifest), 'the packed manifest validates');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['flow.json', 'index.html', 'report.json']);

  // Status conflicts and unknown fields are rejected by the published schema.
  assert.equal(manifestCheck.Check({ ...manifest, extra: true }), false);
  assert.equal(manifestCheck.Check({
    ...manifest,
    video: { kind: 'video', status: 'skipped', code: 'ENCODE_FAILED', path: 'media/session.mp4' },
  }), false, 'a skipped video may not declare a file');
  assert.equal(manifestCheck.Check({
    ...manifest, video: { kind: 'video', status: 'complete', code: 'ENCODE_FAILED' },
  }), false, 'a complete video may not carry a failure code');
  assert.equal(manifestCheck.Check({
    ...manifest, files: { 'index.html': { bytes: 1, sha256: 'not-a-digest' } },
  }), false);

  const contents = {
    'index.html': packed['index.html'],
    'report.json': packed['report.json'],
    'flow.json': packed['flow.json'],
  };
  verifyManifestFiles(manifest, contents);

  const truncated = new Uint8Array(contents['index.html'].subarray(0, 10));
  assert.throws(() => verifyManifestFiles(manifest, { ...contents, 'index.html': truncated }),
    /byte count does not match/);

  const sameLength = new Uint8Array(contents['index.html']);
  sameLength[0] ^= 0xff;
  assert.throws(() => verifyManifestFiles(manifest, { ...contents, 'index.html': sameLength }),
    /SHA-256 does not match/);

  assert.throws(() => verifyManifestFiles(manifest, {
    'report.json': contents['report.json'], 'flow.json': contents['flow.json'],
  }), /missing file: index\.html/);
});

test('packing carries media/, manifest.video and the video panel; old reports stay untouched', async t => {
  const wallStart = Date.now() - 1000;
  const result = await capture(t, { wallStart });
  writeFileSync(join(result.media, videoSidecarFile), JSON.stringify(result.artifact));
  const loaded = await loadVideoArtifact(result.media);
  assert.equal(loaded.video?.status, 'complete');
  assert.deepEqual(loaded.media.map(asset => [asset.path, asset.bytes.length]), [['media/session.mp4', 4096]]);

  const flow = parseFlow(example('textedit.flow'));
  const report = structuredClone(example('textedit.report'));
  assert.equal(report.entries.length, 3);
  const packed = unzipSync(packReport(report, flow, { ...loaded }));
  const manifest = JSON.parse(strFromU8(packed['manifest.json']));
  assert.deepEqual(manifest.video, result.artifact);
  assert.ok(packed['media/session.mp4']);
  assert.equal(manifest.files['media/session.mp4'].bytes, 4096);
  assert.ok(!manifest.assets.some(asset => asset.role === 'video'));
  const html = strFromU8(packed['index.html']);
  assert.match(html, /<video id="sessionVideo"[^>]*src="media\/session\.mp4"/);
  assert.match(html, /data-offset-ms="-1500"/);
  assert.match(html, /data-duration-ms="5000"/);
  assert.match(html, /media-src 'self' file: data:/);
  assert.doesNotMatch(html, /本报告未录制会话视频/);

  // An old report has no video key, no <video> and a single explanatory note.
  const legacy = unzipSync(packReport(report, flow));
  const legacyManifest = JSON.parse(strFromU8(legacy['manifest.json']));
  assert.equal('video' in legacyManifest, false);
  assert.equal(legacy['media/session.mp4'], undefined);
  const legacyHtml = strFromU8(legacy['index.html']);
  assert.doesNotMatch(legacyHtml, /<video/);
  assert.match(legacyHtml, /本报告未录制会话视频/);

  // A skipped capture records why, without an empty player.
  const skipped = { kind: 'video', status: 'skipped', code: 'SCREEN_CAPTURE_NOT_AUTHORIZED' };
  const skippedZip = unzipSync(packReport(report, flow, { video: skipped }));
  const skippedHtml = strFromU8(skippedZip['index.html']);
  assert.match(skippedHtml, /SCREEN_CAPTURE_NOT_AUTHORIZED/);
  assert.match(skippedHtml, /未授权屏幕录制/);
  assert.doesNotMatch(skippedHtml, /<video/);

  // A truncated movie is still playable: it packs with its media file and the
  // stop time that explains the early end.
  const cut = await capture(t, { mode: 'truncated' });
  const cutZip = unzipSync(packReport(report, flow, {
    video: cut.artifact,
    media: [{ path: 'media/session.mp4', bytes: readFileSync(join(cut.media, videoFile)) }],
  }));
  const cutManifest = JSON.parse(strFromU8(cutZip['manifest.json']));
  assert.equal(cutManifest.video.status, 'truncated');
  assert.equal(cutManifest.video.truncatedAtMs, 4200);
  assert.ok(cutZip['media/session.mp4']);
});

test('packing refuses media that is missing, mismatched, unreferenced or over the limit', async t => {
  const result = await capture(t);
  const flow = parseFlow(example('textedit.flow'));
  const report = example('textedit.report');

  assert.throws(() => packReport(report, flow, { video: result.artifact }),
    /Video artifact is missing/);
  assert.throws(() => packReport(report, flow, {
    video: result.artifact,
    media: [{ path: 'media/session.mp4', bytes: Buffer.alloc(10, 1) }],
  }), /size does not match/);
  assert.throws(() => packReport(report, flow, {
    media: [{ path: 'media/session.mp4', bytes: Buffer.alloc(2048, 1) }],
  }), /require a video artifact/);
  assert.throws(() => packReport(report, flow, {
    media: [{ path: '../escape.mp4', bytes: Buffer.alloc(2048, 1) }],
  }), /Invalid media path/);

  const oversized = { path: 'media/session.mp4', bytes: { length: mediaLimitBytes + 1 } };
  assert.throws(() => packReport(report, flow, {
    video: { ...result.artifact, bytes: oversized.bytes.length },
    media: [oversized],
  }), /MEDIA_TOO_LARGE/);

});

test('CLI pack includes media by default and --no-media drops it', async t => {
  const result = await capture(t);
  writeFileSync(join(result.media, videoSidecarFile), JSON.stringify(result.artifact));
  const runDirectory = join(result.root, 'run');
  mkdirSync(runDirectory, { recursive: true });
  const reportPath = join(runDirectory, 'report.json');
  writeFileSync(reportPath, JSON.stringify(example('textedit.report')));
  writeFileSync(join(runDirectory, 'flow.json'), JSON.stringify(example('textedit.flow')));
  mkdirSync(join(runDirectory, 'media'), { recursive: true });
  writeFileSync(join(runDirectory, 'media', videoSidecarFile), JSON.stringify(result.artifact));
  writeFileSync(join(runDirectory, 'media', videoFile), readFileSync(join(result.media, videoFile)));

  const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
  const withMedia = join(result.root, 'with.zip');
  const full = spawnSync(process.execPath, [cli, 'report', 'pack', reportPath,
    '--flow', join(runDirectory, 'flow.json'), '--out', withMedia, '--no-upload', '--json'],
  { encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  assert.ok(unzipSync(readFileSync(withMedia))['media/session.mp4']);

  const without = join(result.root, 'without.zip');
  const slim = spawnSync(process.execPath, [cli, 'report', 'pack', reportPath,
    '--flow', join(runDirectory, 'flow.json'), '--out', without, '--no-media', '--no-upload', '--json'],
  { encoding: 'utf8' });
  assert.equal(slim.status, 0, slim.stderr);
  const files = unzipSync(readFileSync(without));
  assert.equal(files['media/session.mp4'], undefined);
  assert.equal('video' in JSON.parse(strFromU8(files['manifest.json'])), false);
});

test('the upload queue receives a bundle without session media', async t => {
  const result = await capture(t);
  const runDirectory = join(result.root, 'run');
  mkdirSync(join(runDirectory, 'media'), { recursive: true });
  writeFileSync(join(runDirectory, 'report.json'), JSON.stringify(example('textedit.report')));
  writeFileSync(join(runDirectory, 'flow.json'), JSON.stringify(example('textedit.flow')));
  writeFileSync(join(runDirectory, 'media', videoSidecarFile), JSON.stringify(result.artifact));
  writeFileSync(join(runDirectory, 'media', videoFile), readFileSync(join(result.media, videoFile)));

  const queue = join(result.root, 'queue');
  const output = join(result.root, 'report.zip');
  const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
  const packed = spawnSync(process.execPath, [cli, 'report', 'pack', join(runDirectory, 'report.json'),
    '--flow', join(runDirectory, 'flow.json'), '--out', output, '--queue', queue, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, HOME: result.root,
      CUEKEEPER_UPLOAD_URL: 'http://127.0.0.1:1', CUEKEEPER_UPLOAD_PROJECT: 'p1',
      CUEKEEPER_UPLOAD_TOKEN_ENV: 'CQ_TEST_TOKEN', CQ_TEST_TOKEN: 'token',
    },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const data = JSON.parse(packed.stdout).data;
  assert.equal(data.upload.queued, true);
  assert.equal(data.upload.bundle, join(result.root, 'report.upload.zip'));

  // The local ZIP is the full archive and keeps the movie.
  assert.ok(unzipSync(readFileSync(output))['media/session.mp4']);

  // The queued ZIP is the one that would be uploaded: no movie, no video
  // metadata, no empty player and no dangling media reference.
  const item = JSON.parse(readFileSync(join(queue, `${data.upload.id}.json`), 'utf8'));
  const uploaded = readFileSync(item.bundlePath);
  assert.equal(item.bundleBytes, uploaded.length);
  const files = unzipSync(uploaded);
  assert.equal(files['media/session.mp4'], undefined);
  assert.equal('video' in JSON.parse(strFromU8(files['manifest.json'])), false);
  const html = strFromU8(files['index.html']);
  assert.doesNotMatch(html, /<video/);
  assert.doesNotMatch(html, /media\/session\.mp4/);
  assert.match(html, /本报告未录制会话视频/);
});

test('CLI keeps session video opt-in, report-bound and out of dry runs', () => {
  const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
  const run = args => spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' });
  const dry = run(['run', 'examples/textedit.flow.json', '--dry-run',
    '--snapshot', 'examples/textedit.snapshot.json', '--report', join(tmpdir(), 'never-written.json'), '--video']);
  assert.equal(dry.status, 2);
  assert.match(JSON.parse(dry.stdout).error.message, /--video requires a real replay/);

  const unattached = run(['run', 'examples/textedit.flow.json', '--video']);
  assert.equal(unattached.status, 2);
  assert.match(JSON.parse(unattached.stdout).error.message, /--video requires --report/);

  const badMask = run(['run', 'examples/textedit.flow.json', '--video',
    '--report', join(tmpdir(), 'never-written.json'), '--video-mask', '10,20,30']);
  assert.equal(badMask.status, 2);
  assert.match(JSON.parse(badMask.stdout).error.message, /--video-mask expects/);
});


test('pause and resume reach the helper and are reported as events', async t => {
  const { helper, media } = fixture(t);
  const events = [];
  const session = await startVideoCapture({
    windowId: 'w-77', reportStartedAt: new Date().toISOString(), mediaDir: media, helper,
    env: { ...process.env, CUEKEEPER_VIDEO_CAPTURE: '1', FAKE_VIDEO_PERMISSION: 'yes' },
    onEvent: event => events.push(event), stopTimeoutMs: 5000,
  });
  const until = async predicate => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the helper event');
  };
  assert.equal(session.pause(), true);
  await until(() => events.some(event => event.kind === 'paused'));
  assert.equal(session.resume(), true);
  await until(() => events.some(event => event.kind === 'resumed'));
  const artifact = await session.stop();
  assert.equal(artifact.status, 'complete');
  assert.deepEqual(events.filter(event => event.kind === 'paused' || event.kind === 'resumed')
    .map(event => [event.kind, event.atMs]), [['paused', 100], ['resumed', 200]]);
});
