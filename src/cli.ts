#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { captureTargetCheck } from './contracts.js';
import { offlineDesktop, withDesktop } from './desktop.js';
import { ensureNew, readJson, writeNew } from './files.js';
import { parseFlow, plan } from './flow.js';
import { Fault } from './locator.js';
import { record } from './record.js';
import { packReport } from './report.js';
import { runFlow } from './run.js';

const help = `Cuekeeper

  cuekeeper flow validate <flow.json> [--json]
  cuekeeper run <flow.json> [--dry-run [--snapshot <snapshot.json>]] [--headed] [--report <report.json>] [--json]
  cuekeeper record --app <bundle-id> --window <title> --out <flow.json> [--seconds 25] [--no-indicator] [--sound] [--json]
  cuekeeper report pack <report.json> --flow <flow.json> --out <report.zip> [--json]

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

async function main() {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    success({ usage: help }, help);
    return;
  }
  const [command, ...rest] = argv;
  if (command === 'flow' && rest[0] === 'validate') {
    const { positionals } = parseArgs({ args: rest.slice(1), options: common, allowPositionals: true });
    checkPositionals(positionals, 1);
    const flow = parseFlow(await readJson(positionals[0]));
    const actions = plan(flow).length;
    success({ flowId: flow.id, actions }, `Valid flow ${flow.id} with ${actions} actions`);
    return;
  }

  if (command === 'run') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: {
        ...common, 'dry-run': { type: 'boolean' }, headed: { type: 'boolean' },
        report: { type: 'string' }, snapshot: { type: 'string' },
      },
    });
    checkPositionals(positionals, 1);
    const dryRun = values['dry-run'] ?? false;
    if (values.snapshot && !dryRun) throw new Error('--snapshot requires --dry-run');
    if (values.headed && dryRun) throw new Error('--headed is only for replay');
    if (values.report) await ensureNew(values.report);
    const flow = parseFlow(await readJson(positionals[0]));
    const options = { dryRun, signal };
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

  if (command === 'record') {
    const { values } = parseArgs({
      args: rest, options: {
        ...common, app: { type: 'string' }, window: { type: 'string' },
        out: { type: 'string' }, seconds: { type: 'string', default: '25' },
        'no-indicator': { type: 'boolean' }, sound: { type: 'boolean' },
      },
    });
    const target = { app: values.app, window: values.window };
    if (!captureTargetCheck.Check(target) || !/^[a-z\d][a-z\d.-]*\.[a-z\d][a-z\d-]*$/i.test(target.app)) {
      throw new Error('Specify --app with a bundle ID and --window with an exact window title');
    }
    const output = requireString(values.out, '--out');
    const seconds = Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('--seconds must be an integer from 1 to 60');
    macOnly();
    await ensureNew(output);
    const options = { seconds, indicator: !values['no-indicator'], sound: values.sound ?? false };
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
        ...common, flow: { type: 'string' }, out: { type: 'string' },
      },
    });
    checkPositionals(positionals, 1);
    const path = requireString(values.flow, '--flow');
    const output = requireString(values.out, '--out');
    const [input, rawFlow] = await Promise.all([readJson(positionals[0]), readJson(path)]);
    const archive = packReport(input, parseFlow(rawFlow));
    await writeNew(output, archive);
    success({ output, bytes: archive.length }, `Wrote ${output}`);
    return;
  }

  throw new Error('Unknown command. See --help');
}

try {
  await main();
} catch (error) {
  const code = signal.aborted ? 130 : error instanceof Fault && !error.dependency ? 1 : 2;
  const reason = error instanceof Error ? error.message : 'Unexpected error';
  if (machine) {
    console.log(JSON.stringify({ ok: false, error: {
      code: signal.aborted ? 'INTERRUPTED' : error instanceof Fault ? error.code : 'INPUT_ERROR', message: reason,
    } }));
  } else {
    console.error(reason);
  }
  process.exitCode = code;
}
