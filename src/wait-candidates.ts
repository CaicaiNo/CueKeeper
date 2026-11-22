import type { FlowV2, Scope, StepV2, WindowScope } from './contracts-v2.js';
import { parseFlowV2, scopeKey } from './flow-v2.js';
import { Fault } from './locator.js';

// Workbench wait candidates. A recording can prove that a download finished, an
// installer appeared, an install completed, the app showed up, an uninstaller
// ran and the app disappeared. Each of those is an explicit event the workbench
// may turn into a proposed `wait`; an idle stretch with no event is never a
// candidate and no condition is guessed. A candidate only becomes a step after
// the user confirms it.

export const lifecycleKinds = [
  'download_completed', 'installer_shown', 'install_completed',
  'app_appeared', 'uninstaller_shown', 'app_disappeared',
] as const;
export type LifecycleKind = typeof lifecycleKinds[number];

const lifecycleKindSet = new Set<string>(lifecycleKinds);

export interface LifecycleEvent {
  /** Milliseconds since the recording started. */
  at: number;
  kind: LifecycleKind;
  /** Bundle ID the event proved; candidate conditions bind this app. */
  app?: string;
  /** Downloaded file or bundle path, used only in the candidate reason. */
  path?: string;
  /** Window title the event named, used only to match a recorded scope. */
  windowTitle?: string;
  /**
   * Explicit position: insert the wait after this recorded step. When absent the
   * event time plus recorded step times decide; with neither there is no safe
   * position, so no candidate is proposed.
   */
  afterStepId?: string;
}

export interface WaitCandidate {
  id: string;
  eventKind: LifecycleKind;
  /** Insert the wait directly after this recorded step. */
  afterStepId: string;
  /** The proposed wait step; absent when the event still needs a user choice. */
  step?: StepV2;
  /** Why this event suggests a wait; never contains captured text. */
  reason: string;
  /** True when `step` is a complete wait that only needs confirmation. */
  ready: boolean;
}

export interface WaitCandidateOptions {
  /** Recorded step times (ms since recording start), from actions.json. */
  stepTimes?: ReadonlyMap<string, number>;
}

const bundleIdPattern = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

function invalid(what: string): never {
  throw new Fault('WAIT_EVENT_INVALID', `Invalid lifecycle event: ${what}`);
}

/** Validates a lifecycle document: `{ version: 1, events: [...] }`. */
export function parseLifecycleDocument(input: unknown): LifecycleEvent[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('expected an object');
  const document = input as Record<string, unknown>;
  if (document.version !== 1) invalid('expected version 1');
  if (!Array.isArray(document.events) || document.events.length > 500) {
    invalid('events must be a bounded array');
  }
  const events = document.events.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid(`events[${index}]`);
    const event = item as Record<string, unknown>;
    if (typeof event.at !== 'number' || !Number.isSafeInteger(event.at) || event.at < 0) {
      invalid(`events[${index}].at must be a nonnegative integer`);
    }
    if (typeof event.kind !== 'string' || !lifecycleKindSet.has(event.kind)) {
      invalid(`events[${index}].kind is unknown`);
    }
    const parsed: LifecycleEvent = { at: event.at, kind: event.kind as LifecycleKind };
    if (event.app !== undefined) {
      if (typeof event.app !== 'string' || !bundleIdPattern.test(event.app)) {
        invalid(`events[${index}].app must be a bundle ID`);
      }
      parsed.app = event.app;
    }
    if (event.path !== undefined) {
      if (typeof event.path !== 'string' || event.path.length > 4096) invalid(`events[${index}].path`);
      parsed.path = event.path;
    }
    if (event.windowTitle !== undefined) {
      if (typeof event.windowTitle !== 'string' || event.windowTitle.length > 256) {
        invalid(`events[${index}].windowTitle`);
      }
      parsed.windowTitle = event.windowTitle;
    }
    if (event.afterStepId !== undefined) {
      if (typeof event.afterStepId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(event.afterStepId)) {
        invalid(`events[${index}].afterStepId`);
      }
      parsed.afterStepId = event.afterStepId;
    }
    return parsed;
  });
  return events.sort((a, b) => a.at - b.at);
}

