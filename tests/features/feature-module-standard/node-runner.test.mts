import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkFeatureModule } from '../../../packages/feature-module-standard/dist/index.js';
import { exampleModule, exampleSources } from '../../../packages/feature-module-standard/dist/fixtures.js';
import { checkFeatureModuleOnDisk, formatNodeReport } from '../../../packages/feature-module-standard/dist/node.js';
import type { NodeCheckConfig } from '../../../packages/feature-module-standard/dist/node.js';

// The runner's acceptance case: the example tree of the standard, materialized as real files, must give the kernel's own answer.
const example = exampleModule();
const config = (consumerRoot: string, more: Partial<NodeCheckConfig> = {}): NodeCheckConfig => ({
  consumerRoot,
  sourceRoots: ['src'],
  structure: {
    featuresRoot: 'src/features',
    roleDirectories: { contracts: 'contracts', domain: 'domain', application: 'application', adapters: 'adapters', composition: 'composition' },
    subFeatureRoots: example.featureRoots.filter((root) => root.includes('/features/', 'src/features'.length + 1)),
  },
  surfaces: example.surfaces ?? {},
  ...more,
});

async function materialize(sources: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fms-node-runner-'));
  for (const [path, text] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function withExample(run: (root: string) => Promise<void>, edit?: (sources: Record<string, string>) => void): Promise<void> {
  const sources = { ...exampleSources() };
  edit?.(sources);
  const root = await materialize(sources);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

void test('the runner gives the kernel answer for the materialized example tree', async () => {
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root));
    const kernel = checkFeatureModule(example);
    assert.deepEqual(report.diagnostics, kernel.diagnostics);
    assert.deepEqual(report.features, kernel.features);
    assert.deepEqual(report.metrics, kernel.metrics);
    assert.equal(report.ok, true);
    assert.equal(formatNodeReport(report), '');
  });
});

void test('a deep import in a real file is reported at its line', async () => {
  const file = 'src/features/orders/features/pricing/composition/feature.ts';
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root));
    const found = report.diagnostics.filter(({ code }) => code === 'deep-import');
    assert.deepEqual(found.map(({ path, line }) => [path, line]), [[file, 1]]);
    assert.equal(report.ok, false);
    assert.match(formatNodeReport(report), /^error deep-import src\/features\/orders\/features\/pricing\/composition\/feature\.ts:1 /u);
  }, (sources) => {
    sources[file] = `import '../../discounts/domain/model.ts';\n${sources[file] ?? ''}`;
  });
});

void test('a re-export statement is read as a republication, not as a use', async () => {
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root));
    assert.deepEqual(report.diagnostics.map(({ code }) => code), ['republication-undeclared']);
  }, (sources) => {
    const orders = 'src/features/orders/contracts/public.ts';
    sources[orders] = `export * from '../features/pricing/contracts/public.ts';\n${sources[orders] ?? ''}`;
  });
});

void test('growth budgets warn and never fail the run', async () => {
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root, { budgets: [{ metric: 'depth', max: 1 }, { metric: 'sourceFiles', max: 6, subject: 'orders' }] }));
    assert.equal(report.ok, true);
    assert.deepEqual(report.budgetWarnings.map(({ subject, metric }) => `${subject} ${metric}`), ['billing/coupons depth', 'orders/discounts depth', 'orders/discounts/coupons depth', 'orders/pricing depth']);
    assert.match(formatNodeReport(report), /^warning budget billing\/coupons: depth is 2, budget 1$/mu);
  });
});

void test('a file that cannot be parsed fails the run', async () => {
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root));
    assert.equal(report.ok, false);
    assert.deepEqual(report.parseFailures, ['src/features/billing/domain/model.ts']);
  }, (sources) => {
    sources['src/features/billing/domain/model.ts'] = 'import { from ;\n';
  });
});

void test('the runner reads only the declared roots', async () => {
  await withExample(async (root) => {
    await writeFile(join(root, 'elsewhere.ts'), "import './src/features/orders/domain/model.ts';\nimport { from ;\n");
    const report = await checkFeatureModuleOnDisk(config(root));
    assert.equal(report.ok, true);
    assert.deepEqual(report.parseFailures, []);
  });
});
