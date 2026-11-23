import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { reportCheck } from './contracts.js';
import type { Action, Report } from './contracts.js';
import { flowV2Check, reportV2Check } from './contracts-v2.js';
import type { FlowV2, ReportV2, Scope, StepV2 } from './contracts-v2.js';
import { readJson } from './files.js';
import { hashFlow, plan } from './flow.js';
import { hashFlowV2, isFlowV2, parseFlowDocument, scopeKey, validateFlowV2 } from './flow-v2.js';
import { object, parseSnapshot } from './locator.js';
import { pickCandidates } from './pick.js';
import type { PickCandidate } from './pick.js';
import { describeApps } from './apps.js';
import { inferSetup } from './setup.js';
import { summarizeShellUsage } from './shell.js';
import { parseLifecycleDocument, proposeWaitCandidates } from './wait-candidates.js';

export const sameTarget = (a: { app: string; window: string }, b: { app: string; window: string }) =>
  a.app === b.app && a.window === b.window;

type TimelineAction = {
  id: string;
  action: Action | StepV2;
  app: string;
  window: string;
  atMs?: number;
  durationMs?: number;
  thumbnail?: string;
  /** v2 only: the step scope the row belongs to. */
  scope?: Scope;
  /** v2 only: identity of the consecutive scope group. */
  scopeGroup?: string;
  /** v2 only: true on the first row of a scope group. */
  groupStart?: boolean;
};

type ScopeGroup = {
  key: string;
  kind: 'window' | 'app' | 'surface' | 'file' | 'gap';
  app?: string;
  window?: string;
  surface?: string;
  /** File scope: the watched file name (exact or `*suffix`). */
  file?: string;
  stepIds: string[];
};

function fileNameOf(scope: Extract<Scope, { kind: 'file' }>): string {
  return 'name' in scope ? scope.name : `*${scope.suffix}`;
}

function scopeRowTarget(scope: Scope | undefined): { app: string; window: string } {
  if (!scope) return { app: '', window: '' };
  if (scope.kind === 'window') return { app: scope.app, window: scope.windowTitle };
  if (scope.kind === 'app') return { app: scope.app, window: '' };
  if (scope.kind === 'file') return { app: '', window: fileNameOf(scope) };
  const app = scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu'
    ? scope.app : '';
  const window = scope.surface === 'app_context_menu' ? scope.windowTitle : scope.surface;
  return { app, window };
}

function scopeGroupOf(scope: Scope | undefined, key: string, stepId: string): ScopeGroup {
  if (!scope) return { key, kind: 'gap', stepIds: [stepId] };
  if (scope.kind === 'window') {
    return { key, kind: 'window', app: scope.app, window: scope.windowTitle, stepIds: [stepId] };
  }
  if (scope.kind === 'app') return { key, kind: 'app', app: scope.app, stepIds: [stepId] };
  if (scope.kind === 'file') return { key, kind: 'file', file: fileNameOf(scope), stepIds: [stepId] };
  return {
    key, kind: 'surface', surface: scope.surface, stepIds: [stepId],
    ...(scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu'
      ? { app: scope.app } : {}),
    ...(scope.surface === 'app_context_menu' ? { window: scope.windowTitle } : {}),
  };
}

const imageTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

async function localFile(directory: string, name: string, maxBytes: number) {
  const path = await realpath(join(directory, name));
  const fromDirectory = relative(directory, path);
  if (!fromDirectory || isAbsolute(fromDirectory) || fromDirectory === '..' || fromDirectory.startsWith('..' + sep)) {
    throw new Error('Workbench files must stay inside the selected run directory');
  }
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`Invalid or oversized local file: ${name}`);
  return path;
}

async function readArtifact(directory: string, name: string): Promise<unknown | undefined> {
  try {
    return await readJson(await localFile(directory, name, 8 * 1024 * 1024));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readTime(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Action times must be nonnegative integer milliseconds');
  }
  return value;
}

function readLabel(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid action app or window');
  return value;
}

/**
 * The newest one-key recording in a shared recordings directory. `record`
 * without `--out` writes `recording-<timestamp>.flow.json` next to earlier
 * recordings, so opening that directory has to pick one deterministically
 * instead of demanding the fixed `flow.json` name.
 */
async function newestRecording(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile() && /^recording-.+\.flow\.json$/i.test(entry.name))
    .map(entry => entry.name);
  if (!names.length) return undefined;
  const dated = await Promise.all(names.map(async name => ({
    name, at: (await stat(join(directory, name))).mtimeMs,
  })));
  dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  return dated[0].name;
}

/**
 * A recording with a capture gap is still opened: the gap is exactly what the
 * operator has to convert into a wait or a manual checkpoint in the workbench.
 * Every other semantic fault is refused at import, and saving revalidates.
 */
