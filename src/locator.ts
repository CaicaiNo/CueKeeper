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

function matches(tree: Node, locator: ElementLocator): Located[] {
  return flatten(tree).filter(entry =>
    entry.node.role === locator.role &&
    (locator.name === undefined || (entry.node.name ?? '') === locator.name) &&
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
  const locator: ElementLocator = { kind: 'element', role: entry.node.role, name: entry.node.name ?? '' };
  // Prefer a unique role/name. A role path or explicit index is needed for repeated controls.
  if (matches(snapshot.tree, locator).length > 1) {
    locator.path = entry.path;
    const candidates = matches(snapshot.tree, locator);
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
