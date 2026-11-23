import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fault, object } from './locator.js';

/**
 * One macOS text input source (keyboard layout or input method). `ascii` is the
 * system's own `IsASCIICapable` flag, not a guess from the ID.
 */
export interface InputSource {
  id: string;
  name: string;
  ascii: boolean;
  /** False when TIS reports the source cannot be selected; absent means unknown. */
  selectable?: boolean;
}

/** The three TIS operations the guard needs. Tests inject a fake. */
export interface ImeBackend {
  available(): Promise<boolean>;
  list(): Promise<InputSource[]>;
  current(): Promise<InputSource>;
  select(id: string): Promise<void>;
}

export type ImeLevel = 'warning' | 'blocked';
export type ImeCode =
  | 'IME_SOURCE_UNAVAILABLE' | 'IME_CHANGED_BY_USER' | 'IME_RESTORE_FAILED'
  | 'IME_RESTORE_UNAVAILABLE' | 'IME_BUSY' | 'IME_SWITCH_DISABLED'
  | 'IME_PHYSICAL_KEY_BLOCKED' | 'IME_ACTIVE' | 'IME_UNCOMMITTED' | 'IME_UNAVAILABLE'
  | 'IME_SWITCH_FAILED';

/**
 * One user-visible input-source fact. The shape is what `--json`, the report
 * and the viewer show; no token, password or typed text ever lands here.
 */
export interface ImeWarning {
  code: ImeCode;
  level: ImeLevel;
  title: string;
  message: string;
  action: string;
  original?: InputSource;
  current?: InputSource;
  runId?: string;
  holderRunId?: string;
  lockExpiresAt?: string;
  attempted?: InputSource;
  verified?: InputSource;
}

/** A blocked step carries its warning so the report and CLI stay in sync. */
export class ImeFault extends Fault {
  constructor(public warning: ImeWarning) {
    super(warning.code, warning.message);
  }
}

/** A step is blocked by the input source, not by the application under test. */
export function isImeFault(error: unknown): error is ImeFault {
  return error instanceof ImeFault;
}

export interface ImeSummary {
  switched: boolean;
  original?: InputSource;
  target?: InputSource;
  final?: InputSource;
  runDir?: string;
}

export interface ImeRestoreResult {
  warnings: ImeWarning[];
  summary: ImeSummary;
}

const copy: Record<ImeCode, { title: string; action: string }> = {
  IME_SOURCE_UNAVAILABLE: {
    title: '无法切换到英文输入法',
    action: '打开「系统设置 → 键盘 → 输入源」添加 ABC 或 U.S.，然后重新运行。',
  },
  IME_CHANGED_BY_USER: {
    title: '输入法被手动切换',
    action: '切回原输入法后重新运行；如果要自己管理输入法，加 --no-input-source-switch。',
  },
  IME_RESTORE_FAILED: {
    title: '输入法没有恢复',
    action: '请手动切回原输入法；或运行 cuekeeper ime set <id>。报告里保留了 original / current。',
  },
  IME_RESTORE_UNAVAILABLE: {
    title: '原输入法已不可用',
    action: '如果已经卸载，可以忽略；如果还要用，请在系统设置重新添加，或运行 cuekeeper ime set <id>。',
  },
  IME_BUSY: {
    title: '另一个测试正在切换输入法',
    action: '等它结束后重试；如果确认卡死，运行 cuekeeper ime unlock --run <run-id> 或等锁超时。',
  },
  IME_SWITCH_DISABLED: {
    title: '没有自动切换输入法',
    action: '需要自动切换时去掉 --no-input-source-switch；文本仍按 Unicode 写入，不受输入法影响。',
  },
  IME_PHYSICAL_KEY_BLOCKED: {
    title: '物理按键可能被输入法改写',
    action: '切到 ABC/U.S. 后重新运行，或去掉 --no-input-source-switch 让 Cuekeeper 自动切换。',
  },
  IME_ACTIVE: {
    title: '录制时输入法处于中文状态',
    action: '切到 ABC/U.S. 后重新录制，或核对录制结果里的输入文本。',
  },
  IME_UNCOMMITTED: {
    title: '录制的文本疑似被输入法改写',
    action: '切到英文输入法后重新录制该段，或手动修正 flow 里的 text。',
  },
  IME_UNAVAILABLE: {
    title: '输入法保护不可用',
    action: '运行 pnpm build:recorder 重新构建输入法辅助程序，或重新安装发布包。',
  },
  IME_SWITCH_FAILED: {
    title: '没有切换到英文输入法',
    action: '录制会继续。需要准确捕获英文按键时，先在系统设置添加 ABC/U.S. 或手动切换后重录这一段。',
  },
};

