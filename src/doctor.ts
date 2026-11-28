import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { hostname, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDesktopVersion } from './desktop.js';
import { Fault } from './locator.js';
import { buildInfo } from './version.js';
import type { BuildInfo } from './version.js';
import { workbenchAssets } from './workbench-assets.js';

/** System Settings deep links. They are printed, never opened by Cuekeeper. */
export const accessibilitySettings =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
export const inputMonitoringSettings =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';

export const minimumNodeMajor = 22;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The executable could not be started at all (ENOENT/EACCES). */
  missing?: boolean;
}

export type CommandRunner = (executable: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;

export interface DoctorOptions {
  /** Install root that contains `dist/` and `workbench/`. */
  root?: string;
  platform?: NodeJS.Platform;
  /** Release string reported for the platform check. */
  osRelease?: string;
  arch?: string;
  nodeVersion?: string;
  host?: string;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface Permissions {
  accessibility: boolean;
  inputMonitoring: boolean;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  platform: string;
  arch: string;
  node: string;
  host: string;
  root: string;
  checks: DoctorCheck[];
  nextSteps: string[];
}

export interface PreflightIssue {
  code: 'RECORDER_MISSING' | 'RECORDER_UNUSABLE' | 'PERMISSIONS_REQUIRED';
  message: string;
  hint?: string;
}

export interface CapturePreflight {
  recorder: string;
  permissions?: Permissions;
  issues: PreflightIssue[];
}

export interface RecordHealth {
  ok: boolean;
  /** Failed doctor checks that keep `record --global` from starting. */
  blocking: DoctorCheck[];
  nextSteps: string[];
  /** The exact recorder binary these checks were run against. */
  recorderPath?: string;
  /** The nested app bundle that owns the recorder's TCC grant. */
  recorderAppPath?: string;
  /** The app bundle that owns the TCC grant when running inside CueKeeper.app. */
  appPath?: string;
}

/** The checks a `record --global` run needs; anything else does not gate it. */
const recordingGate = new Set(['recorder', 'accessibility', 'input-monitoring', 'agent-desktop']);

function defaultRoot() {
  return resolve(fileURLToPath(new URL('../', import.meta.url)));
}

function execRunner(executable: string, args: string[], timeoutMs = 5000): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
            (error as NodeJS.ErrnoException).code === 'EACCES')) {
          resolve({ code: 127, stdout: '', stderr: String(stderr ?? ''), missing: true });
          return;
        }
        const code = error ? typeof error.code === 'number' ? error.code : 1 : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
  });
}

function nodeMajor(version: string) {
  const major = Number(/^v?(\d+)/.exec(version)?.[1]);
  return Number.isInteger(major) ? major : undefined;
}

