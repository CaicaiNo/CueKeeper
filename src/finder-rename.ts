import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ElementLocator } from './contracts.js';
import type { StepV2 } from './contracts-v2.js';
import { DesktopFault } from './desktop.js';
import type { Desktop, FinderRenameRequest, RunningApp } from './desktop.js';
import { Fault, contains, flatten, resolve } from './locator.js';
import type { Point, Snapshot } from './locator.js';
import type { ScopeResolver, WindowBinding } from './scope.js';
import type { StepResult } from './report-v2.js';

type Click = Extract<StepV2, { kind: 'click' }>;
type Type = Extract<StepV2, { kind: 'type' }>;
const finder = 'com.apple.finder';
const rowRoles = /^(row|treeitem|listitem|outlineitem|outlinerow)$/;
const staleMenuCodes = new Set(['NOT_DELIVERED', 'STALE_REF', 'ELEMENT_NOT_FOUND', 'AMBIGUOUS_TARGET']);
const labels = new Set(['Rename', '重新命名', '重命名']);
const invalidSequence = () => new Fault('RENAME_SEQUENCE_UNPROVEN',
  'Rename requires one named file row, a context menu, a text step and one Return in the same window');

function filename(name: string) {
  if (!name || name === '.' || name === '..' || /[/:\x00-\x1f\x7f]/u.test(name) || Buffer.byteLength(name) > 255) {
    throw new Fault('RENAME_INVALID_NAME', 'Expected a single Finder filename including the extension');
  }
  return name;
}

async function absent(path: string) {
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  return false;
}

async function fileIdentity(path: string, hash = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Fault('RENAME_INVALID_SOURCE', 'Rename requires a regular file');
    let digest: string | undefined;
    if (hash) {
      const sha = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) sha.update(chunk);
      digest = sha.digest('hex');
    }
    return { id: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, digest };
  } finally { await handle.close(); }
}

/** Intercept the recorded steps before the ordinary dispatcher can focus a window or post input. */
export function finderRenameSteps(steps: StepV2[], desktop: Desktop, resolver: ScopeResolver,
  inputs: Readonly<Record<string, string>>, signal: AbortSignal, forceMenu: boolean, commitTimeoutMs = 2000) {
  const actions = new Map<string, () => Promise<Omit<StepResult, 'status'>>>();
  for (const [i, menu] of steps.entries()) {
    if (menu.kind !== 'click' || menu.scope.app !== finder || menu.target.kind !== 'element' ||
        menu.target.role !== 'menuitem' || !labels.has(menu.target.name ?? '')) continue;
    const right = steps[i - 1];
    const previous = steps[i - 2];
    const select = previous?.kind === 'click' && previous.button !== 'right' &&
      previous.target.kind === 'element' && rowRoles.test(previous.target.role) ? previous : undefined;
    const type = steps[i + 1];
    const commit = steps[i + 2];
    const affected = [select, right, menu].filter((s): s is StepV2 => !!s);
    for (const step of affected) actions.set(step.id, async () => { throw invalidSequence(); });
    if (right?.kind !== 'click' || right.button !== 'right' || right.target.kind !== 'element' ||
        type?.kind !== 'type' || !/^(textfield|textbox)$/.test(type.target.role) ||
        commit?.kind !== 'key' || commit.key !== 'return' || commit.modifiers?.length ||
        menu.button === 'right' || [select, right, menu].some(s => s && (s.count ?? 1) !== 1)) continue;
    const group = [...affected, type, commit];
    if (group.some(s => s.kind === 'gap' || s.scope.kind !== 'window' || s.scope.app !== finder ||
        s.scope.windowKey !== menu.scope.windowKey || s.scope.windowTitle !== menu.scope.windowTitle ||
        ('focusAfter' in s && s.focusAfter))) continue;
    const target = select?.target ?? right.target;
    if (target.kind !== 'element' || !target.name || !rowRoles.test(target.role)) continue;
    if (select && !(rowRoles.test(right.target.role) && right.target.name === target.name) &&
        !/^(outline|table|list|tree|group|scrollarea)$/.test(right.target.role)) continue;
    const session = new FinderRename(desktop, resolver, menu, target as ElementLocator,
      type, inputs, signal, !!select && !!menu.recordedWindowNumber && !forceMenu, commitTimeoutMs);
    if (select) actions.set(select.id, () => session.select());
    actions.set(right.id, () => session.context());
    actions.set(menu.id, () => session.enter());
    actions.set(type.id, () => session.replace());
    actions.set(commit.id, () => session.commit());
  }
  return actions;
}

