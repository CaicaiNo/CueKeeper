import assert from 'node:assert/strict';
import test from 'node:test';
import { InstallState } from '../dist/install-state.js';

// Install evidence is read from an in-memory filesystem and process table: no
// real download, installer or uninstaller runs in this file.

function fakeInstallState(options = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const directories = new Set(options.directories ?? ['/Users/qa/Downloads']);
  const bundles = new Map(Object.entries(options.bundles ?? {}));
  const receipts = [...(options.receipts ?? [])];
  const processes = new Map(Object.entries(options.processes ?? {}).map(([pid, facts]) => [Number(pid), facts]));
  const calls = [];

  const factsOf = path => {
    if (directories.has(path)) {
      return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
    }
    const file = files.get(path);
    if (file === undefined) return undefined;
    const facts = typeof file === 'number' ? { size: file, mtimeMs: 1000 } : file;
    return { isFile: () => true, isDirectory: () => false, ...facts };
  };

  const state = new InstallState({
    async stat(path) { calls.push(['stat', path]); return factsOf(path); },
    async readdir(directory) {
      calls.push(['readdir', directory]);
      if (!directories.has(directory)) return undefined;
      const prefix = `${directory}/`;
      return [...directories, ...files.keys()]
        .filter(path => path.startsWith(prefix))
        .map(path => path.slice(prefix.length))
        .filter(name => name && !name.includes('/'));
    },
    async bundleId(path) { calls.push(['bundleId', path]); return bundles.get(path); },
    async receipts() { return receipts; },
    async process(pid) { calls.push(['process', pid]); return processes.get(pid); },
  });
  return { state, files, directories, bundles, receipts, processes, calls };
}

const download = '/Users/qa/Downloads';

test('a completed download must be one uniquely located, finished file', async t => {
  const { state, files } = fakeInstallState({
    files: {
      [`${download}/CuekeeperTest.pkg`]: 2048,
    },
  });

  const found = await state.locateDownload({ directory: download, name: 'CuekeeperTest.pkg' });
  assert.equal(found.path, `${download}/CuekeeperTest.pkg`);
  assert.equal(found.size, 2048);

  // A download the system suffixed is still the same single file.
  files.set(`${download}/CuekeeperTest (1).pkg`, 4096);
  const suffixed = await state.locateDownload({ directory: download, suffix: 'CuekeeperTest (1).pkg' });
  assert.equal(suffixed.path, `${download}/CuekeeperTest (1).pkg`);

  await assert.rejects(state.locateDownload({ directory: download, suffix: '.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_AMBIGUOUS');
    return true;
  });
  await assert.rejects(state.locateDownload({ directory: download, name: 'Missing.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_NOT_FOUND');
    return true;
  });
  await assert.rejects(state.locateDownload({ directory: '/Users/qa/Nope', name: 'a.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_PATH_INVALID');
    return true;
  });
  await assert.rejects(state.locateDownload({ directory: 'Downloads', name: 'a.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_PATH_INVALID');
    return true;
  });
  await assert.rejects(state.locateDownload({ directory: download, name: '../a.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_PATH_INVALID');
    return true;
  });
});

test('a partial or empty download is not a completed one', async t => {
  const { state, files } = fakeInstallState({
    files: {
      [`${download}/CuekeeperTest.pkg.crdownload`]: 100,
      [`${download}/Empty.pkg`]: 0,
    },
  });
  await assert.rejects(state.locateDownload({ directory: download, suffix: '.crdownload' }), error => {
    assert.equal(error.code, 'DOWNLOAD_INCOMPLETE');
    return true;
  });
  await assert.rejects(state.locateDownload({ directory: download, name: 'Empty.pkg' }), error => {
    assert.equal(error.code, 'DOWNLOAD_INCOMPLETE');
    return true;
  });

  // A file that predates this recording is not evidence for this download.
  files.set(`${download}/Old.pkg`, { size: 10, mtimeMs: 100 });
  await assert.rejects(state.locateDownload({
    directory: download, name: 'Old.pkg', notBeforeMs: 500,
  }), error => {
    assert.equal(error.code, 'DOWNLOAD_NOT_FOUND');
    return true;
  });
});

