#!/usr/bin/env node
// Build a self-contained, unsigned macOS release directory and archive.
//
//   node scripts/package.mjs [--out release] [--version 0.1.0] [--node <path>]
//                            [--skip-build] [--skip-recorder] [--allow-missing-recorder]
//                            [--no-archive] [--keep-staging] [--json]
//
// The package bundles the compiled CLI, workbench assets, the prebuilt recorder
// and a Node runtime so a clean Mac without Node or pnpm can run it.
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sep = process.platform === 'win32' ? '\\' : '/';
const ignore = (source) => !source.endsWith('/.DS_Store') && !source.endsWith('/.git');

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function parse(argv) {
  const options = {
    out: join(repoRoot, 'release'), version: undefined, node: process.execPath,
    skipBuild: false, skipRecorder: false, allowMissingRecorder: false,
    archive: true, json: false,
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
      case '--node': options.node = resolve(value()); break;
      case '--skip-build': options.skipBuild = true; break;
      case '--skip-recorder': options.skipRecorder = true; break;
      case '--allow-missing-recorder': options.allowMissingRecorder = true; break;
      case '--no-archive': options.archive = false; break;
      case '--json': options.json = true; break;
      case '--help':
        console.log('Usage: node scripts/package.mjs [--out <dir>] [--version <x.y.z>] [--node <runtime>]\\n' +
          '  [--skip-build] [--skip-recorder] [--allow-missing-recorder] [--no-archive] [--json]');
        process.exit(0);
      default: fail(`unknown option ${arg}`);
    }
  }
  return options;
}

function run(command, args, extraEnv) {
  process.stderr.write(`$ ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...extraEnv },
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileDigest(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

/** Resolve a dependency package directory the way Node loads it. */
function packageDirectory(name) {
  const require = createRequire(join(repoRoot, 'package.json'));
  const entry = require.resolve(name);
  let directory = dirname(entry);
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      if (parsed.name === name) return { directory, manifest: parsed };
    }
    const parent = dirname(directory);
    if (parent === directory) fail(`could not find the package root for ${name}`);
    directory = parent;
  }
}

/** Copy runtime dependencies (and their runtime dependencies) into `destination`. */
function copyDependencies(destination, names) {
  const seen = new Set();
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const { directory, manifest } = packageDirectory(name);
    cpSync(directory, join(destination, name), { recursive: true, dereference: true, filter: ignore });
    pending.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return [...seen].sort();
}

function walk(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) walk(root, path, files);
    else if (entry.isFile()) files.push(path.slice(root.length + 1).split(sep).join('/'));
  }
  return files.sort();
}
function launcher() {
  return `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
runtime="$root/runtime/node"
if [ ! -x "$runtime" ]; then
  printf '%s\\n' "Cuekeeper runtime is missing: $runtime" >&2
  printf '%s\\n' "Reinstall the release archive, or use the source checkout." >&2
  exit 2
fi
exec "$runtime" "$root/lib/dist/cli.js" "$@"
`;
}

function releaseNotes({ name, version, arch, archive, digest, recorder }) {
  return `# Cuekeeper ${version} (macOS ${arch})

- 产物：\`${archive ?? name}\`
- 版本：${version}
- 平台：macOS ${arch}
- 构建时间：${new Date().toISOString()}
${digest ? `- SHA-256：\`${digest}\`\n` : ''}- 录制器：${recorder ? '已随包，位于 `lib/dist/cuekeeper-capture`（未签名，ad-hoc）' : '本次构建未包含录制器'}
- agent-desktop：1.3.1 不随包分发；先运行 \`bin/cuekeeper doctor\`，按提示安装。

## 安装

\`\`\`sh
shasum -a 256 -c ${archive ?? name}.sha256
mkdir -p ~/Applications
tar -xzf ${archive ?? name} -C ~/Applications
~/Applications/${name}/bin/cuekeeper doctor
\`\`\`

产物未签名。首次打开时移除隔离属性，或在「系统设置 → 隐私与安全性」选择「仍要打开」；详见 README「安装」。

## 升级与卸载

用同一路径覆盖安装，路径不变时 macOS 更容易沿用录制器的权限授权。删除安装目录即卸载；
行为库保留在 \`~/.cuekeeper\`，需要时手动删除。
`;
}

