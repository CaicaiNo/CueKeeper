import { link, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

export async function ensureNew(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Output already exists: ${path}`);
}

export async function writeNew(path: string, contents: string | Uint8Array) {
  const directory = await mkdtemp(join(dirname(resolve(path)), '.cuekeeper-'));
  try {
    const staged = join(directory, 'output');
    await writeFile(staged, contents, { mode: 0o600 });
    // link publishes the whole file and fails if another writer created the destination.
    await link(staged, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
