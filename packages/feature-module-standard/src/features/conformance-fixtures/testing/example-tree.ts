import { inferDirectoryLayout } from '../../feature-layout/application/infer-directory-layout.js';
import type { FeatureModuleInput, ImportMode, ImportRecord, LayerRole } from '../../feature-model/domain/model.js';

/** The informative example tree of Feature Module Standard v1.1, section "Sub-features", as one valid module. */
export const FEATURES_ROOT = 'src/features';
export const TEST_FEATURES_ROOT = 'tests/features';

// Identity -> root below the features root; a sub-feature sits in its parent's `features` container.
const roots = {
  orders: 'orders',
  'orders/pricing': 'orders/features/pricing',
  'orders/discounts': 'orders/features/discounts',
  'orders/discounts/coupons': 'orders/features/discounts/features/coupons',
  billing: 'billing',
  'billing/coupons': 'billing/features/coupons',
} as const;
export type ExampleFeature = keyof typeof roots;
/** The roots of the example features, for cases that declare them. */
export const exampleRoots: readonly string[] = Object.values(roots).map((root) => `${FEATURES_ROOT}/${root}`);

const parts = ['public', 'domain', 'application', 'composition', 'contract', 'group'] as const;
type Part = (typeof parts)[number];
const partPaths: Readonly<Record<Part, string>> = {
  public: 'contracts/public.ts',
  domain: 'domain/model.ts',
  application: 'application/use-case.ts',
  composition: 'composition/feature.ts',
  contract: 'composition/feature.contracts.ts',
  group: 'composition/feature.group.ts',
};

/** The file of one part of an example feature: its public entrypoint, composition code, composition contract and so on. */
export const fileOf = (feature: ExampleFeature, part: Part): string => `${FEATURES_ROOT}/${roots[feature]}/${partPaths[part]}`;

export const MODULE_COMPOSITION = 'src/module.ts';
export const roleDirectories: Readonly<Record<string, LayerRole>> = {
  contracts: 'contracts', domain: 'domain', application: 'application', adapters: 'adapters', composition: 'composition',
};

export const importOf = (from: string, to: string, mode: ImportMode = 'runtime', reexport = false): ImportRecord =>
  ({ from, to, mode, line: 1, ...(reexport ? { reexport } : {}) });

const features = Object.keys(roots) as ExampleFeature[];
const parentOf = (feature: ExampleFeature): ExampleFeature | undefined =>
  features.filter((candidate) => feature.startsWith(`${candidate}/`)).at(-1);

/** A valid module: every parent wires the composition surface of each direct sub-feature, the module wires the top level. */
export function exampleModule(): FeatureModuleInput {
  const files = [MODULE_COMPOSITION, ...features.flatMap((feature) => parts.map((part) => fileOf(feature, part)))];
  const subFeatureRoots = exampleRoots.filter((root) => root.includes('/features/', FEATURES_ROOT.length + 1));
  const assembly = features.flatMap((feature) => {
    const parent = parentOf(feature);
    return parent === undefined
      ? [importOf(MODULE_COMPOSITION, fileOf(feature, 'group'))]
      : [importOf(fileOf(parent, 'composition'), fileOf(feature, 'group'))];
  });
  return {
    ...inferDirectoryLayout({ featuresRoot: FEATURES_ROOT, files, roleDirectories, subFeatureRoots }),
    files,
    moduleComposition: [MODULE_COMPOSITION],
    testFeaturesRoot: TEST_FEATURES_ROOT,
    surfaces: {
      public: features.map((feature) => fileOf(feature, 'public')),
      compositionContract: features.map((feature) => fileOf(feature, 'contract')),
      compositionSurface: features.map((feature) => fileOf(feature, 'group')),
    },
    imports: assembly,
  };
}
