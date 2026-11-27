import type { ElementLocator, Target } from './contracts.js';

type Bounds = { x: number; y: number; width: number; height: number };
export type Point = [number, number];

export interface Node {
  role: string;
  name?: string;
  value?: string;
  text?: string;
  ref?: string;
  /**
   * The accessibility identifier the platform exposes for this element:
   * Chromium's AXDOMIdentifier for web content, Cocoa's AXIdentifier for native
   * controls. It can stay stable across copy changes; replay prefers a unique
   * identifier match and falls back to the name when the identifier is absent.
   */
  identifier?: string;
  states: string[];
  secure: boolean;
  bounds?: Bounds;
  /** Actions the driver reports for this node (e.g. ["Click"], ["Press"]). */
  actions?: string[];
  children: Node[];
}

export interface Snapshot {
  windowId: string;
  tree: Node;
}

export interface Located {
  node: Node;
  path: string[];
  index?: number;
}

export class Fault extends Error {
  /**
   * A bounded qualification of `code` when one code covers several causes.
   * `INCOMPLETE_TREE` carries the one that matters to callers: `budget` means
   * the driver ran out of its observation window (a slow read), while
   * `truncated`, `identity_unproven` and `subtree` mean the answer really does
   * not describe the whole tree. Only `budget` may be retried.
   */
  constructor(public code: string, message: string, public dependency = false, public reason?: string) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Fault('BAD_RESPONSE', 'Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function parseBounds(value: unknown): Bounds | undefined {
  if (value === undefined || value === null) return undefined;
  const { x, y, width, height } = object(value);
  if (typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' &&
      [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
    return { x, y, width, height };
  }
}

/** The driver's native identifier, whatever attribute the platform took it from. */
function parseIdentifier(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const native = object(value);
  if (typeof native.value !== 'string') return undefined;
  if (typeof native.kind === 'string' && !/identifier/i.test(native.kind)) return undefined;
  const trimmed = native.value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

function parseNode(input: unknown, depth: number): Node {
  const node = object(input);
  if (node.subtree_truncated === true || node.identity_unproven === true || depth > 50 ||
      (typeof node.children_count === 'number' && node.children_count >
        (Array.isArray(node.children) ? node.children.length : 0))) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot contains an incomplete subtree', false, 'subtree');
  }
  if (typeof node.role !== 'string' || !node.role ||
      (node.children !== undefined && !Array.isArray(node.children))) {
    throw new Fault('BAD_RESPONSE', 'Invalid snapshot node');
  }
  const states = Array.isArray(node.states) ? node.states.filter((state): state is string => typeof state === 'string') : [];
  const actions = Array.isArray(node.available_actions)
    ? node.available_actions.filter((action): action is string => typeof action === 'string')
    : undefined;
  return {
    role: node.role,
    name: optionalString(node.name),
    value: optionalString(node.value),
    text: optionalString(node.text),
    identifier: parseIdentifier(node.native_id),
    ref: typeof node.ref_id === 'string' && /^@[a-z\d]+:e\d+$/i.test(node.ref_id) ? node.ref_id : undefined,
    bounds: parseBounds(node.bounds),
    states,
    actions,
    secure: node.secure === true || node.protected === true || states.includes('secure') ||
      states.includes('protected') || /password|secure/i.test(`${node.role} ${node.subrole ?? ''}`),
    children: (node.children ?? []).map((child: unknown) => parseNode(child, depth + 1)),
  };
}

export function parseSnapshot(data: unknown, target: Target): Snapshot {  const input = object(data);
  // Three different facts answer `false` here, and only the first is about the
  // read rather than the tree: `complete` is false when the driver's observation
  // window ended before the walk did, `truncated` when the answer itself was cut,
  // and `identity_unproven` when the driver could not prove its refs unique.
  if (input.complete !== true) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot is incomplete', false, 'budget');
  }
  if (input.truncated === true) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot is incomplete', false, 'truncated');
  }
  if (Boolean(input.identity_unproven)) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot is incomplete', false, 'identity_unproven');
  }
  const window = object(input.window);
  if (window.title !== target.window) {
    throw new Fault('WINDOW_MISMATCH', 'Observed window does not match the flow target');
  }
  if (typeof window.id !== 'string' || !/^w-[a-zA-Z0-9_.:-]+$/.test(window.id)) {
    throw new Fault('BAD_RESPONSE', 'Missing or invalid window ID');
  }
  return { windowId: window.id, tree: parseNode(input.tree, 0) };
}

