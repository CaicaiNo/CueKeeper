import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listApps } from './app-catalog.js';
import { appIconPng } from './apps.js';
import { loadBaseline } from './assertion.js';
import { BuiltinBehaviorError, builtinBehaviorViews } from './builtin-behaviors.js';
import { fixtureAppPath, offlineDesktop, withDesktop } from './desktop.js';
import { captureHealth } from './doctor.js';
import type { RecordHealth } from './doctor.js';
import { readJson, writeNew } from './files.js';
import { hashFlow, plan } from './flow.js';
import { dryRunFlowV2, hashFlowV2, isFlowV2, pointTargetSteps } from './flow-v2.js';
import type { FlowV2, StepV2, WindowScope } from './contracts-v2.js';
import { Fault, object } from './locator.js';
import { crop, decodePng, encodePng } from './png.js';
import { runFlow } from './run.js';
import type { ShellRunOptions } from './run.js';
import { createRootPrivilegeRunner } from './shell-privilege.js';
import { createSudoKeychainStore } from './sudo-credential.js';
import { startReplayIndicator } from './indicator.js';
import type { ReplayIndicator } from './indicator.js';
import type { SudoKeychainStore } from './sudo-credential.js';
import {
  describeShellStep, hasShellSecrets, reachableShells, shellGate, shellPrivilege,
} from './shell.js';
import { keepConfirmedSetup } from './setup.js';
import { parseLibraryItem, parseTestItem, resolveSecrets } from './test-item.js';
import { workbenchAssets } from './workbench-assets.js';
import { BatchError, BatchRunner, listBatchCandidates } from './workbench-batch.js';
import { createRecordController } from './workbench-record.js';
import type { RecordStatus } from './workbench-record.js';
import { loadSession, sameTarget } from './workbench-session.js';
import { EditError, loadEditableFlow } from './workbench-edit.js';
import type { EditableFlowV2, EditOp } from './workbench-edit.js';
import { parseCheckpointWait } from './manual-checkpoint.js';
import { pickWindowCandidates } from './workbench-pick.js';
import type { WindowPickResult } from './workbench-pick.js';
import { confirmWaitCandidate } from './wait-candidates.js';
import type { WaitCandidate } from './wait-candidates.js';
import {
  applyTemplate, createTemplate, deleteTemplate, listTemplates, parseTemplate, saveTemplate,
  templateCandidates, templateDirectory,
} from './templates.js';
import type { TemplateSelection } from './templates.js';
import { createDesktopWorkdir, prepareWorkdir, workdirEnv, workdirRoot } from './workdir.js';

const staticFiles = new Map(workbenchAssets.map(asset => [asset.path, [asset.file, asset.type] as const]));

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Workbench input exceeds 8 MiB');
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString()));
}

function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function readRegion(input: unknown) {
  const value = object(input);
  const numbers = ['x', 'y', 'width', 'height'].map(key => value[key]);
  if (!numbers.every(item => typeof item === 'number' && Number.isSafeInteger(item))) {
    throw new Error('Region coordinates must be whole pixels');
  }
  const [x, y, width, height] = numbers as number[];
  if (x < 0 || y < 0 || x > 8191 || y > 8191 || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('Region is outside the supported pixel area');
  }
  if (width * height > 16_777_216) throw new Error('Region exceeds the pixel limit');
  return { x, y, width, height };
}

