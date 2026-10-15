import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkFeatureModule, cyclicComponents, findCycles, findOverlappingRoots, layerDirectionAllowed,
} from '../../../packages/feature-module-standard/dist/index.js';
import type { FeatureModuleInput, LayerRole } from '../../../packages/feature-module-standard/dist/index.js';
import { conformanceCases, exampleModule } from '../../../packages/feature-module-standard/dist/fixtures.js';

const codesOf = (input: FeatureModuleInput): string[] => checkFeatureModule(input).diagnostics.map(({ code }) => code);
const allowed = (from: string, to: string, scope: 'same-feature' | 'other-feature'): boolean => layerDirectionAllowed(from as LayerRole, to as LayerRole, scope);
const packagesRoot = fileURLToPath(new URL('../../../packages/', import.meta.url));

for (const fixture of conformanceCases) {
  test(`fixture ${fixture.id}`, () => {
    const report = checkFeatureModule(fixture.input);
    assert.deepEqual(report.diagnostics.map(({ code }) => code).toSorted(), [...fixture.expect].toSorted(), fixture.description);
    assert.equal(report.ok, fixture.ok);
  });
}

test('fixture ids are unique and every rejecting code is exercised', () => {
  assert.equal(new Set(conformanceCases.map(({ id }) => id)).size, conformanceCases.length);
  const exercised = new Set(conformanceCases.flatMap(({ expect }) => expect));
  for (const code of [
    'assembly-misplaced', 'assembly-missing', 'composition-contract-layer', 'composition-contract-misplaced', 'republication-mismatch', 'container-empty', 'container-file', 'deep-import',
    'entry-unmapped', 'feature-cycle', 'feature-duplicate', 'feature-root-placement', 'feature-undeclared', 'layer-direction',
    'load-cycle', 'not-visible', 'republication-invalid', 'republication-skips-level', 'republication-undeclared',
    'surface-unowned', 'test-misplaced', 'test-unowned', 'use-undeclared',
  ]) { assert.ok(exercised.has(code), code); }
});

test('the report does not depend on input order and leaves the input untouched', () => {
  const base = conformanceCases.find(({ id }) => id === 'lateral-and-downward-cycle')?.input;
  assert.ok(base);
  const frozen = structuredClone(base);
  const shuffled = { ...base, files: base.files.toReversed(), imports: base.imports.toReversed() };
  assert.deepEqual(checkFeatureModule(shuffled), checkFeatureModule(base));
  assert.deepEqual(base, frozen);
});

test('paths that escape the repository are reported and never trusted', () => {
  const input = exampleModule();
  const report = codesOf({ ...input, files: [...input.files, '../outside.ts', '/abs.ts', 'a\\b.ts'], imports: [...input.imports, { from: '../x.ts', to: input.files[0] ?? '', mode: 'runtime', line: 1 }] });
  assert.deepEqual(report.toSorted(), ['invalid-path', 'invalid-path', 'invalid-path', 'invalid-path']);
});

test('a directory named like an Object prototype key is no role directory', () => {
  const input = exampleModule();
  assert.deepEqual(codesOf({ ...input, files: [...input.files, 'src/features/orders/constructor/x.ts', 'src/features/orders/__proto__/x.ts'] }), ['entry-unmapped', 'entry-unmapped']);
});

test('layer direction follows the standard and rejects unknown roles', () => {
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

test('cycle search reports each cycle path in a stable order', () => {
  assert.deepEqual(findCycles([['b', 'a'], ['a', 'b'], ['c', 'c'], ['c', 'd']]), [['a', 'b', 'a']]);
  assert.deepEqual(findCycles([['a', 'b'], ['b', 'c']]), []);
  assert.deepEqual(cyclicComponents([['a', 'b'], ['b', 'a'], ['b', 'c'], ['d', 'd']]), [['a', 'b']]);
});

test('component search is iterative and survives a very long chain', () => {
  const length = 50_000;
  const edges = Array.from({ length }, (_, index): readonly [string, string] => [`f${index}`, `f${(index + 1) % length}`]);
  assert.equal(cyclicComponents(edges).at(0)?.length, length);
});

test('overlapping ownership roots are reported in declaration order', () => {
  assert.deepEqual(findOverlappingRoots(['a/x', 'a/y', 'a/x/z', 'a/xy']), [['a/x', 'a/x/z']]);
});

test('metrics count owned files, tests, sub-features and consumer groups', () => {
  const input = { ...exampleModule(), testFiles: ['tests/features/orders/features/discounts/a.test.ts'], fileGroups: { composition: (path: string) => path.includes('/composition/') } };
  const metrics = new Map(checkFeatureModule(input).metrics.map((metric) => [metric.id, metric]));
  assert.deepEqual(metrics.get('orders/discounts'), { id: 'orders/discounts', depth: 2, subFeatures: 1, sourceFiles: 6, testFiles: 1, groups: { composition: 3 } });
  assert.equal(metrics.get('orders')?.subFeatures, 2);
});

test('no other package depends on the Feature Module Standard package and its kernel has no dependencies', async () => {
  const name = '@agent-teams/feature-module-standard';
  for (const directory of await readdir(packagesRoot)) {
    const manifest = JSON.parse(await readFile(`${packagesRoot}${directory}/package.json`, 'utf8')) as Record<string, Record<string, string> | undefined>;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}));
    if (directory === 'feature-module-standard') { assert.deepEqual(manifest['dependencies'] ?? {}, {}); continue; }
    assert.equal(declared.includes(name), false, `${directory} must not depend on ${name}`);
  }
});
