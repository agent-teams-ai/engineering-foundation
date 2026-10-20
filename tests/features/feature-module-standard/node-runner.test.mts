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
  moduleComposition: example.moduleComposition ?? [],
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

void test('external test roots require explicit mirrored coverage, including when mappedFiles is declared', async () => {
  const file = 'tests/features/orders/model.test.ts';
  await withExample(async (root) => {
    const selected = config(root, { testRoots: ['tests'] });
    for (const profile of [selected, { ...selected, testFeaturesRoot: 'other/features' },
      { ...selected, mappedFiles: ['model.test.ts'] }]) {
      await assert.rejects(checkFeatureModuleOnDisk(profile), /Test files require a feature root or testFeaturesRoot mapping: tests\/features\/orders\/model\.test\.ts/u);
    }
    const report = await checkFeatureModuleOnDisk({ ...selected, testFeaturesRoot: 'tests/features' });
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.map(({ code, path, line }) => ({ code, path, line })), [{ code: 'deep-import', path: file, line: 1 }]);
    assert.equal(report.metrics.find(({ id }) => id === 'orders')?.testFiles, 1);
  }, (sources) => {
    sources[file] = 'import "../../../src/features/billing/domain/model.js";\n';
  });
});

void test('colocated test directories retain ownership and import checks without a mirrored root', async () => {
  const file = 'src/features/orders/domain/tests/model.test.ts';
  await withExample(async (root) => {
    const selected = config(root, { testRoots: ['src/features/orders/domain/tests'] });
    const own = await checkFeatureModuleOnDisk(selected);
    assert.equal(own.ok, true);
    assert.deepEqual(own.diagnostics, []);
    assert.equal(own.metrics.find(({ id }) => id === 'orders')?.testFiles, 1);
    await writeFile(join(root, file), 'import "../../../billing/domain/model.js";\n');
    const foreign = await checkFeatureModuleOnDisk(selected);
    assert.equal(foreign.ok, false);
    assert.deepEqual(foreign.diagnostics.map(({ code, path, line }) => ({ code, path, line })), [{ code: 'deep-import', path: file, line: 1 }]);
    assert.equal(foreign.metrics.find(({ id }) => id === 'orders')?.testFiles, 1);
  }, (sources) => { sources[file] = 'import "../model.js";\n'; });
});

void test('test mapping preserves kernel invalid-path errors and test-unowned warnings', async () => {
  const file = 'tests/features/ghost/model.test.ts';
  await withExample(async (root) => {
    const selected = config(root, { testRoots: ['tests'], testFeaturesRoot: 'tests/features' });
    const unowned = await checkFeatureModuleOnDisk(selected);
    assert.equal(unowned.ok, true);
    assert.deepEqual(unowned.diagnostics.map(({ code, severity }) => ({ code, severity })), [{ code: 'test-unowned', severity: 'warning' }]);
    const invalid = await checkFeatureModuleOnDisk({ ...selected, testFeaturesRoot: 'tests//features' });
    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.diagnostics.map(({ code, severity }) => ({ code, severity })), [{ code: 'invalid-path', severity: 'error' }]);
  }, (sources) => { sources[file] = 'export {};\n'; });
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

void test('a type-only re-export retains its republication provenance', async () => {
  await withExample(async (root) => {
    const report = await checkFeatureModuleOnDisk(config(root));
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.map(({ code }) => code), ['republication-undeclared']);
    assert.ok(!report.diagnostics.some(({ code }) => code === 'load-cycle'));
  }, (sources) => {
    const orders = 'src/features/orders/contracts/public.ts';
    sources[orders] = `export type * from '../features/pricing/contracts/public.ts';\n${sources[orders] ?? ''}`;
  });
});

void test('only declared module composition may depend on a composition contract', async () => {
  const root = await materialize({
    'src/composition/root.ts': 'import type { Capabilities } from "../features/orders/composition/orders.contracts.js";\nexport type Root = Capabilities;\n',
    'src/features/orders/composition/orders.contracts.ts': 'export interface Capabilities {}\n',
  });
  const profile: NodeCheckConfig = {
    consumerRoot: root, sourceRoots: ['src'],
    structure: { featuresRoot: 'src/features', roleDirectories: { composition: 'composition' } },
    surfaces: { compositionContract: ['src/features/orders/composition/orders.contracts.ts'] },
  };
  try {
    const accepted = await checkFeatureModuleOnDisk({ ...profile, moduleComposition: ['src/composition/root.ts'] });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.diagnostics, []);
    for (const selected of [profile, { ...profile, moduleComposition: [] }]) {
      const rejected = await checkFeatureModuleOnDisk(selected);
      assert.equal(rejected.ok, false);
      assert.deepEqual(rejected.diagnostics.map(({ code }) => code), ['composition-contract-layer']);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

void test('unresolved literal and computed references cannot become a successful run', async () => {
  const file = 'src/features/orders/application/service.ts';
  for (const [source, expectedKind, computed] of [
    ['import "./missing.js";\n', 'static', false],
    ['import "#hidden/domain";\n', 'static', false],
    ['const target = "./missing.js"; void import(target);\n', 'dynamic', true],
    ['const load = require; const target = "./missing.js"; load(target);\n', 'commonjs', true],
  ] as const) {
    await withExample(async (root) => {
      const report = await checkFeatureModuleOnDisk(config(root));
      assert.equal(report.ok, false);
      assert.deepEqual(report.diagnostics, [], 'source coverage failures are separate from kernel rule diagnostics');
      const references = computed ? report.unresolvedRuntimeReferences : report.unresolved;
      assert.deepEqual(references.map(({ from, line, kind }) => ({ from, line, kind })), [{ from: file, line: 1, kind: expectedKind }]);
      assert.match(formatNodeReport(report), computed ? /^error unresolved-runtime-reference /mu : /^error unresolved-reference /mu);
    }, sources => { sources[file] = source; });
  }
});

void test('external bare specifiers keep the documented resolver scope', async () => {
  await withExample(async root => {
    const report = await checkFeatureModuleOnDisk(config(root));
    assert.equal(report.ok, true);
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.unresolvedRuntimeReferences, []);
  }, sources => { sources['src/features/orders/adapters/external.ts'] = 'import "node:fs";\n'; });
});
