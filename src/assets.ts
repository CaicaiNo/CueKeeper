import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

/** A file read from disk. `path` is relative to the asset root and always uses "/". */
export interface RawAsset {
  path: string;
  bytes: Uint8Array;
}

export type AssetRole = 'screenshot-before' | 'screenshot-after' | 'screenshot' | 'assertion-baseline' |
  'assertion-actual' | 'log' | 'snapshot' | 'file' | 'video' | 'filmstrip';

export interface PackAsset extends RawAsset {
  /** Report entry this asset belongs to, when the asset was grouped under an entry id. */
  entryId?: string;
  role: AssetRole;
  /** UTF-8 preview for logs and accessibility snapshots. */
  text?: string;
}

const looseExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.log']);
const textExtensions = new Set(['.log', '.txt', '.md', '.json', '.jsonl']);
const previewLimit = 20_000;

async function isDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(root: string, current: string, depth: number, seen: RawAsset[]) {
  if (depth > 8) throw new Error(`Asset directory is nested too deeply: ${current}`);
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    const info = await lstat(path);
    // Symlinks are deliberately skipped: an asset bundle may not reach outside its root.
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await walk(root, path, depth + 1, seen);
      continue;
    }
    if (!info.isFile()) continue;
    const relative = path.slice(root.length + 1).split(/[\\/]/).join('/');
    seen.push({ path: relative, bytes: await readFile(path) });
  }
}

export async function collectAssets(directory: string): Promise<RawAsset[]> {
  const root = resolve(directory);
  if (!await isDirectory(root)) throw new Error(`Asset directory not found: ${directory}`);
  const assets: RawAsset[] = [];
  await walk(root, root, 0, assets);
  return assets;
}

/**
 * Assets are looked up the way a run directory is laid out:
 * an explicit `--assets` directory, then `<report dir>/assets`, then loose
 * screenshots and logs next to the report. Everything is optional.
 */
export async function discoverAssets(reportPath: string, requested?: string): Promise<RawAsset[]> {
  const evidence = `${resolve(reportPath)}.assets`;
  const evidenceAssets = await isDirectory(evidence) ? await collectAssets(evidence) : [];
  if (requested) return [...await collectAssets(requested), ...evidenceAssets];
  const directory = dirname(resolve(reportPath));
  const assets = join(directory, 'assets');
  const found: RawAsset[] = [];
  if (await isDirectory(assets)) found.push(...await collectAssets(assets));
  else {
    const names = await readdir(directory, { withFileTypes: true });
    const loose: RawAsset[] = [];
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!looseExtensions.has(extension)) continue;
      loose.push({ path: entry.name, bytes: await readFile(join(directory, entry.name)) });
    }
    found.push(...loose);
  }
  // Assertion evidence keeps expanded step directories under `<report>.assets`.
  found.push(...evidenceAssets);
  return found;
}

export function decorateAsset(asset: RawAsset, entryId: string | undefined, path: string): PackAsset {
  const extension = extname(path).toLowerCase();
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  let role: AssetRole;
  if (base === 'assertion-baseline.png') role = 'assertion-baseline';
  else if (base === 'assertion-actual.png') role = 'assertion-actual';
  else if (/(^|[._-])before([._-]|$)/.test(base)) role = 'screenshot-before';
  else if (/(^|[._-])after([._-]|$)/.test(base)) role = 'screenshot-after';
  else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) role = 'screenshot';
  else if (extension === '.mp4' || extension === '.mov') role = 'video';
  else if (extension === '.log' || extension === '.txt') role = 'log';
  else if (extension === '.json' || extension === '.jsonl') role = 'snapshot';
  else role = 'file';

  let text: string | undefined;
  if (textExtensions.has(extension)) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(asset.bytes);
    if (text.length > previewLimit) {
      text = `${text.slice(0, previewLimit)}\n… 预览已截断，完整内容见归档文件`;
    }
  }
  return { path, bytes: asset.bytes, role, ...(entryId ? { entryId } : {}), ...(text !== undefined ? { text } : {}) };
}
