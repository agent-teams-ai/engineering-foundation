import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases } from '../../support/ci-input-proof-donor-cases.mts';
import { compareLeafInventories } from '../../../packages/ci-input-proof/dist/index.js';
import type { InputLeaf, RejectionReason } from '../../../packages/ci-input-proof/dist/index.js';

const oldDigest = '1'.repeat(40);
const newDigest = '2'.repeat(40);
const sparse = (length: number): unknown[] => {
  const array: unknown[] = [];
  array.length = length;
  return array;
};
const leaf = (path: string, membership: 'closed' | 'structural' = 'closed', content = oldDigest): Extract<InputLeaf, { type: 'file' }> =>
  ({ path, type: 'file', mode: '100644', membership, content });
const inventory = (inputs: unknown = [leaf('package.json'), leaf('src/a.ts', 'structural')], scheme = 'git-object-sha1') =>
  ({ version: 1, digestScheme: scheme, inputs });
const rejected = (before: unknown, after: unknown, permission: unknown, reason: RejectionReason): void => {
  assert.deepEqual(compareLeafInventories(before, after, permission), { status: 'rejected', reason });
};


// Independent common cases also execute against each real donor in TEST checkouts.
// Failure: a shared fixture's advertised relation diverges from package behavior.
void test('versioned real-donor corpus keeps its independently expected leaf relations', () => {
  for (const entry of cases) {
    const inputs: InputLeaf[] = [leaf('package.json'), leaf('src/a.ts', 'structural')];
    switch (entry.id) {
      case 'same': break;
      case 'body-content': inputs[1] = leaf('src/a.ts', 'structural', newDigest); break;
      case 'closed-content': inputs[0] = leaf('package.json', 'closed', newDigest); break;
      case 'chmod': inputs[1] = { ...leaf('src/a.ts', 'structural'), mode: '100755' }; break;
      case 'addition': inputs.push(leaf('src/extra.ts')); break;
      case 'deletion': inputs.pop(); break;
      case 'rename': inputs[1] = leaf('src/b.ts', 'structural'); break;
    }
    const result = compareLeafInventories(inventory(), inventory(inputs), ['src/a.ts']);
    assert.equal(result.status === 'compatible-inputs', entry.compatible, entry.id);
    if (result.status === 'compatible-inputs') {
      assert.deepEqual(result.changedContentPaths, entry.id === 'body-content' ? ['src/a.ts'] : []);
    }
  }
});

