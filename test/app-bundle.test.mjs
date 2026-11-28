import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assembleApp, infoPlist } from '../scripts/app-bundle.mjs';

test('the app bundle carries the shell, the release and the icon', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-app-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = join(root, 'release');
  await mkdir(join(release, 'lib', 'dist'), { recursive: true });
  await mkdir(join(release, 'lib', 'workbench'), { recursive: true });
  await mkdir(join(release, 'runtime'), { recursive: true });
  await writeFile(join(release, 'lib', 'dist', 'cli.js'), 'console.log("workbench")\n');
  await writeFile(join(release, 'lib', 'workbench', 'index.html'), '<title>CueKeeper</title>\n');
  await writeFile(join(release, 'runtime', 'node'), '#!/bin/sh\n');

  const binary = join(root, 'CueKeeper');
  await writeFile(binary, 'app shell\n');
  const icon = join(root, 'icon.icns');
  await writeFile(icon, 'icon\n');
  const out = join(root, 'out');
  await mkdir(out);

  const app = assembleApp({ releaseDir: release, binary, outDir: out, version: '9.8.7', iconPath: icon });
  assert.equal(await readFile(join(app, 'Contents', 'MacOS', 'CueKeeper'), 'utf8'), 'app shell\n');
  assert.equal(
    await readFile(join(app, 'Contents', 'Resources', 'cuekeeper', 'lib', 'dist', 'cli.js'), 'utf8'),
    'console.log("workbench")\n');
  assert.equal(await readFile(join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8'), 'icon\n');

  const plist = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, /<string>com\.cuekeeper\.app<\/string>/);
  assert.match(plist, /<string>9\.8\.7<\/string>/);
  assert.match(plist, /<string>CueKeeper<\/string>/);
  assert.match(plist, /<string>AppIcon<\/string>/);
  assert.match(plist, /<key>NSAccessibilityUsageDescription<\/key>/);
  if (process.platform === 'darwin') {
    execFileSync('plutil', ['-lint', join(app, 'Contents', 'Info.plist')], { stdio: 'ignore' });
  }
});

test('the plist escapes metadata', () => {
  const plist = infoPlist({ version: '1.0.0', name: 'Cue & Keeper' });
  assert.match(plist, /Cue &amp; Keeper/);
});
