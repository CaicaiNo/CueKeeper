import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const chunkBytes = 8_388_608;
const maxBundleBytes = 1_073_741_824;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function timestamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function projectSummary(run) {
  const completedAt = timestamp();
  return {
    projectId: run.projectId,
    runId: run.id,
    flowId: 'mock-flow',
    flowSha256: '0'.repeat(64),
    startedAt: run.createdAt,
    completedAt,
    mode: 'dry-run',
    status: 'passed',
    durationMs: 1,
    entryCounts: { passed: 1, failed: 0, blocked: 0, skipped: 0, resolved: 0 },
    artifact: {
      artifactId: `art_${run.id}`,
      bundleSha256: run.bundleSha256,
      bundleBytes: run.bundleBytes,
      expiresAt: timestamp(30 * 24 * 60 * 60 * 1000),
      state: 'available',
    },
  };
}

/**
 * A protocol-shaped mock of the upload API. It exists only to verify the
 * client in tests: no persistence, no real authentication, no admin features.
 *
 * Scenario hooks:
 *   api.inject({ route, status, code, retryable, times, retryAfter, drop })
 *   api.setOffline(true)   // destroy the socket before answering
 */
export async function startUploadApi(options = {}) {
  const tokens = options.tokens ?? { 'test-token': 'p1' };
  const projectId = options.projectId ?? 'p1';
  const bundleLimit = options.maxBundleBytes ?? 64 * 1024 * 1024;
  const state = {
    runs: new Map(),          // `${project}|${sha256}` -> run
    runsById: new Map(),      // runId -> run
    uploads: new Map(),       // uploadId -> upload
    bundles: new Map(),       // runId -> Buffer (verified bytes)
    requests: [],
  };
  const injections = [];
  let offline = false;
  let nextRun = 1;
  let nextUpload = 1;

  function takeInjection(route) {
    const index = injections.findIndex(entry => entry.route === route && (entry.times ?? 1) > 0);
    if (index < 0) return undefined;
    const entry = injections[index];
    entry.times = (entry.times ?? 1) - 1;
    if (entry.times <= 0) injections.splice(index, 1);
    return entry;
  }

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  function sendError(res, { status, code, retryable, message, retryAfter }) {
    const headers = {};
    if (status === 401) headers['www-authenticate'] = 'Bearer';
    if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);
    sendJson(res, status, {
      requestId: `req_${state.requests.length + 1}`,
      error: {
        status,
        code,
        retryable,
        message: message ?? code,
      },
    }, headers);
  }

  async function bodyOf(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  function uploadFor(run, uploadId) {
    const upload = state.uploads.get(uploadId);
    return upload && upload.runId === run.id ? upload : undefined;
  }

  function currentUpload(run) {
    const upload = state.uploads.get(run.uploadId);
    if (upload.state === 'receiving' && Date.parse(upload.expiresAt) <= Date.now()) {
      upload.state = 'closed';
    }
    return upload;
  }

  function newUpload(run) {
    const upload = {
      id: `upl_${nextUpload++}`,
      runId: run.id,
      state: 'receiving',
      committedBytes: 0,
      chunks: new Map(),
      createdAt: timestamp(),
      expiresAt: timestamp(24 * 60 * 60 * 1000),
    };
    state.uploads.set(upload.id, upload);
    run.uploadId = upload.id;
    return upload;
  }

  function progress(upload) {
    return {
      uploadId: upload.id,
      chunkBytes,
      committedBytes: upload.committedBytes,
      expiresAt: upload.expiresAt,
    };
  }

  async function handle(req, res) {
    if (offline) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const create = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/runs$/);
    const chunk = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/uploads\/([^/]+)\/chunks\/(\d+)$/);
    const complete = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/runs\/([^/]+)\/uploads\/([^/]+)\/complete$/);
    if (!create && !chunk && !complete) {
      sendError(res, { status: 404, code: 'NOT_FOUND', retryable: false, message: 'Unknown route' });
      return;
    }
    const route = create ? 'create' : chunk ? 'chunk' : 'complete';
    state.requests.push({ route, method: req.method, path: url.pathname });
    // Read the body before any early response so a keep-alive connection is
    // never left with unread request bytes.
    const raw = await bodyOf(req);

    const authorization = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(authorization);
    const tokenProject = match ? tokens[match[1]] : undefined;
    if (!tokenProject) {
      sendError(res, { status: 401, code: 'UNAUTHENTICATED', retryable: false, message: 'Invalid token' });
      return;
    }
    const requestedProject = (create ?? chunk ?? complete)[1];
    if (requestedProject !== projectId || tokenProject !== requestedProject) {
      sendError(res, { status: 403, code: 'FORBIDDEN', retryable: false, message: 'Token cannot access this project' });
      return;
    }

    const injected = takeInjection(route);
    if (injected?.delayMs) await new Promise(resolve => setTimeout(resolve, injected.delayMs));
    if (injected && !injected.drop) {
      sendError(res, injected);
      return;
    }

    if (route === 'create') {
      // A dropped response is simulated by creating the run and closing the
      // socket without writing anything, so the client cannot observe success.
      const finish = (status, payload) => {
        if (injected?.drop) {
          req.socket.destroy();
          return;
        }
        sendJson(res, status, payload);
      };
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
        sendError(res, { status: 400, code: 'BAD_REQUEST', retryable: false, message: 'Missing Idempotency-Key' });
        return;
      }
      const body = raw;
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendError(res, { status: 400, code: 'BAD_REQUEST', retryable: false, message: 'Invalid JSON' });
        return;
      }
      const bytes = payload?.bundleBytes;
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > maxBundleBytes) {
        sendError(res, { status: 400, code: 'BAD_REQUEST', retryable: false, message: 'Invalid bundleBytes' });
        return;
      }
      const mapKey = `${requestedProject}|${key}`;
      let run = state.runs.get(mapKey);
      if (run) {
        if (run.bundleBytes !== bytes) {
          sendError(res, { status: 409, code: 'IDEMPOTENCY_CONFLICT', retryable: false,
            message: 'The idempotency key was already used with a different size' });
          return;
        }
        if (run.state === 'ready') {
          finish(200, { runId: run.id, state: 'ready' });
          return;
        }
        const upload = currentUpload(run);
        if (!upload || upload.state !== 'receiving') {
          const replacement = newUpload(run);
          finish(200, { runId: run.id, state: 'pending', upload: progress(replacement) });
          return;
        }
        finish(200, { runId: run.id, state: 'pending', upload: progress(upload) });
        return;
      }
      if (bytes > bundleLimit) {
        sendError(res, { status: 413, code: 'PAYLOAD_TOO_LARGE', retryable: false,
          message: 'Bundle exceeds the deployment limit' });
        return;
      }
      run = {
        id: `run_${nextRun++}`,
        projectId: requestedProject,
        bundleSha256: key,
        bundleBytes: bytes,
        state: 'pending',
        createdAt: timestamp(),
      };
      state.runs.set(mapKey, run);
      state.runsById.set(run.id, run);
      const upload = newUpload(run);
      finish(201, { runId: run.id, state: 'pending', upload: progress(upload) });
      return;
    }

    const requestedProjectId = (chunk ?? complete)[1];
    const runId = (chunk ?? complete)[2];
    const uploadId = (chunk ?? complete)[3];
    const run = state.runsById.get(runId);
    const upload = run ? uploadFor(run, uploadId) : undefined;
    if (!run || run.projectId !== requestedProjectId || !upload) {
      sendError(res, { status: 404, code: 'NOT_FOUND', retryable: false, message: 'Unknown run or upload' });
      return;
    }

    if (route === 'chunk') {
      if (upload.state === 'verifying') {
        sendError(res, { status: 409, code: 'UPLOAD_VERIFYING', retryable: true, retryAfter: 1,
          message: 'Upload is being verified' });
        return;
      }
      if (upload.state === 'completed') {
        sendError(res, { status: 409, code: 'UPLOAD_FINALIZED', retryable: true,
          message: 'Upload is already finalized' });
        return;
      }
      if (upload.state !== 'receiving') {
        sendError(res, { status: 409, code: 'UPLOAD_EXPIRED', retryable: true, message: 'Upload expired' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('application/octet-stream')) {
        sendError(res, { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', retryable: false,
          message: 'Chunks require application/octet-stream' });
        return;
      }
      const index = Number(chunk[4]);
      const bytes = raw;
      const declared = Number(req.headers['content-length']);
      if (!Number.isInteger(declared) || declared !== bytes.length) {
        sendError(res, { status: 400, code: 'BAD_REQUEST', retryable: false, message: 'Content-Length mismatch' });
        return;
      }
      if (bytes.length > chunkBytes) {
        sendError(res, { status: 413, code: 'PAYLOAD_TOO_LARGE', retryable: false, message: 'Chunk is too large' });
        return;
      }
      if (req.headers['x-chunk-sha256'] !== digest(bytes)) {
        sendError(res, { status: 422, code: 'CHUNK_DIGEST_MISMATCH', retryable: false,
          message: 'Chunk digest does not match X-Chunk-Sha256' });
        return;
      }
      const expected = upload.committedBytes / chunkBytes;
      if (index > expected) {
        sendError(res, { status: 409, code: 'CHUNK_OUT_OF_ORDER', retryable: true,
          message: `Expected chunk ${expected}, received ${index}` });
        return;
      }
      if (index < expected) {
        const existing = upload.chunks.get(index);
        if (existing && existing.bytes.equals(bytes)) {
          res.writeHead(204);
          res.end();
          if (injected?.drop) req.socket.destroy();
          return;
        }
        sendError(res, { status: 409, code: 'CHUNK_CONFLICT', retryable: false,
          message: 'A different chunk was already accepted at this index' });
        return;
      }
      if (upload.committedBytes + bytes.length > run.bundleBytes) {
        sendError(res, { status: 422, code: 'CHUNK_DIGEST_MISMATCH', retryable: false,
          message: 'Chunk exceeds the declared bundle size' });
        return;
      }
      upload.chunks.set(index, { bytes, sha256: digest(bytes) });
      upload.committedBytes += bytes.length;
      res.writeHead(204);
      res.end();
      if (injected?.drop) req.socket.destroy();
      return;
    }

    // complete
    if (upload.state === 'completed') {
      sendJson(res, 200, projectSummary(run));
      return;
    }
    if (upload.state === 'verifying') {
      sendError(res, { status: 409, code: 'UPLOAD_VERIFYING', retryable: true, retryAfter: 1,
        message: 'Upload is being verified' });
      return;
    }
    if (upload.state !== 'receiving') {
      sendError(res, { status: 409, code: 'UPLOAD_EXPIRED', retryable: true, message: 'Upload expired' });
      return;
    }
    if (upload.committedBytes !== run.bundleBytes) {
      sendError(res, { status: 409, code: 'UPLOAD_INCOMPLETE', retryable: true,
        message: `Committed ${upload.committedBytes} of ${run.bundleBytes} bytes` });
      return;
    }
    const chunks = [...upload.chunks.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value.bytes);
    const bundle = Buffer.concat(chunks);
    if (bundle.length !== run.bundleBytes || digest(bundle) !== run.bundleSha256) {
      upload.state = 'closed';
      sendError(res, { status: 422, code: 'BUNDLE_DIGEST_MISMATCH', retryable: false,
        message: 'Bundle digest does not match the idempotency key' });
      return;
    }
    upload.state = 'completed';
    run.state = 'ready';
    state.bundles.set(run.id, bundle);
    sendJson(res, 200, projectSummary(run));
    if (injected?.drop) req.socket.destroy();
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        sendError(res, { status: 500, code: 'SERVER_ERROR', retryable: true, message: 'Mock server failure' });
      } else {
        req.socket.destroy();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    inject(entry) {
      injections.push({ times: 1, ...entry });
    },
    setOffline(value) {
      offline = value;
    },
    close() {
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