function parseJsonLine(stdout: string) {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ?
      value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function recorderPath(root: string, env: NodeJS.ProcessEnv) {
  return env.CUEKEEPER_RECORDER?.trim() || join(root, 'dist', 'cuekeeper-capture');
}

interface RecorderProbe {
  path: string;
  present: boolean;
  executable: boolean;
  permissions?: Permissions;
  /** Why the permission probe gave no answer. */
  probeError?: string;
}

async function probeRecorder(root: string, run: CommandRunner, env: NodeJS.ProcessEnv): Promise<RecorderProbe> {
  const path = recorderPath(root, env);
  let info;
  try {
    info = await stat(path);
  } catch {
    return { path, present: false, executable: false };
  }
  if (!info.isFile()) return { path, present: false, executable: false };
  try {
    await access(path, constants.X_OK);
  } catch {
    return { path, present: true, executable: false };
  }
  const result = await run(path, ['--permissions'], 5000);
  const payload = parseJsonLine(result.stdout);
  const accessibility = payload?.accessibility;
  const inputMonitoring = payload?.inputMonitoring;
  if (result.code === 0 && typeof accessibility === 'boolean' && typeof inputMonitoring === 'boolean') {
    return { path, present: true, executable: true, permissions: { accessibility, inputMonitoring } };
  }
  return {
    path, present: true, executable: true,
    probeError: result.code === 0 ?
      'The recorder did not report permission state' :
      `The recorder exited ${result.code} while checking permissions`,
  };
}

async function present(root: string, relative: string) {
  try {
    const info = await stat(join(root, relative));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function permissionHint(missing: Array<'accessibility' | 'inputMonitoring'>) {
  const lines = [
    'Open System Settings → Privacy & Security, enable “cuekeeper-capture” (the Cuekeeper recorder),',
    'then quit and rerun the command. macOS attributes the grant to the recorder binary;',
    'replacing that binary can require granting it again.',
  ];
  for (const item of missing) {
    lines.push(item === 'accessibility' ?
      `  Accessibility:   open "${accessibilitySettings}"` :
      `  Input Monitoring: open "${inputMonitoringSettings}"`);
  }
  return lines.join('\n');
}

function agentDesktopHint() {
  return `Install agent-desktop ${agentDesktopVersion} and keep it on PATH, or point ` +
    'CUEKEEPER_AGENT_DESKTOP at the executable. Cuekeeper pins this version and refuses other builds.';
}

function nextSteps(checks: DoctorCheck[], root: string) {
  const steps: string[] = [];
  for (const check of checks) {
    if (check.status !== 'fail' && check.status !== 'warn') continue;
    if (check.id === 'recorder' || check.id === 'install') {
      const hint = check.id === 'recorder' ?
        'Rebuild the recorder with `npm run build:recorder`, or reinstall the release archive.' :
        'Reinstall the release archive so the packaged files are complete.';
      if (!steps.includes(hint)) steps.push(hint);
    }
    if (check.hint && !['accessibility', 'input-monitoring'].includes(check.id) && !steps.includes(check.hint)) {
      steps.push(check.hint);
    }
  }
  if (checks.some(check => check.id === 'agent-desktop' && check.status === 'fail')) {
    steps.push(agentDesktopHint());
  }
  if (checks.some(check => ['accessibility', 'input-monitoring'].includes(check.id) && check.status === 'fail')) {
    const missing: Array<'accessibility' | 'inputMonitoring'> =
      checks.some(check => check.status === 'fail' && check.id === 'accessibility') ? ['accessibility'] : [];
    if (checks.some(check => check.id === 'input-monitoring' && check.status === 'fail')) {
      missing.push('inputMonitoring');
    }
    steps.push(permissionHint(missing));
  }
  if (steps.length) {
    steps.push(`Re-run \`cuekeeper doctor\` after fixing a check; ` +
      `install root: ${root}`);
  }
  return steps;
}

/**
 * Read-only environment diagnosis. It runs `agent-desktop version` and the
 * recorder's `--permissions` probe; neither asks macOS for new permissions,
 * opens a window, or touches the desktop.
 */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const root = options.root ?? defaultRoot();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const node = options.nodeVersion ?? process.versions.node;
  const host = options.host ?? hostname();
  const run = options.run ?? execRunner;
  const info: BuildInfo = buildInfo();
  const checks: DoctorCheck[] = [];
  const mac = platform === 'darwin';

  checks.push({
    id: 'platform', label: 'platform', status: mac ? 'pass' : 'fail',
    detail: mac ? `macOS ${options.osRelease ?? release()} (darwin, ${arch})` : `${platform}, not macOS`,
    ...(mac ? {} : { hint: 'Live capture and replay require macOS; offline commands still work.' }),
  });

  const major = nodeMajor(node);
  checks.push({
    id: 'runtime', label: 'runtime', status: major !== undefined && major >= minimumNodeMajor ? 'pass' : 'fail',
    detail: `node ${node}${major !== undefined ? ` (>= ${minimumNodeMajor} required)` : ''}`,
    ...(major !== undefined && major >= minimumNodeMajor ? {} : {
      hint: 'A packaged release ships its own Node runtime; a source checkout needs Node 22 or newer.',
    }),
  });

  const missing: string[] = [];
  if (!await present(root, join('dist', 'cli.js'))) missing.push('dist/cli.js');
  for (const asset of workbenchAssets) {
    if (!await present(root, join('workbench', asset.file))) missing.push(`workbench/${asset.file}`);
  }
  checks.push({
    id: 'install', label: 'files', status: missing.length ? 'fail' : 'pass',
    detail: missing.length ? `missing ${missing.join(', ')}` :
      `dist/cli.js and ${workbenchAssets.length} workbench files under ${root}`,
    ...(missing.length ? { hint: 'Reinstall the release archive; workbench files must live next to dist/.' } : {}),
  });

  const agentDesktop = env.CUEKEEPER_AGENT_DESKTOP?.trim() || 'agent-desktop';
  const versionResult = await run(agentDesktop, ['version'], 5000);
  const envelope = parseJsonLine(versionResult.stdout);
  const data = envelope?.ok === true && envelope.command === 'version' && envelope.data !== null &&
    typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : undefined;
  if (versionResult.missing || versionResult.code !== 0 || !data) {
    checks.push({
      id: 'agent-desktop', label: 'agent-desktop', status: 'fail',
      detail: versionResult.missing ? `not found (${agentDesktop})` : `${agentDesktop} did not report a version`,
    });
  } else if (data.version !== agentDesktopVersion) {
    checks.push({
      id: 'agent-desktop', label: 'agent-desktop', status: 'fail',
      detail: `found ${String(data.version)}, expected ${agentDesktopVersion} (${agentDesktop})`,
    });
  } else {
    checks.push({
      id: 'agent-desktop', label: 'agent-desktop', status: 'pass',
      detail: `${agentDesktopVersion} (${agentDesktop})`,
    });
  }

  if (!mac) {
    checks.push({
      id: 'recorder', label: 'recorder', status: 'skip', detail: 'macOS only',
    });
    checks.push({
      id: 'accessibility', label: 'accessibility', status: 'skip', detail: 'macOS only',
    });
    checks.push({
      id: 'input-monitoring', label: 'input monitoring', status: 'skip', detail: 'macOS only',
    });
  } else {
    const recorder = await probeRecorder(root, run, env);
    checks.push({
      id: 'recorder', label: 'recorder',
      status: recorder.present && recorder.executable ? 'pass' : 'fail',
      detail: recorder.present && recorder.executable ? recorder.path :
        recorder.present ? `not executable: ${recorder.path}` : `missing: ${recorder.path}`,
    });
    const permissions = recorder.permissions;
    const probeDetail = recorder.probeError;
    checks.push({
      id: 'accessibility', label: 'accessibility',
      status: !permissions ? probeDetail ? 'warn' : 'skip' : permissions.accessibility ? 'pass' : 'fail',
      detail: !permissions ? probeDetail ?? 'Recorder unavailable' :
        permissions.accessibility ? 'granted for the recorder' : 'not granted for the recorder',
      ...(permissions && !permissions.accessibility ? { hint: `open "${accessibilitySettings}"` } : {}),
    });
    checks.push({
      id: 'input-monitoring', label: 'input monitoring',
      status: !permissions ? probeDetail ? 'warn' : 'skip' : permissions.inputMonitoring ? 'pass' : 'fail',
      detail: !permissions ? probeDetail ?? 'Recorder unavailable' :
        permissions.inputMonitoring ? 'granted for the recorder' : 'not granted for the recorder',
      ...(permissions && !permissions.inputMonitoring ? { hint: `open "${inputMonitoringSettings}"` } : {}),
    });
  }

  return {
    ok: checks.every(check => check.status !== 'fail'),
    version: info.version,
    platform,
    arch,
    node,
    host,
    root,
    checks,
    nextSteps: nextSteps(checks, root),
  };
}

const marks: Record<CheckStatus, string> = { pass: 'ok  ', fail: 'fail', warn: 'warn', skip: 'skip' };

/** Copyable plain-text diagnosis for a terminal or a bug report. */
export function formatDoctor(report: DoctorReport) {
  const lines = [
    `cuekeeper ${report.version} · ${report.platform} ${report.arch} · node ${report.node} · ${report.host}`,
    `install root: ${report.root}`,
    '',
    ...report.checks.map(check => {
      const hint = check.hint ? `\n         ${check.hint.replace(/\n/g, '\n         ')}` : '';
      return `[${marks[check.status]}] ${check.label.padEnd(16)} ${check.detail}${hint}`;
    }),
    '',
  ];
  const failed = report.checks.filter(check => check.status === 'fail').length;
  const warned = report.checks.filter(check => check.status === 'warn').length;
  lines.push(failed ? `Result: ${failed} check${failed === 1 ? '' : 's'} failed` :
    warned ? `Result: ready, ${warned} check${warned === 1 ? '' : 's'} could not be confirmed` :
      'Result: ready');
  if (report.nextSteps.length) lines.push('', 'Next steps', ...report.nextSteps.map((step, index) =>
    `${index + 1}. ${step.replace(/\n/g, '\n   ')}`));
  return lines.join('\n');
}

/**
 * Pre-capture check used by `record` before agent-desktop starts. It reports
 * missing recorder binaries and ungranted permissions instead of failing later
 * with a bare spawn error. It never asks macOS to grant anything.
 */
export async function capturePreflight(options: DoctorOptions = {}): Promise<CapturePreflight> {
  const env = options.env ?? process.env;
  const root = options.root ?? defaultRoot();
  const recorder = await probeRecorder(root, options.run ?? execRunner, env);
  const issues: PreflightIssue[] = [];
  if (!recorder.present) {
    issues.push({
      code: 'RECORDER_MISSING',
      message: `The recorder is missing: ${recorder.path}`,
      hint: 'Rebuild it with `npm run build:recorder`, or reinstall the release archive.',
    });
  } else if (!recorder.executable) {
    issues.push({
      code: 'RECORDER_UNUSABLE',
      message: `The recorder is not executable: ${recorder.path}`,
      hint: 'Restore the executable bit, or reinstall the release archive.',
    });
  } else if (recorder.permissions) {
    const missing: Array<'accessibility' | 'inputMonitoring'> = [];
    if (!recorder.permissions.accessibility) missing.push('accessibility');
    if (!recorder.permissions.inputMonitoring) missing.push('inputMonitoring');
    if (missing.length) {
      issues.push({
        code: 'PERMISSIONS_REQUIRED',
        message: 'Recording needs macOS permission for the recorder before it can start.',
        hint: permissionHint(missing),
      });
    }
  }
  return { recorder: recorder.path, ...(recorder.permissions ? { permissions: recorder.permissions } : {}), issues };
}

/** Turn preflight issues into one dependency fault for the CLI error path. */
export function preflightFault({ issues }: CapturePreflight) {
  if (!issues.length) return undefined;
  const lines = issues.flatMap(issue => [issue.message, ...(issue.hint ? [issue.hint] : [])]);
  return new Fault(issues[0].code, lines.join('\n'), true);
}

/**
 * The doctor subset that gates a web-driven recording: the recorder binary, its
 * macOS permissions, and the pinned agent-desktop build. The workbench asks
 * before it offers the record button, so a missing binary shows up on page load
 * instead of as a fault on the first press.
 */
export async function captureHealth(options: DoctorOptions = {}): Promise<RecordHealth> {
  const report = await diagnose(options);
  const blocking = report.checks.filter(check => check.status === 'fail' && recordingGate.has(check.id));
  const root = options.root ?? defaultRoot();
  const env = options.env ?? process.env;
  const appPath = env.CUEKEEPER_APP_PATH?.trim();
  const recorderAppPath = env.CUEKEEPER_CAPTURE_APP?.trim();
  return {
    ok: blocking.length === 0,
    blocking,
    nextSteps: report.nextSteps,
    recorderPath: recorderPath(root, env),
    ...(recorderAppPath ? { recorderAppPath } : {}),
    ...(appPath ? { appPath } : {}),
  };
}