function main() {
  const options = parse(process.argv.slice(2));
  if (process.platform !== 'darwin') fail('release packaging targets macOS; run it on macOS');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const version = options.version ?? manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`invalid version ${String(version)}`);
  }
  if (!options.skipBuild) run('pnpm', ['build']);
  if (!options.skipRecorder) run('sh', ['scripts/build-recorder.sh']);

  const cli = join(repoRoot, 'dist', 'cli.js');
  if (!existsSync(cli)) fail('dist/cli.js is missing; run without --skip-build');
  const recorder = join(repoRoot, 'dist', 'cuekeeper-capture');
  if (!existsSync(recorder)) {
    if (!options.allowMissingRecorder) {
      fail('dist/cuekeeper-capture is missing; build the recorder or pass --skip-recorder with a prebuilt binary');
    }
  }
  if (!existsSync(options.node)) fail(`runtime not found: ${options.node}`);

  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  const name = `cuekeeper-${version}-macos-${arch}`;
  const staging = join(options.out, name);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  cpSync(join(repoRoot, 'dist'), join(staging, 'lib', 'dist'), { recursive: true, filter: ignore });
  cpSync(join(repoRoot, 'workbench'), join(staging, 'lib', 'workbench'), { recursive: true, filter: ignore });
  copyFileSync(join(repoRoot, 'package.json'), join(staging, 'lib', 'package.json'));
  for (const file of ['README.md', 'LICENSE']) {
    if (existsSync(join(repoRoot, file))) copyFileSync(join(repoRoot, file), join(staging, file));
  }
  const dependencies = copyDependencies(join(staging, 'lib', 'node_modules'), Object.keys(manifest.dependencies ?? {}));

  mkdirSync(join(staging, 'bin'), { recursive: true });
  writeFileSync(join(staging, 'bin', 'cuekeeper'), launcher(), { mode: 0o755 });
  chmodSync(join(staging, 'bin', 'cuekeeper'), 0o755);

  mkdirSync(join(staging, 'runtime'), { recursive: true });
  copyFileSync(options.node, join(staging, 'runtime', 'node'));
  chmodSync(join(staging, 'runtime', 'node'), 0o755);

  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const commitText = commit.status === 0 ? commit.stdout.trim() : undefined;
  writeFileSync(join(staging, 'lib', 'build-info.json'),
    JSON.stringify({ version, ...(commitText ? { commit: commitText } : {}), arch, node: process.version,
      builtAt: new Date().toISOString() }, null, 2) + '\n');

  const files = walk(staging).map(file => ({
    path: file, ...fileDigest(join(staging, file)),
  }));
  const packageManifest = {
    name: 'cuekeeper', version, platform: 'macos', arch,
    builtAt: new Date().toISOString(), node: process.version,
    dependencies, recorder: existsSync(recorder), files,
  };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(packageManifest, null, 2) + '\n');

  let archive;
  let digest;
  if (options.archive) {
    archive = `${name}.tar.gz`;
    const archivePath = join(options.out, archive);
    rmSync(archivePath, { force: true });
    run('tar', ['-czf', archivePath, '-C', options.out, name]);
    digest = sha256(readFileSync(archivePath));
    writeFileSync(`${archivePath}.sha256`, `${digest}  ${archive}\n`);
  }
  writeFileSync(join(options.out, `cuekeeper-${version}-RELEASE.md`), releaseNotes({
    name, version, arch, archive, digest, recorder: existsSync(recorder),
  }));

  const summary = {
    name, version, platform: 'macos', arch, directory: staging,
    ...(archive ? { archive: join(options.out, archive), sha256: digest } : {}),
    files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0),
    dependencies, recorder: existsSync(recorder),
    releaseNotes: join(options.out, `cuekeeper-${version}-RELEASE.md`),
  };
  if (options.json) {
    console.log(JSON.stringify({ ok: true, data: summary }));
  } else {
    console.log(`Packaged ${name}`);
    console.log(`  directory ${staging}`);
    if (archive) console.log(`  archive   ${summary.archive}\n  sha256    ${digest}`);
    console.log(`  files     ${summary.files} (${(summary.bytes / 1024 / 1024).toFixed(1)} MB before compression)`);
    console.log(`  notes     ${summary.releaseNotes}`);
  }
}

main();
