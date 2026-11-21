import { execFile } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type AppIdentity = {
  bundleId: string;
  name: string;
  paths: string[];
  label: string;
  icon?: string;
};

const cache = new Map<string, Omit<AppIdentity, 'label'>>();
const iconCache = new Map<string, Buffer | undefined>();

async function installedPaths(bundleId: string) {
  try {
    const { stdout } = await run(
      'mdfind',
      [`kMDItemCFBundleIdentifier == "${bundleId.replaceAll('"', '\\"')}"`],
      { timeout: 4000, maxBuffer: 1024 * 1024 },
    );
    return [...new Set(stdout.split('\n').map(line => line.trim())
      .filter(path => path.endsWith('.app')))];
  } catch {
    return [];
  }
}

async function displayName(path: string) {
  try {
    const { stdout } = await run('mdls', ['-name', 'kMDItemDisplayName', '-raw', path], {
      timeout: 3000, maxBuffer: 64 * 1024,
    });
    const name = stdout.trim();
    if (name && name !== '(null)') return name.replace(/\.app$/i, '');
  } catch {
    // Spotlight metadata is optional; fall back to the bundle filename.
  }
  return basename(path).replace(/\.app$/i, '');
}

async function iconPng(path: string) {
  if (iconCache.has(path)) return iconCache.get(path);
  let icon: Buffer | undefined;
  try {
    const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')], {
      timeout: 3000, maxBuffer: 256 * 1024,
    });
    const info = JSON.parse(stdout) as { CFBundleIconFile?: string; CFBundleIconName?: string };
    const name = info.CFBundleIconFile ?? info.CFBundleIconName;
    if (name) {
      const file = join(path, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`);
      const directory = await mkdtemp(join(tmpdir(), 'cuekeeper-icon-'));
      const output = join(directory, 'icon.png');
      try {
        await run('sips', ['-s', 'format', 'png', file, '--out', output, '-Z', '64'], { timeout: 4000 });
        icon = await readFile(output);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  } catch {
    icon = undefined;
  }
  iconCache.set(path, icon);
  return icon;
}

export async function appIconPng(path: string) {
  return iconPng(path);
}

async function appIcon(path: string) {
  const png = await iconPng(path);
  return png ? `data:image/png;base64,${png.toString('base64')}` : undefined;
}

export async function describeApps(bundleIds: string[], hints: Record<string, string> = {}) {
  const unique = [...new Set(bundleIds.filter(Boolean))];
  const entries = await Promise.all(unique.map(async bundleId => {
    const known = cache.get(bundleId);
    if (known) return known;
    const paths = await installedPaths(bundleId);
    const name = paths.length
      ? await displayName(paths[0])
      : hints[bundleId] ?? bundleId;
    const identity = { bundleId, name, paths, icon: paths.length ? await appIcon(paths[0]) : undefined };
    cache.set(bundleId, identity);
    return identity;
  }));
  const names = new Map<string, number>();
  for (const entry of entries) names.set(entry.name, (names.get(entry.name) ?? 0) + 1);
  return Object.fromEntries(entries.map(entry => {
    const parts = [entry.name];
    if (names.get(entry.name)! > 1) parts.push(entry.bundleId);
    if (entry.paths.length > 1) parts.push(`${entry.paths.length} 份`);
    return [entry.bundleId, { ...entry, label: parts.join(' · ') }];
  })) as Record<string, AppIdentity>;
}
