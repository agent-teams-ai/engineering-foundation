import type { DiagnosticCode, PackageChange } from "./application/model.js";

import {
  alphaAfter,
  binding,
  digest,
  direct,
  file,
  nested,
  noRelease,
  packageChanges,
  recorded,
  root,
} from "./conformance-inputs.js";

export type { DiagnosticCode, PackageChange } from "./application/model.js";

export type ConformanceCase = Readonly<{
  id: string;
  input: unknown;
  expected: Readonly<{
    outcome: "passed" | "rejected";
    diagnosticCodes: readonly DiagnosticCode[];
    packageChanges: readonly PackageChange[];
  }>;
}>;

const cases: readonly ConformanceCase[] = [
  {
    id: "direct-dependent-empty-and-unchanged-none",
    input: direct,
    expected: { outcome: "passed", diagnosticCodes: [], packageChanges },
  },
  {
    id: "no-release-with-empty-intent-and-none",
    input: noRelease,
    expected: { outcome: "passed", diagnosticCodes: [], packageChanges: [] },
  },
  {
    id: "existing-retained-file-consumption",
    input: recorded,
    expected: { outcome: "passed", diagnosticCodes: [], packageChanges },
  },
  {
    id: "nested-packages-without-root-manifest",
    input: nested,
    expected: { outcome: "passed", diagnosticCodes: [], packageChanges },
  },
  {
    id: "unclassified-root-manifest",
    input: {
      ...nested,
      observed: {
        ...nested.observed,
        manifests: [
          ...nested.observed.manifests,
          { manifestPath: "package.json", before: root, after: root },
        ],
      },
    },
    expected: { outcome: "rejected", diagnosticCodes: ["package.unknown"], packageChanges },
  },
  {
    id: "unknown-input",
    input: null,
    expected: { outcome: "rejected", diagnosticCodes: ["input.invalid"], packageChanges: [] },
  },
  {
    id: "stale-config-binding",
    input: {
      ...direct,
      observed: { ...direct.observed, binding: { ...binding, configDigest: digest("1") } },
    },
    expected: { outcome: "rejected", diagnosticCodes: ["binding.mismatch"], packageChanges },
  },
  {
    id: "hidden-export-change-despite-permission",
    input: {
      ...direct,
      observed: {
        ...direct.observed,
        manifests: direct.observed.manifests.map((entry) =>
          entry.manifestPath === "packages/alpha/package.json"
            ? {
                ...entry,
                after: {
                  ...alphaAfter,
                  semantic: {
                    name: "@fixture/alpha",
                    version: "1.1.0",
                    exports: { ".": "./dist/other.js" },
                  },
                },
              }
            : entry,
        ),
      },
    },
    expected: {
      outcome: "rejected",
      diagnosticCodes: ["manifest.content-changed"],
      packageChanges,
    },
  },
  {
    id: "exact-planned-version-mismatch",
    input: {
      ...direct,
      observed: {
        ...direct.observed,
        manifests: direct.observed.manifests.map((entry) =>
          entry.manifestPath === "packages/alpha/package.json"
            ? {
                ...entry,
                after: {
                  ...alphaAfter,
                  semantic: {
                    name: "@fixture/alpha",
                    version: "1.1.1",
                    exports: { ".": "./dist/index.js" },
                  },
                },
              }
            : entry,
        ),
      },
    },
    expected: {
      outcome: "rejected",
      diagnosticCodes: ["plan.version-mismatch"],
      packageChanges: [
        {
          packageName: "@fixture/alpha",
          manifestPath: "packages/alpha/package.json",
          oldVersion: "1.0.0",
          newVersion: "1.1.1",
        },
        {
          packageName: "@fixture/beta",
          manifestPath: "packages/beta/package.json",
          oldVersion: "1.0.0",
          newVersion: "1.0.1",
        },
      ],
    },
  },
  {
    id: "missing-original-consumption-digest",
    input: {
      ...direct,
      observed: {
        ...direct.observed,
        consumptions: [
          { intentId: "direct", digest: digest("0"), effect: { kind: "remove" } },
          direct.observed.consumptions[1]!,
        ],
      },
    },
    expected: { outcome: "rejected", diagnosticCodes: ["intent.consumption"], packageChanges },
  },
  {
    id: "unlisted-generated-output",
    input: {
      ...direct,
      observed: {
        ...direct.observed,
        diff: [
          ...direct.observed.diff,
          {
            path: "generated/unknown.txt",
            classification: "output",
            kind: "added",
            before: null,
            after: file("e"),
          },
        ],
      },
    },
    expected: { outcome: "rejected", diagnosticCodes: ["diff.unexpected"], packageChanges },
  },
  {
    id: "duplicate-direct-link",
    input: {
      ...direct,
      expected: {
        ...direct.expected,
        plan: {
          ...direct.expected.plan,
          releases: direct.expected.plan.releases.map((entry) =>
            entry.packageName === "@fixture/alpha"
              ? { ...entry, intentIds: ["direct", "direct"] }
              : entry,
          ),
        },
      },
    },
    expected: { outcome: "rejected", diagnosticCodes: ["identity.duplicate"], packageChanges: [] },
  },
];
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      freeze(item);
    }
    Object.freeze(value);
  }
}
freeze(cases);
/** Shared data only. Each consumer invokes its installed public checker and owns its assertions. */
export const releaseCandidateConformanceCases: readonly ConformanceCase[] = cases;
