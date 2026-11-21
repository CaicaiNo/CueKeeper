import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { offlineDesktop, withDesktop } from './desktop.js';
import { readJson, writeNew } from './files.js';
import { plan } from './flow.js';
import { object } from './locator.js';
import { runFlow } from './run.js';
import { parseLibraryItem, parseTestItem, resolveSecrets } from './test-item.js';
import { loadSession, sameTarget } from './workbench-session.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/model.js', ['model.js', 'text/javascript']],
]);

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

export async function startWorkbench(options: {
  directory?: string; port: number; library?: string; allowLive: boolean; signal: AbortSignal;
}) {
  let session = options.directory ? await loadSession(options.directory) : undefined;
  const library = resolve(options.library ?? join(homedir(), '.cuekeeper', 'behaviors'));
  const allowLive = options.allowLive && process.platform === 'darwin';
  let running = false;
  let origin: string;

  async function listLibrary() {
    let names;
    try {
      names = await readdir(library, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.filter(entry => entry.isFile() && /^[a-z0-9_-]+\.behavior\.json$/i.test(entry.name))
      .map(async entry => parseLibraryItem(await readJson(join(library, entry.name)))));
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
    if (path === '/api/state') return send(response, 200, { session: session?.view, allowLive, library: await listLibrary() });
    if (path === '/api/import') {
      if (typeof data.directory !== 'string' || !data.directory.trim()) throw new Error('Enter a run directory');
      if (running) throw new Error('A test is running');
      const path = data.directory.trim();
      const imported = await loadSession(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
      if (running) throw new Error('A test is running');
      session = imported;
      return send(response, 200, session.view);
    }
    const current = session;
    if (!current || data.session !== current.view.id) return send(response, 409, { error: 'Reload the current session' });
    if (path === '/api/library') {
      const item = parseLibraryItem(data.item);
      if (!sameTarget(item.target, current.flow.target)) throw new Error('Behavior target must match the session');
      await mkdir(library, { mode: 0o700, recursive: true });
      await writeNew(join(library, `${item.behavior.id}.behavior.json`), JSON.stringify(item, null, 2) + '\n');
      return send(response, 201, item);
    }
    if (path !== '/api/save' && path !== '/api/run') return send(response, 404, { error: 'Unknown workbench endpoint' });
    const { flow, secrets } = parseTestItem(data.test);
    if (!sameTarget(flow.target, current.flow.target)) throw new Error('Test target must match the session');
    if (path === '/api/save') {
      const extension = secrets.size ? 'test' : 'flow';
      const output = join(current.directory, `test-${randomUUID()}.${extension}.json`);
      await writeNew(output, JSON.stringify(data.test, null, 2) + '\n');
      return send(response, 201, { output });
    }
    if (data.mode !== 'offline' && data.mode !== 'live') throw new Error('Choose a replay mode');
    if (running) throw new Error('A test is already running');
    const dryRun = data.mode === 'offline';
    running = true;
    try {
      const { signal } = options;
      if (!dryRun && (!allowLive || data.confirm !== true)) throw new Error('Live replay requires explicit opt-in and confirmation');
      if (dryRun && current.snapshot === undefined) throw new Error('Offline replay requires snapshot.json in the run directory');
      if (!dryRun && plan(flow).some(({ action }) => action.kind === 'click' && action.target.kind === 'point')) {
        throw new Error('Save and run coordinate clicks explicitly with the CLI --headed option');
      }
      const secretTexts = dryRun ? undefined : resolveSecrets(secrets, process.env);
      const report = dryRun
        ? await runFlow(flow, offlineDesktop(current.snapshot, flow.target), { dryRun, signal })
        : await withDesktop({ headed: true, signal }, desktop => runFlow(flow, desktop, { dryRun, signal, secretTexts }));
      return send(response, 200, report);
    } finally {
      running = false;
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
