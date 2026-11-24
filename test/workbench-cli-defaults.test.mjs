import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The CLI layer decides the defaults; startWorkbench keeps taking explicit
// options (the unit-level gate tests pass their own allowShell/allowSudo).
// This covers the user-visible contract: `cuekeeper workbench` serves a
// workbench with Shell and privileged steps enabled, and the --no-* flags
// still lock it down.
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function workbenchState(args) {
  const child = spawn(process.execPath, [cliPath, 'workbench', '--port', '0', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`workbench did not print a URL\nstdout: ${out}\nstderr: ${err}`)), 20000);
      child.on('exit', code => {
        clearTimeout(timer);
        reject(new Error(`workbench exited with ${code}\nstdout: ${out}\nstderr: ${err}`));
      });
      child.stdout.on('data', chunk => {
        out += chunk;
        const match = out.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const response = await fetch(`${url}/api/state`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json', 'x-cuekeeper-workbench': '1' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    return await response.json();
  } finally {
    child.kill('SIGTERM');
  }
}

test('the workbench enables Shell and privileged steps by default', async () => {
  const state = await workbenchState([]);
  assert.equal(state.allowShell, true);
  assert.equal(state.allowSudo, true);
});

test('--no-allow-shell and --no-allow-sudo still lock the workbench down', async () => {
  const state = await workbenchState(['--no-allow-shell', '--no-allow-sudo']);
  assert.equal(state.allowShell, false);
  assert.equal(state.allowSudo, false);
});
