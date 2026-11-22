import { link, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Shared destination for recordings made without an explicit `--out`. */
export function recordingsDirectory() {
  return join(homedir(), '.cuekeeper', 'recordings');
}

/** `~/.cuekeeper/recordings` for the shell hint, since this is a user path. */
export function displayRecordingsDirectory() {
  const home = homedir();
  const directory = recordingsDirectory();
  return directory.startsWith(home + '/') ? `~${directory.slice(home.length)}` : directory;
}

/** `recording-20261122T042530Z.flow.json`, with a filesystem-safe UTC stamp. */
export function recordingFileName(when: Date) {
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `recording-${stamp}.flow.json`;
}

/**
 * Write a recording next to other one-key recordings without ever replacing
 * one. The first free suffixed name wins, so an overwrite cannot happen even
 * if another process created the file between the check and the write.
 */
export async function writeRecording(directory: string, name: string, contents: string) {
  const stem = name.replace(/\.flow\.json$/i, '');
  for (let nth = 1; nth <= 100; nth++) {
    const path = resolve(join(directory, nth === 1 ? name : `${stem}-${nth}.flow.json`));
    const staging = await mkdtemp(join(dirname(path), '.cuekeeper-'));
    try {
      const staged = join(staging, 'output');
      await writeFile(staged, contents, { mode: 0o600 });
      // `link` publishes the whole file and fails with EEXIST when the name is taken.
      await link(staged, path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  throw new Error(`No free recording name left in ${directory}`);
}
