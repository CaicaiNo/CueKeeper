import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSudoKeychainStore, defaultSecurityPath, runSudoCommand, sudoKeychainService,
} from '../dist/sudo-credential.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'cuekeeper-sudo-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * A stand-in for the system `security` binary. `add-generic-password` only
 * succeeds when `-w` is the final argument with no value, which is how the real
 * tool is told to prompt for the password itself. `find-generic-password -w`
 * prints the stored password; every other shape prints attributes only.
 */
function fakeSecurity(configPath) {
  return `
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(config.log, JSON.stringify(args) + '\\n');
const present = () => existsSync(config.state);
const command = args[0];
if (command === 'add-generic-password') {
  if (args[args.length - 1] !== '-w' || args.indexOf('-w') !== args.length - 1) process.exit(9);
  writeFileSync(config.state, config.password);
  process.exit(0);
}
if (command === 'find-generic-password') {
  if (config.behavior === 'denied') process.exit(128);
  if (config.behavior === 'error') process.exit(1);
  if (!present()) process.exit(44);
  if (args.includes('-w')) {
    process.stdout.write(config.password + '\\n');
    process.exit(0);
  }
  process.stdout.write('keychain: "login.keychain-db"\\nclass: "genp"\\nattributes:\\n  "acct"\\n  "svce"\\n');
  process.exit(0);
}
if (command === 'delete-generic-password') {
  if (!present()) process.exit(44);
  unlinkSync(config.state);
  process.exit(0);
}
process.exit(2);
`;
}

