import type { ConformanceCase } from "./conformance-case-inputs.js";
import {
  define,
  f,
  ex,
  type,
  orders,
  odCoupons,
  billingApi,
  testRoot,
  discountsTest,
  billingKit,
  reportsApi,
  reportsAdapter,
  billingApi2,
  v1Files,
  profileCase,
  withApi,
  FEATURES_ROOT,
  MODULE_COMPOSITION,
  TEST_FEATURES_ROOT,
  exampleModule,
  importOf,
  roleDirectories,
  inferDirectoryLayout,
} from "./conformance-case-inputs.js";
export const laterConformanceCases: readonly ConformanceCase[] = [
  define(
    "application-uses-an-internal-api",
    "Aggregate and internal-feature ownership",
    "Application code uses the curated internal API of another feature.",
    [],
    { ...withApi, imports: [importOf(f("orders", "application"), billingApi)] },
  ),
  define(
    "domain-cannot-use-an-application-internal-api",
    "Aggregate and internal-feature ownership",
    "Domain code uses only the domain internal API of another feature.",
    ["layer-direction"],
    { ...withApi, imports: [importOf(f("orders", "domain"), billingApi)] },
  ),
  define(
    "adapters-reach-siblings-through-the-core",
    "Aggregate and internal-feature ownership",
    "An adapter does not import another feature directly.",
    ["layer-direction"],
    {
      files: [`${FEATURES_ROOT}/billing/adapters/gateway.ts`],
      imports: [importOf(`${FEATURES_ROOT}/billing/adapters/gateway.ts`, f("orders", "public"))],
    },
  ),
  define(
    "undeclared-use-edge",
    "Sub-features: Edges",
    "With a declared feature graph, an undeclared use edge is rejected.",
    ["use-undeclared"],
    {
      imports: [importOf(f("orders", "composition"), f("orders/discounts", "public"))],
      input: { useEdges: [] },
    },
  ),
  define("declared-use-edge", "Sub-features: Edges", "A declared use edge is accepted.", [], {
    imports: [importOf(f("orders", "composition"), f("orders/discounts", "public"))],
    input: { useEdges: [{ from: "orders", to: "orders/discounts" }] },
  }),
  define(
    "declared-graph-cycle",
    "Sub-features: Dependency graph and cycles",
    "A cycle in the declared graph is rejected before any import exists.",
    ["feature-cycle"],
    {
      input: {
        useEdges: [
          { from: "orders/pricing", to: "orders/discounts" },
          { from: "orders/discounts", to: "orders/pricing" },
        ],
      },
    },
  ),
  define(
    "surface-without-a-feature",
    "Sub-features: Visibility",
    "A surface file that belongs to no feature is rejected.",
    ["surface-unowned"],
    {
      input: {
        surfaces: {
          ...exampleModule().surfaces,
          public: [...(exampleModule().surfaces?.public ?? []), MODULE_COMPOSITION],
        },
      },
    },
  ),
  define(
    "depth-warning",
    ex,
    "A feature past the declared depth is a warning, not a failure.",
    ["depth-warning"],
    { input: { depthWarning: 2 } },
  ),
  define(
    "composition-contract-outside-composition",
    "Composition contracts",
    "A composition contract is composition code of its feature.",
    ["composition-contract-misplaced"],
    {
      files: [`${orders}/application/wiring.ts`],
      input: {
        surfaces: {
          ...exampleModule().surfaces,
          compositionContract: [
            ...(exampleModule().surfaces?.compositionContract ?? []),
            `${orders}/application/wiring.ts`,
          ],
        },
      },
    },
  ),
  define(
    "republication-of-another-surface",
    "Growth guardrails 13",
    "A republication re-exports the same surface of its parent, not the other one.",
    ["republication-mismatch"],
    {
      imports: [importOf(f("orders", "public"), f("orders/pricing", "contract"), "runtime", true)],
    },
  ),
  define(
    "test-uses-the-internals-of-its-own-feature",
    "Test ownership",
    "A test of a sub-feature uses its own domain.",
    [],
    {
      input: { testFiles: [discountsTest] },
      imports: [importOf(discountsTest, f("orders/discounts", "domain"))],
    },
  ),
  define(
    "test-of-the-parent-uses-a-sub-feature-domain",
    "Test ownership",
    "A test in the test root of orders may not use the internals of orders/discounts.",
    ["deep-import"],
    {
      input: { testFiles: [`${testRoot}/orders.test.ts`] },
      imports: [importOf(`${testRoot}/orders.test.ts`, f("orders/discounts", "domain"))],
    },
  ),
  define(
    "test-uses-a-visible-sibling-entrypoint",
    "Test ownership",
    "A test of a sub-feature uses the public entrypoint of a visible sibling.",
    [],
    {
      input: { testFiles: [discountsTest] },
      imports: [importOf(discountsTest, f("orders/pricing", "public"))],
    },
  ),
  define(
    "test-of-another-feature-cannot-see-a-sub-feature",
    "Test ownership",
    "A test of billing may not use a sub-feature of orders.",
    ["not-visible"],
    {
      input: { testFiles: [`${TEST_FEATURES_ROOT}/billing/billing.test.ts`] },
      imports: [
        importOf(`${TEST_FEATURES_ROOT}/billing/billing.test.ts`, f("orders/pricing", "public")),
      ],
    },
  ),
  define(
    "test-uses-a-testing-surface",
    "Test ownership",
    "Test code uses the testing surface of a visible feature.",
    [],
    {
      files: [billingKit],
      input: {
        testFiles: [discountsTest],
        surfaces: { ...exampleModule().surfaces, testing: [billingKit] },
      },
      imports: [importOf(discountsTest, billingKit)],
    },
  ),
  define(
    "cycle-through-a-deep-import",
    "Sub-features: Dependency graph and cycles",
    "A deep import is rejected and still closes a cycle.",
    ["deep-import", "feature-cycle"],
    {
      imports: [
        importOf(f("orders/pricing", "composition"), f("orders/discounts", "domain")),
        importOf(f("orders/discounts", "composition"), f("orders/pricing", "public")),
      ],
    },
  ),
  define(
    "contracts-cannot-use-a-composition-contract",
    "Composition contracts",
    "Code of the contracts role never depends on a composition contract.",
    ["composition-contract-layer"],
    {
      imports: [importOf(f("billing", "public"), f("orders", "contract"))],
    },
  ),
  define(
    "adapters-cannot-use-a-composition-contract",
    "Composition contracts",
    "Code of the adapters role never depends on a composition contract.",
    ["composition-contract-layer"],
    {
      files: [`${FEATURES_ROOT}/billing/adapters/gateway.ts`],
      imports: [importOf(`${FEATURES_ROOT}/billing/adapters/gateway.ts`, f("orders", "contract"))],
    },
  ),
  define(
    "module-code-outside-composition-cannot-use-a-composition-contract",
    "Composition contracts",
    "Only module-level composition may depend on a composition contract.",
    ["composition-contract-layer"],
    {
      files: ["src/other.ts"],
      imports: [importOf("src/other.ts", f("orders", "contract"))],
    },
  ),
  define(
    "module-code-outside-composition-cannot-wire-a-composition-surface",
    "Sub-features: Assembly",
    "Only module-level composition wires the composition surface of a top-level feature.",
    ["deep-import"],
    {
      files: ["src/other.ts"],
      imports: [importOf("src/other.ts", f("billing", "group"))],
    },
  ),
  define(
    "module-composition-uses-a-top-level-composition-contract",
    "Composition contracts",
    "Module composition depends on the composition contract of a top-level feature.",
    [],
    {
      imports: [importOf(MODULE_COMPOSITION, f("orders", "contract"))],
    },
  ),
  define(
    "module-code-is-not-composition-unless-listed",
    "Composition contracts",
    "Without a listed module composition, module-level code may not depend on a composition contract or wire a composition surface.",
    ["composition-contract-layer", "deep-import", "deep-import"],
    {
      input: { moduleComposition: [] },
      imports: [importOf(MODULE_COMPOSITION, f("orders", "contract"))],
    },
  ),
  {
    id: "absent-module-composition-rejects",
    source: "Composition contracts",
    ok: false,
    description: "Without any moduleComposition, module-level code is not composition.",
    expect: ["composition-contract-layer", "deep-import", "deep-import"],
    input: {
      ...exampleModule(false),
      imports: [...exampleModule().imports, importOf(MODULE_COMPOSITION, f("orders", "contract"))],
    },
  },
  define(
    "lateral-reexport-is-no-republication",
    "Growth guardrails 13",
    "A sibling cannot republish the contracts of another sibling.",
    ["republication-not-sub-feature"],
    {
      imports: [
        importOf(f("orders/pricing", "public"), f("orders/discounts", "public"), "runtime", true),
      ],
    },
  ),
  define(
    "upward-reexport-is-no-republication",
    "Growth guardrails 13",
    "A sub-feature cannot republish the contracts of its parent.",
    ["republication-not-sub-feature"],
    {
      imports: [importOf(f("orders/discounts", "public"), f("orders", "public"), "runtime", true)],
    },
  ),
  define(
    "leaking-republication-chain",
    "Growth guardrails 13",
    "A sibling re-export cannot be laundered through a declared republication.",
    ["republication-not-sub-feature"],
    {
      imports: [
        importOf(f("orders/pricing", "public"), f("orders/discounts", "public"), "runtime", true),
        importOf(f("orders", "public"), f("orders/pricing", "public"), "runtime", true),
        importOf(f("billing", "composition"), f("orders", "public")),
      ],
      input: { republications: [{ from: "orders", to: "orders/pricing", surface: "public" }] },
    },
  ),
  define(
    "colocated-test-uses-its-own-internals",
    "Test ownership",
    "A test beside its source belongs to the deepest feature and may use its internals.",
    [],
    {
      input: { testFiles: [`${orders}/domain/model.test.ts`] },
      imports: [importOf(`${orders}/domain/model.test.ts`, f("orders", "domain"))],
    },
  ),
  define(
    "colocated-test-uses-a-sub-feature-domain",
    "Test ownership",
    "A colocated test of a parent may not use the internals of its sub-feature.",
    ["deep-import"],
    {
      input: { testFiles: [`${orders}/domain/model.test.ts`] },
      imports: [importOf(`${orders}/domain/model.test.ts`, f("orders/discounts", "domain"))],
    },
  ),
  define(
    "application-cannot-wire-a-top-level-composition-surface",
    "Sub-features: Assembly",
    "Only composition code wires a composition surface.",
    ["deep-import"],
    {
      imports: [importOf(f("billing", "application"), f("orders", "group"))],
    },
  ),
  define(
    "declared-use-edge-of-an-unknown-feature",
    "Sub-features: Edges",
    "A declared use edge names a feature that does not exist.",
    ["use-edge-invalid"],
    {
      input: { useEdges: [{ from: "ghost", to: "orders" }] },
    },
  ),
  define(
    "declared-use-edge-to-an-invisible-feature",
    "Sub-features: Visibility",
    "A declared use edge cannot target a feature that is not visible.",
    ["not-visible"],
    {
      input: { useEdges: [{ from: "billing", to: "orders/pricing" }] },
    },
  ),
  define(
    "type-only-import-does-not-wire",
    "Sub-features: Assembly",
    "A parent that only references the composition surface by type has not wired it.",
    ["assembly-missing"],
    {
      drop: (record) =>
        record.from === f("orders/discounts", "composition") && record.to === f(odCoupons, "group"),
      imports: [importOf(f("orders/discounts", "composition"), f(odCoupons, "group"), type)],
    },
  ),
  define(
    "path-outside-the-repository",
    "Sub-features: Placement and layout",
    "A path that escapes the repository is reported and never trusted.",
    ["invalid-path"],
    { files: ["../outside.ts"] },
  ),
  {
    id: "v1-features-directory-keeps-its-meaning",
    source: "Sub-features: introduction",
    ok: true,
    expect: [],
    description:
      "Without a declared sub-feature, a directory named features inside a feature keeps its v1 meaning.",
    input: {
      imports: [],
      files: v1Files,
      ...inferDirectoryLayout({ featuresRoot: FEATURES_ROOT, files: v1Files, roleDirectories }),
    },
  },
  profileCase(
    "profile-mapped-layout-conforms",
    [],
    [importOf(billingApi2, reportsApi)],
    "Roles mapped to files and to a directory with another name, in two feature roots, conform.",
  ),
  profileCase(
    "v1-reexport-is-an-ordinary-use",
    [],
    [{ ...importOf(billingApi2, reportsApi, "runtime", true) }],
    "Republication is a rule of modules with sub-features; in any other module a re-export is a use.",
  ),
  profileCase(
    "profile-mapped-adapter-direction",
    ["layer-direction"],
    [importOf(reportsAdapter, billingApi2)],
    "An adapter in a feature directory still reaches siblings only through its application core.",
  ),
  profileCase(
    "profile-mapped-deep-import",
    ["deep-import", "layer-direction"],
    [importOf(billingApi2, reportsAdapter)],
    "A file mapped to a role is not a public entrypoint unless the profile says so.",
  ),
  profileCase(
    "profile-mapped-cycle",
    ["feature-cycle", "load-cycle"],
    [importOf(billingApi2, reportsApi), importOf(reportsApi, billingApi2)],
    "Features under different roots form a cycle like any others.",
  ),
];
