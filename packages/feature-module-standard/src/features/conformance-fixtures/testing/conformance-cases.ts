import { WARNING_CODES } from '../../feature-model/domain/model.js';
import type {
  FeatureModuleInput, ImportMode, ImportRecord, LayerRole, Republication, RepublishedSurface, SurfaceMap, UseEdge,
} from '../../feature-model/domain/model.js';
import {
  FEATURES_ROOT, MODULE_COMPOSITION, TEST_FEATURES_ROOT, exampleModule, exampleRoots, fileOf, importOf, roleDirectories,
} from './example-tree.js';

// A fixture's `input` is a kernel input; the fixtures entry point republishes the types that describe it.
export type { FeatureModuleInput, ImportMode, ImportRecord, LayerRole, Republication, RepublishedSurface, SurfaceMap, UseEdge };

/** One fixture: a complete module description and the exact diagnostic codes the kernel must report for it. */
export type ConformanceCase = Readonly<{
  id: string;
  /** Where Feature Module Standard v1.1 states the rule: a section name, with the example table or bullet it uses. */
  source: string;
  description: string;
  input: FeatureModuleInput;
  /** Sorted diagnostic codes, duplicates kept; empty when the module conforms. */
  expect: readonly string[];
  /** False only when an error code is among `expect`; a warning does not fail. */
  ok: boolean;
}>;

type Change = Readonly<{
  files?: readonly string[];
  imports?: readonly ImportRecord[];
  drop?: (record: ImportRecord) => boolean;
  input?: Partial<FeatureModuleInput>;
}>;

const warnings: ReadonlySet<string> = new Set(WARNING_CODES);
const define = (id: string, source: string, description: string, expect: readonly string[], change: Change = {}): ConformanceCase => {
  const base = exampleModule();
  const input: FeatureModuleInput = {
    ...base, ...change.input,
    files: [...base.files, ...(change.files ?? [])],
    imports: [...base.imports.filter((record) => !(change.drop?.(record) ?? false)), ...(change.imports ?? [])],
  };
  return { id, source, description, input, expect, ok: expect.every((code) => warnings.has(code)) };
};

const f = fileOf;
const ex = 'Sub-features: Examples';
const type = 'type-only';
const orders = `${FEATURES_ROOT}/orders`;
const odCoupons = 'orders/discounts/coupons';
const billingApi = `${FEATURES_ROOT}/billing/application/internal-api.ts`;
const testRoot = `${TEST_FEATURES_ROOT}/orders`;
const discountsTest = `${testRoot}/features/discounts/discount.test.ts`;
const billingKit = `${FEATURES_ROOT}/billing/application/kit.ts`;
const withApi = { files: [billingApi], input: { surfaces: { ...exampleModule().surfaces, internalApi: [billingApi] } } };

