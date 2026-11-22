import type { WindowScope } from './contracts-v2.js';
import type { Desktop } from './desktop.js';
import { Fault } from './locator.js';
import { pickCandidates } from './pick.js';
import type { PickCandidate } from './pick.js';

// The workbench re-picks a v2 step's target from the live window that its scope
// names. The read is the same `agent-desktop snapshot --window-id` the CLI pick
// uses, but the scope is a v2 window key instead of a flow-level target. No
// input is delivered and no window is focused or captured by this module.

export interface WindowPickResult {
  windowId: string;
  windowTitle: string;
  /** Picker order: interactive controls first, document order inside a group. */
  candidates: PickCandidate[];
}

function windowScopeOrFault(scope: unknown): WindowScope {
  if (scope === null || typeof scope !== 'object' || (scope as { kind?: unknown }).kind !== 'window') {
    throw new Fault('SCOPE_NOT_WINDOW',
      'Only a step bound to one window has a snapshot to pick from; edit this step to a window scope first');
  }
  return scope as WindowScope;
}

/**
 * Snapshot the window a scope names and list its pickable elements. A missing
 * app, a missing or ambiguous window and an empty tree are explicit faults: the
 * editor must show why nothing could be picked instead of silently keeping the
 * old target.
 */
export async function pickWindowCandidates(
  desktop: Desktop,
  scopeInput: unknown,
  timeoutMs = 5000,
): Promise<WindowPickResult> {
  const scope = windowScopeOrFault(scopeInput);
  let windows;
  try {
    windows = await desktop.listWindows(scope.app, timeoutMs);
  } catch (error) {
    if (error instanceof Fault && error.code === 'APP_NOT_FOUND') {
      throw new Fault('APP_NOT_FOUND',
        `${scope.app} is not running; start the app and open the window before picking`);
    }
    throw error;
  }
  const matches = windows.filter(window => window.title === scope.windowTitle);
  if (!matches.length) {
    const open = windows.map(window => window.title).filter(Boolean).slice(0, 5);
    throw new Fault('WINDOW_NOT_FOUND',
      `No window titled "${scope.windowTitle}" is open for ${scope.app}` +
      (open.length ? `; open windows: ${open.join(' / ')}` : ''));
  }
  if (matches.length > 1) {
    throw new Fault('AMBIGUOUS_TARGET',
      `More than one window titled "${scope.windowTitle}" belongs to ${scope.app}`);
  }
  const window = matches[0];
  const snapshot = await desktop.snapshotWindow(window.id, undefined, timeoutMs);
  if (snapshot.windowId !== window.id) {
    throw new Fault('WINDOW_CHANGED', 'The driver read a different window than the one the scope names');
  }
  const candidates = pickCandidates(snapshot);
  if (!candidates.length) {
    throw new Fault('NO_PICK_CANDIDATES',
      'The window snapshot has no pickable element; grant Accessibility access to CueKeeper or pick another window');
  }
  return { windowId: window.id, windowTitle: window.title, candidates };
}
