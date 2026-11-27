import type {
  DeliveryV2, FlowV2, ReportV2, ReportV2Entry, StepV2,
} from './contracts-v2.js';
import { hashFlowV2 } from './flow-v2.js';

// The v2 report keeps one entry per flow step, in flow order, and never carries
// typed text: a type step records only whether it used a literal or a named
// input. Cross-app entries also carry the resolved scope, the delivery state and
// the window a step asked to leave in front.

export type AppIdentityRecord = NonNullable<ReportV2['appIdentities']>[number];

export interface StepResult {
  status: ReportV2Entry['status'];
  message?: string;
  code?: string;
  delivery?: DeliveryV2;
  /** Which path a hover took: its resolved element or the recorded screen point. */
  deliveredVia?: ReportV2Entry['deliveredVia'];
  textMode?: 'literal' | 'input';
  input?: string;
  /** The declared focusAfter scope the step handed the foreground to. */
  focusAfter?: NonNullable<ReportV2Entry['focusAfter']>;
  /** Safe checkpoint metadata: trigger, reason and resolution, never a value. */
  checkpoint?: NonNullable<ReportV2Entry['checkpoint']>;
  /** What a system state check compared; `actual` is null when unknown. */
  stateCheck?: NonNullable<ReportV2Entry['stateCheck']>;
}

export class ReportV2Session {
  readonly flow: FlowV2;
  readonly report: ReportV2;
  private readonly startedAt: number;

  constructor(flow: FlowV2, private readonly onEntry?: (entry: ReportV2Entry) => void) {
    this.flow = flow;
    this.startedAt = performance.now();
    this.report = {
      version: 2,
      flowId: flow.id,
      flowSha256: hashFlowV2(flow),
      startedAt: new Date().toISOString(),
      mode: 'replay',
      status: 'passed',
      entries: [],
    };
  }

  elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  /** One entry for a step that ran, with its declared scope and result. */
  record(step: StepV2, result: StepResult, atMs: number): void {
    const entry: ReportV2Entry = {
      id: step.id,
      kind: step.kind,
      ...(step.kind === 'gap' ? {} : { scope: step.scope }),
      status: result.status,
      atMs,
      durationMs: this.elapsed() - atMs,
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
      ...(result.deliveredVia === undefined ? {} : { deliveredVia: result.deliveredVia }),
      ...(result.focusAfter === undefined ? {} : { focusAfter: result.focusAfter }),
      ...(result.checkpoint === undefined ? {} : { checkpoint: result.checkpoint }),
      ...(result.stateCheck === undefined ? {} : { stateCheck: result.stateCheck }),
      ...(result.textMode === undefined ? {} : { textMode: result.textMode }),
      ...(result.input === undefined ? {} : { input: result.input }),
    };
    this.report.entries.push(entry);
    this.onEntry?.(entry);
  }

  /** A step that never ran because an earlier step stopped the run. */
  skip(step: StepV2, message = 'Stopped by an earlier result'): void {
    this.record(step, { status: 'skipped', message }, this.elapsed());
  }

  /**
   * A failure before the first desktop call (identity, lease) lists every step
   * as blocked without inventing setup entries.
   */
  blockAll(code: string, message: string): void {
    this.report.status = 'blocked';
    for (const step of this.flow.steps) {
      this.record(step, { status: 'blocked', code, message }, 0);
    }
  }

  setIdentities(records: AppIdentityRecord[]): void {
    if (records.length) this.report.appIdentities = records;
  }

  finish(status: ReportV2['status'] = 'passed'): ReportV2 {
    this.report.status = status;
    return this.report;
  }
}
