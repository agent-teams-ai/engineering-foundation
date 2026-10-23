import { inferDirectoryLayout } from "../../feature-layout/application/infer-directory-layout.js";
import { ERROR_CODES, WARNING_CODES } from "../../feature-model/domain/model.js";
import type {
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
} from "../../feature-model/domain/model.js";
import {
  FEATURES_ROOT,
  MODULE_COMPOSITION,
  TEST_FEATURES_ROOT,
  exampleModule,
  exampleRoots,
  fileOf,
  importOf,
  roleDirectories,
} from "./example-tree.js";

export { ERROR_CODES, WARNING_CODES };
// A fixture's `input` is a kernel input; the fixtures entry point republishes the types that describe it.
export type {
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
};

/** One fixture: a complete module description and the exact diagnostic codes the kernel must report for it. */
export type ConformanceCase = Readonly<{
  id: string;
  /** Where Feature Module Standard v1.1 states the rule: a section name, with the example table or bullet it uses. */
  source: string;
  description: string;
  input: FeatureModuleInput;
  /** Sorted diagnostic codes, duplicates kept; empty when the module conforms. */
  expect: readonly DiagnosticCode[];
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
export const define = (
  id: string,
  source: string,
  description: string,
  expect: readonly DiagnosticCode[],
  change: Change = {},
): ConformanceCase => {
  const base = exampleModule();
  const input: FeatureModuleInput = {
    ...base,
    ...change.input,
    files: [...base.files, ...(change.files ?? [])],
    imports: [
      ...base.imports.filter((record) => !(change.drop?.(record) ?? false)),
      ...(change.imports ?? []),
    ],
  };
  return { id, source, description, input, expect, ok: expect.every((code) => warnings.has(code)) };
};

export const f = fileOf;
export const ex = "Sub-features: Examples";
export const type = "type-only";
export const orders = `${FEATURES_ROOT}/orders`;
export const odCoupons = "orders/discounts/coupons";
export const billingApi = `${FEATURES_ROOT}/billing/application/internal-api.ts`;
export const testRoot = `${TEST_FEATURES_ROOT}/orders`;
export const discountsTest = `${testRoot}/features/discounts/discount.test.ts`;
export const billingKit = `${FEATURES_ROOT}/billing/application/kit.ts`;
// A repository whose layout is not the default declares its roots and role mapping itself.
const reports = "src/capabilities/reports";
const billing2 = "src/features/billing";
export const reportsApi = `${reports}/api.ts`;
export const reportsAdapter = `${reports}/adapters/store.ts`;
export const billingApi2 = `${billing2}/api.ts`;
const files = [
  reportsApi,
  `${reports}/module.ts`,
  reportsAdapter,
  billingApi2,
  `${billing2}/contracts.ts`,
];
export const v1Files = [
  `${FEATURES_ROOT}/legacy/domain/model.ts`,
  `${FEATURES_ROOT}/legacy/features/helper.ts`,
];
export const profileCase = (
  id: string,
  expect: readonly DiagnosticCode[],
  imports: readonly ImportRecord[],
  description: string,
): ConformanceCase => ({
  id,
  source: "Abstract repository layout",
  description,
  expect,
  ok: expect.length === 0,
  input: {
    files,
    imports,
    featureRoots: [reports, billing2],
    roleRoots: [
      { root: reportsApi, role: "application" },
      { root: `${reports}/module.ts`, role: "composition" },
      { root: `${reports}/adapters`, role: "adapters" },
      { root: billingApi2, role: "application" },
      { root: `${billing2}/contracts.ts`, role: "contracts" },
    ],
    surfaces: { public: [reportsApi, billingApi2] },
  },
});
export const withApi = {
  files: [billingApi],
  input: { surfaces: { ...exampleModule().surfaces, internalApi: [billingApi] } },
};

export {
  FEATURES_ROOT,
  MODULE_COMPOSITION,
  TEST_FEATURES_ROOT,
  exampleModule,
  exampleRoots,
  importOf,
  roleDirectories,
  inferDirectoryLayout,
};
