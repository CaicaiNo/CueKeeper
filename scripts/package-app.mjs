#!/usr/bin/env node
// Build CueKeeper.app: the Rust shell, the self-contained Node release, the
// prebuilt recorder, an ad-hoc signature and a zip.
//
//   node scripts/package-app.mjs [--out <dir>] [--version <x.y.z>]
//                                [--skip-build] [--skip-recorder] [--skip-rust]
//                                [--no-sign] [--no-zip] [--json]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME, assembleApp, assembleCaptureApp, CAPTURE_NAME, signApp, zipApp } from './app-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`package-app: ${message}`);
  process.exit(1);
}

function parse(argv) {
  const options = {
    out: join(repoRoot, 'release'), version: undefined,
    skipBuild: false, skipRecorder: false, skipRust: false,
    sign: true, zip: true, json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) fail(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--': break;
      case '--out': options.out = resolve(value()); break;
      case '--version': options.version = value(); break;
      case '--skip-build': options.skipBuild = true; break;
      case '--skip-recorder': options.skipRecorder = true; break;
      case '--skip-rust': options.skipRust = true; break;
      case '--no-sign': options.sign = false; break;
      case '--no-zip': options.zip = false; break;
      case '--json': options.json = true; break;
      case '--help':
        console.log('Usage: node scripts/package-app.mjs [--out <dir>] [--version <x.y.z>]\n' +
          '  [--skip-build] [--skip-recorder] [--skip-rust] [--no-sign] [--no-zip] [--json]');
        process.exit(0);
      default: fail(`unknown option ${arg}`);
    }
  }
  return options;
}

function run(command, args, env = {}) {
  process.stderr.write(`$ ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env },
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
}

function findCargo() {
  const candidates = [process.env.CARGO, 'cargo', join(homedir(), '.cargo', 'bin', 'cargo')]
    .filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  fail('cargo is not installed; install Rust or rerun with --skip-rust');
}

function releaseNotes({ version, arch, archive, sha256 }) {
  return `# ${APP_NAME} ${version}（macOS ${arch}）

- 产物：\`${APP_NAME}.app\`${archive ? `、\`${archive}\`` : ''}
- 版本：${version}
- 构建时间：${new Date().toISOString()}
${sha256 ? `- SHA-256：\`${sha256}\`\n` : ''}- 签名：ad-hoc（未公证）。首次打开若被 Gatekeeper 拦截，右键选择「打开」。

## 安装

1. 解压，把 \`${APP_NAME}.app\` 拖进 \`~/Applications\`（或 \`/Applications\`）。
2. 首次启动会请求「辅助功能」和「输入监控」；在系统设置里勾选 **${APP_NAME}**。
3. 如果错过弹窗：菜单「${APP_NAME} → 请求录制权限」，或点击工作台右上角「使用引导」。

## 说明

- 授权对象是 App，不是内部的 \`cuekeeper-capture\`；录制器作为子进程继承授权。
- 重新构建 App 本体后，ad-hoc 签名变化，macOS 可能要求重新授权。
- 工作台日志：\`~/Library/Logs/com.cuekeeper.app/workbench.log\`
- 行为库和录制仍保存在 \`~/.cuekeeper\`，与命令行版本共用。
`;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (process.platform !== 'darwin') fail('the app bundle targets macOS; run it on macOS');

  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const version = options.version ?? manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid version ${String(version)}`);
  }
  const tauri = JSON.parse(readFileSync(join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  if (tauri.version !== version) {
    fail(`desktop/tauri.conf.json version ${tauri.version} does not match package.json ${version}`);
  }

  if (!options.skipBuild) run('npm', ['run', 'build']);
  if (!options.skipRecorder) run('sh', ['scripts/build-recorder.sh']);

  const out = options.out;
  mkdirSync(out, { recursive: true });
  const stage = join(out, '.app-stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const directory = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'package.mjs'),
    '--skip-build', '--skip-recorder', '--no-archive',
    '--out', stage, '--json',
  ], { cwd: repoRoot, encoding: 'utf8', env: process.env });
  if (directory.error) fail(`directory release failed: ${directory.error.message}`);
  if (directory.status !== 0) {
    process.stderr.write(directory.stderr ?? '');
    fail(`directory release exited ${directory.status}`);
  }
  const line = directory.stdout.trim().split('\n').filter(Boolean).at(-1);
  let releaseDir;
  try {
    releaseDir = JSON.parse(line).data.directory;
  } catch {
    fail(`could not parse the directory release summary: ${line}`);
  }

  if (!options.skipRust) {
    run(findCargo(), [
      'build', '--release', '--manifest-path', join(repoRoot, 'desktop', 'Cargo.toml'),
    ], { MACOSX_DEPLOYMENT_TARGET: '11.0' });
  }
  const binary = join(repoRoot, 'desktop', 'target', 'release', APP_NAME);
  if (!existsSync(binary)) {
    fail(`Rust app binary is missing: ${binary}${options.skipRust ? ' (run without --skip-rust)' : ''}`);
  }

  const iconPath = join(repoRoot, 'desktop', 'icons', 'icon.icns');
  const appDir = assembleApp({
    releaseDir,
    binary,
    outDir: out,
    version,
    iconPath,
  });
  const captureApp = assembleCaptureApp({
    binary: join(releaseDir, 'lib', 'dist', 'cuekeeper-capture'),
    outDir: join(appDir, 'Contents', 'Resources', 'cuekeeper', 'helpers'),
    iconPath,
  });
  if (options.sign) signApp(appDir);

  let archive;
  let sha256;
  if (options.zip) {
    archive = join(out, `${APP_NAME}-${version}-macos-${process.arch}.zip`);
    const zipped = zipApp(appDir, archive);
    sha256 = zipped.sha256;
    writeFileSync(`${archive}.sha256`, `${sha256}  ${basename(archive)}\n`);
  }
  const notes = join(out, `${APP_NAME}-${version}-RELEASE.md`);
  writeFileSync(notes, releaseNotes({ version, arch: process.arch, archive, sha256 }));

  rmSync(stage, { recursive: true, force: true });

  const summary = {
    ok: true,
    data: {
      app: appDir,
      captureApp,
      ...(archive ? { archive, sha256 } : {}),
      notes,
      version,
      arch: process.arch,
      signed: options.sign,
    },
  };
  if (options.json) console.log(JSON.stringify(summary));
  else {
    console.log(`Packaged ${APP_NAME}.app`);
    console.log(`  app    ${appDir}`);
    console.log(`  helper ${captureApp}`);
    if (archive) console.log(`  zip    ${archive}\n  sha256 ${sha256}`);
    console.log(`  notes  ${notes}`);
  }
}

main();
