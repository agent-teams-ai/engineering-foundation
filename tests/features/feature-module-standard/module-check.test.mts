import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STANDARD, checkFeatureModule } from '../../../packages/feature-module-standard/dist/index.js';
import { exampleModule } from '../../../packages/feature-module-standard/dist/fixtures.js';

const packagesRoot = fileURLToPath(new URL('../../../packages/', import.meta.url));

void test('metrics count owned files, tests, sub-features and consumer groups', () => {
  const input = { ...exampleModule(), testFiles: ['tests/features/orders/features/discounts/a.test.ts'], fileGroups: { composition: (path: string) => path.includes('/composition/') } };
  const metrics = new Map(checkFeatureModule(input).metrics.map((metric) => [metric.id, metric]));
  assert.deepEqual(metrics.get('orders/discounts'), { id: 'orders/discounts', depth: 2, subFeatures: 1, sourceFiles: 6, testFiles: 1, groups: { composition: 3 } });
  assert.equal(metrics.get('orders')?.subFeatures, 2);
});

void test('no other package depends on the Feature Module Standard package and its kernel has no dependencies', async () => {
  const name = '@agent-teams/feature-module-standard';
  for (const directory of await readdir(packagesRoot)) {
    const manifest = JSON.parse(await readFile(`${packagesRoot}${directory}/package.json`, 'utf8')) as Record<string, Record<string, string> | undefined>;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => Object.keys(manifest[field] ?? {}));
    if (directory === 'feature-module-standard') { assert.deepEqual(manifest['dependencies'] ?? {}, {}); continue; }
    assert.equal(declared.includes(name), false, `${directory} must not depend on ${name}`);
  }
});

void test('the package pins the exact text of the standard it implements', () => {
  assert.deepEqual(STANDARD, {
    id: 'agent-teams.feature-module-standard', version: 'v1.1',
    digest: 'sha256:cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c',
  });
});

void test('a SHOULD of the standard is a warning that does not fail the module', () => {
  const report = checkFeatureModule({ ...exampleModule(), testFiles: ['tests/features/ghost/ghost.test.ts'] });
  assert.deepEqual(report.diagnostics.map(({ code, severity }) => [code, severity]), [['test-unowned', 'warning']]);
  assert.equal(report.ok, true);
});
