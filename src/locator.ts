import type { ElementLocator, Target } from './contracts.js';

type Bounds = { x: number; y: number; width: number; height: number };
export type Point = [number, number];

export interface Node {
  role: string;
  name?: string;
  value?: string;
  text?: string;
  ref?: string;
  states: string[];
  secure: boolean;
  bounds?: Bounds;
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
  constructor(public code: string, message: string, public dependency = false) {
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

function parseNode(input: unknown, depth: number): Node {
  const node = object(input);
  if (node.subtree_truncated === true || node.identity_unproven === true || depth > 50 ||
      (typeof node.children_count === 'number' && node.children_count >
        (Array.isArray(node.children) ? node.children.length : 0))) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot contains an incomplete subtree');
  }
  if (typeof node.role !== 'string' || !node.role ||
      (node.children !== undefined && !Array.isArray(node.children))) {
    throw new Fault('BAD_RESPONSE', 'Invalid snapshot node');
  }
  const states = Array.isArray(node.states) ? node.states.filter((state): state is string => typeof state === 'string') : [];
  return {
    role: node.role,
    name: optionalString(node.name),
    value: optionalString(node.value),
    text: optionalString(node.text),
    ref: typeof node.ref_id === 'string' && /^@[a-z\d]+:e\d+$/i.test(node.ref_id) ? node.ref_id : undefined,
    bounds: parseBounds(node.bounds),
    states,
    secure: node.secure === true || node.protected === true || states.includes('secure') ||
      states.includes('protected') || /password|secure/i.test(`${node.role} ${node.subrole ?? ''}`),
    children: (node.children ?? []).map((child: unknown) => parseNode(child, depth + 1)),
  };
}

export function parseSnapshot(data: unknown, target: Target): Snapshot {
  const input = object(data);
  if (input.complete !== true || input.truncated === true || Boolean(input.identity_unproven)) {
    throw new Fault('INCOMPLETE_TREE', 'Window snapshot is incomplete');
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
 * field's value is content and never becomes a target name.
 */
const labelValueRoles = new Set(['statictext', 'text']);

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

/**
 * The name every node in one tree is addressed by. Recording a target and
 * matching it at replay share this single rule, so an item label named by its
 * value is both recorded and found again.
 */
export function elementNames(tree: Node): Map<Node, string> {
  const names = new Map<Node, string>();
  function visit(node: Node, item: boolean) {
    const withinItem = item || itemContainers.has(node.role);
    names.set(node, nameOf(node, withinItem));
    for (const child of node.children) visit(child, withinItem);
  }
  visit(tree, false);
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
  return flatten(tree).filter(entry =>
    entry.node.role === locator.role &&
    (locator.name === undefined || (names.get(entry.node) ?? '') === locator.name) &&
    (locator.path === undefined ||
      (locator.path.length === entry.path.length && locator.path.every((role, index) => role === entry.path[index]))),
  );
}

export function resolve(snapshot: Snapshot, locator: ElementLocator): Located {
  const candidates = matches(snapshot.tree, locator);
  if (locator.index !== undefined) {
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
  return locator;
}

export function contains(bounds: Bounds | undefined, [x, y]: Point): boolean {
  return !!bounds && x >= bounds.x && x < bounds.x + bounds.width &&
    y >= bounds.y && y < bounds.y + bounds.height;
}

export function hitTest(snapshot: Snapshot, point: Point): Located | undefined {
  const candidates = flatten(snapshot.tree)
    .filter(({ node }) => node.ref && !node.states.includes('hidden') && contains(node.bounds, point))
    .map(entry => ({ entry, area: entry.node.bounds!.width * entry.node.bounds!.height }));
  candidates.sort((a, b) => b.entry.path.length - a.entry.path.length || a.area - b.area);
  const [first, second] = candidates;
  if (first && second && first.entry.path.length === second.entry.path.length && first.area === second.area) {
    throw new Fault('AMBIGUOUS_HIT', 'Click overlapped indistinguishable controls');
  }
  return first?.entry;
}
