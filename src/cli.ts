#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { discoverAssets } from './assets.js';
import { capturePreflight, diagnose, formatDoctor, preflightFault } from './doctor.js';
import { buildInfo, versionLine } from './version.js';
import { BatchError, batchExitCode, bindRows, readData, resolveBatchSecrets, runBatch } from './batch.js';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import { captureTargetCheck } from './contracts.js';
import type { Target } from './contracts.js';
import { fixtureAppPath, offlineDesktop, withDesktop } from './desktop.js';
import { ensureNew, readJson, writeNew } from './files.js';
import { parseFlow, plan } from './flow.js';
import { Fault } from './locator.js';
import type { Snapshot } from './locator.js';
import { pickCandidates, selectCandidate } from './pick.js';
import type { PickCandidate } from './pick.js';
import { record } from './record.js';
import { packReport } from './report.js';
import { blockedShellReport, runFlow } from './run.js';
import type { ShellRunOptions } from './run.js';
import { createRootPrivilegeRunner } from './shell-privilege.js';
import { flowHasShellDefinitions, reachableShells, shellGate } from './shell.js';
import { parseTestItem, resolveSecrets } from './test-item.js';
import { enqueueUpload, processUploadQueue } from './upload-queue.js';
import { defaultQueueDir, resolveUploadConfig } from './upload.js';
import { startWorkbench } from './workbench.js';
import { loadVideoArtifact, startVideoCapture, videoSidecarFile } from './video-capture.js';
import type { VideoCaptureSession } from './video-capture.js';
import type { VideoArtifact } from './video.js';

const help = `Cuekeeper ${buildInfo().version}

  cuekeeper --version
  cuekeeper doctor [--json]
  cuekeeper flow validate <flow.json|test.json> [--json]
  cuekeeper run <flow.json|test.json> [--data <rows.json>] [--dry-run [--snapshot <snapshot.json>]] [--headed] [--interactive] [--report <report.json>] [--video] [--allow-shell] [--allow-sudo] [--capture-shell-output] [--json]
  cuekeeper workbench [run-directory] [--port <port>] [--library <directory>] [--allow-live-replay] [--allow-shell] [--allow-sudo]
  cuekeeper pick --app <bundle-id> --window <title> [--app-path <path>] [--select <ref>] [--snapshot <snapshot.json>] [--json]
  cuekeeper record --app <bundle-id> --window <title> --out <flow.json> [--app-path <path>] [--seconds 25] [--no-indicator] [--sound] [--trace-clicks] [--json]
  cuekeeper report pack <report.json> --flow <flow.json> --out <report.zip> [--assets <dir>] [--no-media] [--no-upload] [--queue <dir>] [--config <upload.json>] [--json]
  cuekeeper report upload [--queue <dir>] [--retry-paused] [--json]

Exit codes
  0  Completed
  1  Test, locator, or capture failed or was blocked
  2  Invalid input, file, or dependency
  130  Interrupted`;

const argv = process.argv.slice(2);
const machine = argv.includes('--json');
const cancellation = new AbortController();
for (const event of ['SIGINT', 'SIGTERM'] as const) {
  process.once(event, () => cancellation.abort(new Error('Interrupted')));
}
const { signal } = cancellation;
const common = {
  json: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

function requireString(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`Missing ${flag}`);
  return value;
}

function checkPositionals(positionals: string[], count: number) {
  if (positionals.length !== count) throw new Error('Unexpected positional arguments. See --help');
}

function macOnly() {
  if (process.platform !== 'darwin') {
    throw new Fault('UNSUPPORTED_PLATFORM', 'Live desktop operations in M1 require macOS', true);
  }
}

function success(data: unknown, message: string, code = 0) {
  console[code && !machine ? 'error' : 'log'](machine ? JSON.stringify({ ok: code === 0, data }) : message);
  process.exitCode = code;
}

