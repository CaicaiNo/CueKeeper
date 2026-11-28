import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const BUNDLE_ID = 'com.cuekeeper.app';
export const BUNDLE_NAME = 'CueKeeper';
export const APP_NAME = BUNDLE_NAME;
export const MINIMUM_MACOS = '11.0';

export function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The Info.plist for the app shell. No user input reaches this file. */
export function infoPlist({
  version, identifier = BUNDLE_ID, name = BUNDLE_NAME, executable = BUNDLE_NAME,
  icon = 'AppIcon', minimumSystemVersion = MINIMUM_MACOS,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>${xmlEscape(name)}</string>
  <key>CFBundleExecutable</key>
  <string>${xmlEscape(executable)}</string>
  <key>CFBundleIconFile</key>
  <string>${xmlEscape(icon)}</string>
  <key>CFBundleIdentifier</key>
  <string>${xmlEscape(identifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${xmlEscape(name)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${xmlEscape(version)}</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>
    <string>MacOSX</string>
  </array>
  <key>CFBundleVersion</key>
  <string>${xmlEscape(version)}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key>
  <string>${xmlEscape(minimumSystemVersion)}</string>
  <key>NSAccessibilityUsageDescription</key>
  <string>CueKeeper 需要辅助功能和输入监控来录制与回放桌面操作。</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright © 2026 CueKeeper</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * Build CueKeeper.app around an already assembled directory release. Signing is
 * separate so tests can inspect the layout without codesign.
 */
export function assembleApp({ releaseDir, binary, outDir, version, iconPath, appName = BUNDLE_NAME }) {
  const cli = join(releaseDir, 'lib', 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error(`release has no lib/dist/cli.js: ${releaseDir}`);
  if (!existsSync(binary)) throw new Error(`app binary not found: ${binary}`);

  const appDir = join(outDir, `${appName}.app`);
  rmSync(appDir, { recursive: true, force: true });
  const contents = join(appDir, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });

  cpSync(binary, join(contents, 'MacOS', appName));
  chmodSync(join(contents, 'MacOS', appName), 0o755);
  cpSync(releaseDir, join(contents, 'Resources', 'cuekeeper'), {
    recursive: true,
    dereference: true,
    filter: source => !source.endsWith('/.DS_Store') && !source.endsWith('/.git'),
  });
  if (iconPath) cpSync(iconPath, join(contents, 'Resources', 'AppIcon.icns'));
  writeFileSync(join(contents, 'Info.plist'), infoPlist({ version, executable: appName }));
  return appDir;
}

/** Ad-hoc sign nested executables, then the bundle. */
export function signApp(appDir) {
  if (process.platform !== 'darwin') return;
  const nested = [
    'Contents/MacOS/CueKeeper',
    'Contents/Resources/cuekeeper/runtime/node',
    'Contents/Resources/cuekeeper/lib/dist/cuekeeper-capture',
    'Contents/Resources/cuekeeper/lib/dist/cuekeeper-identity',
    'Contents/Resources/cuekeeper/lib/dist/cuekeeper-ime',
  ];
  for (const relative of nested) {
    const path = join(appDir, relative);
    if (!existsSync(path)) continue;
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', path]);
  }
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', appDir]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir]);
}

export function zipApp(appDir, archivePath) {
  rmSync(archivePath, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDir, archivePath]);
  const bytes = readFileSync(archivePath);
  return {
    archive: archivePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}
