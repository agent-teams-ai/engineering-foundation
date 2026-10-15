import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cyclicComponents, findCycles, findOverlappingRoots, layerDirectionAllowed,
} from '../../../packages/feature-module-standard/dist/index.js';
import type { LayerRole } from '../../../packages/feature-module-standard/dist/index.js';

const allowed = (from: string, to: string, scope: 'same-feature' | 'other-feature'): boolean => layerDirectionAllowed(from as LayerRole, to as LayerRole, scope);

void test('layer direction follows the standard and rejects unknown roles', () => {
  assert.equal(allowed('application', 'contracts', 'same-feature'), false);
  assert.equal(allowed('domain', 'contracts', 'other-feature'), false);
  assert.equal(allowed('adapters', 'domain', 'same-feature'), true);
  assert.equal(allowed('adapters', 'application', 'other-feature'), false);
  assert.equal(allowed('composition', 'adapters', 'other-feature'), true);
  assert.equal(allowed('composition', 'testing', 'same-feature'), false);
  assert.equal(allowed('composition', 'testing', 'other-feature'), true);
  assert.equal(allowed('constructor', 'domain', 'same-feature'), false);
  assert.equal(allowed('unknown', 'domain', 'other-feature'), false);
});

void test('cycle search reports each cycle path in a stable order', () => {
  assert.deepEqual(findCycles([['b', 'a'], ['a', 'b'], ['c', 'c'], ['c', 'd']]), [['a', 'b', 'a']]);
  assert.deepEqual(findCycles([['a', 'b'], ['b', 'c']]), []);
  assert.deepEqual(cyclicComponents([['a', 'b'], ['b', 'a'], ['b', 'c'], ['d', 'd']]), [['a', 'b']]);
});

void test('component search is iterative and survives a very long chain', () => {
  const length = 50_000;
  const edges = Array.from({ length }, (_, index): readonly [string, string] => [`f${index}`, `f${(index + 1) % length}`]);
  assert.equal(cyclicComponents(edges).at(0)?.length, length);
});

void test('overlapping ownership roots are reported in declaration order', () => {
  assert.deepEqual(findOverlappingRoots(['a/x', 'a/y', 'a/x/z', 'a/xy']), [['a/x', 'a/x/z']]);
});