export const conformanceCases: readonly ConformanceCase[] = [
  define('module-conforms', ex, 'The example tree, wired as the standard requires, conforms.', []),
  define('upward-use', ex, 'A sub-feature uses the public entrypoint of its parent.', [], { imports: [importOf(f('orders/discounts', 'composition'), f('orders', 'public'))] }),
  define('downward-use', ex, 'A parent uses the public entrypoint of its direct sub-feature.', [], { imports: [importOf(f('orders', 'composition'), f('orders/discounts', 'public'))] }),
  define('parent-and-sub-feature-use-each-other', ex, 'The upward edge is outside the cycle graph.', [], {
    imports: [importOf(f('orders', 'composition'), f('orders/discounts', 'public')), importOf(f('orders/discounts', 'composition'), f('orders', 'public'))],
  }),
  define('grandchild-not-visible-to-ancestor', ex, 'A feature cannot use a sub-feature of its sub-feature.', ['not-visible'], { imports: [importOf(f('orders', 'composition'), f(odCoupons, 'public'))] }),
  define('lateral-use-between-siblings', ex, 'Siblings use each other through public entrypoints.', [], { imports: [importOf(f('orders/pricing', 'composition'), f('orders/discounts', 'public'))] }),
  define('lateral-cycle', ex, 'Siblings that use each other form a cycle.', ['feature-cycle'], {
    imports: [importOf(f('orders/pricing', 'composition'), f('orders/discounts', 'public')), importOf(f('orders/discounts', 'composition'), f('orders/pricing', 'public'))],
  }),
  define('deep-import', ex, 'A sibling cannot import the domain of another feature.', ['deep-import'], { imports: [importOf(f('orders/pricing', 'composition'), f('orders/discounts', 'domain'))] }),
  define('descendant-uses-top-level-feature', ex, 'A deep feature uses a top-level feature.', [], { imports: [importOf(f(odCoupons, 'composition'), f('billing', 'public'))] }),
  define('sub-feature-not-visible-outside-its-parent', ex, 'A top-level feature cannot use a sub-feature of another.', ['not-visible'], { imports: [importOf(f('billing', 'composition'), f('orders/pricing', 'public'))] }),
  define('declared-republication', ex, 'A parent republishes the public entrypoint of its direct sub-feature as declared.', [], {
    imports: [importOf(f('billing', 'composition'), f('orders', 'public')), importOf(f('orders', 'public'), f('orders/pricing', 'public'), 'runtime', true)],
    input: { republications: [{ from: 'orders', to: 'orders/pricing', surface: 'public' }] },
  }),
  define('republication-skips-a-level', ex, 'A feature cannot republish from a grandchild.', ['republication-skips-level'], {
    imports: [importOf(f('orders', 'public'), f(odCoupons, 'public'), 'runtime', true)],
    input: { republications: [{ from: 'orders', to: 'orders/pricing', surface: 'public' }] },
  }),
  define('undeclared-republication', ex, 'A republication without a declaration is rejected.', ['republication-undeclared'], { imports: [importOf(f('orders', 'public'), f('orders/pricing', 'public'), 'runtime', true)] }),
  define('republication-declared-from-a-grandchild', ex, 'A declaration must name a direct sub-feature.', ['republication-invalid'], { input: { republications: [{ from: 'orders', to: odCoupons, surface: 'public' }] } }),
  define('load-time-cycle-through-republication', ex, 'Public contracts and the parent that republishes them import each other at load time.', ['load-cycle'], {
    imports: [importOf(f('orders/discounts', 'public'), f('orders', 'public')), importOf(f('orders', 'public'), f('orders/discounts', 'public'), 'runtime', true)],
    input: { republications: [{ from: 'orders', to: 'orders/discounts', surface: 'public' }] },
  }),
  define('type-only-upward-import-is-no-load-cycle', ex, 'The same shape with a type-only upward import conforms.', [], {
    imports: [importOf(f('orders/discounts', 'public'), f('orders', 'public'), type), importOf(f('orders', 'public'), f('orders/discounts', 'public'), 'runtime', true)],
    input: { republications: [{ from: 'orders', to: 'orders/discounts', surface: 'public' }] },
  }),
  define('module-composition-cannot-wire-a-sub-feature', ex, 'Only the parent wires a sub-feature.', ['assembly-misplaced'], { imports: [importOf(MODULE_COMPOSITION, f('orders/discounts', 'group'))] }),
  define('grandparent-cannot-wire-a-grandchild', ex, 'Only the direct parent wires a sub-feature.', ['assembly-misplaced'], { imports: [importOf(f('orders', 'composition'), f(odCoupons, 'group'))] }),
  define('parent-must-wire-its-sub-feature', ex, 'A sub-feature that exposes a composition surface is wired by its parent.', ['assembly-missing'], {
    drop: (record) => record.from === f('orders/discounts', 'composition') && record.to === f(odCoupons, 'group'),
  }),
  define('sibling-of-ancestor', ex, 'A deep feature uses a sibling of its ancestor.', [], { imports: [importOf(f(odCoupons, 'composition'), f('orders/pricing', 'public'))] }),
  define('sub-feature-hidden-from-sibling-subtree', ex, 'A sibling cannot use a sub-feature of another sibling.', ['not-visible'], { imports: [importOf(f('orders/pricing', 'composition'), f(odCoupons, 'public'))] }),
  define('cycle-closed-by-an-upward-edge', ex, 'The only cycle closes through the upward edge.', [], {
    imports: [importOf(f('orders/pricing', 'composition'), f('orders/discounts', 'public')), importOf(f('orders/discounts', 'composition'), f('orders', 'public')), importOf(f('orders', 'composition'), f('orders/pricing', 'public'))],
  }),
  define('lateral-and-downward-cycle', ex, 'A cycle of lateral and downward use edges is rejected.', ['feature-cycle'], {
    imports: [importOf(f('orders/discounts', 'composition'), f('billing', 'public')), importOf(f('billing', 'composition'), f('orders', 'public')), importOf(f('orders', 'composition'), f('orders/discounts', 'public'))],
  }),
  define('type-only-cycle-counts', ex, 'Type-only references count in the feature dependency graph.', ['feature-cycle'], {
    imports: [importOf(f('orders/pricing', 'composition'), f('orders/discounts', 'public'), type), importOf(f('orders/discounts', 'composition'), f('orders/pricing', 'public'), type)],
  }),
  define('same-name-under-different-parents', ex, 'Names are unique only among the sub-features of one parent.', []),
  define('misplaced-sub-feature-test', 'Test ownership', 'Tests of a sub-feature do not live in its parent test root.', ['test-misplaced'], { input: { testFiles: [`${TEST_FEATURES_ROOT}/orders/discounts/discount.test.ts`] } }),
  define('mirrored-sub-feature-test', 'Test ownership', 'Tests of a sub-feature live in its own mirrored test root.', [], { input: { testFiles: [`${TEST_FEATURES_ROOT}/orders/features/discounts/discount.test.ts`] } }),
  define('test-of-no-feature', 'Test ownership', 'A test outside every feature test root is unowned.', ['test-unowned'], { input: { testFiles: [`${TEST_FEATURES_ROOT}/ghost/ghost.test.ts`] } }),
  define('file-in-the-container', ex, 'A source file directly in a features container is rejected.', ['container-file'], { files: [`${orders}/features/helper.ts`] }),
  define('empty-container', ex, 'An empty container is rejected.', ['container-empty'], { input: { emptyDirectories: [`${orders}/features/pricing/features`] } }),
  define('unmapped-entry', ex, 'A direct entry that is no role directory, container or mapped file is rejected.', ['entry-unmapped'], { files: [`${orders}/helpers/clock.ts`] }),
  define('mapped-file-is-allowed', ex, 'A file the profile maps directly below a feature root is allowed.', [], { files: [`${orders}/README.md`], input: { mappedFiles: ['README.md'] } }),
  define('sub-feature-root-off-the-container', ex, 'A declared sub-feature root must sit in its parent container.', ['feature-root-placement'], {
    input: { featureRoots: [...exampleRoots, `${orders}/extra/sub`] },
  }),
  define('duplicate-feature-root', ex, 'A feature root declared twice is rejected.', ['feature-duplicate'], { input: { featureRoots: [...exampleRoots, orders] } }),
  define('undeclared-feature-directory', ex, 'A directory of the container that no profile declares is rejected.', ['feature-undeclared'], {
    files: [`${orders}/features/ghost/domain/x.ts`], input: { featureRoots: exampleRoots },
  }),
  define('composition-uses-a-visible-composition-contract', ex, 'Feature composition uses the composition contract of a visible feature.', [], { imports: [importOf(f('billing', 'composition'), f('orders', 'contract'))] }),
  define('application-cannot-use-a-composition-contract', ex, 'Only composition code depends on a composition contract.', ['composition-contract-layer'], { imports: [importOf(f('billing', 'application'), f('orders', 'contract'))] }),
  define('domain-cannot-use-its-own-composition-contract', 'Composition contracts', 'No inner code depends on a composition contract, its own feature included.', ['composition-contract-layer'], { imports: [importOf(f('orders', 'domain'), f('orders', 'contract'))] }),
  define('sub-feature-composition-uses-parent-contract', ex, 'A sub-feature composition uses the composition contract of its parent.', [], { imports: [importOf(f('orders/discounts', 'composition'), f('orders', 'contract'))] }),
  define('module-composition-cannot-use-a-hidden-composition-contract', ex, 'Module composition reaches a sub-feature only through what its parent republishes.', ['not-visible'], { imports: [importOf(MODULE_COMPOSITION, f('orders/discounts', 'contract'))] }),
  define('composition-contract-of-an-invisible-feature', 'Composition contracts', 'A composition contract of a feature that is not visible is rejected.', ['not-visible'], { imports: [importOf(f('orders/pricing', 'composition'), f(odCoupons, 'contract'))] }),
  define('declared-composition-contract-republication', ex, 'A parent republishes the composition contract of its direct sub-feature as declared.', [], {
    imports: [importOf(f('orders', 'contract'), f('orders/discounts', 'contract'), 'runtime', true)],
    input: { republications: [{ from: 'orders', to: 'orders/discounts', surface: 'composition-contract' }] },
  }),
  define('domain-cannot-import-contracts', 'Aggregate and internal-feature ownership', 'Domain code never imports contracts, its own included.', ['layer-direction'], { imports: [importOf(f('orders', 'domain'), f('orders', 'public'))] }),
  define('application-uses-an-internal-api', 'Aggregate and internal-feature ownership', 'Application code uses the curated internal API of another feature.', [], { ...withApi, imports: [importOf(f('orders', 'application'), billingApi)] }),
  define('domain-cannot-use-an-application-internal-api', 'Aggregate and internal-feature ownership', 'Domain code uses only the domain internal API of another feature.', ['layer-direction'], { ...withApi, imports: [importOf(f('orders', 'domain'), billingApi)] }),
  define('adapters-reach-siblings-through-the-core', 'Aggregate and internal-feature ownership', 'An adapter does not import another feature directly.', ['layer-direction'], {
    files: [`${FEATURES_ROOT}/billing/adapters/gateway.ts`], imports: [importOf(`${FEATURES_ROOT}/billing/adapters/gateway.ts`, f('orders', 'public'))],
  }),
  define('undeclared-use-edge', 'Sub-features: Edges', 'With a declared feature graph, an undeclared use edge is rejected.', ['use-undeclared'], {
    imports: [importOf(f('orders', 'composition'), f('orders/discounts', 'public'))], input: { useEdges: [] },
  }),
  define('declared-use-edge', 'Sub-features: Edges', 'A declared use edge is accepted.', [], {
    imports: [importOf(f('orders', 'composition'), f('orders/discounts', 'public'))], input: { useEdges: [{ from: 'orders', to: 'orders/discounts' }] },
  }),
  define('declared-graph-cycle', 'Sub-features: Dependency graph and cycles', 'A cycle in the declared graph is rejected before any import exists.', ['feature-cycle'], {
    input: { useEdges: [{ from: 'orders/pricing', to: 'orders/discounts' }, { from: 'orders/discounts', to: 'orders/pricing' }] },
  }),
  define('surface-without-a-feature', 'Sub-features: Visibility', 'A surface file that belongs to no feature is rejected.', ['surface-unowned'], {
    input: { surfaces: { ...exampleModule().surfaces, public: [...(exampleModule().surfaces?.public ?? []), MODULE_COMPOSITION] } },
  }),
  define('depth-warning', ex, 'A feature past the declared depth is a warning, not a failure.', ['depth-warning'], { input: { depthWarning: 2 } }),
  define('composition-contract-outside-composition', 'Composition contracts', 'A composition contract is composition code of its feature.', ['composition-contract-misplaced'], {
    files: [`${orders}/application/wiring.ts`],
    input: { surfaces: { ...exampleModule().surfaces, compositionContract: [...(exampleModule().surfaces?.compositionContract ?? []), `${orders}/application/wiring.ts`] } },
  }),
  define('republication-of-another-surface', 'Growth guardrails 13', 'A republication re-exports the same surface of its parent, not the other one.', ['republication-mismatch'], {
    imports: [importOf(f('orders', 'public'), f('orders/pricing', 'contract'), 'runtime', true)],
  }),
  define('test-uses-the-internals-of-its-own-feature', 'Test ownership', 'A test of a sub-feature uses its own domain.', [], {
    input: { testFiles: [discountsTest] }, imports: [importOf(discountsTest, f('orders/discounts', 'domain'))],
  }),
  define('test-of-the-parent-uses-a-sub-feature-domain', 'Test ownership', 'A test in the test root of orders may not use the internals of orders/discounts.', ['deep-import'], {
    input: { testFiles: [`${testRoot}/orders.test.ts`] }, imports: [importOf(`${testRoot}/orders.test.ts`, f('orders/discounts', 'domain'))],
  }),
  define('test-uses-a-visible-sibling-entrypoint', 'Test ownership', 'A test of a sub-feature uses the public entrypoint of a visible sibling.', [], {
    input: { testFiles: [discountsTest] }, imports: [importOf(discountsTest, f('orders/pricing', 'public'))],
  }),
  define('test-of-another-feature-cannot-see-a-sub-feature', 'Test ownership', 'A test of billing may not use a sub-feature of orders.', ['not-visible'], {
    input: { testFiles: [`${TEST_FEATURES_ROOT}/billing/billing.test.ts`] },
    imports: [importOf(`${TEST_FEATURES_ROOT}/billing/billing.test.ts`, f('orders/pricing', 'public'))],
  }),
  define('test-uses-a-testing-surface', 'Test ownership', 'Test code uses the testing surface of a visible feature.', [], {
    files: [billingKit], input: { testFiles: [discountsTest], surfaces: { ...exampleModule().surfaces, testing: [billingKit] } },
    imports: [importOf(discountsTest, billingKit)],
  }),
  {
    id: 'v1-features-directory-keeps-its-meaning', source: 'Sub-features: introduction', ok: true, expect: [],
    description: 'Without a declared sub-feature, a directory named features inside a feature keeps its v1 meaning.',
    input: {
      featuresRoot: FEATURES_ROOT, roleDirectories, imports: [],
      files: [`${FEATURES_ROOT}/legacy/domain/model.ts`, `${FEATURES_ROOT}/legacy/features/helper.ts`],
    },
  },
  define('lateral-reexport-is-no-republication', 'Growth guardrails 13', 'A sibling cannot republish the contracts of another sibling.', ['republication-not-sub-feature'], {
    imports: [importOf(f('orders/pricing', 'public'), f('orders/discounts', 'public'), 'runtime', true)],
  }),
  define('upward-reexport-is-no-republication', 'Growth guardrails 13', 'A sub-feature cannot republish the contracts of its parent.', ['republication-not-sub-feature'], {
    imports: [importOf(f('orders/discounts', 'public'), f('orders', 'public'), 'runtime', true)],
  }),
  define('leaking-republication-chain', 'Growth guardrails 13', 'A sibling re-export cannot be laundered through a declared republication.', ['republication-not-sub-feature'], {
    imports: [
      importOf(f('orders/pricing', 'public'), f('orders/discounts', 'public'), 'runtime', true),
      importOf(f('orders', 'public'), f('orders/pricing', 'public'), 'runtime', true),
      importOf(f('billing', 'composition'), f('orders', 'public')),
    ],
    input: { republications: [{ from: 'orders', to: 'orders/pricing', surface: 'public' }] },
  }),
  define('colocated-test-uses-its-own-internals', 'Test ownership', 'A test beside its source belongs to the deepest feature and may use its internals.', [], {
    input: { testFiles: [`${orders}/domain/model.test.ts`] }, imports: [importOf(`${orders}/domain/model.test.ts`, f('orders', 'domain'))],
  }),
  define('colocated-test-uses-a-sub-feature-domain', 'Test ownership', 'A colocated test of a parent may not use the internals of its sub-feature.', ['deep-import'], {
    input: { testFiles: [`${orders}/domain/model.test.ts`] }, imports: [importOf(`${orders}/domain/model.test.ts`, f('orders/discounts', 'domain'))],
  }),
  define('application-cannot-wire-a-top-level-composition-surface', 'Sub-features: Assembly', 'Only composition code wires a composition surface.', ['deep-import'], {
    imports: [importOf(f('billing', 'application'), f('orders', 'group'))],
  }),
  define('declared-use-edge-of-an-unknown-feature', 'Sub-features: Edges', 'A declared use edge names a feature that does not exist.', ['use-edge-invalid'], {
    input: { useEdges: [{ from: 'ghost', to: 'orders' }] },
  }),
  define('declared-use-edge-to-an-invisible-feature', 'Sub-features: Visibility', 'A declared use edge cannot target a feature that is not visible.', ['not-visible'], {
    input: { useEdges: [{ from: 'billing', to: 'orders/pricing' }] },
  }),
  define('type-only-import-does-not-wire', 'Sub-features: Assembly', 'A parent that only references the composition surface by type has not wired it.', ['assembly-missing'], {
    drop: (record) => record.from === f('orders/discounts', 'composition') && record.to === f(odCoupons, 'group'),
    imports: [importOf(f('orders/discounts', 'composition'), f(odCoupons, 'group'), type)],
  }),
  define('path-outside-the-repository', 'Sub-features: Placement and layout', 'A path that escapes the repository is reported and never trusted.', ['invalid-path'], { files: ['../outside.ts'] }),
];
