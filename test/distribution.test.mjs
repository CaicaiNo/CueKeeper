import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { diagnose } from '../dist/doctor.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');
const scriptPath = join(repoRoot, 'scripts', 'package.mjs');
const example = join(repoRoot, 'examples', 'textedit.flow.json');

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-doctor-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, { mode: 0o700 });
    chmodSync(target, 0o700);
  }
  return root;
}

function agentDesktopScript(version) {
  return `#!/bin/sh
printf '%s\\n' '{"version":"2.6","ok":true,"command":"version","data":{"version":"${version}"}}'
`;
}

function recorderScript(accessibility, inputMonitoring) {
  return `#!/bin/sh
printf '%s\\n' '{"accessibility":${accessibility},"inputMonitoring":${inputMonitoring}}'
`;
}

function doctorCli(env) {
  const result = spawnSync(process.execPath, [cliPath, 'doctor', '--json'], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000,
  });
  return { code: result.status, response: JSON.parse(result.stdout), stderr: result.stderr };
}

test('doctor is ready when the recorder, agent-desktop and workbench files are present', t => {
  const root = fixture(t, {
    'agent-desktop': agentDesktopScript('1.3.1'),
    'cuekeeper-capture': recorderScript(true, true),
  });
  const { code, response } = doctorCli({
    CUEKEEPER_AGENT_DESKTOP: join(root, 'agent-desktop'),
    CUEKEEPER_RECORDER: join(root, 'cuekeeper-capture'),
  });
  assert.equal(code, 0);
  assert.equal(response.ok, true);
  assert.equal(response.data.ok, true);
  const statuses = Object.fromEntries(response.data.checks.map(check => [check.id, check.status]));
  assert.deepEqual(statuses, {
    platform: 'pass', runtime: 'pass', install: 'pass', 'agent-desktop': 'pass',
    recorder: 'pass', accessibility: 'pass', 'input-monitoring': 'pass',
  });
  assert.deepEqual(response.data.nextSteps, []);
});

test('doctor names the pinned agent-desktop version when the dependency is missing or outdated', t => {
  const missing = doctorCli({ CUEKEEPER_AGENT_DESKTOP: join(tmpdir(), 'cuekeeper-no-such-agent-desktop') });
  assert.equal(missing.code, 1);
  assert.equal(missing.response.data.ok, false);
  const missingCheck = missing.response.data.checks.find(check => check.id === 'agent-desktop');
  assert.equal(missingCheck.status, 'fail');
  assert.match(missingCheck.detail, /not found/);
  assert.ok(missing.response.data.nextSteps.some(step => step.includes('agent-desktop 1.3.1')));

  const root = fixture(t, { 'agent-desktop': agentDesktopScript('1.2.0') });
  const outdated = doctorCli({ CUEKEEPER_AGENT_DESKTOP: join(root, 'agent-desktop') });
  assert.equal(outdated.code, 1);
  const outdatedCheck = outdated.response.data.checks.find(check => check.id === 'agent-desktop');
  assert.equal(outdatedCheck.status, 'fail');
  assert.match(outdatedCheck.detail, /found 1\.2\.0, expected 1\.3\.1/);
});

test('doctor reports a missing recorder without guessing about permissions', () => {
  const { code, response } = doctorCli({ CUEKEEPER_RECORDER: join(tmpdir(), 'cuekeeper-no-such-recorder') });
  assert.equal(code, 1);
  const statuses = Object.fromEntries(response.data.checks.map(check => [check.id, check.status]));
  assert.equal(statuses.recorder, 'fail');
  assert.equal(statuses.accessibility, 'skip');
  assert.equal(statuses['input-monitoring'], 'skip');
  assert.ok(response.data.nextSteps.some(step => step.includes('npm run build:recorder')));
});

test('doctor points at both System Settings panes when permissions are not granted', t => {
  const root = fixture(t, {
    'agent-desktop': agentDesktopScript('1.3.1'),
    'cuekeeper-capture': recorderScript(false, false),
  });
  const { code, response } = doctorCli({
    CUEKEEPER_AGENT_DESKTOP: join(root, 'agent-desktop'),
    CUEKEEPER_RECORDER: join(root, 'cuekeeper-capture'),
  });
  assert.equal(code, 1);
  const statuses = Object.fromEntries(response.data.checks.map(check => [check.id, check.status]));
  assert.equal(statuses.accessibility, 'fail');
  assert.equal(statuses['input-monitoring'], 'fail');
  const steps = response.data.nextSteps.join('\n');
  assert.match(steps, /Privacy_Accessibility/);
  assert.match(steps, /Privacy_ListenEvent/);
});