function warning(
  code: ImeCode, level: ImeLevel, message: string, extra: Partial<ImeWarning> = {},
): ImeWarning {
  return { code, level, title: copy[code].title, message, action: copy[code].action, ...extra };
}

function sourceUnavailable(current?: InputSource, targetId?: string): ImeWarning {
  const message = targetId
    ? `系统里没有可用的「${targetId}」输入源，也没有其它可选的 ABC / U.S. 输入源，英文输入可能被中文输入法改写。`
    : '系统里没有可用的 ABC 或 U.S. 输入源，英文输入可能被中文输入法改写。';
  return warning('IME_SOURCE_UNAVAILABLE', 'blocked', message,
    current ? { current } : {});
}

function changedByUser(original: InputSource, current: InputSource, runId: string,
  recording = false): ImeWarning {
  return warning('IME_CHANGED_BY_USER', recording ? 'warning' : 'blocked',
    recording
      ? `录制中检测到输入源从「${original.name}」变为「${current.name}」；为避免覆盖你的选择，没有切回。`
      : `运行中检测到输入源从「${original.name}」变为「${current.name}」。为避免覆盖你的选择，后续输入已停止。`,
    { original, current, runId });
}

function physicalBlocked(current: InputSource): ImeWarning {
  return warning('IME_PHYSICAL_KEY_BLOCKED', 'blocked',
    `已用 --no-input-source-switch 关闭自动切换，当前输入源「${current.name}」会把按键转成候选文本；该步骤需要物理按键，已停止。`,
    { current });
}

function switchDisabled(current: InputSource): ImeWarning {
  return warning('IME_SWITCH_DISABLED', 'warning',
    `已用 --no-input-source-switch 关闭自动切换，当前输入源「${current.name}」可能改写英文按键；本次文本按 Unicode 写入。`,
    { current });
}

function restoreUnavailable(original: InputSource, current: InputSource): ImeWarning {
  return warning('IME_RESTORE_UNAVAILABLE', 'warning',
    `运行结束后找不到原输入源「${original.name}」（ID ${original.id}），因此没有自动恢复；当前保持「${current.name}」。`,
    { original, current });
}

function imeUnavailable(): ImeWarning {
  return warning('IME_UNAVAILABLE', 'warning',
    '找不到可用的输入法辅助程序（cuekeeper-ime），本次运行没有检测或切换输入法。');
}

/**
 * Recording keeps going without a switched source: the flow is still worth
 * recording, and only physical English keys may come out wrong.
 */
function switchFailed(message: string, current?: InputSource): ImeWarning {
  return warning('IME_SWITCH_FAILED', 'warning', message, current ? { original: current } : {});
}

function busy(holder: { runId?: string; expiresAt?: string } | undefined): ImeWarning {
  const who = holder?.runId ? `锁由 run ${holder.runId} 持有。` : '锁被另一个 run 持有。';
  return warning('IME_BUSY', 'blocked',
    `同一时间只允许一个 run 管理输入法，避免互相覆盖。${who}`,
    {
      ...(holder?.runId ? { holderRunId: holder.runId } : {}),
      ...(holder?.expiresAt ? { lockExpiresAt: holder.expiresAt } : {}),
    });
}

