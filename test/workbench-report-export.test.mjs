import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startWorkbench } from '../dist/workbench.js';

test('a replay report is written to disk and revealed in Finder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exportsRoot = join(root, 'exports');
  const opened = [];
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, library: join(root, 'library'), allowLive: false,
    signal: cancellation.signal,
    exportsRoot,
    openReportFolder: path => opened.push(path),
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const report = {
    version: 2, flowId: 'global-test', status: 'failed',
    entries: [{ id: 's5', kind: 'click', status: 'failed', code: 'TARGET_NOT_READY' }],
  };
  const response = await fetch(`${started.url}/api/report/export`, {
    method: 'POST',
    headers: {
      Origin: started.url,
      'x-cuekeeper-workbench': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ report, flowId: report.flowId }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.path.startsWith(`${exportsRoot}/`), true);
  assert.match(body.path, /report-global-test-.*\.json$/);
  assert.deepEqual(opened, [body.path], 'the export folder is revealed once');
  assert.deepEqual(JSON.parse(await readFile(body.path, 'utf8')), report);
});

test('the export endpoint refuses a non-report body', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-export-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cancellation = new AbortController();
  const started = await startWorkbench({
    port: 0, library: join(root, 'library'), allowLive: false,
    signal: cancellation.signal,
    exportsRoot: join(root, 'exports'),
    openReportFolder: () => { throw new Error('must not open'); },
  });
  t.after(async () => { cancellation.abort(); await started.closed; });

  const response = await fetch(`${started.url}/api/report/export`, {
    method: 'POST',
    headers: {
      Origin: started.url,
      'x-cuekeeper-workbench': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ report: [] }),
  });
  assert.equal(response.status, 400);
});