/** A menu or menubar surface has no window title; parse it without one. */
export function parseSurface(data: unknown): Snapshot {
  const input = object(data);
  if (input.complete !== true || input.truncated === true) {
    throw new Fault('INCOMPLETE_TREE', 'Surface snapshot is incomplete');
  }
  if (input.tree === undefined) throw new Fault('BAD_RESPONSE', 'Surface snapshot has no tree');
  return { windowId: '', tree: parseNode(input.tree, 0) };
}

export function flatten(tree: Node): Located[] {
  const entries: Located[] = [];
  function visit(node: Node, parents: string[]) {
    const path = [...parents, node.role];
    entries.push({ node, path });
    for (const child of node.children) visit(child, path);
  }
  visit(tree, []);
  return entries;
}

/** Roles that hold items rather than content: a list, outline or collection. */
const itemContainers = new Set([
  'row', 'cell', 'listitem', 'outlineitem', 'outlinerow', 'treeitem', 'table', 'list', 'outline', 'grid',
]);

/** Roles that can stand for the clicked item itself, not for a wrapper. */
const itemRoles = new Set([
  'row', 'cell', 'listitem', 'outlineitem', 'outlinerow', 'treeitem', 'statictext', 'text', 'image', 'link',
]);

/**
 * Item roles whose value is the visible label, not typed content. An editable
 * field's value is content and never becomes a target name on its own.
 */
const labelValueRoles = new Set(['statictext', 'text']);

/** Roles that stand for a whole row: in a list view, one file per row. */
const rowRoles = new Set(['row', 'outlinerow', 'treeitem', 'outlineitem']);

/** Roles that carry a visible label inside a row's name column. */
const columnLabelRoles = new Set(['statictext', 'text', 'textfield']);

/**
 * The name an element can be re-addressed by. An item label carries its name in
 * the value instead of a title (Finder shows a file name that way), so a value
 * counts only inside a row, cell or other item: a document's text content never
 * becomes a recorded target name.
 */
function nameOf(node: Node, item: boolean): string {
  const name = node.name;
  if (name !== undefined && name.trim() !== '') return name;
  if (!item || !labelValueRoles.has(node.role)) return '';
  const value = (node.value ?? node.text ?? '').trim();
  return value === '' || value.length > 256 ? '' : value;
}

/** The file name a row's first cell shows; an editable field holds it in its value. */
function columnLabel(cell: Node): string {
  const own = (cell.name ?? '').trim();
  if (own !== '') return own;
  const pending = [...cell.children];
  while (pending.length) {
    const node = pending.shift()!;
    if (columnLabelRoles.has(node.role)) {
      const name = (node.name ?? '').trim();
      if (name !== '') return name;
      const value = (node.value ?? node.text ?? '').trim();
      if (value !== '' && value.length <= 256) return value;
    }
    pending.push(...node.children);
  }
  return '';
}

/**
 * The name a list row addresses, taken from its first cell only. A list view
 * gives every row one cell per column, and the row's own name is the columns
 * joined together ("今天 21:36 616 字节 JSON"). A row with one cell (icon view,
 * sidebar) already names itself and is left alone.
 */
function listRowColumn(row: Node): { cells: Node[]; label: string } | undefined {
  const cells = row.children.filter(child => child.role === 'cell');
  if (cells.length < 2) return undefined;
  return { cells, label: columnLabel(cells[0]) };
}

/**
 * The name every node in one tree is addressed by. Recording a target and
 * matching it at replay share this single rule, so an item label named by its
 * value is both recorded and found again.
 */
export function elementNames(tree: Node): Map<Node, string> {
  const names = new Map<Node, string>();
  function visit(node: Node, item: boolean, described: boolean) {
    const withinItem = item || itemContainers.has(node.role);
    const columns = rowRoles.has(node.role) ? listRowColumn(node) : undefined;
    // A list row is named by its file column, never by its date, size or kind.
    const name = described ? '' : columns ? columns.label : nameOf(node, withinItem);
    names.set(node, name);
    for (const child of node.children) {
      // Every other column describes the file; its text is not its name.
      visit(child, withinItem, described || (!!columns && child.role === 'cell' && child !== columns.cells[0]));
    }
  }
  visit(tree, false, false);
  return names;
}

/** Root-first ancestors of one node; undefined when it is not in the tree. */
function ancestry(tree: Node, target: Node): Node[] | undefined {
  if (tree === target) return [];
  for (const child of tree.children) {
    const chain = ancestry(child, target);
    if (chain) return [tree, ...chain];
  }
  return undefined;
}

/**
 * The element a recorded click should name. Finder nests a file under a cell or
 * row and labels it with a static text beside the icon, while the innermost
 * element under the pointer is often an unnamed text field. A click keeps its
 * deepest named element and climbs only through item roles, so a wrapper such
 * as a toolbar or a group never becomes the target. `undefined` means the click
 * has no proven identity and must stay a point.
 */