void test('permutation is compatible; only actual permitted changes are reported in ordinal order', () => {
  const before = inventory([leaf('package.json'), leaf('src/z.ts', 'structural'), leaf('src/a.ts', 'structural')]);
  const after = inventory([leaf('src/a.ts', 'structural', newDigest), leaf('src/z.ts', 'structural', newDigest), leaf('package.json')]);
  assert.deepEqual(compareLeafInventories(before, after, ['src/z.ts', 'src/a.ts']),
    { status: 'compatible-inputs', changedContentPaths: ['src/a.ts', 'src/z.ts'] });
  assert.deepEqual(compareLeafInventories(before, before, ['src/z.ts']),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('closed drift and unpermitted structural drift reject; permissions never grant closed changes', () => {
  rejected(inventory(), inventory([leaf('package.json', 'closed', newDigest), leaf('src/a.ts', 'structural')]), [], 'closed-input-changed');
  rejected(inventory(), inventory([leaf('package.json'), leaf('src/a.ts', 'structural', newDigest)]), [], 'closed-input-changed');
  for (const permissions of [['package.json'], ['missing.ts'], ['src/a.ts', 'src/a.ts'], [1]]) {
    rejected(inventory(), inventory(), permissions, 'invalid-content-permission');
  }
});

void test('rename, addition, deletion, chmod, type and membership changes reject even with equal content', () => {
  const original = leaf('src/a.ts', 'structural');
  for (const inputs of [
    [leaf('package.json'), leaf('src/b.ts', 'structural')],
    [leaf('package.json')],
    [leaf('package.json'), original, leaf('extra.ts')],
    [leaf('package.json'), { ...original, mode: '100755' }],
    [leaf('package.json'), { ...original, type: 'symlink', mode: '120000' }],
    [leaf('package.json'), { ...original, membership: 'closed' }],
  ]) { rejected(inventory(), inventory(inputs), [], 'input-structure-changed'); }
});

void test('original getters and custom array iterators are rejected without executing them', () => {
  let effects = 0;
  const getter = () => { effects += 1; throw new Error('must not execute'); };
  for (const bad of [
    Object.defineProperty(inventory(), 'inputs', { get: getter }),
    inventory([Object.defineProperty(leaf('package.json'), 'content', { get: getter })]),
    inventory(Object.defineProperty([leaf('package.json')], Symbol.iterator, { value: getter })),
    inventory(Object.defineProperty([leaf('package.json')], '0', { get: getter })),
  ]) { rejected(bad, inventory(), [], 'malformed-inventory'); }
  rejected(inventory(), inventory(), Object.defineProperty(['src/a.ts'], Symbol.iterator, { value: getter }), 'invalid-content-permission');
  assert.equal(effects, 0);
});

void test('extra own fields, symbols, holes and unsupported prototypes cannot disappear during projection', () => {
  for (const bad of [
    { ...inventory(), extra: true },
    { ...inventory(), [Symbol('extra')]: true },
    inventory([{ ...leaf('package.json'), extra: true }]),
    inventory(sparse(1)),
    inventory(Object.assign([leaf('package.json')], { extra: true })),
    Object.setPrototypeOf(inventory(), { inherited: true }),
    inventory([Object.setPrototypeOf(leaf('package.json'), { inherited: true })]),
    inventory(Object.setPrototypeOf([leaf('package.json')], null)),
  ]) { rejected(bad, inventory(), [], 'malformed-inventory'); }
  const plain: unknown = Object.assign(Object.create(null), inventory([Object.assign(Object.create(null), leaf('package.json'))]));
  assert.deepEqual(compareLeafInventories(plain, inventory([leaf('package.json')]), []),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('empty/unclosed inventories and duplicate paths cannot qualify', () => {
  rejected(inventory([]), inventory(), [], 'incomplete-inputs');
  rejected(inventory([leaf('src/a.ts', 'structural')]), inventory(), [], 'incomplete-inputs');
  rejected(inventory([leaf('package.json'), leaf('package.json')]), inventory(), [], 'duplicate-input');
});

void test('literal paths reject ambiguous/absolute forms and retain case and Unicode identity', () => {
  for (const path of ['', '/a', 'C:/a', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\u0000b', 'a\u007fb', 'a/']) {
    rejected(inventory([leaf(path)]), inventory(), [], 'malformed-inventory');
  }
  for (const [before, after] of [['A.ts', 'a.ts'], ['é.ts', 'e\u0301.ts']]) {
    rejected(inventory([leaf(before)]), inventory([leaf(after)]), [], 'input-structure-changed');
  }
});

void test('schemes, canonical nonzero digests and type/mode pairings are checked', () => {
  rejected({ ...inventory(), version: 2 }, inventory(), [], 'unsupported-version');
  rejected(inventory(undefined, 'unknown'), inventory(), [], 'unsupported-scheme');
  rejected(inventory([leaf('package.json')]), inventory([leaf('package.json', 'closed', '1'.repeat(64))], 'sha256'), [], 'scheme-mismatch');
  for (const content of ['0'.repeat(40), 'A'.repeat(40), '1'.repeat(64), '1'.repeat(39)]) {
    rejected(inventory([leaf('package.json', 'closed', content)]), inventory(), [], 'malformed-inventory');
  }
  rejected(inventory([{ ...leaf('package.json'), mode: '120000' }]), inventory(), [], 'malformed-inventory');
  for (const input of [{ ...leaf('a'), type: 'symlink', mode: '120000' }, { ...leaf('a'), type: 'gitlink', mode: '160000' }]) {
    assert.deepEqual(compareLeafInventories(inventory([input]), inventory([input]), []),
      { status: 'compatible-inputs', changedContentPaths: [] });
  }
});

void test('bounds reject before copying over-limit collections', () => {
  rejected(inventory(sparse(65_537)), inventory(), [], 'exceeded-limit');
  rejected(inventory([leaf('a'.repeat(4097))]), inventory(), [], 'exceeded-limit');
  rejected(inventory(), inventory(), sparse(3), 'exceeded-limit');
  const atLimit = inventory([leaf('a'.repeat(4096))]);
  assert.deepEqual(compareLeafInventories(atLimit, atLimit, []),
    { status: 'compatible-inputs', changedContentPaths: [] });
});

void test('result owns immutable values; caller mutation cannot alter an earlier relation', () => {
  const before = inventory();
  const callerLeaves = [leaf('package.json'), leaf('src/a.ts', 'structural', newDigest)];
  const after = inventory(callerLeaves);
  const permissions = ['src/a.ts'];
  const result = compareLeafInventories(before, after, permissions);
  callerLeaves[1] = leaf('other.ts');
  permissions[0] = 'other.ts';
  assert.deepEqual(result, { status: 'compatible-inputs', changedContentPaths: ['src/a.ts'] });
  assert.ok(Object.isFrozen(result));
  if (result.status === 'compatible-inputs') { assert.ok(Object.isFrozen(result.changedContentPaths)); }
});