async function saveBaseline(directory: string, source: string, region: ReturnType<typeof readRegion>) {
  const path = isAbsolute(source) ? source : join(directory, source);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Choose a regular full-window PNG file');
  if (info.size > 64 * 1024 * 1024) throw new Error('The baseline source is too large');
  const bytes = new Uint8Array(await readFile(path));
  let image;
  try {
    image = decodePng(bytes);
  } catch {
    throw new Error('The baseline source is not a usable PNG');
  }
  const cropped = encodePng(crop(image, region.x, region.y, region.width, region.height));
  const sha256 = createHash('sha256').update(cropped).digest('hex');
  const baselines = join(directory, 'baselines');
  await mkdir(baselines, { recursive: true, mode: 0o700 });
  const target = join(baselines, `${sha256}.png`);
  try {
    const existing = await readFile(target);
    if (!Buffer.from(existing).equals(Buffer.from(cropped))) {
      throw new Error('A different baseline file already uses this digest');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(target, cropped, { mode: 0o600 });
  }
  return { sha256, frameWidth: image.width, frameHeight: image.height };
}

async function writeProposedWaitFlow(directory: string, flow: FlowV2): Promise<string> {
  for (let nth = 1; nth <= 50; nth++) {
    const path = join(directory, nth === 1 ? 'flow.with-waits.json' : `flow.with-waits-${nth}.json`);
    try {
      await writeNew(path, JSON.stringify(flow, null, 2) + '\n');
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('No free flow.with-waits name left in this run directory');
}

/**
 * An applied template becomes an ordinary workflow in its own directory, so it
 * is saved, edited and replayed exactly like a recording. Nothing is written
 * back into the template or the recording it came from.
 */
async function writeAppliedTemplate(flow: FlowV2, root: string, directoryName: string): Promise<string> {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'flow.json');
  await writeFile(path, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function newTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}


interface ConfirmationToken {
  sessionId: string;
  flowSha256: string;
  planHash: string;
  expiresAt: number;
}

const confirmationTtlMs = 120_000;

function stepsNeedLive(planned: ReturnType<typeof plan>) {
  return planned.some(({ action }) =>
    action.kind === 'hover' ||
    ((action.kind === 'click' || action.kind === 'scroll') && action.target.kind === 'point') ||
    (action.kind === 'drag' && (action.from.kind === 'point' || action.to.kind === 'point')));
}

function planHash(sessionId: string, flowSha256: string, steps: unknown, captureOutput: boolean) {
  return createHash('sha256')
    .update(JSON.stringify({ sessionId, flowSha256, steps, captureOutput }))
    .digest('hex');
}

/** Runtime values for a live v2 replay, one string per declared parameter. */
function inputValues(names: readonly string[], raw: unknown): Record<string, string> {
  const source = raw === undefined ? {} : object(raw);
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 4000) {
      throw new Error(`Input ${name} needs a value before a live replay`);
    }
    values[name] = value;
  }
  return values;
}

/** The v2 report a `run` subprocess printed as its last JSON line. */
function cliReport(stdout: string, stderr = ''): unknown {
  const detail = stderr.trim().split('\n').at(-1);
  const suffix = detail ? `: ${detail}` : '';
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(`The replay process printed no report${suffix}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`The replay process did not print a JSON report${suffix}`);
  }
  const envelope = object(parsed);
  if (envelope.data === undefined) throw new Error(`The replay process printed an unexpected report${suffix}`);
  return envelope.data;
}

/** A checkpoint the CLI announced on stderr and the page may still answer. */
interface CheckpointState {
  stepId: string;
  triggerStepId: string;
  timeoutMs: number;
  scope?: WindowScope;
  /** Wall-clock budget the CLI applies to the hand-off. */
  deadline: number;
}

interface CliRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CliRunHandle {
  done: Promise<CliRunResult>;
  /** Writes one answer line to the child's stdin; false when it is closed. */
  write(line: string): boolean;
}

export async function startWorkbench(options: {
  directory?: string; port: number; library?: string; allowLive: boolean;
  allowShell?: boolean; allowSudo?: boolean; signal: AbortSignal;
  /** The CLI used by a live v2 replay; tests point it at a stub. */
  cliPath?: string;
  /**
   * The read-only window snapshot the v2 editor picks elements from; tests
   * replace the live agent-desktop call with a fake desktop.
   */
  pickWindow?: (scope: WindowScope, signal: AbortSignal) => Promise<WindowPickResult>;
  record?: { cli?: string; recordings?: string; stopTimeoutMs?: number };
  /** Tests replace the read-only probe that gates the record button. */
  recordHealth?: () => Promise<RecordHealth>;
  /** The login-keychain store the page writes an administrator password to. */
  sudoStore?: SudoKeychainStore;
  /** Tests replace the batch's blue overlay; the release spawns the helper. */
  startIndicator?: (onCancel: () => void) => ReplayIndicator;
  /** Where saved templates live; defaults to ~/.cuekeeper/templates. */
  templates?: string;
  /** Where an applied template writes its new workflow; defaults to ~/.cuekeeper/applied. */
  applied?: string;
}) {
  let session = options.directory ? await loadSession(options.directory) : undefined;
  let importedRecording: string | undefined;
  // A v2 session keeps its editing state in this server process; the P2 engine
  // owns mutations, undo/redo, validation, the diff and revision writes.
  const openEditor = async (loaded: Awaited<ReturnType<typeof loadSession>> | undefined, recording?: string) => {
    if (!loaded || loaded.view.version !== 2) return undefined;
    const flowPath = recording ?? (loaded.view as { flowPath?: string }).flowPath;
    if (!flowPath) throw new Error('The version 2 session has no recording path');
    return loadEditableFlow(flowPath);
  };
  let editable = await openEditor(session);
  const library = resolve(options.library ?? join(homedir(), '.cuekeeper', 'behaviors'));
  const templateRoot = resolve(options.templates ?? templateDirectory());
  const appliedRoot = resolve(options.applied ?? join(homedir(), '.cuekeeper', 'applied'));
  const allowLive = options.allowLive && process.platform === 'darwin';
  const allowShell = options.allowShell ?? false;
  const allowSudo = options.allowSudo ?? false;
  // Create the durable work root before the first recording, so a workbench
  // started from a shell whose TMPDIR is already gone still has somewhere to
  // put per-run desktop state.
  const workRoot = workdirRoot();
  const workdirFailure = await prepareWorkdir(workRoot);
  if (workdirFailure) {
    console.error(`无法准备临时目录 ${workRoot}（${workdirFailure}）；录制会自动回退到系统临时目录。`);
  }
  const tokens = new Map<string, ConfirmationToken>();
  const cliPath = options.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  const sudoStore = options.sudoStore ?? createSudoKeychainStore();
  // A pick reads one window snapshot; it never focuses, captures or types.
  const pickWindow = options.pickWindow ?? ((scope: WindowScope, signal: AbortSignal) =>
    withDesktop({ headed: false, signal, workRoot }, desktop => pickWindowCandidates(desktop, scope)));
  let running = false;
  let currentRun: AbortController | undefined;
  let currentChild: ChildProcess | undefined;
  /** Step entries the replay has already finished, for the live timeline. */
  let liveEntries: Record<string, unknown>[] = [];
  let childStopped = false;
  /** The checkpoint the waiting CLI child announced, while the page may answer. */
  let checkpointWait: CheckpointState | undefined;
  /** Writes one answer line to the CLI child's stdin; only set for a checkpoint run. */
  let checkpointAnswer: ((line: string) => boolean) | undefined;
  // The batch queue owns the same desktop as a single replay: beginning a batch
  // flips the single-run guard too, so the two can never overlap.
  const batch = new BatchRunner({
    directory: () => session?.directory ?? '',
    cliPath,
    workRoot,
    allowLive: () => allowLive,
    allowShell: () => allowShell,
    allowSudo: () => allowSudo,
    begin: () => { running = true; },
    end: () => { running = false; },
    ...(options.startIndicator ? { startIndicator: options.startIndicator } : {}),
  });
  let origin: string;
  const recorder = createRecordController({
    cli: options.record?.cli ?? fileURLToPath(new URL('./cli.js', import.meta.url)),
    recordings: options.record?.recordings,
    stopTimeoutMs: options.record?.stopTimeoutMs,
    workRoot,
    busy: () => running,
  });

  /** The editing snapshot the page renders after every v2 call. */
  function v2View() {
    if (!editable) return undefined;
    const flow = editable.flow;
    const saved = editable.savedRevisions;
    const flowSha256 = hashFlowV2(flow);
    // The page names the file a live replay would run, so an untouched import
    // replays the recording itself instead of demanding a revision.
    const target = editable.replayTarget();
    return {
      flowPath: editable.source.path,
      originalSha256: editable.source.sha256,
      originalFlowSha256: editable.source.flowSha256,
      flow,
      diff: editable.diff(),
      // Dirty means "differs from the last saved revision"; with no revision
      // yet it means "differs from the recording".
      dirty: saved.length
        ? saved.at(-1)!.flowSha256 !== flowSha256
        : flowSha256 !== editable.source.flowSha256,
      live: target && { path: target.path, revision: target.kind === 'revision' },
      validation: editable.validate(),
      canUndo: editable.canUndo,
      canRedo: editable.canRedo,
      saved: saved.map(revision => ({
        path: revision.path,
        createdAt: revision.createdAt,
        flowSha256: revision.flowSha256,
        changed: revision.diff.changed,
      })),
    };
  }

  function sessionView(loaded: NonNullable<typeof session>) {
    const view = { ...loaded.view } as Record<string, unknown>;
    const editor = v2View();
    if (editor) view.v2 = editor;
    return view;
  }

  /**
   * Starts the replay CLI. A checkpoint run keeps stdin open so the page can
   * answer with one `continue` or `cancel` line, and its stderr is also read
   * line by line for the fixed CHECKPOINT_WAIT marker.
   */
  function startCli(args: string[], cwd: string, options: {
    stdin?: boolean;
    onStderrLine?: (line: string) => void;
  } = {}): CliRunHandle {
    let child: ChildProcess | undefined;
    const done = new Promise<CliRunResult>((resolveRun, rejectRun) => {
      child = spawn(process.execPath, [cliPath, ...args], {
        cwd, stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // The replay child holds no durable root of its own; hand it ours so
        // its desktop state never depends on the inherited TMPDIR.
        env: { ...process.env, [workdirEnv]: workRoot },
      });
      currentChild = child;
      liveEntries = [];
      let stdout = '';
      let stderr = '';
      let pending = '';
      const readLine = (line: string) => {
        if (options.onStderrLine && line) options.onStderrLine(line);
      };
      let pendingStdout = '';
      child.stdout?.on('data', chunk => {
        const text = String(chunk);
        stdout += text;
        pendingStdout += text;
        const lines = pendingStdout.split('\n');
        pendingStdout = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = object(JSON.parse(line));
            if (parsed.kind === 'step' && parsed.entry !== undefined) {
              liveEntries.push(object(parsed.entry));
            }
          } catch {
            // The final report line is parsed once the process exits.
          }
        }
      });
      child.stderr?.on('data', chunk => {
        const text = String(chunk);
        stderr += text;
        if (!options.onStderrLine) return;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) readLine(line);
      });
      child.once('error', error => {
        currentChild = undefined;
        rejectRun(error);
      });
      child.once('close', (code, signal) => {
        currentChild = undefined;
        // A last line without a newline still carries its marker.
        if (pending) readLine(pending);
        resolveRun({ code, signal, stdout, stderr });
      });
    });
    return {
      done,
      write(line) {
        if (!child?.stdin?.writable) return false;
        child.stdin.write(line);
        return true;
      },
    };
  }

  function libraryEntry(item: Awaited<ReturnType<typeof parseLibraryItem>>) {
    const shells = item.behavior.steps.filter(step => step.kind === 'shell');
    return {
      ...item,
      source: 'custom' as const,
      editable: true,
      shell: {
        steps: shells.length,
        privileged: shells.filter(step => step.kind === 'shell' && shellPrivilege(step) !== 'user').length,
      },
    };
  }

  /**
   * A stopped recording enters the workbench through the same session loader
   * the import button uses, so the timeline reflects it without a second
   * reader. A flow the CLI never wrote (killed after the stop timeout, empty
   * run) becomes a warning on the stop result, not a failed request.
   */
  async function importRecording(result: RecordStatus) {
    if (!result.flowPath) return undefined;
    const warn = (code: string, message: string) => {
      // A repeated stop returns the same result object; keep its warnings stable.
      if (!result.warnings.some(warning => warning.code === code)) result.warnings.push({ code, message });
    };
    // A repeated stop must not pull an older recording back over a session the
    // operator imported by hand afterwards.
    if (result.flowPath === importedRecording) return undefined;
    let present = false;
    try {
      present = (await lstat(result.flowPath)).isFile();
    } catch {
      present = false;
    }
    if (!present) {
      warn('RECORD_NOT_SAVED', 'The recording stopped before CueKeeper wrote a flow file.');
      return undefined;
    }
    try {
      const imported = await loadSession(dirname(result.flowPath), { flowFile: basename(result.flowPath) });
      // The freed recording becomes the editor state too, so the page can edit
      // and replay what was just recorded without a second import.
      const nextEditable = await openEditor(imported, result.flowPath);
      session = imported;
      editable = nextEditable;
      importedRecording = result.flowPath;
      return imported.view;
    } catch (error) {
      warn('RECORD_IMPORT_FAILED',
        `The recording was saved but could not be imported: ${error instanceof Error ? error.message : 'unknown error'}`);
      return undefined;
    }
  }

  /**
   * The library has two groups that never mix: built-in behaviors ship with the
   * product (read-only, inserted as real steps) and custom behaviors live in the
   * library directory the CLI wrote.
   */
  async function listLibrary() {
    const builtin = builtinBehaviorViews();
    let names;
    try {
      names = await readdir(library, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { builtin, custom: [] };
      throw error;
    }
    const custom = await Promise.all(names
      .filter(entry => entry.isFile() && /^[a-z0-9_-]+\.behavior\.json$/i.test(entry.name))
      .map(async entry => libraryEntry(await parseLibraryItem(await readJson(join(library, entry.name))))));
    return { builtin, custom };
  }

  async function requestHandler(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (`http://${request.headers.host}` !== origin) return send(response, 403, { error: 'Invalid workbench host' });
    const path = request.url ?? '';
    const asset = staticFiles.get(path);
    if (request.method === 'GET' && asset) {
      const data = await readFile(new URL(`../workbench/${asset[0]}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }).end(data);
      return;
    }
    if (request.method === 'GET' && path.startsWith('/app-icon/')) {
      const bundleId = decodeURIComponent(path.slice('/app-icon/'.length).split('?')[0]);
      const app = (await listApps()).find(item => item.bundleId === bundleId);
      const png = app ? await appIconPng(app.paths[0]) : undefined;
      if (!png) return send(response, 404, { error: 'Icon unavailable' });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' }).end(png);
      return;
    }
    if (request.method === 'GET' && session && path.startsWith(`/thumbnail/${session.view.id}/`)) {
      const image = session.images.get(path.split('/').at(-1)!);
      if (!image || path.split('/').length !== 4) return send(response, 404, { error: 'Thumbnail unavailable' });
      const data = await readFile(image.path);
      response.writeHead(200, { 'Content-Type': image.type }).end(data);
      return;
    }
    // Record status is polled while a recording runs, so it answers GET. A
    // cross-origin caller cannot set this header without a preflight that this
    // server never approves, which keeps the read same-origin.
    if (request.method === 'GET' && path === '/api/record/status') {
      if (request.headers['x-cuekeeper-workbench'] !== '1') {
        return send(response, 403, { error: 'Use the local CueKeeper workbench' });
      }
      return send(response, 200, recorder.status());
    }
    // Read-only like the status poll: no desktop access, no permission prompt.
    if (request.method === 'GET' && path === '/api/record/health') {
      if (request.headers['x-cuekeeper-workbench'] !== '1') {
        return send(response, 403, { error: 'Use the local CueKeeper workbench' });
      }
      return send(response, 200, await (options.recordHealth ?? (() => captureHealth()))());
    }
    if (request.method !== 'POST' || request.headers.origin !== origin ||
        request.headers['x-cuekeeper-workbench'] !== '1' || request.headers['content-type'] !== 'application/json') {
      return send(response, 403, { error: 'Use the local CueKeeper workbench' });
    }
    const data = await readBody(request);
    if (path === '/api/state') {
      return send(response, 200, {
        session: session ? sessionView(session) : undefined,
        record: recorder.status(),
        allowLive, allowShell, allowSudo, library: await listLibrary(),
      });
    }
    if (path === '/api/apps') return send(response, 200, { apps: await listApps() });
    if (path === '/api/record/start') return send(response, 200, await recorder.start(data));
    if (path === '/api/record/stop') {
      const result = await recorder.stop();
      const view = await importRecording(result);
      return send(response, 200, { ...result, ...(view ? { session: view } : {}) });
    }
    if (path === '/api/import') {
      if (typeof data.directory !== 'string' || !data.directory.trim()) throw new Error('Enter a workflow file or run directory');
      if (running) throw new Error('A test is running');
      if (recorder.recording) throw new Error('Stop the recording before importing another run directory');
      const requested = data.directory.trim();
      const expanded = requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested;
      // Share one flow file without building a directory around it: a path to
      // flow.json is imported from its own folder.
      const info = await lstat(expanded).catch(() => undefined);
      const isFile = info?.isFile() === true;
      const directory = isFile ? dirname(expanded) : expanded;
      const flowFile = isFile ? basename(expanded) : undefined;
      const imported = await loadSession(directory, flowFile ? { flowFile } : {});
      if (running) throw new Error('A test is running');
      const nextEditable = await openEditor(imported);
      session = imported;
      editable = nextEditable;
      // The queue belongs to the previous run directory; a new import starts
      // with an empty one instead of listing another session's saved items.
      batch.reset();
      return send(response, 200, sessionView(imported));
    }
    if (path === '/api/sudo/status') {
      return send(response, 200, await sudoStore.status());
    }
    if (path === '/api/sudo/set') {
      // Storing the credential is only meaningful (and only allowed) when the
      // workbench can use it, and never while a replay owns the keychain.
      if (!allowSudo) throw new Error('Storing an administrator password needs --allow-sudo');
      if (running) throw new Error('A test is running');
      if (data.confirm !== true) {
        throw new Error('Confirm that the password may be stored in the login keychain');
      }
      const password = data.password;
      if (typeof password !== 'string' || password.length === 0 || password.length > 1024 ||
          /[\r\n\0]/.test(password)) {
        throw new Error('Enter the administrator password');
      }
      const stored = await sudoStore.setWithPassword(password);
      return send(response, 201, { ...stored, configured: true });
    }
    if (path === '/api/sudo/clear') {
      if (running) throw new Error('A test is running');
      if (data.confirm !== true) throw new Error('Confirm removal of the stored password');
      return send(response, 200, await sudoStore.clear());
    }
    if (path === '/api/batch/state') {
      return send(response, 200, await batch.snapshot());
    }
    if (path === '/api/batch/open') {
      // Opening a queued workflow is the edit entry from the batch list, not a
      // new import: the queue and its results stay in place.
      if (running) throw new Error('A test is running');
      const directory = session?.directory;
      if (!directory) throw new Error('Import a run directory first');
      if (typeof data.path !== 'string') throw new Error('Choose a workflow');
      const target = resolve(data.path);
      const candidates = await listBatchCandidates(directory);
      const found = candidates.find(candidate => candidate.path === target);
      if (!found) throw new Error('That workflow is not in this queue');
      const loaded = await loadSession(directory, { flowFile: found.file });
      const nextEditable = await openEditor(loaded, join(directory, found.file));
      session = loaded;
      editable = nextEditable;
      return send(response, 200, sessionView(loaded));
    }
    if (path === '/api/batch/start') {
      // A single replay owns the desktop too; a batch must wait for it.
      if (running && !batch.running) {
        return send(response, 409, { error: 'BUSY', message: 'A single test is running' });
      }
      if (recorder.recording) {
        return send(response, 409, { error: 'RECORDING', message: 'Stop the recording before starting a batch' });
      }
      try {
        return send(response, 202, await batch.start(data));
      } catch (error) {
        if (error instanceof BatchError) {
          return send(response, 400, { error: error.code, message: error.message });
        }
        throw error;
      }
    }
    if (path === '/api/batch/stop') {
      return send(response, 200, { stopped: batch.stop() });
    }
    if (path === '/api/batch/report') {
      // Only a report the batch itself wrote under this session may be read.
      const raw = data.path;
      const directory = session?.directory;
      if (typeof raw !== 'string' || !directory) throw new Error('Choose a batch report');
      const target = await realpath(resolve(raw));
      const rel = relative(await realpath(directory), target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) ||
          !/(^|[\\/])batch-[^\\/]+[\\/]round-\d+-\d+[\\/]report\.json$/.test(rel)) {
        throw new Error('That file is not a report from this batch');
      }
      const info = await lstat(target);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('The report is too large to open');
      return send(response, 200, JSON.parse(await readFile(target, 'utf8')));
    }
    if (path === '/api/stop') {
      // A batch stops its own child and keeps the rows it already finished.
      if (batch.running) return send(response, 200, { stopped: batch.stop() });
      // A live v2 replay is a CLI child process; stopping it signals the CLI so
      // its report still records which step was interrupted. A waiting
      // checkpoint ends with its own cancel answer so the report names it.
      if (currentChild) {
        childStopped = true;
        if (checkpointWait && checkpointAnswer?.('cancel\n')) {
          checkpointWait = undefined;
        } else {
          currentChild.kill('SIGINT');
        }
        return send(response, 200, { stopped: true });
      }
      // Stop is bound to the server run, not to a session snapshot.
      if (!currentRun) return send(response, 200, { stopped: false });
      currentRun.abort(new Error('Stopped from the workbench'));
      return send(response, 200, { stopped: true });
    }
    // Templates are saved workflows with `{{name}}` placeholders. They live
    // outside any run directory, so listing one never depends on the open
    // session. Applying one writes an ordinary flow and switches the session.
    if (path.startsWith('/api/templates/')) {
      const failTemplate = (error: unknown) => send(response, 400, {
        error: error instanceof Fault ? error.code : 'TEMPLATE_INVALID',
        message: error instanceof Error ? error.message : 'Template request failed',
      });
      if (path === '/api/templates/list') {
        return send(response, 200, {
          templates: await listTemplates(templateRoot), directory: templateRoot,
        });
      }
      if (path === '/api/templates/create') {
        if (running) return send(response, 409, { error: 'A test is running' });
        if (recorder.recording) return send(response, 409, { error: 'Stop the recording before creating a template' });
        if (!editable) return send(response, 409, { error: 'Open a version 2 workflow before creating a template' });
        try {
          const template = createTemplate({
            id: newTemplateId(),
            name: typeof data.name === 'string' ? data.name : '',
            description: typeof data.description === 'string' ? data.description : undefined,
            flow: editable.flow,
            selections: Array.isArray(data.selections) ? data.selections as TemplateSelection[] : [],
          });
          const saved = await saveTemplate(template, templateRoot);
          return send(response, 201, { template, path: saved });
        } catch (error) {
          return failTemplate(error);
        }
      }
      if (path === '/api/templates/import') {
        try {
          const parsed = parseTemplate(data.template);
          // An import never overwrites an existing template; the same id from
          // another machine gets a fresh one and the page says so.
          const existing = (await listTemplates(templateRoot)).some(item => item.id === parsed.id);
          const template = existing ? { ...parsed, id: newTemplateId() } : parsed;
          const saved = await saveTemplate(template, templateRoot);
          return send(response, 201, { template, path: saved, renamed: existing });
        } catch (error) {
          return failTemplate(error);
        }
      }
      if (path === '/api/templates/candidates') {
        if (!editable) return send(response, 409, { error: 'Open a version 2 workflow first' });
        return send(response, 200, { candidates: templateCandidates(editable.flow) });
      }
      if (path === '/api/templates/delete') {
        if (typeof data.templateId !== 'string') {
          return send(response, 400, { error: 'TEMPLATE_ID_INVALID', message: 'Delete needs a template id' });
        }
        try {
          await deleteTemplate(data.templateId, templateRoot);
        } catch (error) {
          return failTemplate(error);
        }
        return send(response, 200, { deleted: true });
      }
      if (path === '/api/templates/apply') {
        if (running) return send(response, 409, { error: 'A test is running' });
        if (recorder.recording) return send(response, 409, { error: 'Stop the recording before applying a template' });
        if (typeof data.templateId !== 'string' || !data.templateId) {
          return send(response, 400, { error: 'TEMPLATE_ID_INVALID', message: 'Apply needs a template id' });
        }
        if (editable && v2View()?.dirty && data.discardEdits !== true) {
          return send(response, 409, {
            error: 'UNSAVED_EDITS',
            message: '保存当前工作流，或确认应用模板会切换会话',
          });
        }
        const template = (await listTemplates(templateRoot)).find(item => item.id === data.templateId);
        if (!template) return send(response, 404, { error: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
        try {
          const rawValues = data.values;
          const values: Record<string, string> = {};
          if (rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)) {
            for (const [key, value] of Object.entries(rawValues)) {
              if (typeof value === 'string') values[key] = value;
            }
          }
          const flow = applyTemplate(template, values, {
            id: randomUUID(),
            name: typeof data.name === 'string' && data.name.trim() ? data.name : template.name,
          });
          const output = await writeAppliedTemplate(flow, appliedRoot,
            `${template.id}-${Date.now().toString(36)}-${flow.id.slice(0, 8)}`);
          const imported = await loadSession(dirname(output));
          const nextEditable = await openEditor(imported, output);
          session = imported;
          editable = nextEditable;
          return send(response, 201, { session: sessionView(imported), output });
        } catch (error) {
          return failTemplate(error);
        }
      }
      return send(response, 404, { error: 'Unknown template endpoint' });
    }
    const current = session;
    if (!current || data.session !== current.view.id) return send(response, 409, { error: 'Reload the current session' });
    const activeFlow = current.flow;
    // A confirmed wait candidate writes a new flow copy; it never edits the
    // reviewed flow.json, and it never starts the desktop.
    if (path === '/api/wait-candidate') {
      if (running) throw new Error('A test is running');
      if (!isFlowV2(activeFlow)) throw new Error('Only a version 2 session has wait candidates');
      const candidates = (current.view as { waitCandidates?: WaitCandidate[] }).waitCandidates ?? [];
      const candidate = candidates.find(item => item.id === data.candidate);
      if (!candidate) throw new Error('Unknown wait candidate; reload the session');
      let next: FlowV2;
      try {
        next = confirmWaitCandidate(activeFlow, candidate);
      } catch (error) {
        // The workbench API carries one message, so keep the explicit code.
        if (error instanceof Fault) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
      const output = await writeProposedWaitFlow(current.directory, next);
      return send(response, 201, {
        output, steps: next.steps.length, candidate: candidate.id, ready: candidate.ready,
      });
    }
    // Version 2 is edited and replayed through the P2 engine: every mutation is
    // one EditOp, a revision is written next to the recording and the original
    // file is only ever read. The v1 single-window path below is untouched.
    if (isFlowV2(activeFlow)) {
      if (!editable) return send(response, 409, { error: 'Reload the current session' });
      // A pick reads the live window the step's scope names, so the page can
      // replace a stale or coordinate target with the element under it.
      if (path === '/api/v2/pick') {
        if (running) return send(response, 409, { error: 'A test is running' });
        if (typeof data.stepId !== 'string' || !data.stepId) throw new Error('Pick needs the step being edited');
        const step = editable.flow.steps.find(entry => entry.id === data.stepId);
        if (!step) {
          return send(response, 404, { error: `No step ${data.stepId} in this flow`, code: 'UNKNOWN_STEP' });
        }
        const scope = (step as { scope?: unknown }).scope;
        try {
          return send(response, 200, {
            stepId: step.id, scope, ...await pickWindow(scope as WindowScope, options.signal),
          });
        } catch (error) {
          // The page shows the reason, so keep both the stable code and words.
          if (error instanceof Fault) {
            return send(response, 400, { error: error.message, code: error.code });
          }
          throw error;
        }
      }
      if (path === '/api/v2/behavior') {
        if (running) return send(response, 409, { error: 'A test is running' });
        // One built-in behavior becomes several real steps in one undo entry;
        // its parameters are runtime inputs, so no value enters the flow. The
        // engine commits the draft only when every step passes the schema.
        try {
          editable.insertBuiltinBehavior(data);
        } catch (error) {
          if (error instanceof BuiltinBehaviorError) {
            return send(response, 400, { error: error.message, code: error.code });
          }
          if (error instanceof EditError) {
            return send(response, 400, { error: error.code, message: error.message, detail: error.toDetail() });
          }
          throw error;
        }
        return send(response, 200, v2View());
      }
      if (path === '/api/v2/edit') {
        if (running) return send(response, 409, { error: 'A test is running' });
        if (data.op === null || typeof data.op !== 'object' || Array.isArray(data.op)) {
          throw new Error('An edit needs one operation');
        }
        const result = editable.apply(data.op as EditOp);
        if (!result.ok) {
          return send(response, 400, {
            error: result.error.code, message: result.error.message, detail: result.error,
          });
        }
        return send(response, 200, v2View());
      }
      if (path === '/api/v2/replace') {
        if (running) return send(response, 409, { error: 'A test is running' });
        if (typeof data.id !== 'string' || data.step === null || typeof data.step !== 'object') {
          throw new Error('Replacing a gap needs its step id and the new step');
        }
        try {
          editable.replaceStep(data.id, data.step as StepV2);
        } catch (error) {
          if (error instanceof EditError) {
            return send(response, 400, { error: error.code, message: error.message, detail: error.toDetail() });
          }
          throw error;
        }
        return send(response, 200, v2View());
      }
      if (path === '/api/v2/undo' || path === '/api/v2/redo') {
        if (running) return send(response, 409, { error: 'A test is running' });
        const changed = path === '/api/v2/undo' ? editable.undo() : editable.redo();
        if (!changed) {
          return send(response, 409, {
            error: path === '/api/v2/undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO',
          });
        }
        return send(response, 200, v2View());
      }
      if (path === '/api/save') {
        if (running) return send(response, 409, { error: 'A test is running' });
        let revision;
        try {
          revision = await editable.saveRevision();
        } catch (error) {
          if (error instanceof EditError) {
            return send(response, 400, { error: error.code, message: error.message, detail: error.toDetail() });
          }
          throw error;
        }
        // Saving never rewrites the recording; the revision is a sibling file.
        return send(response, 201, {
          output: revision.path, createdAt: revision.createdAt, flowSha256: revision.flowSha256,
          originalSha256: editable.source.sha256, diff: revision.diff, v2: v2View(),
        });
      }
      if (path === '/api/run') {
        if (running) throw new Error('A test is already running');
        if (data.mode !== 'dry-run' && data.mode !== 'live') throw new Error('Choose a dry run or a live replay');
        const flow = editable.flow;
        const gaps = flow.steps.filter(step => step.kind === 'gap');
        if (gaps.length) {
          return send(response, 400, {
            error: 'GAP_UNRESOLVED',
            message: `Resolve the capture gap at ${gaps[0].id} before running; a gap has no replayable scope`,
            detail: { stepId: gaps[0].id, stepIds: gaps.map(step => step.id) },
          });
        }
        const validation = editable.validate();
        if (!validation.ok) {
          const first = validation.errors[0];
          return send(response, 400, { error: first.code, message: first.message, detail: first });
        }
        // A dry run reports the structural scope plan without opening a window.
        // A point target is refused here: replay cannot prove what is under a
        // recorded coordinate, so the operator must pick an element first.
        if (data.mode === 'dry-run') {
          const points = pointTargetSteps(flow);
          if (points.length) {
            return send(response, 400, {
              error: 'UNSAFE_POINT',
              message: `Turn ${points.map(step => step.id).join(', ')} into element targets first; ` +
                'a recorded screen point cannot pass a dry run (a live replay still clicks it inside its window)',
              detail: { stepIds: points.map(step => step.id) },
            });
          }
          return send(response, 200, { ...dryRunFlowV2(flow), stopped: false });
        }
        if (!allowLive || data.confirm !== true) {
          throw new Error('Live replay requires --allow-live-replay and explicit confirmation');
        }
        const live = editable.replayTarget();
        if (!live) {
          throw new Error('The flow has unsaved edits; save the workflow before a live replay');
        }
        const checkpoints = flow.steps.filter(step => step.kind === 'manual_checkpoint');
        const inputs = (flow.inputs ?? []).length
          ? inputValues(flow.inputs as string[], data.inputs)
          : undefined;
        const args = ['run', live.path, '--foreground', '--headed', '--json', '--progress'];
        // A checkpoint flow uses the machine channel: the CLI announces the
        // wait on stderr and reads one answer line from stdin.
        if (checkpoints.length) args.push('--checkpoint-events');
        let inputsFile: string | undefined;
        let inputsDir: string | undefined;
        if (inputs) {
          // Values stay out of the flow: they travel to the CLI as a private,
          // short-lived file and are removed once the replay exits. The file
          // sits in the durable work root, never in the inherited TMPDIR.
          inputsDir = (await createDesktopWorkdir(workRoot)).directory;
          inputsFile = join(inputsDir, 'inputs.json');
          await writeFile(inputsFile, `${JSON.stringify(inputs)}\n`, { mode: 0o600 });
          args.push('--inputs', inputsFile);
        }
        childStopped = false;
        running = true;
        checkpointWait = undefined;
        let handle: CliRunHandle | undefined;
        try {
          handle = startCli(args, current.directory, checkpoints.length ? {
            stdin: true,
            onStderrLine: line => {
              const event = parseCheckpointWait(line);
              if (!event) return;
              const step = flow.steps.find(entry => entry.id === event.stepId);
              checkpointWait = {
                ...event,
                ...(step && step.kind !== 'gap' ? { scope: step.scope as WindowScope } : {}),
                deadline: Date.now() + event.timeoutMs,
              };
            },
          } : {});
          if (checkpoints.length) checkpointAnswer = line => handle!.write(line);
          const result = await handle.done;
          const report = cliReport(result.stdout, result.stderr);
          return send(response, 200, {
            ...(report as object), exitCode: result.code, signal: result.signal, stopped: childStopped,
          });
        } finally {
          running = false;
          checkpointWait = undefined;
          checkpointAnswer = undefined;
          if (inputsDir) await rm(inputsDir, { recursive: true, force: true });
        }
      }
      // The page polls while /api/run is in flight: a waiting checkpoint is
      // reported here instead of as a hard --json refusal.
      if (path === '/api/run/status') {
        return send(response, 200, { running, checkpoint: checkpointWait, entries: liveEntries });
      }
      if (path === '/api/run/checkpoint') {
        if (data.answer !== 'continue' && data.answer !== 'cancel') {
          throw new Error('A checkpoint answer is continue or cancel');
        }
        if (!running || !checkpointAnswer) {
          return send(response, 409, { error: 'No checkpoint run is waiting' });
        }
        if (!checkpointWait) {
          return send(response, 409, { error: 'The run is not waiting for a checkpoint' });
        }
        if (!checkpointAnswer(`${data.answer}\n`)) {
          return send(response, 409, { error: 'The replay process closed its input; reload the report' });
        }
        checkpointWait = undefined;
        return send(response, 200, { sent: true, answer: data.answer });
      }
      return send(response, 400, {
        error: 'UNSUPPORTED_FLOW_VERSION',
        message: 'A version 2 session supports edit, undo/redo, save and run endpoints',
      });
    }
    if (path === '/api/library') {
      const item = parseLibraryItem(data.item);
      if (!sameTarget(item.target, activeFlow.target)) throw new Error('Behavior target must match the session');
      await mkdir(library, { mode: 0o700, recursive: true });
      await writeNew(join(library, `${item.behavior.id}.behavior.json`), JSON.stringify(item, null, 2) + '\n');
      return send(response, 201, libraryEntry(item));
    }
    if (path === '/api/baseline') {
      const source = typeof data.source === 'string' ? data.source.trim() : '';
      if (!source) throw new Error('Choose a full-window PNG file');
      const region = readRegion(data.region);
      const saved = await saveBaseline(current.directory, source, region);
      return send(response, 201, { ...saved, region });
    }
    if (path === '/api/plan') {
      const { flow, secrets } = parseTestItem(data.test);
      if (!sameTarget(flow.target, activeFlow.target)) throw new Error('Test target must match the session');
      const planned = plan(flow);
      const shells = reachableShells(planned);
      const captureOutput = data.captureOutput === true;
      const captureAllowed = secrets.size === 0 &&
        !shells.some(step => hasShellSecrets(step.action)) &&
        !shells.some(step => shellPrivilege(step.action) !== 'user');
      const steps = planned.map(({ id, action }) => action.kind === 'shell'
        ? { kind: 'shell', ...describeShellStep(action, { baseDir: current.directory }) }
        : { id, kind: action.kind });
      const flowSha256 = hashFlow(flow);
      const hash = planHash(current.view.id, flowSha256, steps, captureOutput);
      const token = randomUUID();
      const now = Date.now();
      for (const [key, value] of tokens) if (value.expiresAt <= now) tokens.delete(key);
      tokens.set(token, {
        sessionId: current.view.id, flowSha256, planHash: hash, expiresAt: now + confirmationTtlMs,
      });
      return send(response, 200, {
        steps, shell: { reachable: shells.length, privileged: shells.filter(step => shellPrivilege(step.action) !== 'user').length },
        captureOutput, captureAllowed, allowShell, allowSudo,
        needsDesktop: (flow.setup?.length ?? 0) > 0 ||
          planned.some(step => step.action.kind !== 'shell' || (step.action.setup?.length ?? 0) > 0),
        token,
      });
    }
    if (path !== '/api/save' && path !== '/api/run') return send(response, 404, { error: 'Unknown workbench endpoint' });
    const baselines = join(current.directory, 'baselines');
    if (path === '/api/save') {
      // Only confirmed conditions belong in a saved test item; the runner already
      // skips the rest, but a saved file should not carry unapproved setup.
      const test = keepConfirmedSetup(data.test);
      const { flow, secrets } = parseTestItem(test);
      if (!sameTarget(flow.target, activeFlow.target)) throw new Error('Test target must match the session');
      for (const { action } of plan(flow)) {
        if (action.kind === 'assert' && action.check.target.kind === 'window' &&
            action.check.expect.property === 'screenshot') {
          await loadBaseline(baselines, action.check.expect);
        }
      }
      const extension = secrets.size ? 'test' : 'flow';
      const output = join(current.directory, `test-${randomUUID()}.${extension}.json`);
      await writeNew(output, JSON.stringify(test, null, 2) + '\n');
      return send(response, 201, { output });
    }
    const { flow, secrets } = parseTestItem(data.test);
    if (!sameTarget(flow.target, activeFlow.target)) throw new Error('Test target must match the session');
    if (data.mode !== 'offline' && data.mode !== 'live') throw new Error('Choose a replay mode');
    if (running) throw new Error('A test is already running');
    if (recorder.recording) throw new Error('A recording is in progress; stop it before replaying');
    const dryRun = data.mode === 'offline';
    const planned = plan(flow);
    const shells = reachableShells(planned);
    const interactive = !dryRun && data.confirm === true;
    const gate = dryRun ? undefined : shellGate(flow, planned, { allowShell, allowSudo, interactive });
    if (gate) {
      throw new Error(gate.message ?? (gate.code === 'SHELL_NOT_ALLOWED'
        ? 'Shell steps require the workbench to start with --allow-shell'
        : 'Privileged shell steps require --allow-sudo'));
    }
    if (!dryRun && (!allowLive || data.confirm !== true)) {
      throw new Error('Live replay requires explicit opt-in and confirmation');
    }
    if (!dryRun && shells.length > 0) {
      const captureOutput = data.captureOutput === true;
      const tokenId = typeof data.token === 'string' ? data.token : undefined;
      const token = tokenId ? tokens.get(tokenId) : undefined;
      if (!tokenId || !token) throw new Error('Run preview expired. Review the plan again before starting');
      const steps = planned.map(({ id, action }) => action.kind === 'shell'
        ? { kind: 'shell', ...describeShellStep(action, { baseDir: current.directory }) }
        : { id, kind: action.kind });
      const expected = planHash(current.view.id, hashFlow(flow), steps, captureOutput);
      if (token.sessionId !== current.view.id || token.flowSha256 !== hashFlow(flow) ||
          token.planHash !== expected || token.expiresAt <= Date.now()) {
        throw new Error('Run confirmation no longer matches this test or session');
      }
      if (captureOutput && (secrets.size || shells.some(step => hasShellSecrets(step.action)) ||
          shells.some(step => shellPrivilege(step.action) !== 'user'))) {
        throw new Error('Shell output stays metadata-only while secrets or privileged steps are present');
      }
      // Consume only a valid token, immediately before the plan starts.
      tokens.delete(tokenId);
    }
    running = true;
    currentRun = new AbortController();
    try {
      const signal = AbortSignal.any([options.signal, currentRun.signal]);
      const needsDesktop = (flow.setup?.length ?? 0) > 0 ||
        planned.some(step => step.action.kind !== 'shell' || (step.action.setup?.length ?? 0) > 0);
      if (dryRun && needsDesktop && current.snapshot === undefined) {
        throw new Error('Offline replay requires snapshot.json in the run directory');
      }
      if (!dryRun && stepsNeedLive(planned)) {
        throw new Error('Save and run hover or coordinate steps explicitly with the CLI --headed option');
      }
      const shell: ShellRunOptions = {
        allowShell, allowSudo, interactive, baseDir: current.directory,
        captureOutput: data.captureOutput === true,
        privilege: createRootPrivilegeRunner(),
      };
      const secretTexts = dryRun ? undefined : resolveSecrets(secrets, process.env);
      const baselineDir = join(current.directory, 'baselines');
      // A live workbench replay manages no input source: the default is to
      // leave the user's IME alone, so no TIS read, no switch and no report
      // `ime` field. Unicode injection delivers the recorded text anyway.
      // A live v1 replay gets the same blue overlay the CLI shows; a dry run
      // only reads fixtures and needs no indicator.
      const indicator = startReplayIndicator({
        enabled: !dryRun,
        onCancel: () => currentRun?.abort(new Error('Cancelled from the replay overlay')),
      });
      try {
        const report = dryRun
          ? await runFlow(flow, needsDesktop ? offlineDesktop(current.snapshot, flow.target) : undefined, {
            dryRun, signal, baselineDir, shell, offline: true,
            ...(needsDesktop && current.snapshot !== undefined && fixtureAppPath(current.snapshot)
              ? { fixtureAppPath: fixtureAppPath(current.snapshot)! } : {}),
          })
          : await (needsDesktop
            ? withDesktop({ headed: true, signal, workRoot },
              desktop => runFlow(flow, desktop, { dryRun, signal, secretTexts, baselineDir, shell }))
            : runFlow(flow, undefined, { dryRun, signal, secretTexts, baselineDir, shell }));
        return send(response, 200, { ...report, stopped: currentRun.signal.aborted });
      } finally {
        indicator.stop();
      }
    } finally {
      running = false;
      currentRun = undefined;
    }
  }

  const server = createServer((request, response) => {
    void requestHandler(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 400, { error: error instanceof Error ? error.message : 'Workbench request failed' });
      else response.destroy();
    });
  });
  const closed = new Promise<void>(resolve => server.once('close', resolve));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not bind workbench'));
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  const stop = () => {
    // A recording or a batch outlives no server: stop it before the port closes.
    recorder.cancel();
    batch.stop();
    server.close();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  return { url: origin!, closed };
}
