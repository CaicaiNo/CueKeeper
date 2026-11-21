import type { ElementLocator } from './contracts.js';
import { flatten, toLocator } from './locator.js';
import type { Node, Point, Snapshot } from './locator.js';

type Bounds = NonNullable<Node['bounds']>;

/** Roles that accept direct user interaction. Everything else is listed after these. */
const interactiveRoles = new Set([
  'button', 'checkbox', 'combobox', 'colorwell', 'datefield', 'disclosure triangle',
  'incrementor', 'link', 'listbox', 'menu button', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'pop up button', 'popupbutton', 'radiobutton', 'searchfield',
  'segmented control', 'slider', 'stepper', 'switch', 'tab', 'text area', 'textfield',
  'textarea', 'timefield', 'toggle', 'toolbar button', 'treeitem',
]);

export interface PickCandidate {
  /** agent-desktop ref id from the snapshot, e.g. `@scuekeeper:e1`. */
  ref: string;
  role: string;
  name: string;
  /** Role path from the window root, used in the CLI listing and when disambiguating. */
  path: string[];
  bounds?: Bounds;
  /** Center of `bounds`, inside the control and safe to click. */
  point?: Point;
  interactive: boolean;
  /** Locator accepted by flow v1 (click target or type target). */
  locator: ElementLocator;
}

function center(bounds: Bounds | undefined): Point | undefined {
  if (!bounds) return undefined;
  return [
    Math.min(bounds.x + bounds.width - 1, Math.floor(bounds.x + bounds.width / 2)),
    Math.min(bounds.y + bounds.height - 1, Math.floor(bounds.y + bounds.height / 2)),
  ];
}

function pickable(node: Node) {
  return !!node.ref && !node.secure && !node.states.includes('hidden');
}

/**
 * Build the picker listing from a read-only window snapshot. Interactive controls
 * come first; each group keeps the snapshot's document order.
 */
export function pickCandidates(snapshot: Snapshot): PickCandidate[] {
  return flatten(snapshot.tree)
    .map((entry, order) => ({
      entry, order, interactive: interactiveRoles.has(entry.node.role.toLowerCase()),
    }))
    .filter(({ entry }) => pickable(entry.node))
    .sort((a, b) => Number(b.interactive) - Number(a.interactive) || a.order - b.order)
    .map(({ entry, interactive }) => ({
      ref: entry.node.ref!,
      role: entry.node.role,
      name: entry.node.name ?? '',
      path: entry.path,
      bounds: entry.node.bounds,
      point: center(entry.node.bounds),
      interactive,
      locator: toLocator(snapshot, entry),
    }));
}

/** Resolve `--select` input: the full ref id, or its trailing `e<N>` part. */
export function selectCandidate(candidates: PickCandidate[], ref: string): PickCandidate | undefined {
  return candidates.find(candidate => candidate.ref === ref) ??
    candidates.find(candidate => candidate.ref.split(':').at(-1) === ref);
}
