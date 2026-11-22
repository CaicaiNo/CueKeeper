import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleWatcher } from '../dist/lifecycle.js';

// The lifecycle watcher is exercised with an injected filesystem: no real
// download directory, application folder or bundle is read. Every case starts
// from an explicit baseline, exactly like a recording does.

const downloads = '/tmp/cuekeeper-test-downloads';
const applications = '/tmp/cuekeeper-test-applications';
const quietMs = 1000;

function watcherWorld() {
  const files = new Map();
  const directories = new Map();
  const bundles = new Map();
  let clock = 1_700_000_000_000;
  const put = (directory, name) => {
    if (!directories.has(directory)) directories.set(directory, new Set());
    directories.get(directory).add(name);
  };
  const deps = {
    now: () => clock,
    async readdir(directory) {
      const names = directories.get(directory);
      return names ? [...names] : undefined;
    },
    async stat(path) {
      const file = files.get(path);
      if (file) {
        return { isFile: () => true, isDirectory: () => false, size: file.size, mtimeMs: file.mtimeMs };
      }
      if (bundles.has(path)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
      return undefined;
    },
    async bundleId(path) { return bundles.get(path); },
  };
  return {
    files, directories, bundles, deps,
    now: () => clock,
    advance(ms) { clock += ms; },
    /** Creates a finished download whose mtime is the current clock. */
    download(name, size = 512) {
      const path = `${downloads}/${name}`;
      files.set(path, { size, mtimeMs: clock });
      put(downloads, name);
      return path;
    },
    app(name, bundleId) {
      if (bundleId === undefined) bundles.set(`${applications}/${name}`, undefined);
      else bundles.set(`${applications}/${name}`, bundleId);
      put(applications, name);
      return `${applications}/${name}`;
    },
    remove(path) {
      files.delete(path);
      bundles.delete(path);
      const slash = path.lastIndexOf('/');
      directories.get(path.slice(0, slash))?.delete(path.slice(slash + 1));
    },
  };
}

function watcherFor(world) {
  return new LifecycleWatcher({
    downloadDirectories: [downloads],
    appDirectories: [applications],
    quietMs,
    deps: world.deps,
  });
}

test('nothing that existed at the start of a recording becomes an event', async () => {
  const world = watcherWorld();
  world.download('Old.pkg');
  world.app('Old.app', 'com.example.Old');
  const watcher = watcherFor(world);

  await watcher.start();
  world.advance(5000);
  assert.deepEqual(await watcher.poll(), []);
});

test('a download is reported once after its size and mtime stay quiet', async () => {
  const world = watcherWorld();
  const watcher = watcherFor(world);
  await watcher.start();

  const path = world.download('CuekeeperTest.pkg');
  // First sighting records the file; the quiet window has not passed yet.
  assert.deepEqual(await watcher.poll(), []);
  world.advance(600);
  assert.deepEqual(await watcher.poll(), []);
  world.advance(600);
  assert.deepEqual(await watcher.poll(),
    [{ at: 1200, kind: 'download_completed', path }]);
  // A finished download is reported once, not once per poll.
  world.advance(600);
  assert.deepEqual(await watcher.poll(), []);
});

test('a file that keeps growing is not reported until it stops', async () => {
  const world = watcherWorld();
  const watcher = watcherFor(world);
  await watcher.start();

  const path = world.download('Growing.pkg', 100);
  await watcher.poll();
  for (let size = 200; size <= 600; size += 100) {
    world.advance(300);
    world.files.set(path, { size, mtimeMs: world.now() });
    assert.deepEqual(await watcher.poll(), []);
  }
  // The size stops changing; only then does the event arrive.
  world.advance(600);
  assert.deepEqual(await watcher.poll(), []);
  world.advance(600);
  assert.deepEqual(await watcher.poll(), [{ at: 2700, kind: 'download_completed', path }]);
});

test('partial artifacts and unrelated files are never download evidence', async () => {
  const world = watcherWorld();
  const watcher = watcherFor(world);
  await watcher.start();

  world.download('CuekeeperTest.pkg.crdownload', 100);
  world.download('notes.txt');
  world.advance(3000);
  assert.deepEqual(await watcher.poll(), []);
});

test('an installed bundle and its later removal are proven from the bundle itself', async () => {
  const world = watcherWorld();
  const watcher = watcherFor(world);
  await watcher.start();

  const path = world.app('CuekeeperTest.app', 'com.example.CuekeeperTest');
  world.advance(300);
  assert.deepEqual(await watcher.poll(), [{
    at: 300, kind: 'install_completed', app: 'com.example.CuekeeperTest', path,
  }]);
  world.advance(300);
  assert.deepEqual(await watcher.poll(), [], 'an unchanged install is not reported again');

  world.remove(path);
  world.advance(300);
  assert.deepEqual(await watcher.poll(), [{
    at: 900, kind: 'uninstall_completed', app: 'com.example.CuekeeperTest',
  }]);
});

test('a bundle without a readable identifier never proves an install', async () => {
  const world = watcherWorld();
  const watcher = watcherFor(world);
  await watcher.start();

  const path = world.app('Broken.app', undefined);
  world.advance(300);
  assert.deepEqual(await watcher.poll(), []);
  // Once the identifier becomes readable, the install is proven.
  world.bundles.set(path, 'com.example.Broken');
  world.advance(300);
  assert.deepEqual(await watcher.poll(), [{
    at: 600, kind: 'install_completed', app: 'com.example.Broken', path,
  }]);
});

test('polling before the baseline is a hard error, not an empty result', async () => {
  const watcher = watcherFor(watcherWorld());
  await assert.rejects(watcher.poll(), /polled before start/);
});
