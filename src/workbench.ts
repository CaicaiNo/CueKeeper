import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { listApps } from './app-catalog.js';
import { appIconPng } from './apps.js';
import { loadBaseline } from './assertion.js';
import { fixtureAppPath, offlineDesktop, withDesktop } from './desktop.js';
import { readJson, writeNew } from './files.js';
import { hashFlow, plan } from './flow.js';
import { object } from './locator.js';
import { crop, decodePng, encodePng } from './png.js';
import { runFlow } from './run.js';
import type { ShellRunOptions } from './run.js';
import { createRootPrivilegeRunner } from './shell-privilege.js';
import {
  describeShellStep, hasShellSecrets, reachableShells, shellGate, shellPrivilege,
} from './shell.js';
import { keepConfirmedSetup } from './setup.js';
import { parseLibraryItem, parseTestItem, resolveSecrets } from './test-item.js';
import { workbenchAssets } from './workbench-assets.js';
import { loadSession, sameTarget } from './workbench-session.js';

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

export async function startWorkbench(options: {
  directory?: string; port: number; library?: string; allowLive: boolean;
  allowShell?: boolean; allowSudo?: boolean; signal: AbortSignal;
}) {
  let session = options.directory ? await loadSession(options.directory) : undefined;
  const library = resolve(options.library ?? join(homedir(), '.cuekeeper', 'behaviors'));
  const allowLive = options.allowLive && process.platform === 'darwin';
  const allowShell = options.allowShell ?? false;
  const allowSudo = options.allowSudo ?? false;
  const tokens = new Map<string, ConfirmationToken>();
  let running = false;
  let currentRun: AbortController | undefined;
  let origin: string;

  function libraryEntry(item: Awaited<ReturnType<typeof parseLibraryItem>>) {
    const shells = item.behavior.steps.filter(step => step.kind === 'shell');
    return {
      ...item,
      shell: {
        steps: shells.length,
        privileged: shells.filter(step => step.kind === 'shell' && shellPrivilege(step) !== 'user').length,
      },
    };
  }

  async function listLibrary() {
    let names;
    try {
      names = await readdir(library, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.filter(entry => entry.isFile() && /^[a-z0-9_-]+\.behavior\.json$/i.test(entry.name))
      .map(async entry => libraryEntry(await parseLibraryItem(await readJson(join(library, entry.name))))));
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
    if (request.method !== 'POST' || request.headers.origin !== origin ||
        request.headers['x-cuekeeper-workbench'] !== '1' || request.headers['content-type'] !== 'application/json') {
      return send(response, 403, { error: 'Use the local CueKeeper workbench' });
    }
    const data = await readBody(request);
    if (path === '/api/state') {
      return send(response, 200, {
        session: session?.view, allowLive, allowShell, allowSudo, library: await listLibrary(),
      });
    }
    if (path === '/api/apps') return send(response, 200, { apps: await listApps() });
    if (path === '/api/import') {
      if (typeof data.directory !== 'string' || !data.directory.trim()) throw new Error('Enter a run directory');
      if (running) throw new Error('A test is running');
      const path = data.directory.trim();
      const imported = await loadSession(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
      if (running) throw new Error('A test is running');
      session = imported;
      return send(response, 200, session.view);
    }
    if (path === '/api/stop') {
      // Stop is bound to the server run, not to a session snapshot.
      if (!currentRun) return send(response, 200, { stopped: false });
      currentRun.abort(new Error('Stopped from the workbench'));
      return send(response, 200, { stopped: true });
    }
    const current = session;
    if (!current || data.session !== current.view.id) return send(response, 409, { error: 'Reload the current session' });
    if (path === '/api/library') {
      const item = parseLibraryItem(data.item);
      if (!sameTarget(item.target, current.flow.target)) throw new Error('Behavior target must match the session');
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
      if (!sameTarget(flow.target, current.flow.target)) throw new Error('Test target must match the session');
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
      if (!sameTarget(flow.target, current.flow.target)) throw new Error('Test target must match the session');
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
    if (!sameTarget(flow.target, current.flow.target)) throw new Error('Test target must match the session');
    if (data.mode !== 'offline' && data.mode !== 'live') throw new Error('Choose a replay mode');
    if (running) throw new Error('A test is already running');
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
      const report = dryRun
        ? await runFlow(flow, needsDesktop ? offlineDesktop(current.snapshot, flow.target) : undefined, {
          dryRun, signal, baselineDir, shell, offline: true,
          ...(needsDesktop && current.snapshot !== undefined && fixtureAppPath(current.snapshot)
            ? { fixtureAppPath: fixtureAppPath(current.snapshot)! } : {}),
        })
        : await (needsDesktop
          ? withDesktop({ headed: true, signal },
            desktop => runFlow(flow, desktop, { dryRun, signal, secretTexts, baselineDir, shell }))
          : runFlow(flow, undefined, { dryRun, signal, secretTexts, baselineDir, shell }));
      return send(response, 200, { ...report, stopped: currentRun.signal.aborted });
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
  const stop = () => server.close();
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  return { url: origin!, closed };
}
