import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFeatureModule } from '../../../packages/feature-module-standard/dist/index.js';
import type { FeatureModuleInput } from '../../../packages/feature-module-standard/dist/index.js';
import { exampleModule } from '../../../packages/feature-module-standard/dist/fixtures.js';

const codesOf = (input: FeatureModuleInput): string[] => checkFeatureModule(input).diagnostics.map(({ code }) => code);

void test('paths that escape the repository are reported and never trusted', () => {
  const input = exampleModule();
  const report = codesOf({ ...input, files: [...input.files, '../outside.ts', '/abs.ts', 'a\\b.ts'], imports: [...input.imports, { from: '../x.ts', to: input.files[0] ?? '', mode: 'runtime', line: 1 }] });
  assert.deepEqual(report.toSorted(), ['invalid-path', 'invalid-path', 'invalid-path', 'invalid-path']);
});

void test('a directory named like an Object prototype key is no role directory', () => {
  const input = exampleModule();
  assert.deepEqual(codesOf({ ...input, files: [...input.files, 'src/features/orders/constructor/x.ts', 'src/features/orders/__proto__/x.ts'] }), ['entry-unmapped', 'entry-unmapped']);
});