function slug(event: LifecycleEvent) {
  return event.kind.replace(/_/g, '-');
}

function reasonOf(event: LifecycleEvent, detail?: string) {
  const path = event.path ? `（${event.path.split('/').at(-1)}）` : '';
  switch (event.kind) {
    case 'download_completed':
      return `下载完成${path}：请确认下载界面的完成指示控件或下载目录中的文件；工作台不按空闲时间推断条件。`;
    case 'installer_shown':
      return '安装器界面出现：等待该安装器窗口存在后再继续操作。';
    case 'install_completed':
      return `安装完成${detail ? `（${detail}）` : ''}：用 pkg receipt 或固定路径的 App bundle 证明安装，进程退出单独不算成功。`;
    case 'app_appeared':
      return `App 首次出现${detail ? `（${detail}）` : ''}：等待它的窗口或安装证据，再执行后续操作。`;
    case 'uninstaller_shown':
      return '卸载器界面出现：等待该卸载器窗口存在后再继续操作。';
    case 'app_disappeared':
      return 'App 已移除：等待 bundle 消失；进程退出单独不算卸载完成。';
  }
}

/** The window scope the flow already binds for an app, nearest the insertion point. */
function windowScopeFor(flow: FlowV2, event: LifecycleEvent, position: number): WindowScope | undefined {
  if (!event.app) return undefined;
  const scopes = flow.steps.flatMap((step, index) => {
    if (step.kind === 'gap' || step.scope.kind !== 'window') return [];
    if (step.scope.app !== event.app) return [];
    if (event.windowTitle !== undefined && step.scope.windowTitle !== event.windowTitle) return [];
    return [{ scope: step.scope, distance: Math.abs(index - position) }];
  });
  scopes.sort((a, b) => a.distance - b.distance);
  return scopes[0]?.scope;
}

/** The app scope a step already uses for this app, if any. */
function appScopeFor(flow: FlowV2, app: string): Scope {
  const existing = flow.steps.find(step =>
    step.kind !== 'gap' && step.scope.kind === 'app' && step.scope.app === app);
  return existing && existing.kind !== 'gap' ? existing.scope : { kind: 'app', app };
}

function waitStepFor(
  event: LifecycleEvent, flow: FlowV2, position: number, id: string,
): { step?: StepV2; reason: string; ready: boolean } {
  const app = event.app;
  switch (event.kind) {
    case 'download_completed': {
      // A completed download is not a wait condition by itself: the flow has no
      // file or download-UI check, and inventing one would be a guess. The
      // candidate stays open until the user chooses the completion control.
      return { reason: reasonOf(event), ready: false };
    }
    case 'install_completed': {
      if (!app) return { reason: reasonOf(event), ready: false };
      return {
        reason: reasonOf(event),
        ready: true,
        step: {
          id, kind: 'wait', scope: appScopeFor(flow, app),
          check: { kind: 'app_installed', equals: true },
        } as StepV2,
      };
    }
    case 'app_appeared': {
      if (!app) return { reason: reasonOf(event), ready: false };
      const window = windowScopeFor(flow, event, position);
      return {
        reason: reasonOf(event, window?.windowTitle),
        ready: true,
        step: window
          ? { id, kind: 'wait', scope: window, check: { kind: 'window_exists', equals: true } } as StepV2
          : {
            id, kind: 'wait', scope: appScopeFor(flow, app),
            check: { kind: 'app_installed', equals: true },
          } as StepV2,
      };
    }
    case 'app_disappeared': {
      if (!app) return { reason: reasonOf(event), ready: false };
      return {
        reason: reasonOf(event),
        ready: true,
        step: {
          id, kind: 'wait', scope: appScopeFor(flow, app),
          check: { kind: 'app_installed', equals: false },
        } as StepV2,
      };
    }
    case 'installer_shown':
    case 'uninstaller_shown': {
      if (!app) return { reason: reasonOf(event), ready: false };
      const window = windowScopeFor(flow, event, position);
      return {
        reason: reasonOf(event),
        ready: true,
        step: window
          ? { id, kind: 'wait', scope: window, check: { kind: 'window_exists', equals: true } } as StepV2
          : {
            id, kind: 'wait', scope: appScopeFor(flow, app),
            check: { kind: 'app_running', equals: true },
          } as StepV2,
      };
    }
  }
}

