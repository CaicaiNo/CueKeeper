import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { reportCheck } from './contracts.js';
import type { Flow } from './contracts.js';
import { hashFlow, plan } from './flow.js';

const stylesheet = `
:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif;background:Canvas;color:CanvasText}
body{max-width:60rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:clamp(1.6rem,4vw,2.5rem);margin:.2rem 0 .6rem}
h2{font-size:1.2rem;margin-top:2rem}
.meta{display:flex;flex-wrap:wrap;gap:.35rem 1.2rem;margin:0;padding:0;list-style:none}
a{color:LinkText}
ol{list-style:none;padding:0;margin:0}
li.entry{padding:.75rem 0;border-top:1px solid GrayText;overflow-wrap:anywhere}
.status{font-weight:650}
.detail{margin:0;color:GrayText}
`;

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string) => value.replace(/[&<>"']/g, char => entities[char]);
const json = (value: unknown) => strToU8(JSON.stringify(value, null, 2) + '\n');

export function packReport(input: unknown, flow: Flow): Uint8Array {
  if (!reportCheck.Check(input)) throw new Error('Invalid v1 report');
  if (input.flowId !== flow.id || input.flowSha256 !== hashFlow(flow)) {
    throw new Error('Report and flow do not match');
  }

  const steps = plan(flow);
  const actionEntries = input.entries.filter(entry => entry.kind !== 'setup');
  if (actionEntries.length !== steps.length || steps.some(({ id, action }, index) =>
    actionEntries[index].id !== id || actionEntries[index].kind !== action.kind)) {
    throw new Error('Report timeline does not match the flow');
  }

  const timeline = input.entries.map(entry => `
<li class="entry">
  <div><strong>${escape(entry.id)}</strong> · ${entry.kind} · <span class="status">${entry.status}</span></div>
  <p class="detail">${entry.atMs} ms since start · ${entry.durationMs} ms elapsed${entry.delivery ? ` · ${entry.delivery}` : ''}</p>
  ${entry.message ? `<p>${escape(entry.message)}</p>` : ''}
</li>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; base-uri 'none'">
  <title>${escape(flow.name)} · Cuekeeper</title>
  <link rel="stylesheet" href="assets/report.css">
</head>
<body>
<main>
  <header>
    <h1>${escape(flow.name)}</h1>
    <ul class="meta">
      <li class="status">${input.status}</li><li>${input.mode}</li><li><time>${escape(input.startedAt)}</time></li>
    </ul>
  </header>
  <h2>Timeline</h2>
  <ol>${timeline}</ol>
  <p><a href="report.json">Report JSON</a> · <a href="flow.json">Flow JSON</a></p>
</main>
</body>
</html>
`;
  const files = {
    'index.html': strToU8(html),
    'report.json': json(input),
    'flow.json': json(flow),
    'assets/report.css': strToU8(stylesheet),
  };
  const manifest = {
    version: 1,
    files: Object.fromEntries(Object.entries(files).map(([path, contents]) => [
      path, { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') },
    ])),
  };
  return zipSync({ ...files, 'manifest.json': json(manifest) });
}