async function storeFixture(t, options = {}) {
  const root = await scratch(t);
  const directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const configPath = join(root, 'security.json');
  await writeFile(configPath, JSON.stringify({
    log: join(root, 'security.log'),
    state: join(root, 'item'),
    password: options.password ?? 'keychain-password-99',
    behavior: options.behavior ?? 'normal',
  }));
  const security = join(root, 'fake-security.mjs');
  await writeFile(security, `#!${process.execPath}\n${fakeSecurity(configPath)}`, { mode: 0o700 });
  await chmod(security, 0o700);
  const store = createSudoKeychainStore({
    securityPath: security,
    platform: options.platform ?? 'darwin',
    account: options.account ?? 'tester',
    terminal: options.terminal ?? true,
  });
  const calls = async () => {
    try {
      return (await readFile(join(root, 'security.log'), 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { root, directory, security, store, calls, state: join(root, 'item') };
}

test('set, status and clear drive security without ever putting the password in argv', async t => {
  const { root, store, calls, state } = await storeFixture(t);

  // Before anything is stored, status reports the absence from metadata only.
  assert.deepEqual(await store.status(), {
    account: 'tester', service: sudoKeychainService, configured: false,
  });

  assert.deepEqual(await store.set(), { account: 'tester', service: sudoKeychainService });
  assert.equal(existsSync(state), true);
  assert.deepEqual((await calls()).at(-1), [
    'add-generic-password', '-U', '-s', sudoKeychainService, '-a', 'tester',
    '-T', join(root, 'fake-security.mjs'), '-w',
  ]);

  assert.deepEqual(await store.status(), {
    account: 'tester', service: sudoKeychainService, configured: true,
  });
  // Status asks for attributes only: no -w, so security never prints the data.
  assert.deepEqual((await calls()).at(-1), [
    'find-generic-password', '-s', sudoKeychainService, '-a', 'tester',
  ]);

  assert.deepEqual(await store.clear(), {
    account: 'tester', service: sudoKeychainService, removed: true,
  });
  assert.equal(existsSync(state), false);
  assert.deepEqual(await store.status(), {
    account: 'tester', service: sudoKeychainService, configured: false,
  });
  // Clearing an absent item is not an error.
  assert.deepEqual(await store.clear(), {
    account: 'tester', service: sudoKeychainService, removed: false,
  });

  // The password is typed into security's own prompt, so no invocation or
  // stored artefact carries it.
  const log = await readFile(join(root, 'security.log'), 'utf8');
  assert.doesNotMatch(log, /keychain-password-99/);
  for (const entry of await calls()) {
    assert.doesNotMatch(JSON.stringify(entry), /keychain-password-99/);
  }
});

test('a password supplied by the workbench travels over stdin, never argv', async t => {
  const root = await scratch(t);
  const state = join(root, 'item');
  const log = join(root, 'argv.log');
  const security = join(root, 'stdin-security.mjs');
  await writeFile(security, `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'add-generic-password') process.exit(2);
let input = '';
process.stdin.on('data', chunk => { input += String(chunk); });
process.stdin.on('end', () => {
  const lines = input.split('\\n');
  if (lines[0] !== lines[1] || !lines[0]) process.exit(9);
  writeFileSync(${JSON.stringify(state)}, lines[0]);
  process.exit(0);
});
`, { mode: 0o700 });
  const store = createSudoKeychainStore({ securityPath: security, platform: 'darwin', account: 'tester' });

  await store.setWithPassword('workbench-password-42');
  assert.equal(await readFile(state, 'utf8'), 'workbench-password-42');

  // A line break would let the second prompt line differ from the first.
  await assert.rejects(store.setWithPassword('two\nlines'), error =>
    error.code === 'SUDO_PASSWORD_INVALID');
  await assert.rejects(store.setWithPassword(''), error => error.code === 'SUDO_PASSWORD_INVALID');

  const recorded = await readFile(log, 'utf8');
  assert.doesNotMatch(recorded, /workbench-password-42/, 'the password never enters argv');
});

test('a denied, unreadable or unsupported keychain fails closed', async t => {
  for (const behavior of ['denied', 'error']) {
    const { store } = await storeFixture(t, { behavior });
    await assert.rejects(store.status(), error =>
      error.code === 'SUDO_CREDENTIAL_UNAVAILABLE' && error.dependency === true, behavior);
  }

  // Non-macOS hosts never touch the security binary.
  const linux = await storeFixture(t, { platform: 'linux' });
  for (const action of ['set', 'status', 'clear']) {
    await assert.rejects(linux.store[action](), error =>
      error.code === 'UNSUPPORTED_PLATFORM' && /only available on macOS/.test(error.message));
  }
  assert.deepEqual(await linux.calls(), []);

  // `security` prompts on a terminal; refuse early when there is none.
  const noTerminal = await storeFixture(t, { terminal: false });
  await assert.rejects(noTerminal.store.set(), error =>
    error.code === 'SUDO_TERMINAL_REQUIRED' && /interactive terminal/.test(error.message));
  assert.deepEqual(await noTerminal.calls(), []);
});

test('the sudo command reports the outcome and never echoes a password', async t => {
  const { store } = await storeFixture(t);
  const stored = await runSudoCommand('set', store);
  assert.equal(stored.code, 0);
  assert.deepEqual(stored.data, {
    account: 'tester', service: sudoKeychainService, configured: true,
  });
  assert.match(stored.message, /--non-interactive/);
  assert.doesNotMatch(stored.message, /keychain-password-99/);

  const present = await runSudoCommand('status', store);
  assert.equal(present.data.configured, true);
  assert.match(present.message, /configured for tester/);

  const cleared = await runSudoCommand('clear', store);
  assert.match(cleared.message, /Removed/);
  assert.deepEqual(cleared.data, {
    account: 'tester', service: sudoKeychainService, removed: true,
  });

  await assert.rejects(runSudoCommand('rotate', store), error => error.code === 'INPUT_ERROR');
  assert.equal(defaultSecurityPath, '/usr/bin/security');
});

test('the CLI wires the sudo subcommands and refuses a non-interactive set', () => {
  const run = (...args) => spawnSync(process.execPath, [cliPath, 'sudo', ...args, '--json'],
    { encoding: 'utf8' });

  const unknown = run('rotate');
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.match(JSON.parse(unknown.stdout).error.message, /Unknown sudo action/);

  const missing = run();
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);

  // The test runner has no TTY, so set refuses before security can be started.
  const piped = run('set');
  assert.equal(piped.status, 1, piped.stdout + piped.stderr);
  const error = JSON.parse(piped.stdout).error;
  assert.equal(error.code, 'SUDO_TERMINAL_REQUIRED');
  assert.match(error.message, /interactive terminal/);
});
