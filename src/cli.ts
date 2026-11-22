#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { discoverAssets } from './assets.js';
import { countdown, detectTarget } from './auto-target.js';
import { capturePreflight, diagnose, formatDoctor, preflightFault } from './doctor.js';
import { buildInfo, versionLine } from './version.js';
import { BatchError, batchExitCode, bindRows, readData, resolveBatchSecrets, runBatch } from './batch.js';
import { AppIdentitySession, IdentityFault } from './app-identity.js';
import { appPathPattern, captureTargetCheck } from './contracts.js';
import type { Target } from './contracts.js';
import { fixtureAppPath, offlineDesktop, withDesktop } from './desktop.js';
import { ensureNew, readJson, writeNew } from './files.js';
import { parseFlow, plan } from './flow.js';
import {
  UnsupportedFlowVersionError, describePlannedStep, dryRunFlowV2, isFlowV2, parseFlowV2, planFlowV2,
} from './flow-v2.js';
import {
  InputSourceManager, chooseAsciiSource, defaultImeDir, detectInputSource, nativeImeBackend,
  readImeLock, readImeRecord, releaseImeLock, removeImeRecord, restoreImeRecord,
} from './ime.js';
import { Fault } from './locator.js';
import type { Snapshot } from './locator.js';
import { pickCandidates, selectCandidate } from './pick.js';
import type { PickCandidate } from './pick.js';
import { record } from './record.js';
import { displayRecordingsDirectory, recordingFileName, recordingsDirectory, writeRecording } from './recording-output.js';
import { packReport } from './report.js';
import { blockedShellReport, runFlow } from './run.js';
import type { ShellRunOptions } from './run.js';
import { createRootPrivilegeRunner } from './shell-privilege.js';
import { createSudoKeychainStore, runSudoCommand } from './sudo-credential.js';
import { flowHasShellDefinitions, reachableShells, shellGate } from './shell.js';
import { parseTestItem, resolveSecrets } from './test-item.js';
import { enqueueUpload, processUploadQueue } from './upload-queue.js';
import { defaultQueueDir, resolveUploadConfig } from './upload.js';
import { hashToken, loadServerConfig, parseServerHost } from './server-config.js';
import { startServer } from './server.js';
import { startWorkbench } from './workbench.js';

