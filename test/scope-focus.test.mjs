import assert from 'node:assert/strict';
import test from 'node:test';
import { Fault } from '../dist/locator.js';
import { ScopeResolver } from '../dist/scope.js';

const scope = { kind: 'window', app: 'com.example.Electron', windowKey: 'main', windowTitle: 'Notes' };

/**
 * The driver focuses the window but its own settle check reports ACTION_FAILED,
 * which is what VS Code does on macOS. The observed inventory is the only
 * evidence that decides whether that failure is real.
 */
function resolverWith({ focused }) {
  const windows = [{ id: 'w-11', title: 'Notes', isFocused: focused, pid: 42 }];
  const desktop = {
    async focusWindow() {
      throw new Fault('ACTION_FAILED', 'agent-desktop focus-window returned ACTION_FAILED');
    },
    async listAllWindows() {
      return windows;
    },
  };
  const identity = {
    pid: 42,
    processInstance: 'instance-1',
    async prepare() {
      return { pid: 42, startedAt: 'instance-1' };
    },
    async ownedWindows() {
      return windows;
    },
    async focusOwnedWindow(target) {
      await target.focusWindow('w-11');
    },
  };
  return new ScopeResolver({
    desktop, identityFor: () => identity, signal: new AbortController().signal,
    wait: async () => {},
  });
}

test('a window that reports itself focused passes a failed driver settle check', async () => {
  const resolver = resolverWith({ focused: true });
  const binding = await resolver.focusAfter(scope);
  assert.equal(binding.windowId, 'w-11');
  assert.equal(binding.focusGeneration, 1);
  assert.equal(resolver.foreground, 'w-11');
});

test('the same driver failure stays fatal when the window is not focused', async () => {
  const resolver = resolverWith({ focused: false });
  await assert.rejects(() => resolver.focusAfter(scope), error => error.code === 'ACTION_FAILED');
  assert.equal(resolver.foreground, undefined);
});

test('HAOC-222 review 2: a deadline that passed during the foreground read starts no focus', async () => {
  // The proof observed another window in front, so it would focus the bound one.
  // The caller's deadline passed while that read was in flight; the focus command
  // must not be issued even though the deadline's own timer has not fired.
  const windows = [
    { id: 'w-11', title: 'Notes', isFocused: false, pid: 42 },
    { id: 'w-12', title: 'Other', isFocused: true, pid: 43 },
  ];
  const calls = [];
  const desktop = {
    async focusedWindow() {
      return { id: 'w-12', title: 'Other' };
    },
    async focusWindow(windowId) {
      calls.push(windowId);
    },
  };
  const identity = {
    pid: 42,
    processInstance: 'instance-1',
    async prepare() {
      return { pid: 42, startedAt: 'instance-1' };
    },
    async ownedWindows() {
      return windows;
    },
    async focusOwnedWindow(target) {
      await target.focusWindow('w-11');
    },
  };
  const resolver = new ScopeResolver({
    desktop, identityFor: () => identity, signal: new AbortController().signal,
    wait: async () => {},
  });
  const binding = {
    app: 'com.example.Electron', windowKey: 'main', pid: 42, processInstance: 'instance-1',
    windowNumber: 11, windowId: 'w-11', title: 'Notes', observedTitle: 'Notes', focusGeneration: 0,
  };

  await assert.rejects(
    resolver.confirmForeground(binding, undefined, () => {
      throw new Fault('TARGET_NOT_READY', 'the readiness deadline passed during the foreground read');
    }),
    /readiness deadline passed/,
  );
  assert.deepEqual(calls, [], 'no focus command follows a foreground read that outlived the deadline');

  // Control: the same foreground state does focus when the deadline still holds.
  await resolver.confirmForeground(binding);
  assert.deepEqual(calls, ['w-11'], 'the guard is the only reason the focus was withheld');
});