class FinderRename {
  private request?: FinderRenameRequest;
  private original?: Awaited<ReturnType<typeof fileIdentity>>;
  private newName = '';
  /** True from a successful menu wait until the menu is confirmed closed. */
  private menuOpen = false;

  constructor(private desktop: Desktop, private resolver: ScopeResolver, private menu: Click,
    private target: ElementLocator, private type: Type, private inputs: Readonly<Record<string, string>>,
    private signal: AbortSignal, private keyboard: boolean, private commitTimeoutMs: number) {}

  /**
   * Resolve the bound Finder window and check that it still is the window the
   * recording named. This is proof about the window only; whether that window
   * is in front depends on the phase (a menu may hold the foreground).
   */
  private async binding() {
    this.signal.throwIfAborted();
    const binding = await this.resolver.resolveWindow(this.menu.scope, true);
    if (binding.app !== finder || binding.observedTitle !== this.menu.scope.windowTitle ||
        (this.menu.recordedWindowNumber && binding.windowNumber !== this.menu.recordedWindowNumber) ||
        (this.request && (binding.pid !== this.request.pid || binding.windowNumber !== this.request.windowNumber))) {
      throw new Fault('FOCUS_INTERRUPTED', 'The recorded Finder window must be in front');
    }
    return binding;
  }

  private async foreground() {
    const binding = await this.binding();
    if (this.menuOpen) {
      await this.menuForeground(binding);
      return binding;
    }
    if ((await this.desktop.focusedWindow?.())?.id !== binding.windowId) {
      throw new Fault('FOCUS_INTERRUPTED', 'The recorded Finder window must be in front');
    }
    return binding;
  }

  /**
   * A context menu is a surface of its own, so its folder window is no longer
   * the system's focused window. Prove the foreground from the application that
   * owns the menu instead: the frontmost process read natively must be the
   * bound Finder instance. Whether a specific ref belongs to that instance is
   * proved separately, from the surface answer that produced the ref.
   */
  private async menuForeground(binding: WindowBinding) {
    const front = await this.desktop.frontmostApp?.();
    if (!front || front.pid !== binding.pid || front.bundleId !== finder) {
      throw new Fault('FOCUS_INTERRUPTED', 'Finder is not the frontmost application behind the open menu');
    }
  }

  /**
   * Prove that the menu surface a ref came from belongs to the bound Finder
   * process and to the bound window.
   *
   * The driver's surface answer names the application it read, but not its PID,
   * so the name is joined to the running inventory: exactly one process may
   * carry it, and it must be the bound instance. A surface that names another
   * window of the same app is the menu of a different folder window, and a
   * surface that names no application cannot be attributed at all. Both stop
   * before the semantic press.
   */
  private async proveMenuOwner(menu: Snapshot, binding: WindowBinding) {
    if (!menu.ownerApp) {
      throw new Fault('RENAME_MENU_UNPROVEN', 'The open menu does not name the application that owns it');
    }
    if (menu.ownerWindowId !== undefined && menu.ownerWindowId !== binding.windowId) {
      throw new Fault('FOCUS_INTERRUPTED', 'The open menu belongs to another Finder window');
    }
    let named: RunningApp[];
    try {
      named = (await this.desktop.listApps()).filter(app => app.name === menu.ownerApp);
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault('RENAME_MENU_UNPROVEN', 'The running applications could not be listed for the open menu');
    }
    if (named.some(app => app.pid !== binding.pid ||
        (app.bundleId !== undefined && app.bundleId !== finder))) {
      throw new Fault('FOCUS_INTERRUPTED', 'The open menu belongs to another application');
    }
    if (named.length !== 1) {
      throw new Fault('RENAME_MENU_UNPROVEN', 'The open menu cannot be attributed to one Finder instance');
    }
  }