test('installed evidence needs a matching bundle or a pkg receipt, never a process', async t => {
  const app = 'com.example.CuekeeperTest';
  const appPath = '/Applications/CuekeeperTest.app';
  const { state, bundles, receipts, processes } = fakeInstallState({
    directories: [appPath],
    bundles: { [appPath]: app },
    receipts: ['com.example.CuekeeperTest.pkg'],
    processes: { 4321: { pid: 4321, bundleId: app, startedAt: '4321.1' } },
  });

  const bundleOnly = fakeInstallState({ directories: [appPath], bundles: { [appPath]: app } });
  assert.deepEqual(await bundleOnly.state.appInstalled(app, { path: appPath }),
    { installed: true, evidence: ['bundle'] });

  // A receipt whose pkg ID extends the bundle ID is the same package.
  assert.deepEqual(await state.appInstalled(app, { path: '/Applications/Gone.app' }),
    { installed: true, evidence: ['receipt:com.example.CuekeeperTest.pkg'] });
  assert.deepEqual(await state.receipt('com.example.Other'), []);

  // An unreadable or foreign bundle at the pinned path is not this app.
  bundles.set(appPath, 'com.example.Other');
  assert.equal((await state.appInstalled(app, { path: appPath })).installed, true,
    'the receipt still proves the package even when the path holds another bundle');
  receipts.length = 0;
  assert.deepEqual(await state.appInstalled(app, { path: appPath }), { installed: false, evidence: [] });

  // Process exit alone never proves an install.
  processes.clear();
  assert.deepEqual(await state.appInstalled(app, { path: '/Applications/Gone.app' }),
    { installed: false, evidence: [] });

  // A pid owned by another bundle is a wrong process, not this app.
  processes.set(4321, { pid: 4321, bundleId: 'com.example.Other' });
  assert.equal(await state.processState(4321, app), 'mismatch');
  processes.delete(4321);
  assert.equal(await state.processState(4321, app), 'exited');
  processes.set(4321, { pid: 4321, bundleId: app });
  assert.equal(await state.processState(4321, app), 'running');
});

test('uninstall evidence needs the bundle gone and reports process exit separately', async t => {
  const app = 'com.example.CuekeeperTest';
  const appPath = '/Applications/CuekeeperTest.app';
  const { state, directories, processes } = fakeInstallState({
    directories: [appPath],
    bundles: { [appPath]: app },
    processes: { 4321: { pid: 4321, bundleId: app } },
  });

  const still = await state.appRemoved(app, { path: appPath, pid: 4321 });
  assert.deepEqual(still, { removed: false, processExited: false, evidence: [] });

  directories.delete(appPath);
  const gone = await state.appRemoved(app, { path: appPath, pid: 4321 });
  assert.deepEqual(gone, { removed: true, processExited: false, evidence: ['bundle_absent'] });

  processes.delete(4321);
  assert.deepEqual(await state.appRemoved(app, { path: appPath, pid: 4321 }), {
    removed: true, processExited: true, evidence: ['bundle_absent', 'process_exited'],
  });

  // A pid now owned by another app is a mismatch, not an uninstall.
  processes.set(4321, { pid: 4321, bundleId: 'com.example.Other' });
  await assert.rejects(state.appRemoved(app, { path: appPath, pid: 4321 }), error => {
    assert.equal(error.code, 'PROCESS_MISMATCH');
    return true;
  });

  // A foreign bundle at the pinned path means removal cannot be proven.
  directories.add(appPath);
  const foreign = fakeInstallState({ directories: [appPath], bundles: { [appPath]: 'com.example.Other' } });
  await assert.rejects(foreign.state.appRemoved(app, { path: appPath }), error => {
    assert.equal(error.code, 'APP_PATH_INVALID');
    return true;
  });
});
