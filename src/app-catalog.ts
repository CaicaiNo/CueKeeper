import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type CatalogApp = {
  bundleId: string;
  name: string;
  paths: string[];
  label: string;
};

type Listing = {
  bundleId: string;
  name: string;
  paths: string[];
};

let cache: { at: number; apps: CatalogApp[] } | undefined;

const roots = ['/Applications', '/System/Applications', `${homedir()}/Applications`];
const visibleApp = (path: string) => roots.some(root => path.startsWith(`${root}/`));

function installName(path: string) {
  return basename(path).replace(/\.app$/i, '');
}

async function bundleIds(paths: string[]) {
  const ids: Array<string | undefined> = [];
  for (let index = 0; index < paths.length; index += 80) {
    const chunk = paths.slice(index, index + 80);
    try {
      const { stdout } = await run('mdls', ['-name', 'kMDItemCFBundleIdentifier', ...chunk], {
        timeout: 8000, maxBuffer: 2 * 1024 * 1024,
      });
      const lines = stdout.split('\n').filter(line => line.includes('='));
      for (let offset = 0; offset < chunk.length; offset++) {
        ids[index + offset] = lines[offset]?.match(/"([^"]+)"/)?.[1];
      }
    } catch {
      ids.length = index + chunk.length;
    }
  }
  return ids;
}

export async function listApps(): Promise<CatalogApp[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.apps;
  let entries: Array<{ name: string; path: string }> = [];
  try {
    const { stdout } = await run('system_profiler', ['SPApplicationsDataType', '-json'], {
      timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { SPApplicationsDataType?: Array<{ _name?: unknown; path?: unknown }> };
    entries = (parsed.SPApplicationsDataType ?? [])
      .map(item => ({ name: typeof item._name === 'string' ? item._name : '', path: typeof item.path === 'string' ? item.path : '' }))
      .filter(item => item.path.endsWith('.app') && visibleApp(item.path));
  } catch {
    return [];
  }
  const ids = await bundleIds(entries.map(entry => entry.path));
  const grouped = new Map<string, Listing>();
  entries.forEach((entry, index) => {
    const bundleId = ids[index];
    if (!bundleId) return;
    const known = grouped.get(bundleId);
    const name = entry.name || installName(entry.path);
    if (known) {
      if (!known.paths.includes(entry.path)) known.paths.push(entry.path);
    } else {
      grouped.set(bundleId, { bundleId, name, paths: [entry.path] });
    }
  });
  const listings = [...grouped.values()];
  const names = new Map<string, number>();
  for (const app of listings) names.set(app.name, (names.get(app.name) ?? 0) + 1);
  const apps = listings.map(app => {
    const parts = [app.name];
    if (names.get(app.name)! > 1) parts.push(app.bundleId);
    if (app.paths.length > 1) parts.push(`${app.paths.length} 份`);
    return { ...app, label: parts.join(' · ') };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  cache = { at: Date.now(), apps };
  return apps;
}