  private async diskReady() {
    const { directory, expected } = this.request!;
    if (!directory || !isAbsolute(directory)) throw new Fault('RENAME_DIRECTORY_UNPROVEN', 'Missing folder path');
    const entries = await readdir(directory).catch(() => {
      throw new Fault('RENAME_DIRECTORY_UNPROVEN', 'The Finder directory could not be read');
    });
    if (!entries.some(name => name.normalize() === expected.normalize())) {
      throw new Fault('RENAME_INVALID_SOURCE', 'The recorded filename is missing from the Finder directory');
    }
    if (!await absent(join(directory, this.newName))) {
      throw new Fault('RENAME_DESTINATION_EXISTS', 'The requested name already exists in the Finder folder');
    }
    const current = await fileIdentity(join(directory, expected), !this.original);
    if (this.original && this.original.id !== current.id) throw new Fault('RENAME_SOURCE_CHANGED', 'The source changed');
    this.original ??= current;
  }

  private async row(requireSelected: boolean) {
    const binding = await this.foreground();
    const snapshot = await this.resolver.snapshot(binding);
    const row = resolve(snapshot, this.target).node;
    const cell = row.children.find(node => node.role === 'cell');
    const expected = filename(this.target.name!);
    const label = cell && flatten(cell).find(({ node }) => node.bounds &&
      /^(textfield|statictext|text)$/.test(node.role) && [node.value, node.name, node.text].includes(expected))?.node;
    if (!rowRoles.test(row.role) || !row.ref || row.secure || !label?.bounds) throw invalidSequence();
    const b = label.bounds;
    const point: Point = [b.x + Math.min(12, b.width / 2), b.y + b.height / 2];
    this.request = { ...this.request, pid: binding.pid, windowNumber: binding.windowNumber, point, expected };
    const state = await this.desktop.finderRenameState(this.request);
    if (state.editor || (state.selectedCount !== 0 && state.selectedCount !== 1) ||
        (requireSelected && !(state.selectedCount === 1 && state.targetSelected))) {
      throw new Fault('RENAME_SELECTION_UNPROVEN', 'Could not verify a single selected target in the file list');
    }
    if (this.request.directory && this.request.directory !== state.directory) {
      throw new Fault('RENAME_DIRECTORY_UNPROVEN', 'Finder changed directories');
    }
    this.request.directory = state.directory;
    const name = 'text' in this.type ? this.type.text : this.inputs[this.type.input];
    if (name === undefined) throw new Fault('INPUT_MISSING', 'Missing rename input');
    this.newName = filename(name);
    await this.diskReady();
    return { row, listFocused: state.listFocused, selected: state.selectedCount === 1 && state.targetSelected, snapshot };
  }

  async select() {
    const { row, selected } = await this.row(false);
    if (!selected) {
      await this.foreground();
      await this.desktop.click(row.ref!);
    }
    return {};
  }

  async context() {
    const { row, listFocused } = await this.row(true);
    if (!listFocused) this.keyboard = false;
    if (!this.keyboard) {
      await this.foreground();
      await this.desktop.click(row.ref!, { button: 'right' });
    }
    return { message: this.keyboard ? 'Single selection verified for keyboard rename' : 'Opened the target row menu' };
  }

  /**
   * Read the open menu and return the Rename reference, after proving that the
   * surface it came from belongs to the bound Finder process and window. The
   * menu was opened by a right click on the target row of that window, so an
   * attributed surface ties the ref to both the bound window and the row.
   */
  private async renameRef() {
    const binding = await this.binding();
    await this.desktop.waitMenu(finder, true);
    this.menuOpen = true;
    await this.menuForeground(binding);
    const menu = await this.desktop.snapshotSurface('menu', 2000, finder);
    await this.proveMenuOwner(menu, binding);
    const matches = flatten(menu.tree).filter(({ node }) => node.role === 'menuitem' &&
      !node.states.includes('disabled') && labels.has(node.name ?? node.value ?? ''));
    if (matches.length !== 1 || !matches[0].node.ref) {
      throw new Fault('RENAME_MENU_UNPROVEN', 'Expected one enabled localized Rename item with a semantic reference');
    }
    return matches[0].node.ref;
  }

