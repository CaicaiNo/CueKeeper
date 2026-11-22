import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { manifestCheck, reportCheck } from './contracts.js';
import type { Flow, Manifest, Report } from './contracts.js';
import { hashFlow, plan } from './flow.js';
import { flowHasShellDefinitions } from './shell.js';
import { decorateAsset } from './assets.js';
import type { PackAsset, RawAsset } from './assets.js';
import { renderViewer } from './viewer.js';
import { videoArtifactCheck } from './video.js';
import type { VideoArtifact } from './video.js';

/** Packing warns above this media size and refuses above the hard limit. */
export const mediaWarnBytes = 128 * 1024 * 1024;
export const mediaLimitBytes = 512 * 1024 * 1024;

export interface PackOptions {
  /** Files to publish under assets/. Paths are relative to the asset root. */
  assets?: RawAsset[];
  /** Movie files to publish under media/. Paths are archive-relative. */
  media?: RawAsset[];
  /** Optional session video metadata, written to manifest.video. */
  video?: VideoArtifact;
  /** Receives size warnings; the CLI prints them to stderr. */
  onWarning?: (message: string) => void;
}

function json(value: unknown) {
  return strToU8(JSON.stringify(value, null, 2) + '\n');
}

function normalizePath(path: string, original: string) {
  let value = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (value.startsWith('assets/')) value = value.slice('assets/'.length);
  if (!value || value.startsWith('/') || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid asset path: ${original}`);
  }
  return value;
}

/**
 * Assets follow `assets/<step-id>/<name>` so a failure is visible next to the
 * step it belongs to. Files that do not start with a step id stay global.
 */
function attachAssets(raw: RawAsset[], entries: Report['entries']): PackAsset[] {
  const ids = [...new Set(entries.map(entry => entry.id))].sort((left, right) => right.length - left.length);
  const attached: PackAsset[] = [];
  const seen = new Set<string>();
  for (const asset of [...raw].sort((left, right) => left.path.localeCompare(right.path))) {
    const path = normalizePath(asset.path, asset.path);
    let entryId: string | undefined;
    let relative = path;
    for (const id of ids) {
      if (path.startsWith(`${id}/`)) {
        entryId = id;
        relative = path.slice(id.length + 1);
        break;
      }
    }
    if (!relative) throw new Error(`Invalid asset path: ${asset.path}`);
    const destination = entryId ? `${entryId}/${relative}` : relative;
    if (seen.has(destination)) throw new Error(`Duplicate asset path: ${destination}`);
    seen.add(destination);
    attached.push(decorateAsset(asset, entryId, destination));
  }
  return attached;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const mediaPattern = /^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:mp4|mov)$/;

/**
 * Media are validated separately from assets: they are archive-relative, never
 * grouped under a step, and must be backed by a video artifact that names them.
 */
function attachMedia(raw: RawAsset[], video: VideoArtifact | undefined, warn?: (message: string) => void) {
  const media: RawAsset[] = [];
  const seen = new Set<string>();
  for (const asset of raw) {
    const path = asset.path.replace(/\\/g, '/');
    if (!mediaPattern.test(path)) throw new Error(`Invalid media path: ${asset.path}`);
    if (seen.has(path)) throw new Error(`Duplicate media path: ${path}`);
    seen.add(path);
    media.push({ path, bytes: asset.bytes });
  }
  const total = media.reduce((sum, asset) => sum + asset.bytes.length, 0);
  if (total > mediaLimitBytes) throw new Error('MEDIA_TOO_LARGE: media exceeds the 512 MB packing limit');
  if (total > mediaWarnBytes) warn?.(`媒体超过 128 MB（${(total / 1_048_576).toFixed(1)} MB），归档会很大；可用 --no-media 剔除`);
  if (!video) {
    if (media.length) throw new Error('Media files require a video artifact');
    return [];
  }
  if (!videoArtifactCheck.Check(video)) throw new Error('Invalid video manifest');
  if (video.status === 'skipped') {
    if (media.length) throw new Error('A skipped video must not publish media files');
    return [];
  }
  const file = media.find(asset => asset.path === video.path);
  if (!file) throw new Error(`Video artifact is missing: ${video.path}`);
  if (file.bytes.length !== video.bytes) throw new Error('Video artifact size does not match the manifest');
  if (media.some(asset => asset.path !== video.path)) {
    throw new Error('Media file is not referenced by the video artifact');
  }
  return media.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * `manifest.json` is the only index a reader trusts, so every declared file
 * must exist with the declared byte count and SHA-256. Packing runs this on its
 * own output, and packaging tools can reuse it on an edited archive.
 */
export function verifyManifestFiles(manifest: Manifest, contents: Record<string, Uint8Array>) {
  for (const [path, entry] of Object.entries(manifest.files)) {
    const bytes = contents[path];
    if (!bytes) throw new Error(`Manifest lists a missing file: ${path}`);
    if (bytes.length !== entry.bytes) throw new Error(`Manifest byte count does not match: ${path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Manifest SHA-256 does not match: ${path}`);
    }
  }
  for (const path of Object.keys(contents)) {
    if (!(path in manifest.files)) throw new Error(`Manifest omits an archived file: ${path}`);
  }
}

export function packReport(input: unknown, flow: Flow, options: PackOptions = {}): Uint8Array {
  // A packed report embeds the raw flow; shell steps may carry commands and
  // environment references that must not be published.
  if (flowHasShellDefinitions(flow)) {
    throw new Error('Report packing is unavailable for flows with shell steps');
  }
  if (!reportCheck.Check(input)) throw new Error('Invalid v1 report');
  if (input.flowId !== flow.id || input.flowSha256 !== hashFlow(flow)) {
    throw new Error('Report and flow do not match');
  }

  const steps = plan(flow);
  const actionEntries = input.entries.filter(entry => entry.kind !== 'setup');
  if (actionEntries.length !== steps.length || steps.some(({ id, action }, index) =>
    actionEntries[index].id !== id || actionEntries[index].kind !== action.kind)) {
    throw new Error('Report timeline does not match the flow');
  }

  const assets = attachAssets(options.assets ?? [], input.entries);
  const assertions = new Map(steps.flatMap(({ id, action }) =>
    action.kind === 'assert' ? [[id, action.check.expect] as const] : []));
  for (const entry of input.entries) {
    if (entry.kind !== 'assert' || !entry.assertion) continue;
    const expected = assertions.get(entry.id);
    if (expected === undefined || canonical(entry.assertion.expected) !== canonical(expected)) {
      throw new Error('Assertion expected value does not match the flow');
    }
    const screenshots = 'screenshots' in entry.assertion ? entry.assertion.screenshots : undefined;
    if (!screenshots) continue;
    const digest = 'baseline' in expected ? expected.baseline.sha256 : undefined;
    for (const [role, path] of Object.entries(screenshots)) {
      if (typeof path !== 'string') continue;
      if (path !== `assets/${entry.id}/assertion-${role}.png`) {
        throw new Error('Assertion evidence path does not match its report entry');
      }
      const asset = assets.find(candidate => `assets/${candidate.path}` === path);
      if (!asset) throw new Error(`Assertion evidence is missing: ${path}`);
      if (role === 'baseline' && digest &&
          createHash('sha256').update(asset.bytes).digest('hex') !== digest) {
        throw new Error('Assertion baseline evidence does not match the flow digest');
      }
    }
  }

  const media = attachMedia(options.media ?? [], options.video, options.onWarning);
  const viewer = renderViewer(input, flow, steps, assets, options.video);
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(viewer.html),
    'report.json': json(input),
    'flow.json': json(flow),
  };
  for (const asset of assets) files[`assets/${asset.path}`] = asset.bytes;
  for (const asset of media) files[asset.path] = asset.bytes;
  const manifest: Manifest = {
    version: 1,
    flowId: input.flowId,
    flowSha256: input.flowSha256,
    reportStartedAt: input.startedAt,
    files: Object.fromEntries(Object.entries(files).map(([path, contents]) => [
      path, { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') },
    ])),
    assets: assets.map(asset => ({
      path: `assets/${asset.path}`,
      ...(asset.entryId ? { entryId: asset.entryId } : {}),
      role: asset.role,
      bytes: asset.bytes.length,
    })),
    ...(options.video ? { video: options.video } : {}),
  };
  if (!manifestCheck.Check(manifest)) throw new Error('Invalid manifest');
  verifyManifestFiles(manifest, files);
  // A fixed timestamp keeps packing reproducible for the same report and assets.
  return zipSync({ ...files, 'manifest.json': json(manifest) }, { mtime: new Date(1980, 0, 1) });
}
