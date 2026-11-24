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