function parseFlowDocumentOrGaps(input: unknown) {
  if (!isFlowV2(input)) return parseFlowDocument(input);
  if (!flowV2Check.Check(input)) {
    const first = [...flowV2Check.Errors(input)][0];
    throw new Error(`Invalid flow version 2 ${first?.path ?? ''}: ${first?.message ?? 'schema mismatch'}`);
  }
  const flow = input as FlowV2;
  if (!flow.steps.some(step => step.kind === 'gap')) validateFlowV2(flow);
  return { version: 2 as const, flow };
}

/**
 * `flowFile` names the flow inside the directory instead of letting the loader
 * pick one. The workbench passes the recording it just stopped, so a directory
 * that also holds older one-key recordings cannot resolve to the wrong flow.
 */
export async function loadSession(path: string, options: { flowFile?: string } = {}) {
  const directory = await realpath(path);
  if (!(await stat(directory)).isDirectory()) throw new Error('Select a run directory');
  const [primary, recorded, rawReport, rawActions, rawLifecycle, snapshot] = await Promise.all(
    ['flow.json', 'recorded.flow.json', 'report.json', 'actions.json', 'lifecycle.json', 'snapshot.json']
      .map(name => readArtifact(directory, name)),
  );
  let source = options.flowFile ? await readArtifact(directory, options.flowFile) : primary ?? recorded;
  let flowPath = primary !== undefined ? join(directory, 'flow.json')
    : recorded !== undefined ? join(directory, 'recorded.flow.json') : undefined;
  if (source === undefined && options.flowFile) throw new Error('The requested flow file is missing');
  if (source === undefined) {
    const oneKey = await newestRecording(directory);
    if (oneKey === undefined) {
      throw new Error('The selected directory needs flow.json, recorded.flow.json, or a recording-*.flow.json file');
    }
    source = await readArtifact(directory, oneKey);
    flowPath = join(directory, oneKey);
  }
  const parsed = parseFlowDocumentOrGaps(source);
  if (parsed.version === 2) {
    return loadV2Session(directory, parsed.flow, rawReport, rawActions, rawLifecycle, flowPath as string);
  }

  const flow = parsed.flow;
  const planned = plan(flow);
  let report: Report | undefined;
  if (rawReport !== undefined) {
    if (!reportCheck.Check(rawReport) || rawReport.flowId !== flow.id || rawReport.flowSha256 !== hashFlow(flow)) {
      throw new Error('report.json does not match the selected flow');
    }
    report = rawReport;
  }
  const reportActions = report?.entries.filter(entry => entry.kind !== 'setup');
  if (reportActions && (reportActions.length !== planned.length || planned.some((step, index) =>
    step.id !== reportActions[index].id || step.action.kind !== reportActions[index].kind))) {
    throw new Error('report.json timeline does not match the selected flow');
  }

  const metadata = new Map<string, Record<string, unknown>>();
  let captureDuration: number | undefined;
  if (rawActions !== undefined) {
    const data = object(rawActions);
    if (data.version !== 1 || data.flowId !== flow.id || !Array.isArray(data.actions) || data.actions.length > planned.length) {
      throw new Error('Expected actions.json with version 1, the current flowId, and an actions array');
    }
    captureDuration = readTime(data.durationMs);
    const ids = new Set(planned.map(step => step.id));
    for (const item of data.actions) {
      const info = object(item);
      if (typeof info.id !== 'string' || !ids.has(info.id) || metadata.has(info.id)) {
        throw new Error('actions.json contains an unknown or duplicate action ID');
      }
      metadata.set(info.id, info);
    }
  }

  const fromCapture = captureDuration !== undefined ||
    [...metadata.values()].some(info => info.atMs !== undefined || info.durationMs !== undefined);
  const id = randomUUID();
  const images = new Map<string, { path: string; type: string }>();
  const timeline = await Promise.all(planned.map(async ({ id: step, action }, index): Promise<TimelineAction> => {
    const info = metadata.get(step);
    const timing = reportActions?.[index];
    const image = info?.thumbnail;
    let thumbnail: string | undefined;
    if (image !== undefined) {
      if (typeof image !== 'string' || isAbsolute(image) || image.split('/').includes('..')) {
        throw new Error('Expected a relative PNG, JPEG, or WebP thumbnail path');
      }
      const extension = extname(image).slice(1).toLowerCase();
      if (!Object.hasOwn(imageTypes, extension)) throw new Error('Unsupported thumbnail format');
      const type = imageTypes[extension];
      images.set(String(index), { path: await localFile(directory, image, 8 * 1024 * 1024), type });
      thumbnail = `/thumbnail/${id}/${index}`;
    }
    return {
      id: step, action, thumbnail,
      app: readLabel(info?.app, flow.target.app), window: readLabel(info?.window, flow.target.window),
      atMs: fromCapture ? readTime(info?.atMs) : timing?.atMs,
      durationMs: fromCapture ? readTime(info?.durationMs) : timing?.durationMs,
    };
  }));

  let candidates: PickCandidate[] = [];
  let snapshotApp: string | undefined;
  let snapshotAppPath: string | undefined;
  if (snapshot !== undefined) {
    const envelope = object(snapshot);
    const target = object(envelope.target);
    if (envelope.version !== '2.6' || envelope.ok !== true || envelope.command !== 'snapshot' ||
        target.app !== flow.target.app || target.window !== flow.target.window) {
      throw new Error('snapshot.json does not match the selected flow target');
    }
    if (typeof target.appPath === 'string' && target.appPath) snapshotAppPath = target.appPath;
    const data = object(envelope.data);
    if (typeof data.app === 'string' && data.app) snapshotApp = data.app;
    candidates = pickCandidates(parseSnapshot(data, flow.target));
  }
  const completeTimings = timeline.every(action => action.atMs !== undefined && action.durationMs !== undefined);
  const durationMs = fromCapture
    ? captureDuration ?? (completeTimings ? Math.max(...timeline.map(row => row.atMs! + row.durationMs!)) : undefined)
    : report ? Math.max(...report.entries.map(entry => entry.atMs + entry.durationMs)) : undefined;
  const existingSetup = flow.setup ?? [];
  const setup = [...existingSetup, ...inferSetup(flow.target, timeline.map(row => ({
    id: row.id, app: row.app, window: row.window,
  })), existingSetup)];
  const apps = await describeApps([
    flow.target.app,
    ...timeline.map(row => row.app),
    ...setup.flatMap(condition => condition.ensure ? [condition.ensure.app] : []),
  ], snapshotApp ? { [flow.target.app]: snapshotApp } : {});
  return {
    directory, flow, images, snapshot,
    view: {
      id, directory, version: 1, name: flow.name, target: flow.target, setup, apps, timeline, candidates,
      durationMs, timingSource: fromCapture ? 'capture' : report?.mode,
      startedAt: fromCapture ? undefined : report?.startedAt,
      hasSnapshot: snapshot !== undefined,
      snapshotAppPath,
      // The flow owns identity; a fixture from another path blocks offline runs.
      pathConflict: Boolean(flow.target.appPath && snapshotAppPath && flow.target.appPath !== snapshotAppPath),
      shell: summarizeShellUsage(flow, planned),
    },
  };
}

