import { spawn as nodeSpawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { Fault } from './locator.js';

/** Keychain service name shared by `cuekeeper sudo` and the askpass helper. */
export const sudoKeychainService = 'com.cuekeeper.sudo';
/** Only this binary is trusted by the item ACL; the helper reads through it. */
export const defaultSecurityPath = '/usr/bin/security';
/** `security` exits with errSecItemNotFound when the item does not exist. */
const itemNotFound = 44;

export interface SudoKeychainStore {
  /** Adds or replaces the item; `security` prompts for the password itself. */
  set(): Promise<{ account: string; service: string }>;
  /** Metadata only: never asks `security` to print the password. */
  status(): Promise<{ account: string; service: string; configured: boolean }>;
  clear(): Promise<{ account: string; service: string; removed: boolean }>;
}

export interface SudoKeychainOptions {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  securityPath?: string;
  account?: string;
  service?: string;
  /** Whether `security` may talk to the terminal for the hidden prompt. */
  terminal?: boolean;
}

interface SecurityResult {
  code: number | null;
  startFailed: boolean;
}

function readStartFailure(what: string): never {
  throw new Fault('SUDO_CREDENTIAL_UNAVAILABLE', `The system ${what} binary could not be started`, true);
}

function assertPlatform(platform: NodeJS.Platform) {
  if (platform !== 'darwin') {
    throw new Fault(
      'UNSUPPORTED_PLATFORM',
      'The login-keychain credential store is only available on macOS; use a sudoers policy elsewhere',
    );
  }
}

function runSecurity(
  launch: typeof nodeSpawn, program: string, args: string[], options: { inherit: boolean },
): Promise<SecurityResult> {
  return new Promise(resolvePromise => {
    let child;
    try {
      child = launch(program, args, {
        // `stdin: inherit` lets `security` run its own hidden prompt on the
        // terminal; CueKeeper never sees or echoes the password.
        stdio: options.inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return readStartFailure('security');
    }
    let spawnError = false;
    child.once('error', () => { spawnError = true; });
    child.once('close', code => {
      resolvePromise({ code: spawnError ? null : code, startFailed: spawnError });
    });
  });
}

/**
 * `cuekeeper sudo set` runs `security add-generic-password` with `-w` last and
 * no value: security itself prompts twice, so the password never enters argv,
 * the environment, a file, a log or a report. The ACL trusts only the system
 * `security` binary, which is also how the askpass helper reads it back.
 */
export function createSudoKeychainStore(options: SudoKeychainOptions = {}): SudoKeychainStore {
  const launch = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const security = options.securityPath ?? defaultSecurityPath;
  const account = options.account ?? userInfo().username;
  const service = options.service ?? sudoKeychainService;
  const terminal = options.terminal ?? process.stdin.isTTY === true;

  return {
    async set() {
      assertPlatform(platform);
      if (!terminal) {
        throw new Fault(
          'SUDO_TERMINAL_REQUIRED',
          'cuekeeper sudo set needs an interactive terminal: the password is typed into security\'s own prompt',
        );
      }
      const result = await runSecurity(launch, security, [
        'add-generic-password', '-U', '-s', service, '-a', account, '-T', security, '-w',
      ], { inherit: true });
      if (result.startFailed) readStartFailure('security');
      if (result.code !== 0) {
        throw new Fault(
          'SUDO_CREDENTIAL_UNAVAILABLE',
          `The administrator password was not stored (security exited with ${result.code ?? 'a signal'})`,
          true,
        );
      }
      return { account, service };
    },

    async status() {
      assertPlatform(platform);
      const result = await runSecurity(launch, security, [
        'find-generic-password', '-s', service, '-a', account,
      ], { inherit: false });
      if (result.startFailed) readStartFailure('security');
      if (result.code === 0) return { account, service, configured: true };
      if (result.code === itemNotFound) return { account, service, configured: false };
      throw new Fault(
        'SUDO_CREDENTIAL_UNAVAILABLE',
        `The login keychain could not be queried (security exited with ${result.code ?? 'a signal'})`,
        true,
      );
    },

    async clear() {
      assertPlatform(platform);
      const result = await runSecurity(launch, security, [
        'delete-generic-password', '-s', service, '-a', account,
      ], { inherit: false });
      if (result.startFailed) readStartFailure('security');
      if (result.code === 0) return { account, service, removed: true };
      if (result.code === itemNotFound) return { account, service, removed: false };
      throw new Fault(
        'SUDO_CREDENTIAL_UNAVAILABLE',
        `The login keychain item could not be removed (security exited with ${result.code ?? 'a signal'})`,
        true,
      );
    },
  };
}

export interface SudoCommandResult {
  data: Record<string, unknown>;
  message: string;
  code: number;
}

/** Shared CLI mapping for `cuekeeper sudo set|status|clear`. */
export async function runSudoCommand(
  action: string, store: SudoKeychainStore,
): Promise<SudoCommandResult> {
  if (action === 'set') {
    const { account, service } = await store.set();
    return {
      data: { account, service, configured: true },
      message: `Stored the CueKeeper administrator credential for ${account} in the login keychain.\n` +
        'Root steps with --non-interactive can now run without a password dialog.',
      code: 0,
    };
  }
  if (action === 'status') {
    const status = await store.status();
    return {
      data: { ...status },
      message: status.configured
        ? `Administrator credential configured for ${status.account} (${status.service})`
        : `No administrator credential configured for ${status.account}. Run cuekeeper sudo set.`,
      code: 0,
    };
  }
  if (action === 'clear') {
    const cleared = await store.clear();
    return {
      data: { ...cleared },
      message: cleared.removed
        ? `Removed the CueKeeper administrator credential for ${cleared.account}.`
        : `No CueKeeper administrator credential was stored for ${cleared.account}.`,
      code: 0,
    };
  }
  throw new Fault('INPUT_ERROR', 'Unknown sudo action. Use set, status or clear');
}