test('doctor flags an incomplete install and an old Node runtime', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-doctor-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'cli.js'), '// packed CLI\n');
  mkdirSync(join(root, 'workbench'));
  writeFileSync(join(root, 'workbench', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(root, 'workbench', 'app.js'), '// app\n');
  const report = await diagnose({
    root,
    platform: 'darwin',
    nodeVersion: '20.11.0',
    host: 'test',
    env: {},
    run: async (executable, args) => {
      assert.equal(args[0], 'version');
      assert.equal(executable, 'agent-desktop');
      return {
        code: 0, stderr: '',
        stdout: '{"version":"2.6","ok":true,"command":"version","data":{"version":"1.3.1"}}',
      };
    },
  });
  assert.equal(report.ok, false);
  const install = report.checks.find(check => check.id === 'install');
  assert.equal(install.status, 'fail');
  assert.match(install.detail, /workbench\/style\.css/);
  assert.match(install.detail, /workbench\/picker\.js/);
  const runtime = report.checks.find(check => check.id === 'runtime');
  assert.equal(runtime.status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'recorder').status, 'fail');
});

async function waitForUrl(child) {
  let buffer = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`workbench printed no URL: ${buffer}`)), 15000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`workbench exited ${code}: ${buffer}`));
    });
  });
  return url.replace(/\n$/, '');
}

test('package script writes a self-contained tree, checksum and release notes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cuekeeper-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime-shim');
  writeFileSync(runtime, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });

  const packed = spawnSync(process.execPath, [scriptPath, '--skip-build', '--skip-recorder', '--allow-missing-recorder',
    '--out', join(root, 'release'), '--node', runtime, '--version', '9.9.9', '--json'],
  { cwd: repoRoot, encoding: 'utf8', timeout: 120000 });
  assert.equal(packed.status, 0, packed.stderr);
  const summary = JSON.parse(packed.stdout).data;
  assert.equal(summary.name, 'cuekeeper-9.9.9-macos-' + process.arch);
  assert.equal(summary.recorder, existsSync(join(repoRoot, 'dist', 'cuekeeper-capture')));

  const directory = summary.directory;
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '9.9.9');
  assert.deepEqual(manifest.dependencies, ['@sinclair/typebox', 'fflate']);
  for (const path of ['bin/cuekeeper', 'runtime/node', 'lib/dist/cli.js', 'lib/workbench/index.html',
    'lib/build-info.json', 'lib/package.json', 'lib/node_modules/fflate/package.json']) {
    const entry = manifest.files.find(file => file.path === path);
    assert.ok(entry, `manifest lists ${path}`);
    const bytes = readFileSync(join(directory, path));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.ok(!manifest.files.some(file => file.path.startsWith('lib/dist/') && file.path.endsWith('.map')));

  const launcher = join(directory, 'bin', 'cuekeeper');
  const version = spawnSync(launcher, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^cuekeeper 9\.9\.9(?: \([0-9a-f]+\))?$/);
  const validate = spawnSync(launcher, ['flow', 'validate', example, '--json'], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).data.flowId, 'textedit-save');

  const archive = summary.archive;
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(summary.sha256, digest);
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${digest}  ${summary.name}.tar.gz\n`);
  const notes = readFileSync(summary.releaseNotes, 'utf8');
  assert.match(notes, /Cuekeeper 9\.9\.9 \(macOS/);
  assert.ok(notes.includes(digest));

  const extracted = join(root, 'extracted');
  mkdirSync(extracted);
  const untar = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  const unpacked = spawnSync(join(extracted, summary.name, 'bin', 'cuekeeper'), ['--version'], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0);
  assert.match(unpacked.stdout.trim(), /^cuekeeper 9\.9\.9(?: \([0-9a-f]+\))?$/);

  const runDirectory = join(root, 'run');
  mkdirSync(runDirectory);
  writeFileSync(join(runDirectory, 'flow.json'), readFileSync(example));
  writeFileSync(join(runDirectory, 'snapshot.json'),
    readFileSync(join(repoRoot, 'examples', 'textedit.snapshot.json')));
  const workbenchChild = spawn(launcher, ['workbench', runDirectory], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await waitForUrl(workbenchChild);
    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<html/i);
    const app = await fetch(`${url}/app.js`);
    assert.equal(app.status, 200);
    assert.ok((await app.text()).length > 1000);
  } finally {
    workbenchChild.kill('SIGTERM');
    await new Promise(resolve => workbenchChild.once('exit', resolve));
  }
});
