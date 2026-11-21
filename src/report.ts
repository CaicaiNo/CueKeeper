import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { reportCheck } from './contracts.js';
import type { Flow, Report } from './contracts.js';
import { hashFlow, plan } from './flow.js';
import { decorateAsset } from './assets.js';
import type { PackAsset, RawAsset } from './assets.js';
import { renderViewer } from './viewer.js';

export interface PackOptions {
  /** Files to publish under assets/. Paths are relative to the asset root. */
  assets?: RawAsset[];
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

export function packReport(input: unknown, flow: Flow, options: PackOptions = {}): Uint8Array {
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
  const viewer = renderViewer(input, flow, steps, assets);
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(viewer.html),
    'report.json': json(input),
    'flow.json': json(flow),
  };
  for (const asset of assets) files[`assets/${asset.path}`] = asset.bytes;
  const manifest = {
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
  };
  // A fixed timestamp keeps packing reproducible for the same report and assets.
  return zipSync({ ...files, 'manifest.json': json(manifest) }, { mtime: new Date(1980, 0, 1) });
}