const help = `Cuekeeper ${buildInfo().version}

  cuekeeper --version
  cuekeeper doctor [--json]
  cuekeeper flow validate <flow.json|test.json> [--json]
  cuekeeper run <flow.json|test.json> [--data <rows.json>] [--dry-run [--snapshot <snapshot.json>]] [--headed] [--interactive|--non-interactive] [--report <report.json>] [--allow-shell] [--allow-sudo] [--capture-shell-output] [--input-source-switch [--input-source <id>] [--strict-ime]] [--json]
  cuekeeper run <flow-v2.json> --dry-run [--report <report-v2.json>] [--json]   (v2: scope plan only; live replay is not available yet)
  cuekeeper run ... [--no-input-source-switch]   (accepted; equal to the default)
  cuekeeper sudo set|status|clear [--json]   (login-keychain credential for --non-interactive root steps)
  cuekeeper ime status|list [--input-source <id>] [--json]
  cuekeeper ime set <id> [--json]
  cuekeeper ime restore --run <run-directory> [--strict-ime] [--json]
  cuekeeper ime unlock --run <run-id> [--json]
  cuekeeper workbench [run-directory] [--port <port>] [--library <directory>] [--allow-live-replay] [--allow-shell] [--allow-sudo]
  cuekeeper pick --app <bundle-id> --window <title> [--app-path <path>] [--select <ref>] [--snapshot <snapshot.json>] [--json]
  cuekeeper record [--seconds 25] [--countdown 3] [--no-indicator] [--sound] [--clipboard] [--trace-clicks] [--json]
  cuekeeper record --app <bundle-id> [--window <title>] [--out <flow.json>] [--app-path <path>] [--seconds 25] [--countdown 0] [--json]
  cuekeeper report pack <report.json> --flow <flow.json> --out <report.zip> [--assets <dir>] [--no-upload] [--queue <dir>] [--config <upload.json>] [--json]
  cuekeeper report upload [--queue <dir>] [--retry-paused] [--json]
  cuekeeper serve --config <server.json> --data <dir> [--host <host>] [--port <port>] [--json]
  cuekeeper serve --hash-token            (read a token from stdin and print its SHA-256)

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

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
    const document = await readJson(positionals[0]);
    if (isFlowV2(document)) {
      // v2 has no flow-level target and no behavior expansion: the step count is
      // the plan, and any capture gap refuses the flow here.
      const flow = parseFlowV2(document);
      const actions = planFlowV2(flow).length;
      success({ flowId: flow.id, actions, version: 2 }, `Valid version 2 flow ${flow.id} with ${actions} steps`);
      return;
    }
    const { flow } = parseTestItem(document);
    const actions = plan(flow).length;
    success({ flowId: flow.id, actions }, `Valid flow ${flow.id} with ${actions} actions`);
    return;
  }

  if (command === 'sudo') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: common });
    checkPositionals(positionals, 1);
    const action = positionals[0];
    if (action !== 'set' && action !== 'status' && action !== 'clear') {
      throw new Error('Unknown sudo action. Use set, status or clear');
    }
    // `security` prompts for the password on its own terminal. Without one it
    // would fail anyway; say so instead of leaving a confusing exit status.
    if (action === 'set' && process.stdin.isTTY !== true) {
      throw new Fault(
        'SUDO_TERMINAL_REQUIRED',
        'cuekeeper sudo set needs an interactive terminal: the password is typed into security\'s own prompt',
      );
    }
    const result = await runSudoCommand(action, createSudoKeychainStore());
    success(result.data, result.message, result.code);
    return;
  }

  if (command === 'ime') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: {
        ...common, run: { type: 'string' }, 'strict-ime': { type: 'boolean' },
        'input-source': { type: 'string' },
      },
    });
    macOnly();
    const backend = nativeImeBackend();
    const action = positionals[0] ?? 'status';
    const requireHelper = async () => {
      if (!await backend.available()) {
        throw new Fault('IME_DEPENDENCY', '输入法辅助程序不可用，请先运行 pnpm build:recorder 重新构建');
      }
    };
    if (action === 'status' || action === 'list') {
      if (positionals.length > 1) throw new Error('Unexpected positional arguments. See --help');
      await requireHelper();
      const current = await backend.current();
      const sources = await backend.list();
      const target = chooseAsciiSource(sources, values['input-source'] ?? process.env.CUEKEEPER_IME_TARGET);
      const lock = await readImeLock();
      const data = {
        current, ascii: current.ascii, ...(target ? { target } : {}), lock,
        ...(action === 'list' ? { sources } : {}), directory: defaultImeDir(),
      };
      success(data, [
        `当前输入源：${current.name}（${current.id}）${current.ascii ? ' · ASCII' : ' · 非 ASCII'}`,
        target ? `英文目标：${target.name}（${target.id}）` : '英文目标：没有可用的 ABC / U.S. 输入源',
        lock.holder
          ? `锁：run ${lock.holder.runId} 持有${lock.stale ? '（已过期，可接管）' : ''}`
          : '锁：空闲',
        ...(action === 'list'
          ? sources.map(source => `- ${source.name}（${source.id}）${source.ascii ? ' · ASCII' : ''}`)
          : []),
      ].join('\n'));
      return;
    }
    if (action === 'set') {
      checkPositionals(positionals, 2);
      await requireHelper();
      const wanted = positionals[1];
      const source = (await backend.list()).find(item => item.id === wanted || item.name === wanted);
      if (!source) throw new Fault('IME_SOURCE_UNAVAILABLE', `系统里没有输入源 ${wanted}`);
      await backend.select(source.id);
      const after = await backend.current();
      if (after.id !== source.id) {
        throw new Fault('IME_RESTORE_FAILED', `已请求切换到 ${source.name}，系统当前仍是 ${after.name}`);
      }
      success({ source: after }, `已切换到 ${after.name}（${after.id}）`);
      return;
    }
    if (action === 'restore') {
      const directory = requireString(values.run, '--run');
      await requireHelper();
      const record = await readImeRecord(directory);
      const result = await restoreImeRecord(record, backend);
      const data = {
        runId: record.runId, original: record.original, restored: result.restored,
        ...(result.current ? { current: result.current } : {}),
        ...(result.warning ? { warnings: [result.warning] } : {}),
      };
      if (!result.restored && result.warning) {
        console.error(`${result.warning.title}：${result.warning.message}`);
        console.error(`下一步：${result.warning.action}`);
        success(data, `${result.warning.title}：${result.warning.message}`,
          values['strict-ime'] ? 1 : 0);
        return;
      }
      await removeImeRecord(directory);
      success(data, `已恢复输入源：${result.current?.name ?? record.original.name}`);
      return;
    }
    if (action === 'unlock') {
      const runId = requireString(values.run, '--run');
      const result = await releaseImeLock(runId);
      if (!result.released) throw new Fault('IME_BUSY', `锁不属于 run ${runId}，或没有锁`);
      success({ runId, path: result.path }, `已释放 run ${runId} 的输入法锁`);
      return;
    }
    throw new Error('Unknown ime action. Use status, list, set, restore or unlock');
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
        'non-interactive': { type: 'boolean' },
        'no-input-source-switch': { type: 'boolean' }, 'input-source': { type: 'string' },
        'input-source-switch': { type: 'boolean' },
        'strict-ime': { type: 'boolean' },
      },
    });
    checkPositionals(positionals, 1);
    const dryRun = values['dry-run'] ?? false;
    const interactive = values.interactive ?? false;
    const nonInteractive = values['non-interactive'] ?? false;
    // Replay manages no input source unless asked: Unicode injection does not
    // depend on the IME, so the default run never reads TIS, never switches,
    // writes no ime.json and reports no IME warnings. `--no-input-source-switch`
    // stays accepted as the explicit spelling of that default.
    const inputSourceSwitch = values['input-source-switch'] ?? false;
    if (inputSourceSwitch && (values['no-input-source-switch'] ?? false)) {
      throw new Error('--input-source-switch cannot be combined with --no-input-source-switch');
    }
    if (interactive && nonInteractive) {
      throw new Error('--interactive cannot be combined with --non-interactive');
    }
    // Machine mode has no human to answer a password dialog; refuse instead of
    // silently downgrading an interactive root step. A dry run never prompts,
    // so it stays allowed under --json.
    if (interactive && machine && !dryRun) {
      throw new Error('--interactive cannot be combined with --json');
    }
    if (values.snapshot && !dryRun) throw new Error('--snapshot requires --dry-run');
    if (values.headed && dryRun) throw new Error('--headed is only for replay');
    if (values.report) await ensureNew(values.report);
    const document = await readJson(positionals[0]);
    if (isFlowV2(document)) {
      // A v2 flow is refused at the entry points it cannot honour yet. The dry
      // run is a structural scope plan: no launch, focus, clipboard or input.
      const flow = parseFlowV2(document);
      if (values.data) {
        throw new UnsupportedFlowVersionError('Batch runs do not support flow version 2 yet');
      }
      if (!dryRun) {
        throw new UnsupportedFlowVersionError(
          'Live replay of flow version 2 needs the cross-app runner; use --dry-run for now');
      }
      if (values.snapshot) {
        throw new UnsupportedFlowVersionError('A version 2 dry run resolves scopes from the flow; --snapshot fixtures are not supported yet');
      }
      const report = dryRunFlowV2(flow);
      if (values.report) await writeNew(values.report, JSON.stringify(report, null, 2) + '\n');
      const details = planFlowV2(flow).map(describePlannedStep).join('\n');
      success(report, `${report.mode} ${report.status}\n${details}`);
      return;
    }
    const { flow, secrets } = parseTestItem(document);
    const planned = plan(flow);
    const input = await realpath(resolve(positionals[0]));
    const shell: ShellRunOptions = {
      allowShell: values['allow-shell'] ?? false,
      allowSudo: values['allow-sudo'] ?? false,
      interactive,
      nonInteractive,
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
      // The guard is not wired into batch rows; refuse instead of promising a
      // protection the run would not apply.
      if (inputSourceSwitch) {
        throw new Error('Batch runs do not support --input-source-switch yet');
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

    // Only --input-source-switch opts into the guard, and only a live replay
    // can act on it: a dry run and an offline snapshot never depend on the
    // user's keyboard state. A missing helper reports once and leaves the run
    // unguarded instead of inventing report warnings.
    let ime: InputSourceManager | undefined;
    if (inputSourceSwitch && !dryRun && !values.snapshot) {
      const backend = nativeImeBackend();
      if (await backend.available()) {
        const imeTarget = values['input-source'] ?? process.env.CUEKEEPER_IME_TARGET;
        ime = new InputSourceManager({
          backend,
          ...(imeTarget ? { targetId: imeTarget } : {}),
        });
      } else if (!machine) {
        console.error('输入法保护不可用：找不到 cuekeeper-ime，本次运行不会检测或切换输入法。');
      }
    } else if (!machine && values['input-source']) {
      console.error('--input-source 只在 --input-source-switch 开启时生效；本次运行不检测或切换输入法。');
    }
    const options = {
      dryRun, signal,
      secretTexts: dryRun ? undefined : resolveSecrets(secrets, process.env),
      baselineDir,
      shell,
      ...(ime ? { ime } : {}),
      ...(values.report ? { evidenceDir: `${resolve(values.report)}.assets` } : {}),
    };
    let report;
    if (gate) {
      // No desktop adapter and no shell process is created for a blocked run.
      report = blockedShellReport(flow, planned, gate, { nonInteractive });
    } else {
      const needsDesktop = (flow.setup?.length ?? 0) > 0 ||
        planned.some(step => step.action.kind !== 'shell' || (step.action.setup?.length ?? 0) > 0);
      if (!needsDesktop) {
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
          desktop => runFlow(flow, desktop, options));
      }
    }
    if (values.report) await writeNew(values.report, JSON.stringify(report, null, 2) + '\n');
    const imeWarnings = report.warnings ?? [];
    for (const warning of imeWarnings) {
      console.error(`${warning.title}：${warning.message}`);
      console.error(`下一步：${warning.action}`);
    }
    const details = report.entries
      .map(entry => {
        const shellDetail = entry.kind === 'shell'
          ? ` ${entry.shell.mode}/${entry.shell.privilege} ${entry.shell.execution}` : '';
        return `${entry.id} ${entry.kind}${shellDetail} ${entry.status}` +
          (entry.message ? ` — ${entry.message}` : '');
      })
      .join('\n');
    // A restore problem never changes the test result unless --strict-ime asks
    // for it; a blocked step already made the run non-passing.
    const restoreFailed = imeWarnings.some(warning =>
      warning.code === 'IME_RESTORE_FAILED' || warning.code === 'IME_RESTORE_UNAVAILABLE');
    success(report, `${report.mode} ${report.status}\n${details}`, signal.aborted ? 130 :
      report.status !== 'passed' ? 1 : values['strict-ime'] && restoreFailed ? 1 : 0);
    return;
  }

  if (command === 'serve') {
    const { values } = parseArgs({
      args: rest, options: {
        ...common, config: { type: 'string' }, data: { type: 'string' },
        host: { type: 'string' }, port: { type: 'string' }, 'hash-token': { type: 'boolean' },
      },
    });
    if (values['hash-token']) {
      const token = (await readStdin()).trim();
      if (!token) throw new Error('Read the token to hash from stdin');
      success({ sha256: hashToken(token) }, hashToken(token));
      return;
    }
    const configPath = requireString(values.config, '--config');
    const dataDir = resolve(requireString(values.data, '--data'));
    const config = await loadServerConfig(configPath);
    if (values.host) config.host = parseServerHost(values.host);
    let port = config.port;
    if (values.port !== undefined) {
      if (!/^\d+$/.test(values.port) || Number(values.port) > 65535 || Number(values.port) < 1) {
        throw new Error('--port must be an integer from 1 to 65535');
      }
      port = Number(values.port);
    }
    const server = await startServer({ config, dataDir, port, signal });
    success({ url: server.url, data: dataDir }, `Cuekeeper server listening on ${server.url}\nData ${dataDir}`);
    await server.closed;
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
        countdown: { type: 'string', default: '3' },
        'no-indicator': { type: 'boolean' }, sound: { type: 'boolean' },
        'trace-clicks': { type: 'boolean' }, clipboard: { type: 'boolean' },
      },
    });
    const seconds = Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 90) throw new Error('--seconds must be an integer from 1 to 90');
    const countdownSeconds = Number(values.countdown);
    if (!Number.isInteger(countdownSeconds) || countdownSeconds < 0 || countdownSeconds > 60) {
      throw new Error('--countdown must be an integer from 0 to 60');
    }
    const app = values.app;
    const window = values.window;
    const appPath = values['app-path'];
    if (window !== undefined && !window) throw new Error('--window must be a nonempty window title');
    if (window && !app) throw new Error('--window needs --app with a bundle ID. Omit both to record the current front window');
    if (appPath && !app) throw new Error('--app-path needs --app with a bundle ID');
    if (app && !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(app)) {
      throw new Error('--app must be a bundle ID such as com.apple.TextEdit');
    }
    if (appPath && !new RegExp(appPathPattern).test(appPath)) {
      throw new Error('--app-path must be an absolute path to an app bundle');
    }
    // A target pinned by the user is recorded as given; anything less is
    // resolved from the front window after the countdown.
    const explicitTarget: Target | undefined = app && window
      ? { app, window, ...(appPath ? { appPath } : {}) }
      : undefined;
    if (explicitTarget && !captureTargetCheck.Check(explicitTarget)) {
      throw new Error('--window must be a nonempty window title no longer than 256 characters');
    }
    macOnly();
    const preflight = preflightFault(await capturePreflight());
    if (preflight) throw preflight;
    const output = values.out ? resolve(values.out) : undefined;
    const directory = output ? undefined : recordingsDirectory();
    if (output) {
      await ensureNew(output);
    } else {
      await mkdir(directory!, { recursive: true, mode: 0o700 });
    }
    // The input source is read before capture; a Chinese IME rewrites physical
    // keys into candidate text, which the recorder cannot undo.
    const inputSource = await detectInputSource(nativeImeBackend());
    if (inputSource && !inputSource.ascii) {
      console.error(`输入法处于中文状态：当前输入源「${inputSource.name}」，录制的英文可能被改写成 cu’e 这类文本。` +
        '建议切到 ABC/U.S. 后重新录制。');
    }
    const options = { seconds, indicator: !values['no-indicator'], sound: values.sound ?? false,
      traceClicks: values['trace-clicks'] ?? false, clipboard: values.clipboard ?? false,
      ...(inputSource ? { inputSource } : {}) };
    const { flow, warnings, partial, failure } = await withDesktop({ headed: false, signal }, async desktop => {
      let target = explicitTarget;
      if (!target) {
        await countdown(countdownSeconds, line => process.stderr.write(`${line}\n`), signal);
        const detected = await detectTarget(desktop, { ...(app ? { app } : {}) });
        target = { ...detected, ...(appPath ? { appPath } : {}) };
        process.stderr.write(`开始录制前台窗口：${target.app} · ${target.window}\n`);
      }
      return record(desktop, target, options, signal);
    });
    const contents = JSON.stringify(flow, null, 2) + '\n';
    const saved = output ?? await writeRecording(directory!, recordingFileName(new Date()), contents);
    if (output) await writeNew(output, contents);
    // Without an explicit --out the flow lands among other one-key recordings,
    // so point at the directory the workbench opens directly.
    const workbench = output ? undefined : `cuekeeper workbench ${displayRecordingsDirectory()}`;
    const data = { output: saved, flowId: flow.id, actions: flow.steps.length,
      ...(workbench ? { workbench } : {}),
      ...(inputSource ? { inputSource } : {}),
      ...(partial ? { partial: true } : {}), ...(warnings.length ? { warnings } : {}) };
    const lines = [`Saved ${flow.steps.length} actions to ${saved}${partial ? ' (partial flow)' : ''}`];
    if (workbench) lines.push(workbench);
    const fault = failure ?? (partial ? new Fault('PARTIAL_RECORDING', 'Some input was skipped') : undefined);
    if (fault && machine) {
      console.log(JSON.stringify({ ok: false, data, error: { code: fault.code, message: fault.message } }));
      process.exitCode = fault.code === 'INTERRUPTED' ? 130 : 1;
    } else {
      const details = [...lines, ...warnings.map(warning => warning.message), ...(fault ? [fault.message] : [])];
      success(data, details.join('\n'), !fault ? 0 : fault.code === 'INTERRUPTED' ? 130 : 1);
    }
    return;
  }

  if (command === 'report' && rest[0] === 'pack') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1), allowPositionals: true, options: {
        ...common, flow: { type: 'string' }, out: { type: 'string' }, assets: { type: 'string' },
        'no-upload': { type: 'boolean' }, queue: { type: 'string' }, config: { type: 'string' },
      },
    });
    checkPositionals(positionals, 1);
    const path = requireString(values.flow, '--flow');
    const output = requireString(values.out, '--out');
    const [input, rawFlow, assets] = await Promise.all([
      readJson(positionals[0]), readJson(path), discoverAssets(positionals[0], values.assets),
    ]);
    if (isFlowV2(rawFlow)) {
      throw new UnsupportedFlowVersionError('Report packing does not support flow version 2 yet');
    }
    const archive = packReport(input, parseFlow(rawFlow), { assets });
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
  const code = signal.aborted ? 130 : error instanceof UnsupportedFlowVersionError ? 2 :
    error instanceof BatchError ? 2 :
    error instanceof Fault && !error.dependency ? 1 : 2;
  const reason = error instanceof Error ? error.message : 'Unexpected error';
  if (machine) {
    console.log(JSON.stringify({ ok: false, error: {
      code: signal.aborted ? 'INTERRUPTED' :
        error instanceof UnsupportedFlowVersionError ? error.code :
        error instanceof Fault ? error.code :
        error instanceof BatchError ? error.code : 'INPUT_ERROR',
      message: reason,
    } }));
  } else {
    console.error(reason);
  }
  process.exitCode = code;
}