function describeCandidate(candidate: PickCandidate) {
  const bounds = candidate.bounds
    ? `${candidate.bounds.x},${candidate.bounds.y} ${candidate.bounds.width}×${candidate.bounds.height}`
    : 'no bounds';
  return `${candidate.ref} · ${candidate.role}${candidate.name ? ` "${candidate.name}"` : ''} · ` +
    `${candidate.path.join(' › ')} · ${bounds}${candidate.point ? ` · point ${candidate.point.join(',')}` : ''}`;
}

/** Human-readable form of a root command; never written to reports or logs. */
function formatCommand(program: string, args: string[]) {
  return [program, ...args]
    .map(part => (!part || /[\s"'\\$`;&|*?<>()]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

/**
 * The manifest video artifact lives next to the movie, not inside report.json
 * (v1 is frozen and additionalProperties: false). `report pack` reads it from
 * `<report dir>/media/video.json`.
 */
async function writeVideoSidecar(reportPath: string, artifact: VideoArtifact) {
  const directory = join(dirname(reportPath), 'media');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, videoSidecarFile), JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
}

async function main() {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    success({ usage: help }, help);
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    const info = buildInfo();
    success({ ...info }, versionLine(info));
    return;
  }
  const [command, ...rest] = argv;
  if (command === 'doctor') {
    const { positionals } = parseArgs({ args: rest, options: common, allowPositionals: true });
    checkPositionals(positionals, 0);
    const report = await diagnose();
    success(report, formatDoctor(report), report.ok ? 0 : 1);
    return;
  }
  if (command === 'flow' && rest[0] === 'validate') {
    const { positionals } = parseArgs({ args: rest.slice(1), options: common, allowPositionals: true });
    checkPositionals(positionals, 1);
    const { flow } = parseTestItem(await readJson(positionals[0]));
    const actions = plan(flow).length;
    success({ flowId: flow.id, actions }, `Valid flow ${flow.id} with ${actions} actions`);
    return;
  }

  if (command === 'pick') {
    const { values } = parseArgs({
      args: rest, options: {
        ...common, app: { type: 'string' }, window: { type: 'string' },
        'app-path': { type: 'string' },
        select: { type: 'string' }, snapshot: { type: 'string' },
      },
    });
    const target = {
      app: values.app, window: values.window,
      ...(values['app-path'] ? { appPath: values['app-path'] } : {}),
    } as Target;
    if (!captureTargetCheck.Check(target) || !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(target.app)) {
      throw new Error('Specify --app with a bundle ID and --window with an exact window title');
    }
    let observed: Snapshot;
    if (values.snapshot) {
      const fixture = await readJson(values.snapshot);
      const saved = fixtureAppPath(fixture);
      if (target.appPath && saved && target.appPath !== saved) {
        throw new IdentityFault('APP_AMBIGUOUS', 'fixture_path_mismatch',
          '快照来自另一个应用路径，请重新采集快照或恢复与快照匹配的目标。',
          target.app, 'bundle_path');
      }
      if (!target.appPath && saved) target.appPath = saved;
      observed = await offlineDesktop(fixture, target).snapshot(target);
    } else {
      macOnly();
      if (target.appPath) {
        const identity = new AppIdentitySession(target);
        await identity.preflight();
        observed = await withDesktop({ headed: false, signal }, async desktop => {
          await identity.bindInstances(desktop);
          const current = await identity.readWindow(desktop, target, { timeoutMs: 5000 });
          // The picked target names the canonical copy that was proven.
          if (identity.canonicalPath) target.appPath = identity.canonicalPath;
          observed = current;
          return current;
        });
      } else {
        observed = await withDesktop({ headed: false, signal },
          desktop => desktop.snapshot(target, 5000, undefined, true));
      }
    }
    const candidates = pickCandidates(observed);
    if (values.select !== undefined) {
      const candidate = selectCandidate(candidates, values.select);
      if (!candidate) {
        throw new Fault('NOT_FOUND', `No pickable element matches ${values.select} in the target window`);
      }
      const frame = candidate.bounds
        ? `${candidate.bounds.x},${candidate.bounds.y} ${candidate.bounds.width}×${candidate.bounds.height}`
        : 'no bounds';
      success({
        target, windowId: observed.windowId, ref: candidate.ref, role: candidate.role,
        name: candidate.name, path: candidate.path, point: candidate.point,
        frame: candidate.bounds, locator: candidate.locator,
      }, [
        `${candidate.ref} · ${candidate.role}${candidate.name ? ` "${candidate.name}"` : ''}`,
        `locator ${JSON.stringify(candidate.locator)}`,
        `point ${candidate.point?.join(',') ?? 'no bounds'} · frame ${frame}`,
        'The locator can be written to click.target or type.target in a flow.',
      ].join('\n'));
      return;
    }
    const lines = candidates.map((candidate, index) => `${index + 1}. ${describeCandidate(candidate)}`);
    success({ target, windowId: observed.windowId, candidates }, [
      `${target.app} · ${target.window} · ${candidates.length} pickable elements`,
      ...lines,
      'Select one with --select <ref>, or use --json for the full list.',
    ].join('\n'));
    return;
  }

  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: {
        ...common, 'dry-run': { type: 'boolean' }, headed: { type: 'boolean' },
        report: { type: 'string' }, snapshot: { type: 'string' }, data: { type: 'string' },
        'allow-shell': { type: 'boolean' }, 'allow-sudo': { type: 'boolean' },
        'capture-shell-output': { type: 'boolean' }, interactive: { type: 'boolean' },
        video: { type: 'boolean' },
      },
    });
    checkPositionals(positionals, 1);
    const dryRun = values['dry-run'] ?? false;
    const interactive = values.interactive ?? false;
    if (values.video && dryRun) throw new Error('--video requires a real replay, not --dry-run');
    if (values.video && values.data) throw new Error('--video is not available for batch runs');
    if (values.video && !values.report) throw new Error('--video requires --report so the movie has a run directory');
    // Machine mode has no human to answer a password dialog; refuse instead of
    // silently downgrading an interactive root step. A dry run never prompts,
    // so it stays allowed under --json.
    if (interactive && machine && !dryRun) {
      throw new Error('--interactive cannot be combined with --json');
    }
    if (values.snapshot && !dryRun) throw new Error('--snapshot requires --dry-run');
    if (values.headed && dryRun) throw new Error('--headed is only for replay');
    if (values.report) await ensureNew(values.report);
    const { flow, secrets } = parseTestItem(await readJson(positionals[0]));
    const planned = plan(flow);
    const input = await realpath(resolve(positionals[0]));
    const shell: ShellRunOptions = {
      allowShell: values['allow-shell'] ?? false,
      allowSudo: values['allow-sudo'] ?? false,
      interactive,
      baseDir: dirname(input),
      captureOutput: values['capture-shell-output'] ?? false,
      privilege: createRootPrivilegeRunner(),
      ...(interactive ? {
        announceRoot: (step: { id: string; program: string; args: string[]; cwd: string; mode: string }) => {
          console.error(`root ${step.id} · ${step.mode} · cwd ${step.cwd}`);
          console.error(`  ${formatCommand(step.program, step.args)}`);
        },
      } : {}),
    };
    const gate = dryRun ? undefined : shellGate(flow, planned, shell);
    const baselineDir = resolve(dirname(input), 'baselines');

    if (values.data) {
      // Batch rows replay one flow repeatedly. Shell steps need the single-flow
      // confirmation path, so a table with shell definitions is refused here.
      if (flowHasShellDefinitions(flow)) {
        throw new Error('Batch runs do not accept flows with shell steps yet');
      }
      // Preflight the whole table, then resolve secrets, before any desktop
      // driver call or report artifact is created.
      const table = await readData(values.data);
      const rows = bindRows(flow, table, secrets);
      const secretTexts = dryRun ? undefined : resolveBatchSecrets(flow, secrets, process.env);
      if (values.report) await ensureNew(`${resolve(values.report)}.rows`);
      const options = {
        dryRun, signal, baselineDir,
        ...(values.report ? { reportPath: resolve(values.report) } : {}),
        ...(secretTexts ? { secretTexts } : {}),
        omitEvidence: (secretTexts?.size ?? 0) > 0,
      };
      let summary;
      if (values.snapshot) {
        const fixture = await readJson(values.snapshot);
        summary = await runBatch(rows, offlineDesktop(fixture, flow.target), {
          ...options, offline: true, ...(fixtureAppPath(fixture) ? { fixtureAppPath: fixtureAppPath(fixture)! } : {}),
        });
      } else {
        macOnly();
        summary = await withDesktop({ headed: values.headed ?? false, signal },
          desktop => runBatch(rows, desktop, options));
      }
      const lines = [
        `${summary.mode} ${summary.status} · ${summary.counts.total} rows · ` +
        `${summary.counts.passed} passed · ${summary.counts.failed} failed · ` +
        `${summary.counts.blocked} blocked · ${summary.counts.notCompleted} not completed`,
      ];
      for (const row of summary.rows) {
        if (row.status === 'passed') continue;
        const issues = row.issues.map(issue => `${issue.stepId} ${issue.code ?? ''}`.trim()).join(', ');
        lines.push(`row ${row.row} ${row.status}${issues ? ` — ${issues}` : ''}`);
      }
      if (summary.error) {
        lines.push(`batch error${summary.error.row ? ` at row ${summary.error.row}` : ''} — ` +
          `${summary.error.code}: ${summary.error.message}`);
      }
      if (values.report) lines.push(`Wrote ${resolve(values.report)}`);
      success(summary, lines.join('\n'), batchExitCode(summary));
      return;
    }

    const options = {
      dryRun, signal,
      secretTexts: dryRun ? undefined : resolveSecrets(secrets, process.env),
      baselineDir,
      shell,
      ...(values.report ? { evidenceDir: `${resolve(values.report)}.assets` } : {}),
    };
    const reportPath = values.report ? resolve(values.report) : undefined;
    let videoArtifact: VideoArtifact | undefined;
    let videoSession: VideoCaptureSession | undefined;
    // SIGUSR1/SIGUSR2 pause and resume capture without stealing a keyboard
    // shortcut from the application under test.
    const pauseVideo = () => { videoSession?.pause(); };
    const resumeVideo = () => { videoSession?.resume(); };
    // Capture is strictly opt-in. It starts only after the runner has bound a
    // real target window, and a failure leaves `report.json` untouched.
    const video = values.video && reportPath ? {
      start: (windowId: string, reportStartedAt: string) => startVideoCapture({
        windowId, reportStartedAt, signal, mediaDir: join(dirname(reportPath), 'media'),
      }),
      onStart: (session: VideoCaptureSession) => { videoSession = session; },
      onArtifact: (artifact: VideoArtifact) => { videoArtifact = artifact; },
      onError: (error: unknown) => {
        console.error(`会话视频：${error instanceof Error ? error.message : String(error)}`);
      },
    } : undefined;
    if (video) {
      process.on('SIGUSR1', pauseVideo);
      process.on('SIGUSR2', resumeVideo);
    }
    let report;
    if (gate) {
      // No desktop adapter and no shell process is created for a blocked run.
      report = blockedShellReport(flow, planned, gate);
    } else {
      const needsDesktop = (flow.setup?.length ?? 0) > 0 ||
        planned.some(step => step.action.kind !== 'shell' || (step.action.setup?.length ?? 0) > 0);
      if (!needsDesktop) {
        if (values.video) console.error('会话视频：本次流程没有桌面步骤，未录制');
        report = await runFlow(flow, undefined, options);
      } else if (values.snapshot) {
        const fixture = await readJson(values.snapshot);
        const path = fixtureAppPath(fixture);
        report = await runFlow(flow, offlineDesktop(fixture, flow.target), {
          ...options, offline: true, ...(path ? { fixtureAppPath: path } : {}),
        });
      } else {
        macOnly();
        report = await withDesktop({ headed: values.headed ?? false, signal },
          desktop => runFlow(flow, desktop, { ...options, ...(video ? { video } : {}) }));
      }
    }
    process.off('SIGUSR1', pauseVideo);
    process.off('SIGUSR2', resumeVideo);
    if (values.report) await writeNew(values.report, JSON.stringify(report, null, 2) + '\n');
    if (reportPath && videoArtifact) await writeVideoSidecar(reportPath, videoArtifact);
    const details = report.entries
      .map(entry => {
        const shellDetail = entry.kind === 'shell'
          ? ` ${entry.shell.mode}/${entry.shell.privilege} ${entry.shell.execution}` : '';
        return `${entry.id} ${entry.kind}${shellDetail} ${entry.status}` +
          (entry.message ? ` — ${entry.message}` : '');
      })
      .join('\n');
    const videoLine = videoArtifact
      ? `\n会话视频 ${videoArtifact.status}${'code' in videoArtifact ? ` · ${videoArtifact.code}` : ''}`
      : '';
    success({ ...report, ...(videoArtifact ? { video: videoArtifact } : {}) },
      `${report.mode} ${report.status}${videoLine}\n${details}`,
      signal.aborted ? 130 : report.status === 'passed' ? 0 : 1);
    return;
  }

  if (command === 'workbench') {
    const { positionals, values } = parseArgs({
      args: rest, allowPositionals: true, options: {
        ...common, port: { type: 'string', default: '0' }, library: { type: 'string' },
        'allow-live-replay': { type: 'boolean' }, 'allow-shell': { type: 'boolean' },
        'allow-sudo': { type: 'boolean' },
      },
    });
    if (positionals.length > 1) throw new Error('Specify at most one run directory');
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid port');
    const workbench = await startWorkbench({
      directory: positionals[0], port, library: values.library,
      allowLive: values['allow-live-replay'] ?? false,
      allowShell: values['allow-shell'] ?? false,
      allowSudo: values['allow-sudo'] ?? false,
      signal,
    });
    success({ url: workbench.url }, workbench.url);
    await workbench.closed;
    return;
  }

  if (command === 'record') {
    const { values } = parseArgs({
      args: rest, options: {
        ...common, app: { type: 'string' }, window: { type: 'string' },
        'app-path': { type: 'string' },
        out: { type: 'string' }, seconds: { type: 'string', default: '25' },
        'no-indicator': { type: 'boolean' }, sound: { type: 'boolean' },
        'trace-clicks': { type: 'boolean' },
      },
    });
    const target = {
      app: values.app, window: values.window,
      ...(values['app-path'] ? { appPath: values['app-path'] } : {}),
    } as Target;
    if (!captureTargetCheck.Check(target) || !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(target.app)) {
      throw new Error('Specify --app with a bundle ID and --window with an exact window title');
    }
    const output = requireString(values.out, '--out');
    const seconds = Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 90) throw new Error('--seconds must be an integer from 1 to 90');
    macOnly();
    const preflight = preflightFault(await capturePreflight());
    if (preflight) throw preflight;
    await ensureNew(output);
    const options = { seconds, indicator: !values['no-indicator'], sound: values.sound ?? false,
      traceClicks: values['trace-clicks'] ?? false };
    const { flow, warnings, partial, failure } = await withDesktop({ headed: false, signal },
      desktop => record(desktop, target, options, signal));
    await writeNew(output, JSON.stringify(flow, null, 2) + '\n');
    const data = { output, flowId: flow.id, actions: flow.steps.length,
      ...(partial ? { partial: true } : {}), ...(warnings.length ? { warnings } : {}) };
    const message = `Saved ${flow.steps.length} actions to ${output}${partial ? ' (partial flow)' : ''}`;
    const fault = failure ?? (partial ? new Fault('PARTIAL_RECORDING', 'Some input was skipped') : undefined);
    if (fault && machine) {
      console.log(JSON.stringify({ ok: false, data, error: { code: fault.code, message: fault.message } }));
      process.exitCode = fault.code === 'INTERRUPTED' ? 130 : 1;
    } else {
      const details = [message, ...warnings.map(warning => warning.message), ...(fault ? [fault.message] : [])];
      success(data, details.join('\n'), !fault ? 0 : fault.code === 'INTERRUPTED' ? 130 : 1);
    }
    return;
  }

  if (command === 'report' && rest[0] === 'pack') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1), allowPositionals: true, options: {
        ...common, flow: { type: 'string' }, out: { type: 'string' }, assets: { type: 'string' },
        'no-media': { type: 'boolean' },
        'no-upload': { type: 'boolean' }, queue: { type: 'string' }, config: { type: 'string' },
      },
    });
    checkPositionals(positionals, 1);
    const path = requireString(values.flow, '--flow');
    const output = requireString(values.out, '--out');
    const [input, rawFlow, assets] = await Promise.all([
      readJson(positionals[0]), readJson(path), discoverAssets(positionals[0], values.assets),
    ]);
    // A run writes media/ next to its report; --no-media drops the movie but
    // keeps the report otherwise identical.
    const mediaBundle = values['no-media']
      ? { media: [], video: undefined }
      : await loadVideoArtifact(join(dirname(resolve(positionals[0])), 'media'));
    const archive = packReport(input, parseFlow(rawFlow), {
      assets,
      media: mediaBundle.media,
      ...(mediaBundle.video ? { video: mediaBundle.video } : {}),
      onWarning: message => console.error(message),
    });
    await writeNew(output, archive);
    let upload: { queued: boolean; queue?: string; id?: string; duplicate?: boolean; error?: string } | undefined;
    if (!values['no-upload']) {
      const queue = values.queue ?? defaultQueueDir(process.env);
      try {
        const config = await resolveUploadConfig({ env: process.env, configPath: values.config });
        if (config) {
          const queued = await enqueueUpload({ queueDir: queue, config, bundlePath: output, bytes: archive });
          upload = { queued: true, queue, id: queued.item.id, duplicate: queued.duplicate };
        }
      } catch (error) {
        // The local ZIP is already published; report upload trouble separately.
        upload = { queued: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const data = { output, bytes: archive.length, assets: assets.length, ...(upload ? { upload } : {}) };
    const details = [`Wrote ${output}`];
    if (upload?.queued) details.push(`Queued upload ${upload.id}${upload.duplicate ? ' (already queued)' : ''}`);
    if (upload?.error) details.push(`Upload not queued: ${upload.error}`);
    success(data, details.join('\n'));
    return;
  }

  if (command === 'report' && rest[0] === 'upload') {
    const { values } = parseArgs({
      args: rest.slice(1), options: {
        ...common, queue: { type: 'string' }, 'retry-paused': { type: 'boolean' },
      },
    });
    const queue = values.queue ?? defaultQueueDir(process.env);
    const summary = await processUploadQueue({
      queueDir: queue, env: process.env, retryPaused: values['retry-paused'] ?? false, signal,
    });
    const data = { queue, ...summary };
    const message = `Uploads: ${summary.done} done, ${summary.pending} pending, ` +
      `${summary.paused} paused, ${summary.skipped} skipped`;
    const code = summary.interrupted || signal.aborted ? 130 : summary.paused ? 1 : 0;
    success(data, message, code);
    return;
  }

  throw new Error('Unknown command. See --help');
}

try {
  await main();
} catch (error) {
  const code = signal.aborted ? 130 : error instanceof BatchError ? 2 :
    error instanceof Fault && !error.dependency ? 1 : 2;
  const reason = error instanceof Error ? error.message : 'Unexpected error';
  if (machine) {
    console.log(JSON.stringify({ ok: false, error: {
      code: signal.aborted ? 'INTERRUPTED' : error instanceof Fault ? error.code :
        error instanceof BatchError ? error.code : 'INPUT_ERROR',
      message: reason,
    } }));
  } else {
    console.error(reason);
  }
  process.exitCode = code;
}
