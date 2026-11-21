import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type AppIdentity = {
  bundleId: string;
  name: string;
  paths: string[];
  label: string;
};

const cache = new Map<string, Omit<AppIdentity, 'label'>>();

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

export async function describeApps(bundleIds: string[], hints: Record<string, string> = {}) {
  const unique = [...new Set(bundleIds.filter(Boolean))];
  const entries = await Promise.all(unique.map(async bundleId => {
    const known = cache.get(bundleId);
    if (known) return known;
    const paths = await installedPaths(bundleId);
    const name = paths.length
      ? await displayName(paths[0])
      : hints[bundleId] ?? bundleId;
    const identity = { bundleId, name, paths };
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
