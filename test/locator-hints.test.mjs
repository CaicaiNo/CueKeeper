import assert from 'node:assert/strict';
import test from 'node:test';

import { resolve, toLocator } from '../dist/locator.js';

const node = (role, name = '', children = [], extra = {}) => ({
  role, name, states: [], secure: false, children, ...extra,
});
const snapshot = tree => ({ windowId: 'w-test', tree });
const child = (parent, index) => parent.children[index];

test('a unique control still records its role path and identifier', () => {
  const settings = node('group', '设置', [], { identifier: 'settings-panel' });
  const tree = node('window', '', [settings]);
  const locator = toLocator(snapshot(tree), {
    node: settings,
    path: ['window', 'group'],
  });
  assert.deepEqual(locator.path, ['window', 'group']);
  assert.equal(locator.identifier, 'settings-panel');
  assert.equal(locator.index, undefined);
});

test('a recorded path resolves one of several same-named groups', () => {
  const first = node('group', '设置');
  const second = node('group', '设置');
  const tree = node('window', '', [first, node('group', '', [second])]);
  const snap = snapshot(tree);
  const locator = toLocator(snap, { node: first, path: ['window', 'group'] });
  assert.deepEqual(locator.path, ['window', 'group']);
  assert.equal(resolve(snap, locator).node, first);
  assert.throws(
    () => resolve(snap, { kind: 'element', role: 'group', name: '设置' }),
    error => error.code === 'AMBIGUOUS' && /matched 2/.test(error.message));
});

test('a path that no longer matches falls back to a unique name', () => {
  const only = node('group', '设置');
  const snap = snapshot(node('window', '', [node('group', '', [only])]));
  const stale = {
    kind: 'element', role: 'group', name: '设置', path: ['window', 'group'],
  };
  assert.equal(resolve(snap, stale).node, only);
});

test('a stale path does not guess when the name is still ambiguous', () => {
  const tree = node('window', '', [
    node('group', '设置'),
    node('group', '', [node('group', '设置')]),
  ]);
  const stale = {
    kind: 'element', role: 'group', name: '设置',
    path: ['window', 'group', 'group', 'group'],
  };
  assert.throws(
    () => resolve(snapshot(tree), stale),
    error => error.code === 'AMBIGUOUS' && /matched 2/.test(error.message));
});

test('a path-less duplicate stays ambiguous instead of guessing', () => {
  const tree = node('window', '', [
    node('group', '设置'),
    node('group', '设置'),
  ]);
  assert.throws(
    () => resolve(snapshot(tree), { kind: 'element', role: 'group', name: '设置' }),
    error => error.code === 'AMBIGUOUS' && /matched 2/.test(error.message));
});

test('an identifier wins over duplicate names', () => {
  const wanted = node('group', '设置', [], { identifier: 'right-settings' });
  const other = node('group', '设置', [], { identifier: 'other-settings' });
  const snap = snapshot(node('window', '', [other, wanted]));
  const identified = {
    kind: 'element', role: 'group', name: '设置', identifier: 'right-settings',
  };
  assert.equal(resolve(snap, identified).node, wanted);
  // A missing identifier may fall back to a unique name, but not choose a
  // same-named sibling.
  assert.throws(
    () => resolve(snap, {
      kind: 'element', role: 'group', name: '设置', identifier: 'gone',
    }),
    error => error.code === 'AMBIGUOUS');
});

test('an index resolves same-named controls with the same role path', () => {
  const first = node('group', '设置');
  const second = node('group', '设置');
  const tree = node('window', '', [first, second]);
  const snap = snapshot(tree);
  assert.throws(
    () => resolve(snap, { kind: 'element', role: 'group', name: '设置' }),
    error => error.code === 'AMBIGUOUS');
  const locator = toLocator(snap, { node: second, path: ['window', 'group'] });
  assert.equal(locator.index, 1);
  assert.equal(resolve(snap, locator).node, second);
});

test('a deep path beyond the schema limit is not recorded', () => {
  let tree = node('window', '', [node('group', '设置')]);
  for (let depth = 0; depth < 52; depth += 1) {
    tree = node('group', '', [tree]);
  }
  // The target itself is shallow; the root path is longer than the schema cap.
  const target = tree;
  const locator = toLocator(snapshot(tree), { node: target, path: Array(52).fill('group') });
  assert.equal(locator.path, undefined);
});