/** Pure-ASCII text is written through Unicode injection and is safe with any IME. */
export function isAsciiText(text: string) {
  return /^[\t\n\r\x20-\x7e]*$/.test(text);
}

/**
 * A physical `key` step that types a character (not a named key, not a
 * command chord) is rewritten by an active IME into composition text.
 */
export function physicalAsciiKey(key: string, modifiers: readonly string[] = []) {
  if (!/^[a-z0-9]$/.test(key)) return false;
  return !modifiers.includes('meta') && !modifiers.includes('ctrl');
}

/**
 * A committed IME string that still carries a syllable separator (`cu’e`)
 * instead of the intended word. Only flagged for non-ASCII input sources or
 * the unmistakable typographic separators, so a real apostrophe survives.
 */
export function looksImeAltered(text: string, nonAsciiSource = true) {
  if (/[A-Za-z][’`＇][A-Za-z]/.test(text)) return true;
  return nonAsciiSource && /[A-Za-z]'[A-Za-z]/.test(text);
}

function helperPath() {
  return process.env.CUEKEEPER_IME ?? fileURLToPath(new URL('./cuekeeper-ime', import.meta.url));
}

/**
 * Talks to the native TIS helper. The helper only reads and selects input
 * sources; it never types, never opens a window and needs no permission grant.
 */
export function nativeImeBackend(executable = helperPath()): ImeBackend {
  function call(command: string, args: string[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(executable, [command, ...args], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          return reject(new Fault('IME_DEPENDENCY',
            'The input source helper is unavailable. Build it with pnpm build:recorder', true));
        }
        let envelope: Record<string, unknown>;
        try {
          envelope = object(JSON.parse(stdout));
        } catch {
          return reject(new Fault('IME_DEPENDENCY', 'The input source helper returned no JSON envelope', true));
        }
        if (envelope.ok === true) return resolve(envelope.data);
        const fault = (() => {
          try { return object(envelope.error ?? {}); } catch { return {}; }
        })();
        reject(new Fault(
          typeof fault.code === 'string' && /^[A-Z_]+$/.test(fault.code) ? fault.code : 'IME_FAILED',
          typeof fault.message === 'string' ? fault.message : `input source ${command} failed`,
        ));
      });
    });
  }
  function parseSource(value: unknown): InputSource {
    const record = object(value);
    if (typeof record.id !== 'string' || !record.id) throw new Fault('BAD_RESPONSE', 'Missing input source ID');
    return {
      id: record.id,
      name: typeof record.name === 'string' && record.name ? record.name : record.id,
      ascii: record.ascii === true,
      ...(typeof record.selectable === 'boolean' ? { selectable: record.selectable } : {}),
    };
  }
  return {
    async available() {
      try {
        await call('version');
        return true;
      } catch (error) {
        if (error instanceof Fault && error.code === 'IME_DEPENDENCY') return false;
        return true;
      }
    },
    async list() {
      const data = object(await call('list'));
      if (!Array.isArray(data.sources)) throw new Fault('BAD_RESPONSE', 'Expected an input source list');
      return data.sources.map(parseSource);
    },
    async current() {
      const data = object(await call('current'));
      return parseSource(data.source);
    },
    async select(id) {
      if (!id) throw new Fault('INPUT_ERROR', 'An input source ID is required');
      await call('select', ['--id', id]);
    },
  };
}

export interface ImeRunRecord {
  version: 1;
  runId: string;
  original: InputSource;
  target?: InputSource;
  switchedAt: string;
  pid: number;
}

interface LockRecord {
  runId: string;
  pid: number;
  expiresAt: string;
}

/** Default state root. `CUEKEEPER_IME_DIR` keeps tests out of the home directory. */
export function defaultImeDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.CUEKEEPER_IME_DIR?.trim();
  return configured ? configured : join(homedir(), '.cuekeeper', 'ime');
}

/** ABC first, then U.S.; the configured ID wins when it resolves. */
export function chooseAsciiSource(sources: InputSource[], targetId?: string) {
  const usable = (source: InputSource) => source.ascii && source.selectable !== false;
  if (targetId) {
    const configured = sources.find(source => usable(source) &&
      (source.id === targetId || source.name === targetId));
    if (configured) return configured;
  }
  return sources.find(source => usable(source) &&
      (source.id === 'com.apple.keylayout.ABC' || source.name === 'ABC'))
    ?? sources.find(source => usable(source) &&
      (source.id === 'com.apple.keylayout.US' || source.name === 'U.S.' || source.name === 'US'));
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseRecordedSource(value: unknown): InputSource | undefined {
  try {
    const record = object(value);
    if (typeof record.id !== 'string' || !record.id) return undefined;
    return {
      id: record.id,
      name: typeof record.name === 'string' && record.name ? record.name : record.id,
      ascii: record.ascii === true,
    };
  } catch {
    return undefined;
  }
}

export async function readImeRecord(directory: string): Promise<ImeRunRecord> {
  const path = directory.endsWith('ime.json') ? directory : join(directory, 'ime.json');
  const raw = await readJsonFile(path);
  if (!raw) throw new Fault('INPUT_ERROR', `No ime.json in ${dirname(path)}`);
  const record = object(raw);
  const original = parseRecordedSource(record.original);
  const target = parseRecordedSource(record.target);
  if (record.version !== 1 || typeof record.runId !== 'string' || !record.runId || !original) {
    throw new Fault('INPUT_ERROR', `Invalid ime.json in ${dirname(path)}`);
  }
  return {
    version: 1,
    runId: record.runId,
    original,
    ...(target ? { target } : {}),
    switchedAt: typeof record.switchedAt === 'string' ? record.switchedAt : '',
    pid: typeof record.pid === 'number' ? record.pid : 0,
  };
}

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ImeManagerOptions {
  backend: ImeBackend;
  /** Identifies the run in warnings, the lock and ime.json. */
  runId?: string;
  /** Directory holding this run's ime.json; defaults under the state root. */
  runDir?: string;
  /** State root for the lock and run directories. */
  baseDir?: string;
  /** Configured ASCII target (ID or display name). ABC, then U.S. when absent. */
  targetId?: string;
  /** False for --no-input-source-switch: warn instead of touching the source. */
  switchEnabled?: boolean;
  lockTtlMs?: number;
  now?: () => number;
  pid?: number;
}

/** What one attempt to select an ASCII source achieved. */
type AsciiOutcome =
  | { ok: true; source: InputSource }
  | { ok: false; reason: 'missing' | 'select' | 'readback'; seen?: InputSource };

/**
 * The input-source guard for one replay run.
 *
 * - The original source is snapshotted before the first switch and written to
 *   ime.json before TIS is touched, so a SIGKILL still leaves a recovery file.
 * - A step re-reads the current source: another ASCII source is accepted, while
 *   a non-ASCII source after the first switch is treated as the user's choice.
 * - restore() never throws; it reports what it could and could not restore.
 */
export class InputSourceManager {
  readonly runId: string;
  readonly runDir: string;
  private backend: ImeBackend;
  private targetId?: string;
  private switchEnabled: boolean;
  private lockFile: string;
  private lockTtlMs: number;
  private now: () => number;
  private pid: number;
  private knownAvailable?: boolean;
  private original?: InputSource;
  private target?: InputSource;
  /** The ASCII source the run is currently relying on (target or accepted). */
  private activeAscii?: InputSource;
  private switched = false;
  private sawAscii = false;
  private lockOwned = false;
  private collected: ImeWarning[] = [];

  constructor(options: ImeManagerOptions) {
    this.backend = options.backend;
    this.runId = options.runId ?? `run-${randomUUID()}`;
    const baseDir = options.baseDir ?? defaultImeDir();
    this.runDir = options.runDir ?? join(baseDir, 'runs', this.runId);
    this.targetId = options.targetId;
    this.switchEnabled = options.switchEnabled !== false;
    this.lockFile = join(baseDir, 'ime.lock');
    this.lockTtlMs = options.lockTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
  }

  warnings() {
    return [...this.collected];
  }

  summary(final?: InputSource): ImeSummary {
    return {
      switched: this.switched,
      ...(this.original ? { original: this.original } : {}),
      ...(this.target ? { target: this.target } : {}),
      ...(final ? { final } : {}),
      // Only a run that actually touched TIS has a recovery file to point at.
      ...(this.switched ? { runDir: this.runDir } : {}),
    };
  }

  private warn(value: ImeWarning) {
    if (this.collected.some(item => item.code === value.code)) return value;
    this.collected.push(value);
    return value;
  }

  private async available() {
    if (this.knownAvailable === undefined) {
      try {
        this.knownAvailable = await this.backend.available();
      } catch {
        this.knownAvailable = false;
      }
    }
    return this.knownAvailable;
  }

  private expiresAt() {
    return new Date(this.now() + this.lockTtlMs).toISOString();
  }

  private async lockHolder(): Promise<LockRecord | undefined> {
    const raw = await readJsonFile(this.lockFile);
    if (!raw) return undefined;
    try {
      const record = object(raw);
      if (typeof record.runId !== 'string' || typeof record.pid !== 'number' ||
          typeof record.expiresAt !== 'string') return undefined;
      return { runId: record.runId, pid: record.pid, expiresAt: record.expiresAt };
    } catch {
      return undefined;
    }
  }

  private async acquireLock() {
    if (this.lockOwned) {
      await writeFile(this.lockFile, JSON.stringify({
        runId: this.runId, pid: this.pid, expiresAt: this.expiresAt(),
      } satisfies LockRecord), { mode: 0o600 });
      return;
    }
    await mkdir(dirname(this.lockFile), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.lockFile, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({
            runId: this.runId, pid: this.pid, expiresAt: this.expiresAt(),
          } satisfies LockRecord));
        } finally {
          await handle.close();
        }
        this.lockOwned = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Fault('IME_LOCK_FAILED', 'Could not create the input source lock');
        }
        const holder = await this.lockHolder();
        const stale = !holder || Date.parse(holder.expiresAt) <= this.now() || !alive(holder.pid);
        if (!stale) throw new ImeFault(this.warn(busy(holder)));
        await unlink(this.lockFile).catch(() => {});
      }
    }
    throw new ImeFault(this.warn(busy(await this.lockHolder())));
  }

  private async releaseLock() {
    if (!this.lockOwned) return;
    this.lockOwned = false;
    const holder = await this.lockHolder();
    if (holder?.runId === this.runId) await unlink(this.lockFile).catch(() => {});
  }

  private async writeRecord() {
    if (!this.original) return;
    await mkdir(this.runDir, { recursive: true, mode: 0o700 });
    const record: ImeRunRecord = {
      version: 1,
      runId: this.runId,
      original: this.original,
      ...(this.target ? { target: this.target } : {}),
      switchedAt: new Date(this.now()).toISOString(),
      pid: this.pid,
    };
    // Write beside the final name first: a crash never leaves a half-written
    // recovery file, which would make `ime restore --run` restore garbage.
    const staging = join(this.runDir, 'ime.json.tmp');
    await writeFile(staging, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(this.runDir, 'ime.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    await unlink(staging).catch(() => {});
  }

  private async removeRecord() {
    await unlink(join(this.runDir, 'ime.json')).catch(() => {});
  }

  /** Reads the current source or throws the blocked warning for C4. */
  private async readCurrent(): Promise<InputSource> {
    try {
      return await this.backend.current();
    } catch {
      throw new ImeFault(this.warn(sourceUnavailable(undefined, this.targetId)));
    }
  }

  private async ensureAscii(current: InputSource) {
    const outcome = await this.applyAscii();
    if (outcome.ok) return;
    if (outcome.reason === 'readback' && outcome.seen) {
      throw new ImeFault(this.warn(warning('IME_SOURCE_UNAVAILABLE', 'blocked',
        `已请求切换到「${this.target?.name}」，但系统当前仍是「${outcome.seen.name}」；本轮已停止。`,
        { attempted: this.target, current: outcome.seen })));
    }
    throw new ImeFault(this.warn(sourceUnavailable(current, this.targetId)));
  }

  /**
   * Selects the ASCII target and reads it back. Replay turns a failure into a
   * blocked fault; recording turns it into a warning. Both share this switch so
   * the lock, the snapshot and the read-back rule stay in one place.
   */
  private async applyAscii(): Promise<AsciiOutcome> {
    const sources = await this.backend.list().catch(() => [] as InputSource[]);
    const target = chooseAsciiSource(sources, this.targetId);
    if (!target) return { ok: false, reason: 'missing' };
    this.target = target;
    await this.acquireLock();
    // ime.json must exist before TIS changes, or a crash loses the original.
    await this.writeRecord();
    try {
      await this.backend.select(target.id);
    } catch {
      try {
        await this.backend.select(target.id);
      } catch {
        return { ok: false, reason: 'select' };
      }
    }
    // The switch happened; a failed read-back still needs a restore.
    this.switched = true;
    let after: InputSource;
    try {
      after = await this.backend.current();
    } catch {
      return { ok: false, reason: 'readback' };
    }
    if (after.id !== target.id) return { ok: false, reason: 'readback', seen: after };
    this.activeAscii = after;
    return { ok: true, source: after };
  }

  /**
   * Recording-time switch: an ASCII source before capture starts.
   *
   * Unlike `prepare()`, nothing here blocks the recording. A missing helper, a
   * missing ASCII source, a lock held by another run or a failed TIS call all
   * become one warning: a flow recorded under the wrong source is still worth
   * keeping. The caller restores the user's source with `restore(true)`.
   */
  async startRecording(): Promise<ImeSummary> {
    if (!await this.available()) {
      this.warn(imeUnavailable());
      return this.summary();
    }
    let current: InputSource;
    try {
      current = await this.backend.current();
    } catch {
      this.warn(switchFailed('读不到当前输入源，输入法未切换，可能影响文本捕获。'));
      return this.summary();
    }
    if (current.ascii) {
      // Already safe: never touch TIS and never take the lock.
      this.sawAscii = true;
      this.activeAscii = current;
      return this.summary(current);
    }
    this.original = current;
    const holder = (await readImeLock(dirname(this.lockFile))).holder;
    if (holder && holder.runId !== this.runId &&
        Date.parse(holder.expiresAt) > this.now() && alive(holder.pid)) {
      this.warn(switchFailed(
        `另一个测试（run ${holder.runId}）正在管理输入法，本次录制没有切换，可能影响文本捕获。`, current));
      return this.summary(current);
    }
    let outcome: AsciiOutcome;
    try {
      outcome = await this.applyAscii();
    } catch {
      this.warn(switchFailed('切换输入法失败，本次录制沿用当前输入源，可能影响文本捕获。', current));
      return this.summary(current);
    }
    if (outcome.ok) return this.summary(outcome.source);
    const target = this.target?.name ?? 'ABC';
    this.warn(switchFailed(outcome.reason === 'missing'
      ? '系统里没有可用的 ABC 或 U.S. 输入源，输入法未切换，可能影响文本捕获。'
      : outcome.reason === 'select'
        ? `切换到「${target}」失败，输入法未切换，可能影响文本捕获。`
        : `已请求切换到「${target}」，但系统当前仍是「${outcome.seen?.name ?? '原输入法'}」，可能影响文本捕获。`,
    current));
    return this.summary(outcome.seen ?? current);
  }

  /**
   * Called before every ASCII `type` and character `key` step. Non-ASCII text
   * is left alone: Unicode injection does not depend on the input source.
   */
  async prepare(kind: 'type' | 'key', text: string, modifiers: readonly string[] = []) {
    const guarded = kind === 'type' ? isAsciiText(text) : physicalAsciiKey(text, modifiers);
    if (!guarded) return;
    // A long run refreshes its own lock so a TTL never expires under it.
    if (this.lockOwned) await this.acquireLock();
    if (!await this.available()) {
      this.warn(imeUnavailable());
      return;
    }
    const current = await this.readCurrent();
    if (current.ascii) {
      this.sawAscii = true;
      this.activeAscii = current;
      return;
    }
    if (!this.switchEnabled) {
      if (kind === 'type') {
        this.warn(switchDisabled(current));
        return;
      }
      throw new ImeFault(this.warn(physicalBlocked(current)));
    }
    if (this.switched || this.sawAscii) {
      // The user chose another source mid-run; never take it back.
      throw new ImeFault(this.warn(changedByUser(this.activeAscii ?? this.original ?? current, current, this.runId)));
    }
    if (!this.original) this.original = current;
    await this.ensureAscii(current);
  }

  /**
   * Best-effort restore for the run's `finally`; never throws.
   *
   * `recording` only changes the wording when the user took the source back:
   * a recording keeps going, it does not stop the input.
   */
  async restore(recording = false): Promise<ImeRestoreResult> {
    let final: InputSource | undefined;
    try {
      if (!await this.available() || !this.switched) {
        // Nothing was switched, so a snapshot may exist without a restore to
        // match it; it must not be left for `ime restore --run` to replay.
        if (!this.switched) await this.removeRecord();
        return { warnings: this.warnings(), summary: this.summary() };
      }
      const original = this.original;
      if (!original) return { warnings: this.warnings(), summary: this.summary() };
      let current: InputSource;
      try {
        current = await this.backend.current();
        final = current;
      } catch {
        // D3: a failed read never claims success.
        const copy = recording
          ? `录制结束后无法读取当前输入源，无法确认是否已切回「${original.name}」。录制结果已保存。`
          : `运行结束后无法读取当前输入源，无法确认是否已切回「${original.name}」。测试结果已正常记录。`;
        this.warn(warning('IME_RESTORE_FAILED', 'warning', copy, { original, attempted: original }));
        return { warnings: this.warnings(), summary: this.summary(final) };
      }
      if (this.activeAscii && current.id !== this.activeAscii.id) {
        // B3: the user changed the source after the last step; keep it, but
        // still report a vanished original if both facts are true (C3).
        this.warn(changedByUser(this.activeAscii, current, this.runId, recording));
        const sources = await this.backend.list().catch(() => [] as InputSource[]);
        if (!sources.some(source => source.id === original.id)) {
          this.warn(restoreUnavailable(original, current));
        }
        return { warnings: this.warnings(), summary: this.summary(current) };
      }
      if (current.id === original.id) {
        await this.removeRecord();
        return { warnings: this.warnings(), summary: this.summary(current) };
      }
      const sources = await this.backend.list().catch(() => [] as InputSource[]);
      if (!sources.some(source => source.id === original.id)) {
        this.warn(restoreUnavailable(original, current));
        return { warnings: this.warnings(), summary: this.summary(current) };
      }
      let selectError = false;
      try {
        await this.backend.select(original.id);
      } catch {
        try {
          await this.backend.select(original.id);
        } catch {
          selectError = true;
        }
      }
      let verified: InputSource | undefined;
      try {
        verified = await this.backend.current();
        final = verified;
      } catch {
        verified = undefined;
      }
      if (selectError || !verified || verified.id !== original.id) {
        this.warn(warning('IME_RESTORE_FAILED', 'warning',
          `已尝试切回「${original.name}」，但系统仍停留在「${verified?.name ?? current.name}」。` +
            (recording ? '录制结果已保存。' : '测试结果已正常记录。'),
          { original, current: verified ?? current, attempted: original, ...(verified ? { verified } : {}) }));
        return { warnings: this.warnings(), summary: this.summary(final ?? current) };
      }
      await this.removeRecord();
      return { warnings: this.warnings(), summary: this.summary(verified) };
    } finally {
      await this.releaseLock().catch(() => {});
    }
  }
}

/** `cuekeeper ime restore --run <dir>`; reports instead of guessing. */
export async function restoreImeRecord(
  record: ImeRunRecord, backend: ImeBackend, runId = record.runId,
): Promise<{ restored: boolean; warning?: ImeWarning; current?: InputSource; original: InputSource }> {
  let current: InputSource | undefined;
  try {
    current = await backend.current();
  } catch {
    return {
      restored: false,
      original: record.original,
      warning: warning('IME_RESTORE_FAILED', 'warning',
        `无法读取当前输入源，无法确认是否已切回「${record.original.name}」。`,
        { original: record.original, runId }),
    };
  }
  if (current.id === record.original.id) {
    return { restored: true, current, original: record.original };
  }
  const sources = await backend.list().catch(() => [] as InputSource[]);
  if (!sources.some(source => source.id === record.original.id)) {
    return {
      restored: false,
      current,
      original: record.original,
      warning: warning('IME_RESTORE_UNAVAILABLE', 'warning',
        `找不到原输入源「${record.original.name}」（ID ${record.original.id}），因此没有自动恢复；当前保持「${current.name}」。`,
        { original: record.original, current, runId }),
    };
  }
  let failure = false;
  try {
    await backend.select(record.original.id);
  } catch {
    try {
      await backend.select(record.original.id);
    } catch {
      failure = true;
    }
  }
  let verified: InputSource | undefined;
  try {
    verified = await backend.current();
  } catch {
    verified = undefined;
  }
  if (failure || !verified || verified.id !== record.original.id) {
    return {
      restored: false,
      current: verified ?? current,
      original: record.original,
      warning: warning('IME_RESTORE_FAILED', 'warning',
        `已尝试切回「${record.original.name}」，但系统仍停留在「${(verified ?? current).name}」。`,
        {
          original: record.original, current: verified ?? current,
          attempted: record.original, ...(verified ? { verified } : {}), runId,
        }),
    };
  }
  return { restored: true, current: verified, original: record.original };
}

/** `cuekeeper ime restore --run <dir>` removes the recovery file after success. */
export async function removeImeRecord(directory: string) {
  const path = directory.endsWith('ime.json') ? directory : join(directory, 'ime.json');
  await unlink(path).catch(() => {});
}

export interface LockState {
  path: string;
  holder?: LockRecord;
  stale: boolean;
}

export async function readImeLock(baseDir = defaultImeDir()): Promise<LockState> {
  const path = join(baseDir, 'ime.lock');
  const raw = await readJsonFile(path);
  if (!raw) return { path, stale: false };
  try {
    const record = object(raw);
    if (typeof record.runId !== 'string' || typeof record.pid !== 'number' ||
        typeof record.expiresAt !== 'string') return { path, stale: true };
    return {
      path,
      stale: Date.parse(record.expiresAt) <= Date.now() || !alive(record.pid),
      holder: { runId: record.runId, pid: record.pid, expiresAt: record.expiresAt },
    };
  } catch {
    return { path, stale: true };
  }
}

/** `cuekeeper ime unlock --run <id>` removes only a matching lock. */
export async function releaseImeLock(runId: string, baseDir = defaultImeDir()) {
  const state = await readImeLock(baseDir);
  if (!state.holder) return { released: false, path: state.path };
  if (state.holder.runId !== runId) return { released: false, path: state.path, holder: state.holder };
  await unlink(state.path).catch(() => {});
  return { released: true, path: state.path };
}

/** Recording metadata: the source the user had when capture started. */
export async function detectInputSource(backend: ImeBackend): Promise<InputSource | undefined> {
  try {
    if (!await backend.available()) return undefined;
    return await backend.current();
  } catch {
    return undefined;
  }
}
