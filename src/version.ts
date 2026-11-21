import { readFileSync } from 'node:fs';

/** Build metadata written by `scripts/package.mjs` for a packaged release. */
export interface BuildInfo {
  version: string;
  commit?: string;
  arch?: string;
  builtAt?: string;
  node?: string;
}

const unset: BuildInfo = { version: '0.0.0' };
let cached: BuildInfo | undefined;

function readJson(url: URL) {
  try {
    const value: unknown = JSON.parse(readFileSync(url, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ?
      value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the running version in both layouts:
 * a source checkout (`dist/version.js` → `../package.json`) and a packaged
 * release (`lib/dist/version.js` → `lib/build-info.json`, `lib/package.json`).
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  const packaged = readJson(new URL('../build-info.json', import.meta.url));
  const manifest = packaged ?? readJson(new URL('../package.json', import.meta.url));
  const version = text(manifest?.version);
  if (!version) {
    cached = unset;
    return cached;
  }
  cached = {
    version,
    ...(text(manifest?.commit) ? { commit: text(manifest?.commit) } : {}),
    ...(text(manifest?.arch) ? { arch: text(manifest?.arch) } : {}),
    ...(text(manifest?.builtAt) ? { builtAt: text(manifest?.builtAt) } : {}),
    ...(text(manifest?.node) ? { node: text(manifest?.node) } : {}),
  };
  return cached;
}

/** One-line version string: `cuekeeper 0.1.0 (abc1234)`. */
export function versionLine(info: BuildInfo = buildInfo()) {
  return `cuekeeper ${info.version}${info.commit ? ` (${info.commit})` : ''}`;
}
