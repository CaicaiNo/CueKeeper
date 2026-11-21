import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { reportCheck } from './contracts.js';
import type { Action, Report } from './contracts.js';
import { readJson } from './files.js';
import { hashFlow, parseFlow, plan } from './flow.js';
import { object, parseSnapshot } from './locator.js';
import { pickCandidates } from './pick.js';
import type { PickCandidate } from './pick.js';
import { inferSetup } from './setup.js';

export const sameTarget = (a: { app: string; window: string }, b: { app: string; window: string }) =>
  a.app === b.app && a.window === b.window;

type TimelineAction = {
  id: string;
  action: Action;
  app: string;
  window: string;
  atMs?: number;
  durationMs?: number;
  thumbnail?: string;
};

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

export async function loadSession(path: string) {
  const directory = await realpath(path);
  if (!(await stat(directory)).isDirectory()) throw new Error('Select a run directory');
  const [primary, recorded, rawReport, rawActions, snapshot] = await Promise.all(
    ['flow.json', 'recorded.flow.json', 'report.json', 'actions.json', 'snapshot.json']
      .map(name => readArtifact(directory, name)),
  );
  if (primary === undefined && recorded === undefined) {
    throw new Error('The selected directory needs flow.json or recorded.flow.json');
  }
  const flow = parseFlow(primary === undefined ? recorded : primary);
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
  if (snapshot !== undefined) {
    const envelope = object(snapshot);
    const target = object(envelope.target);
    if (envelope.version !== '2.6' || envelope.ok !== true || envelope.command !== 'snapshot' ||
        target.app !== flow.target.app || target.window !== flow.target.window) {
      throw new Error('snapshot.json does not match the selected flow target');
    }
    candidates = pickCandidates(parseSnapshot(envelope.data, flow.target));
  }
  const completeTimings = timeline.every(action => action.atMs !== undefined && action.durationMs !== undefined);
  const durationMs = fromCapture
    ? captureDuration ?? (completeTimings ? Math.max(...timeline.map(row => row.atMs! + row.durationMs!)) : undefined)
    : report ? Math.max(...report.entries.map(entry => entry.atMs + entry.durationMs)) : undefined;
  const existingSetup = flow.setup ?? [];
  const setup = [...existingSetup, ...inferSetup(flow.target, timeline.map(row => ({
    id: row.id, app: row.app, window: row.window,
  })), existingSetup)];
  return {
    directory, flow, images, snapshot,
    view: {
      id, directory, name: flow.name, target: flow.target, setup, timeline, candidates,
      durationMs, timingSource: fromCapture ? 'capture' : report?.mode,
      startedAt: fromCapture ? undefined : report?.startedAt,
      hasSnapshot: snapshot !== undefined,
    },
  };
}