export function clickIdentity(tree: Node, hit: Located): Located | undefined {
  const names = elementNames(tree);
  if (names.get(hit.node)) return hit;
  const chain = ancestry(tree, hit.node);
  if (!chain) return undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    if (!itemRoles.has(node.role) || !names.get(node)) continue;
    return { node, path: [...chain.slice(0, index + 1).map(parent => parent.role), node.role] };
  }
  return undefined;
}

function matches(tree: Node, locator: ElementLocator, names = elementNames(tree)): Located[] {
  // Finder reports a file row as AXRow to the capture helper but as a
  // `treeitem` in a window snapshot, and other AX versions use `row` or
  // `outlinerow` for the same item. The row family is one addressable role;
  // the name still has to match exactly.
  const family = (role: string) => rowRoles.has(role) ? 'row' : role;
  const candidates = flatten(tree).filter(entry => family(entry.node.role) === family(locator.role));
  // A platform identifier can survive renamed labels. When the page no longer
  // carries it, the recorded name and path can still resolve the control.
  if (locator.identifier !== undefined) {
    const identified = candidates.filter(entry => entry.node.identifier === locator.identifier);
    if (identified.length) return identified;
    // A control that is recorded by its identifier alone has no name to fall
    // back on: matching "any unnamed element of this role" would address a
    // different control, so a missing identifier is NOT_FOUND instead.
    if (!locator.name?.trim()) return [];
  }
  return candidates.filter(entry =>
    (locator.name === undefined || (names.get(entry.node) ?? '') === locator.name) &&
    (locator.path === undefined ||
      (locator.path.length === entry.path.length &&
        locator.path.every((role, index) => family(role) === family(entry.path[index])))),
  );
}

export function resolve(snapshot: Snapshot, locator: ElementLocator): Located {
  const candidates = matches(snapshot.tree, locator);
  const matchedIdentifier = locator.identifier !== undefined && candidates[0]?.node.identifier === locator.identifier;
  // The index was recorded for the name and path. Exact identifier matches
  // use their own evidence: one resolves, and duplicates are ambiguous.
  if (locator.index !== undefined && !matchedIdentifier) {
    const candidate = candidates[locator.index];
    if (candidate) return candidate;
  } else {
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Fault('AMBIGUOUS', `Locator matched ${candidates.length} elements`);
  }
  throw new Fault('NOT_FOUND', 'Locator did not match in the target window');
}

export function toLocator(snapshot: Snapshot, entry: Located): ElementLocator {
  const names = elementNames(snapshot.tree);
  const locator: ElementLocator = { kind: 'element', role: entry.node.role, name: names.get(entry.node) ?? '' };
  // Prefer a unique role/name. A role path or explicit index is needed for repeated controls.
  if (matches(snapshot.tree, locator, names).length > 1) {
    locator.path = entry.path;
    const candidates = matches(snapshot.tree, locator, names);
    if (candidates.length > 1) {
      locator.index = candidates.findIndex(candidate => candidate.node === entry.node);
    }
  }
  // The name/path above is the fallback identity; the identifier is the
  // preferred one and may be the only one a control has.
  if (entry.node.identifier) locator.identifier = entry.node.identifier;
  return locator;
}

export function contains(bounds: Bounds | undefined, [x, y]: Point): boolean {
  return !!bounds && x >= bounds.x && x < bounds.x + bounds.width &&
    y >= bounds.y && y < bounds.y + bounds.height;
}

export interface HitOptions {
  /**
   * Consider only nodes that carry an action reference. The older single-window
   * recorder ties a click to a control this way; the v2 recorder needs every
   * node, because in an Electron page most controls are plain containers and a
   * reference is only needed later, to press one.
   */
  referencedOnly?: boolean;
}

export function hitTest(snapshot: Snapshot, point: Point, options: HitOptions = {}): Located | undefined {
  const candidates = flatten(snapshot.tree)
    .filter(({ node }) => node.bounds && (!options.referencedOnly || node.ref !== undefined)
      && !node.states.includes('hidden') && contains(node.bounds, point))
    .map(entry => ({ entry, area: entry.node.bounds!.width * entry.node.bounds!.height }));
  candidates.sort((a, b) => b.entry.path.length - a.entry.path.length || a.area - b.area);
  const [first, second] = candidates;
  if (first && second && first.entry.path.length === second.entry.path.length && first.area === second.area) {
    throw new Fault('AMBIGUOUS_HIT', 'Click overlapped indistinguishable controls');
  }
  return first?.entry;
}
