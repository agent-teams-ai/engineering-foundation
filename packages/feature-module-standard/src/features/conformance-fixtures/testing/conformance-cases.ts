import type { ConformanceCase } from "./conformance-case-inputs.js";
import {
  define,
  f,
  ex,
  type,
  orders,
  odCoupons,
  MODULE_COMPOSITION,
  TEST_FEATURES_ROOT,
  exampleRoots,
  importOf,
} from "./conformance-case-inputs.js";
import { laterConformanceCases } from "./conformance-cases-later.js";
export { ERROR_CODES, WARNING_CODES } from "./conformance-case-inputs.js";
export type {
  ConformanceCase,
  DiagnosticCode,
  FeatureModuleInput,
  ImportMode,
  ImportRecord,
  LayerRole,
  Republication,
  RepublishedSurface,
  RoleRoot,
  SurfaceMap,
  UseEdge,
} from "./conformance-case-inputs.js";
export const conformanceCases: readonly ConformanceCase[] = [
  define("module-conforms", ex, "The example tree, wired as the standard requires, conforms.", []),
  define("upward-use", ex, "A sub-feature uses the public entrypoint of its parent.", [], {
    imports: [importOf(f("orders/discounts", "composition"), f("orders", "public"))],
  }),
  define("downward-use", ex, "A parent uses the public entrypoint of its direct sub-feature.", [], {
    imports: [importOf(f("orders", "composition"), f("orders/discounts", "public"))],
  }),
  define(
    "parent-and-sub-feature-use-each-other",
    ex,
    "The upward edge is outside the cycle graph.",
    [],
    {
      imports: [
        importOf(f("orders", "composition"), f("orders/discounts", "public")),
        importOf(f("orders/discounts", "composition"), f("orders", "public")),
      ],
    },
  ),
  define(
    "grandchild-not-visible-to-ancestor",
    ex,
    "A feature cannot use a sub-feature of its sub-feature.",
    ["not-visible"],
    { imports: [importOf(f("orders", "composition"), f(odCoupons, "public"))] },
  ),
  define(
    "lateral-use-between-siblings",
    ex,
    "Siblings use each other through public entrypoints.",
    [],
    { imports: [importOf(f("orders/pricing", "composition"), f("orders/discounts", "public"))] },
  ),
  define("lateral-cycle", ex, "Siblings that use each other form a cycle.", ["feature-cycle"], {
    imports: [
      importOf(f("orders/pricing", "composition"), f("orders/discounts", "public")),
      importOf(f("orders/discounts", "composition"), f("orders/pricing", "public")),
    ],
  }),
  define(
    "deep-import",
    ex,
    "A sibling cannot import the domain of another feature.",
    ["deep-import"],
    { imports: [importOf(f("orders/pricing", "composition"), f("orders/discounts", "domain"))] },
  ),
  define("descendant-uses-top-level-feature", ex, "A deep feature uses a top-level feature.", [], {
    imports: [importOf(f(odCoupons, "composition"), f("billing", "public"))],
  }),
  define(
    "sub-feature-not-visible-outside-its-parent",
    ex,
    "A top-level feature cannot use a sub-feature of another.",
    ["not-visible"],
    { imports: [importOf(f("billing", "composition"), f("orders/pricing", "public"))] },
  ),
  define(
    "declared-republication",
    ex,
    "A parent republishes the public entrypoint of its direct sub-feature as declared.",
    [],
    {
      imports: [
        importOf(f("billing", "composition"), f("orders", "public")),
        importOf(f("orders", "public"), f("orders/pricing", "public"), "runtime", true),
      ],
      input: { republications: [{ from: "orders", to: "orders/pricing", surface: "public" }] },
    },
  ),
  define(
    "republication-skips-a-level",
    ex,
    "A feature cannot republish from a grandchild.",
    ["republication-skips-level"],
    {
      imports: [importOf(f("orders", "public"), f(odCoupons, "public"), "runtime", true)],
      input: { republications: [{ from: "orders", to: "orders/pricing", surface: "public" }] },
    },
  ),
  define(
    "undeclared-republication",
    ex,
    "A republication without a declaration is rejected.",
    ["republication-undeclared"],
    { imports: [importOf(f("orders", "public"), f("orders/pricing", "public"), "runtime", true)] },
  ),
  define(
    "republication-declared-from-a-grandchild",
    ex,
    "A declaration must name a direct sub-feature.",
    ["republication-invalid"],
    { input: { republications: [{ from: "orders", to: odCoupons, surface: "public" }] } },
  ),
  define(
    "load-time-cycle-through-republication",
    ex,
    "Public contracts and the parent that republishes them import each other at load time.",
    ["load-cycle"],
    {
      imports: [
        importOf(f("orders/discounts", "public"), f("orders", "public")),
        importOf(f("orders", "public"), f("orders/discounts", "public"), "runtime", true),
      ],
      input: { republications: [{ from: "orders", to: "orders/discounts", surface: "public" }] },
    },
  ),
  define(
    "type-only-upward-import-is-no-load-cycle",
    ex,
    "The same shape with a type-only upward import conforms.",
    [],
    {
      imports: [
        importOf(f("orders/discounts", "public"), f("orders", "public"), type),
        importOf(f("orders", "public"), f("orders/discounts", "public"), "runtime", true),
      ],
      input: { republications: [{ from: "orders", to: "orders/discounts", surface: "public" }] },
    },
  ),
  define(
    "module-composition-cannot-wire-a-sub-feature",
    ex,
    "Only the parent wires a sub-feature.",
    ["assembly-misplaced"],
    { imports: [importOf(MODULE_COMPOSITION, f("orders/discounts", "group"))] },
  ),
  define(
    "grandparent-cannot-wire-a-grandchild",
    ex,
    "Only the direct parent wires a sub-feature.",
    ["assembly-misplaced"],
    { imports: [importOf(f("orders", "composition"), f(odCoupons, "group"))] },
  ),
  define(
    "parent-must-wire-its-sub-feature",
    ex,
    "A sub-feature that exposes a composition surface is wired by its parent.",
    ["assembly-missing"],
    {
      drop: (record) =>
        record.from === f("orders/discounts", "composition") && record.to === f(odCoupons, "group"),
    },
  ),
  define("sibling-of-ancestor", ex, "A deep feature uses a sibling of its ancestor.", [], {
    imports: [importOf(f(odCoupons, "composition"), f("orders/pricing", "public"))],
  }),
  define(
    "sub-feature-hidden-from-sibling-subtree",
    ex,
    "A sibling cannot use a sub-feature of another sibling.",
    ["not-visible"],
    { imports: [importOf(f("orders/pricing", "composition"), f(odCoupons, "public"))] },
  ),
  define(
    "cycle-closed-by-an-upward-edge",
    ex,
    "The only cycle closes through the upward edge.",
    [],
    {
      imports: [
        importOf(f("orders/pricing", "composition"), f("orders/discounts", "public")),
        importOf(f("orders/discounts", "composition"), f("orders", "public")),
        importOf(f("orders", "composition"), f("orders/pricing", "public")),
      ],
    },
  ),
  define(
    "lateral-and-downward-cycle",
    ex,
    "A cycle of lateral and downward use edges is rejected.",
    ["feature-cycle"],
    {
      imports: [
        importOf(f("orders/discounts", "composition"), f("billing", "public")),
        importOf(f("billing", "composition"), f("orders", "public")),
        importOf(f("orders", "composition"), f("orders/discounts", "public")),
      ],
    },
  ),
  define(
    "type-only-cycle-counts",
    ex,
    "Type-only references count in the feature dependency graph.",
    ["feature-cycle"],
    {
      imports: [
        importOf(f("orders/pricing", "composition"), f("orders/discounts", "public"), type),
        importOf(f("orders/discounts", "composition"), f("orders/pricing", "public"), type),
      ],
    },
  ),
  define(
    "same-name-under-different-parents",
    ex,
    "Names are unique only among the sub-features of one parent.",
    [],
  ),
  define(
    "misplaced-sub-feature-test",
    "Test ownership",
    "Tests of a sub-feature do not live in its parent test root.",
    ["test-misplaced"],
    { input: { testFiles: [`${TEST_FEATURES_ROOT}/orders/discounts/discount.test.ts`] } },
  ),
  define(
    "mirrored-sub-feature-test",
    "Test ownership",
    "Tests of a sub-feature live in its own mirrored test root.",
    [],
    { input: { testFiles: [`${TEST_FEATURES_ROOT}/orders/features/discounts/discount.test.ts`] } },
  ),
  define(
    "test-of-no-feature",
    "Test ownership",
    "A test outside every feature test root is unowned.",
    ["test-unowned"],
    { input: { testFiles: [`${TEST_FEATURES_ROOT}/ghost/ghost.test.ts`] } },
  ),
  define(
    "file-in-the-container",
    ex,
    "A source file directly in a features container is rejected.",
    ["container-file"],
    { files: [`${orders}/features/helper.ts`] },
  ),
  define("empty-container", ex, "An empty container is rejected.", ["container-empty"], {
    input: { emptyDirectories: [`${orders}/features/pricing/features`] },
  }),
  define(
    "unmapped-entry",
    ex,
    "A direct entry that is no role directory, container or mapped file is rejected.",
    ["entry-unmapped"],
    { files: [`${orders}/helpers/clock.ts`] },
  ),
  define(
    "mapped-file-is-allowed",
    ex,
    "A file the profile maps directly below a feature root is allowed.",
    [],
    { files: [`${orders}/README.md`], input: { mappedFiles: ["README.md"] } },
  ),
  define(
    "sub-feature-root-off-the-container",
    ex,
    "A declared sub-feature root must sit in its parent container.",
    ["feature-root-placement"],
    {
      input: { featureRoots: [...exampleRoots, `${orders}/extra/sub`] },
    },
  ),
  define(
    "duplicate-feature-root",
    ex,
    "A feature root declared twice is rejected.",
    ["feature-duplicate"],
    { input: { featureRoots: [...exampleRoots, orders] } },
  ),
  define(
    "undeclared-feature-directory",
    ex,
    "A directory of the container that no profile declares is rejected.",
    ["feature-undeclared"],
    {
      files: [`${orders}/features/ghost/domain/x.ts`],
      input: { featureRoots: exampleRoots },
    },
  ),
  define(
    "composition-uses-a-visible-composition-contract",
    ex,
    "Feature composition uses the composition contract of a visible feature.",
    [],
    { imports: [importOf(f("billing", "composition"), f("orders", "contract"))] },
  ),
  define(
    "application-cannot-use-a-composition-contract",
    ex,
    "Only composition code depends on a composition contract.",
    ["composition-contract-layer"],
    { imports: [importOf(f("billing", "application"), f("orders", "contract"))] },
  ),
  define(
    "domain-cannot-use-its-own-composition-contract",
    "Composition contracts",
    "No inner code depends on a composition contract, its own feature included.",
    ["composition-contract-layer"],
    { imports: [importOf(f("orders", "domain"), f("orders", "contract"))] },
  ),
  define(
    "sub-feature-composition-uses-parent-contract",
    ex,
    "A sub-feature composition uses the composition contract of its parent.",
    [],
    { imports: [importOf(f("orders/discounts", "composition"), f("orders", "contract"))] },
  ),
  define(
    "module-composition-cannot-use-a-hidden-composition-contract",
    ex,
    "Module composition reaches a sub-feature only through what its parent republishes.",
    ["not-visible"],
    { imports: [importOf(MODULE_COMPOSITION, f("orders/discounts", "contract"))] },
  ),
  define(
    "composition-contract-of-an-invisible-feature",
    "Composition contracts",
    "A composition contract of a feature that is not visible is rejected.",
    ["not-visible"],
    { imports: [importOf(f("orders/pricing", "composition"), f(odCoupons, "contract"))] },
  ),
  define(
    "declared-composition-contract-republication",
    ex,
    "A parent republishes the composition contract of its direct sub-feature as declared.",
    [],
    {
      imports: [
        importOf(f("orders", "contract"), f("orders/discounts", "contract"), "runtime", true),
      ],
      input: {
        republications: [
          { from: "orders", to: "orders/discounts", surface: "composition-contract" },
        ],
      },
    },
  ),
  define(
    "domain-cannot-import-contracts",
    "Aggregate and internal-feature ownership",
    "Domain code never imports contracts, its own included.",
    ["layer-direction"],
    { imports: [importOf(f("orders", "domain"), f("orders", "public"))] },
  ),
  ...laterConformanceCases,
];