/**
 * A v2 session is read-only in the workbench: there is no flow-level target, no
 * setup inference and no single-window snapshot to bind. Rows carry their step
 * scope and are grouped by consecutive identical scope, which is how a
 * cross-app recording is reviewed.
 */
async function loadV2Session(
  directory: string,
  flow: FlowV2,
  rawReport: unknown,
  rawActions: unknown,
  rawLifecycle: unknown,
  flowPath: string,
) {
  let report: ReportV2 | undefined;
  if (rawReport !== undefined) {
    if (!reportV2Check.Check(rawReport) || rawReport.flowId !== flow.id ||
        rawReport.flowSha256 !== hashFlowV2(flow)) {
      throw new Error('report.json does not match the selected version 2 flow');
    }
    report = rawReport;
    if (report.entries.length !== flow.steps.length || flow.steps.some((step, index) =>
      report!.entries[index].id !== step.id || report!.entries[index].kind !== step.kind)) {
      throw new Error('report.json timeline does not match the selected version 2 flow');
    }
  }

  const metadata = new Map<string, Record<string, unknown>>();
  let captureDuration: number | undefined;
  if (rawActions !== undefined) {
    const data = object(rawActions);
    if ((data.version !== 1 && data.version !== 2) || data.flowId !== flow.id ||
        !Array.isArray(data.actions) || data.actions.length > flow.steps.length) {
      throw new Error('Expected actions.json with version 1 or 2, the current flowId, and an actions array');
    }
    captureDuration = readTime(data.durationMs);
    const ids = new Set(flow.steps.map(step => step.id));
    for (const item of data.actions) {
      const info = object(item);
      if (typeof info.id !== 'string' || !ids.has(info.id) || metadata.has(info.id)) {
        throw new Error('actions.json contains an unknown or duplicate action ID');
      }
      metadata.set(info.id, info);
    }
  }

  const fromCapture = captureDuration !== undefined ||
    [...metadata.values()].some(info => info.atMs !== undefined || info.durationMs !== undefined);
  const id = randomUUID();
  const images = new Map<string, { path: string; type: string }>();
  const groups: ScopeGroup[] = [];
  const timeline = await Promise.all(flow.steps.map(async (step, index): Promise<TimelineAction> => {
    const info = metadata.get(step.id);
    const timing = report?.entries[index];
    // A recording without actions.json still knows when each step happened: the
    // step itself carries the time it was recorded at. A run report's `atMs` is
    // execution time and wins over it, because a replay is what is being shown.
    const recordedAt = readTime(step.atMs);
    const image = info?.thumbnail;
    let thumbnail: string | undefined;
    if (image !== undefined) {
      if (typeof image !== 'string' || isAbsolute(image) || image.split('/').includes('..')) {
        throw new Error('Expected a relative PNG, JPEG, or WebP thumbnail path');
      }
      const extension = extname(image).slice(1).toLowerCase();
      if (!Object.hasOwn(imageTypes, extension)) throw new Error('Unsupported thumbnail format');
      const type = imageTypes[extension];
      images.set(String(index), { path: await localFile(directory, image, 8 * 1024 * 1024), type });
      thumbnail = `/thumbnail/${id}/${index}`;
    }
    const scope = step.kind === 'gap' ? undefined : step.scope;
    const key = scope ? scopeKey(scope) : `gap:${step.id}`;
    const last = groups.at(-1);
    if (!last || last.key !== key) groups.push(scopeGroupOf(scope, key, step.id));
    else last.stepIds.push(step.id);
    return {
      id: step.id, action: step, scope, scopeGroup: key,
      groupStart: groups.at(-1)!.stepIds.length === 1,
      ...scopeRowTarget(scope), thumbnail,
      atMs: fromCapture ? readTime(info?.atMs) : timing?.atMs ?? recordedAt,
      durationMs: fromCapture ? readTime(info?.durationMs) : timing?.durationMs,
    };
  }));

  // Wait candidates only come from explicit lifecycle events. Step times place
  // an event between recorded steps; without a time or an explicit step, the
  // event is skipped rather than placed by guessing.
  const stepTimes = new Map<string, number>();
  for (const [stepId, info] of metadata) {
    const at = readTime(info.atMs);
    if (at !== undefined) stepTimes.set(stepId, at);
  }
  const waitCandidates = rawLifecycle === undefined
    ? []
    : proposeWaitCandidates(flow, parseLifecycleDocument(rawLifecycle), { stepTimes });

  const appIds = new Set(Object.keys(flow.appPaths ?? {}));
  for (const step of flow.steps) {
    if (step.kind === 'gap') continue;
    const scope = step.scope;
    if (scope.kind === 'file') {
      // A file wait names no app.
    } else if (scope.kind === 'surface') {
      if (scope.surface === 'app_menu_bar' || scope.surface === 'app_context_menu') appIds.add(scope.app);
    } else {
      appIds.add(scope.app);
    }
    if ('focusAfter' in step && step.focusAfter) appIds.add(step.focusAfter.app);
  }
  const completeTimings = timeline.every(row => row.atMs !== undefined && row.durationMs !== undefined);
  const recordedTimes = timeline.map(row => row.atMs).filter((at): at is number => at !== undefined);
  const durationMs = fromCapture
    ? captureDuration ?? (completeTimings ? Math.max(...timeline.map(row => row.atMs! + row.durationMs!)) : undefined)
    : report ? Math.max(...report.entries.map(entry => entry.atMs + entry.durationMs))
      // A recording has no durations, only when each step happened; the last
      // step's time is how long the recording ran.
      : recordedTimes.length ? Math.max(...recordedTimes) : undefined;
  const apps = await describeApps([...appIds]);
  // The times on screen are the recording's own unless a run report replaced
  // them. Only then do the flow's wall-clock start and paused time describe the
  // summary; a replay's summary is its own run.
  const showsRecordedTimes = fromCapture || (report === undefined && recordedTimes.length > 0);
  return {
    directory, flow, images, snapshot: undefined,
    view: {
      id, directory, version: 2, name: flow.name, target: undefined, setup: [], apps,
      appPaths: flow.appPaths ?? {},
      timeline, scopeGroups: groups, candidates: [], durationMs,
      waitCandidates,
      timingSource: fromCapture ? 'capture' : report?.mode ?? (recordedTimes.length ? 'capture' : undefined),
      startedAt: showsRecordedTimes ? flow.startedAt : report?.startedAt,
      pausedMs: showsRecordedTimes ? flow.pausedMs : undefined,
      hasSnapshot: false, snapshotAppPath: undefined, pathConflict: false,
      shell: { reachable: 0, definitions: 0, privileged: 0 },
      // The recording the editor loaded; a revision is written next to it.
      flowPath,
    },
  };
}