function equivalentWait(step: StepV2 | undefined, next: StepV2 | undefined): boolean {
  if (!step || !next || step.kind !== 'wait' || next.kind !== 'wait') return false;
  if (scopeKey(step.scope) !== scopeKey(next.scope)) return false;
  return JSON.stringify(step.check) === JSON.stringify(next.check);
}

/**
 * Turns explicit lifecycle events into proposed waits. An event with no safe
 * position (no step time and no `afterStepId`) or no proven app is skipped
 * instead of placed by guesswork.
 */
export function proposeWaitCandidates(
  flow: FlowV2, events: readonly LifecycleEvent[], options: WaitCandidateOptions = {},
): WaitCandidate[] {
  const index = new Map(flow.steps.map((step, position) => [step.id, position]));
  const candidates: WaitCandidate[] = [];
  const perKind = new Map<string, number>();
  for (const event of events) {
    let position: number | undefined;
    if (event.afterStepId !== undefined) {
      position = index.get(event.afterStepId);
      if (position === undefined || flow.steps[position].kind === 'gap') continue;
    } else if (options.stepTimes) {
      for (const [stepId, at] of options.stepTimes) {
        const stepPosition = index.get(stepId);
        if (stepPosition === undefined || flow.steps[stepPosition].kind === 'gap') continue;
        if (at <= event.at && (position === undefined || stepPosition > position)) position = stepPosition;
      }
    }
    if (position === undefined) continue;
    const afterStepId = flow.steps[position].id;
    const nth = (perKind.get(event.kind) ?? 0) + 1;
    perKind.set(event.kind, nth);
    const id = `wait-${slug(event)}-${nth}`;
    const proposed = waitStepFor(event, flow, position, id);
    const next = flow.steps[position + 1];
    if (proposed.step && equivalentWait(next, proposed.step)) continue;
    candidates.push({
      id, eventKind: event.kind, afterStepId,
      ...(proposed.step === undefined ? {} : { step: proposed.step }),
      reason: proposed.reason, ready: proposed.ready,
    });
  }
  return candidates;
}

/**
 * Applies one confirmed candidate: the wait is inserted directly after the step
 * the event named, with a step ID unique in this flow. The result is validated
 * against the v2 contract before it can be written.
 */
export function confirmWaitCandidate(flow: FlowV2, candidate: WaitCandidate): FlowV2 {
  if (!candidate.ready || !candidate.step) {
    throw new Fault('WAIT_CANDIDATE_INCOMPLETE',
      'This download event needs a chosen completion control or file before it can become a wait');
  }
  const position = flow.steps.findIndex(step => step.id === candidate.afterStepId);
  if (position < 0) {
    throw new Fault('WAIT_CANDIDATE_STALE', 'The step this candidate follows is no longer in the flow');
  }
  const existing = new Set(flow.steps.map(step => step.id));
  let nth = 1;
  let id = candidate.step.id;
  while (existing.has(id)) id = `${candidate.step.id}-${++nth}`;
  const step = { ...structuredClone(candidate.step), id } as StepV2;
  const steps = [...flow.steps.slice(0, position + 1), step, ...flow.steps.slice(position + 1)];
  return parseFlowV2({ ...structuredClone(flow), steps });
}
