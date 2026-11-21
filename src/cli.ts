#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { discoverAssets } from './assets.js';
import { BatchError, batchExitCode, bindRows, readData, resolveBatchSecrets, runBatch } from './batch.js';
import { captureTargetCheck } from './contracts.js';
import { offlineDesktop, withDesktop } from './desktop.js';
import { ensureNew, readJson, writeNew } from './files.js';
import { parseFlow, plan } from './flow.js';
import { Fault } from './locator.js';
import type { Snapshot } from './locator.js';
import { pickCandidates, selectCandidate } from './pick.js';
import type { PickCandidate } from './pick.js';
import { record } from './record.js';
import { packReport } from './report.js';
import { runFlow } from './run.js';
import { parseTestItem, resolveSecrets } from './test-item.js';
import { enqueueUpload, processUploadQueue } from './upload-queue.js';
import { defaultQueueDir, resolveUploadConfig } from './upload.js';
import { startWorkbench } from './workbench.js';

const help = `Cuekeeper

  cuekeeper flow validate <flow.json|test.json> [--json]
  cuekeeper run <flow.json|test.json> [--data <rows.json>] [--dry-run [--snapshot <snapshot.json>]] [--headed] [--report <report.json>] [--json]
  cuekeeper workbench [run-directory] [--port <port>] [--library <directory>] [--allow-live-replay]
  cuekeeper pick --app <bundle-id> --window <title> [--select <ref>] [--snapshot <snapshot.json>] [--json]
  cuekeeper record --app <bundle-id> --window <title> --out <flow.json> [--seconds 25] [--no-indicator] [--sound] [--trace-clicks] [--json]
  cuekeeper report pack <report.json> --flow <flow.json> --out <report.zip> [--assets <dir>] [--no-upload] [--queue <dir>] [--config <upload.json>] [--json]
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

async function main() {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    success({ usage: help }, help);
    return;
  }
  const [command, ...rest] = argv;
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
        select: { type: 'string' }, snapshot: { type: 'string' },
      },
    });
    const target = { app: values.app, window: values.window };
    if (!captureTargetCheck.Check(target) || !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(target.app)) {
      throw new Error('Specify --app with a bundle ID and --window with an exact window title');
    }
    let observed: Snapshot;
    if (values.snapshot) {
      observed = await offlineDesktop(await readJson(values.snapshot), target).snapshot(target);
    } else {
      macOnly();
      observed = await withDesktop({ headed: false, signal },
        desktop => desktop.snapshot(target, 5000, undefined, true));
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
      },
    });
    checkPositionals(positionals, 1);
    const dryRun = values['dry-run'] ?? false;
    if (values.snapshot && !dryRun) throw new Error('--snapshot requires --dry-run');
    if (values.headed && dryRun) throw new Error('--headed is only for replay');
    if (values.report) await ensureNew(values.report);
    const { flow, secrets } = parseTestItem(await readJson(positionals[0]));
    const baselineDir = resolve(dirname(resolve(positionals[0])), 'baselines');

    if (values.data) {
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
        summary = await runBatch(rows, offlineDesktop(await readJson(values.snapshot), flow.target), options);
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
      ...(values.report ? { evidenceDir: `${resolve(values.report)}.assets` } : {}),
    };
    let report;
    if (values.snapshot) {
      report = await runFlow(flow, offlineDesktop(await readJson(values.snapshot), flow.target), options);
    } else {
      macOnly();
      report = await withDesktop({ headed: values.headed ?? false, signal },
        desktop => runFlow(flow, desktop, options));
    }
    if (values.report) await writeNew(values.report, JSON.stringify(report, null, 2) + '\n');
    const details = report.entries
      .map(entry => `${entry.id} ${entry.kind} ${entry.status}${entry.message ? ` — ${entry.message}` : ''}`)
      .join('\n');
    success(report, `${report.mode} ${report.status}\n${details}`, report.status === 'passed' ? 0 : 1);
    return;
  }

  if (command === 'workbench') {
    const { positionals, values } = parseArgs({
      args: rest, allowPositionals: true, options: {
        ...common, port: { type: 'string', default: '0' }, library: { type: 'string' },
        'allow-live-replay': { type: 'boolean' },
      },
    });
    if (positionals.length > 1) throw new Error('Specify at most one run directory');
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid port');
    const workbench = await startWorkbench({
      directory: positionals[0], port, library: values.library, allowLive: values['allow-live-replay'] ?? false, signal,
    });
    success({ url: workbench.url }, workbench.url);
    await workbench.closed;
    return;
  }

  if (command === 'record') {
    const { values } = parseArgs({
      args: rest, options: {
        ...common, app: { type: 'string' }, window: { type: 'string' },
        out: { type: 'string' }, seconds: { type: 'string', default: '25' },
        'no-indicator': { type: 'boolean' }, sound: { type: 'boolean' },
        'trace-clicks': { type: 'boolean' },
      },
    });
    const target = { app: values.app, window: values.window };
    if (!captureTargetCheck.Check(target) || !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(target.app)) {
      throw new Error('Specify --app with a bundle ID and --window with an exact window title');
    }
    const output = requireString(values.out, '--out');
    const seconds = Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 90) throw new Error('--seconds must be an integer from 1 to 90');
    macOnly();
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
        'no-upload': { type: 'boolean' }, queue: { type: 'string' }, config: { type: 'string' },
      },
    });
    checkPositionals(positionals, 1);
    const path = requireString(values.flow, '--flow');
    const output = requireString(values.out, '--out');
    const [input, rawFlow, assets] = await Promise.all([
      readJson(positionals[0]), readJson(path), discoverAssets(positionals[0], values.assets),
    ]);
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