  async enter() {
    if (this.keyboard) {
      const { snapshot, listFocused } = await this.row(true);
      if (!listFocused) throw new Fault('FOCUS_INTERRUPTED', 'The file list lost focus before Return');
      await this.foreground();
      await this.desktop.press('return', snapshot, { headed: false });
    } else {
      const ref = await this.renameRef();
      await this.foreground();
      try { await this.desktop.clickSemantic(ref); } catch (error) {
        if (!(error instanceof DesktopFault) || error.delivery === 'delivery_uncertain' || error.delivery === 'unknown' ||
            !(staleMenuCodes.has(error.code) || error.delivery === 'not_delivered')) throw error;
        await this.context();
        const freshRef = await this.renameRef();
        await this.foreground();
        await this.desktop.clickSemantic(freshRef);
      }
      await this.desktop.waitMenu(finder, false);
      this.menuOpen = false;
    }
    return { message: this.keyboard ? 'Entered rename with Return' : 'Invoked Rename by menu reference' };
  }

  private async editor(expected: string) {
    await this.foreground();
    const request = { ...this.request!, expected };
    const focused = await this.desktop.snapshotSurface('focused', 2000, finder);
    // The editor opens inside the bound window. A focused surface the driver
    // attributes to another window of the same Finder is not this rename.
    if (focused.ownerWindowId !== undefined && focused.ownerWindowId !== `w-${request.windowNumber}`) {
      throw new Fault('FOCUS_INTERRUPTED', 'The focused surface belongs to another Finder window');
    }
    const fields = flatten(focused.tree).filter(({ node }) => node.states.includes('focused') &&
      /^(textfield|textbox|textarea|searchfield|combobox)$/.test(node.role));
    if (fields.length && (fields.length !== 1 || fields[0].node.secure ||
        !/^(textfield|textbox)$/.test(fields[0].node.role) ||
        (fields[0].node.bounds && !contains(fields[0].node.bounds, request.point)) ||
        (fields[0].node.value !== undefined && fields[0].node.value !== expected))) {
      throw new Fault('RENAME_EDITOR_UNPROVEN', 'A different editable control holds focus');
    }
    // A focused cell alone cannot authorize input. The native check also pins
    // the actual AX object used for replacement if the surface omitted it.
    const proof = await this.desktop.finderRenameState(request);
    if (proof.directory !== request.directory) throw new Fault('RENAME_DIRECTORY_UNPROVEN', 'Finder changed directories');
    if (!proof.editor) {
      throw new Fault('RENAME_EDITOR_UNPROVEN', 'The target filename editor could not be verified');
    }
    return request;
  }

  async replace() {
    await this.diskReady();
    const request = await this.editor(this.request!.expected);
    await this.desktop.typeFocused(this.newName, request);
    return 'input' in this.type ? { textMode: 'input' as const, input: this.type.input } : { textMode: 'literal' as const };
  }

  async commit() {
    await this.diskReady();
    const request = await this.editor(this.newName);
    this.signal.throwIfAborted();
    await this.desktop.press('return', { windowId: `w-${request.windowNumber}` }, { headed: false });
    const { directory, expected } = this.request!;
    const oldPath = join(directory!, expected);
    const newPath = join(directory!, this.newName);
    const until = performance.now() + this.commitTimeoutMs;
    do {
      await readdir(directory!);
      if (await absent(oldPath) && !await absent(newPath)) {
        const result = await fileIdentity(newPath, true);
        if (result.id === this.original!.id && result.digest === this.original!.digest) {
          return { message: 'Verified whole filename including extension, size, file identity and SHA-256' };
        }
        break;
      }
      await sleep(50, undefined, { signal: this.signal });
    } while (performance.now() < until);
    throw new Fault('RENAME_DISK_MISMATCH', 'The folder did not contain the original file under its complete new name');
  }
}
