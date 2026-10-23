import type {
  FileLeaf,
  InputBinding,
  ManifestSnapshot,
  PackageChange,
  ReleaseCandidateInput,
} from "./application/model.js";

// Handwritten source/plan/result values, independent of the checker and engine adapters.
const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const file = (character: string): FileLeaf => ({
  type: "file",
  mode: "100644",
  digest: digest(character),
});
const binding: InputBinding = {
  source: { repository: "example/fixture", identity: "accepted-source", digest: digest("a") },
  engine: { name: "fixture-qualified-engine", version: "2.0.0", digest: digest("b") },
  configDigest: digest("c"),
  inventoryDigest: digest("d"),
  policyDigest: digest("e"),
  intentsDigest: digest("f"),
  planDigest: digest("0"),
};
const root: ManifestSnapshot = {
  file: file("5"),
  semantic: { name: "fixture-workspace", private: true, workspaces: ["packages/*"] },
};
const alphaBefore: ManifestSnapshot = {
  file: file("1"),
  semantic: { name: "@fixture/alpha", version: "1.0.0", exports: { ".": "./dist/index.js" } },
};
const alphaAfter: ManifestSnapshot = {
  file: file("2"),
  semantic: { name: "@fixture/alpha", version: "1.1.0", exports: { ".": "./dist/index.js" } },
};
const betaBefore: ManifestSnapshot = {
  file: file("3"),
  semantic: {
    name: "@fixture/beta",
    version: "1.0.0",
    dependencies: { "@fixture/alpha": "workspace:*" },
  },
};
const betaAfter: ManifestSnapshot = {
  file: file("4"),
  semantic: {
    name: "@fixture/beta",
    version: "1.0.1",
    dependencies: { "@fixture/alpha": "workspace:*" },
  },
};
const ignored: ManifestSnapshot = {
  file: file("6"),
  semantic: { name: "@fixture/ignored", version: "3.0.0" },
};
const privatePackage: ManifestSnapshot = {
  file: file("7"),
  semantic: { name: "@fixture/private", private: true },
};
const packages: ReleaseCandidateInput["expected"]["packages"] = [
  {
    name: "fixture-workspace",
    root: ".",
    manifestPath: "package.json",
    classification: "private",
    versioning: "unversioned",
    before: root,
  },
  {
    name: "@fixture/alpha",
    root: "packages/alpha",
    manifestPath: "packages/alpha/package.json",
    classification: "public",
    versioning: "versioned",
    before: alphaBefore,
  },
  {
    name: "@fixture/beta",
    root: "packages/beta",
    manifestPath: "packages/beta/package.json",
    classification: "public",
    versioning: "versioned",
    before: betaBefore,
  },
  {
    name: "@fixture/ignored",
    root: "packages/ignored",
    manifestPath: "packages/ignored/package.json",
    classification: "public",
    versioning: "ignored",
    before: ignored,
  },
  {
    name: "@fixture/private",
    root: "packages/private",
    manifestPath: "packages/private/package.json",
    classification: "private",
    versioning: "unversioned",
    before: privatePackage,
  },
];
const direct: ReleaseCandidateInput = {
  schemaVersion: 1,
  expected: {
    binding,
    packages,
    intents: [
      {
        id: "direct",
        path: ".intent/direct.md",
        digest: digest("8"),
        participation: "pending",
        requests: [{ packageName: "@fixture/alpha", type: "minor" }],
      },
      {
        id: "empty",
        path: ".intent/empty.md",
        digest: digest("9"),
        participation: "pending",
        requests: [],
      },
      {
        id: "ignored",
        path: ".intent/ignored.md",
        digest: digest("a"),
        participation: "retained",
        requests: [{ packageName: "@fixture/ignored", type: "patch" }],
      },
      {
        id: "private",
        path: ".intent/private.md",
        digest: digest("b"),
        participation: "retained",
        requests: [{ packageName: "@fixture/private", type: "patch" }],
      },
    ],
    plan: {
      releases: [
        {
          packageName: "@fixture/beta",
          manifestPath: "packages/beta/package.json",
          type: "patch",
          oldVersion: "1.0.0",
          newVersion: "1.0.1",
          intentIds: [],
        },
        {
          packageName: "@fixture/private",
          manifestPath: "packages/private/package.json",
          type: "none",
          oldVersion: null,
          newVersion: null,
          intentIds: [],
        },
        {
          packageName: "@fixture/alpha",
          manifestPath: "packages/alpha/package.json",
          type: "minor",
          oldVersion: "1.0.0",
          newVersion: "1.1.0",
          intentIds: ["direct"],
        },
      ],
      consumptions: [
        { intentId: "direct", effect: { kind: "remove" } },
        { intentId: "empty", effect: { kind: "remove" } },
      ],
    },
    permittedChanges: [
      {
        path: "packages/alpha/package.json",
        classification: "manifest",
        kind: "modified",
        before: { type: "file", mode: "100644" },
        after: { type: "file", mode: "100644" },
        contentAuthority: "release-checks",
      },
      {
        path: "packages/beta/package.json",
        classification: "manifest",
        kind: "modified",
        before: { type: "file", mode: "100644" },
        after: { type: "file", mode: "100644" },
        contentAuthority: "release-checks",
      },
      {
        path: ".intent/direct.md",
        classification: "intent",
        kind: "deleted",
        before: { type: "file", mode: "100644" },
        after: null,
        contentAuthority: "release-checks",
      },
      {
        path: ".intent/empty.md",
        classification: "intent",
        kind: "deleted",
        before: { type: "file", mode: "100644" },
        after: null,
        contentAuthority: "release-checks",
      },
    ],
  },
  observed: {
    binding,
    candidateIdentity: "independently-observed-candidate",
    manifests: [
      { manifestPath: "package.json", before: root, after: root },
      { manifestPath: "packages/alpha/package.json", before: alphaBefore, after: alphaAfter },
      { manifestPath: "packages/beta/package.json", before: betaBefore, after: betaAfter },
      { manifestPath: "packages/ignored/package.json", before: ignored, after: ignored },
      {
        manifestPath: "packages/private/package.json",
        before: privatePackage,
        after: privatePackage,
      },
    ],
    consumptions: [
      { intentId: "direct", digest: digest("8"), effect: { kind: "remove" } },
      { intentId: "empty", digest: digest("9"), effect: { kind: "remove" } },
    ],
    diff: [
      {
        path: "packages/beta/package.json",
        classification: "manifest",
        kind: "modified",
        before: file("3"),
        after: file("4"),
      },
      {
        path: ".intent/direct.md",
        classification: "intent",
        kind: "deleted",
        before: file("8"),
        after: null,
      },
      {
        path: "packages/alpha/package.json",
        classification: "manifest",
        kind: "modified",
        before: file("1"),
        after: file("2"),
      },
      {
        path: ".intent/empty.md",
        classification: "intent",
        kind: "deleted",
        before: file("9"),
        after: null,
      },
    ],
  },
};
const packageChanges: readonly PackageChange[] = [
  {
    packageName: "@fixture/alpha",
    manifestPath: "packages/alpha/package.json",
    oldVersion: "1.0.0",
    newVersion: "1.1.0",
  },
  {
    packageName: "@fixture/beta",
    manifestPath: "packages/beta/package.json",
    oldVersion: "1.0.0",
    newVersion: "1.0.1",
  },
];
const noRelease: ReleaseCandidateInput = {
  schemaVersion: 1,
  expected: {
    binding,
    packages: [packages[0]!],
    intents: [
      {
        id: "empty",
        path: ".intent/empty.md",
        digest: digest("9"),
        participation: "pending",
        requests: [],
      },
    ],
    plan: {
      releases: [
        {
          packageName: "fixture-workspace",
          manifestPath: "package.json",
          type: "none",
          oldVersion: null,
          newVersion: null,
          intentIds: [],
        },
      ],
      consumptions: [],
    },
    permittedChanges: [],
  },
  observed: {
    binding,
    candidateIdentity: "unchanged-source",
    manifests: [{ manifestPath: "package.json", before: root, after: root }],
    consumptions: [],
    diff: [],
  },
};
const recorded: ReleaseCandidateInput = {
  ...direct,
  expected: {
    ...direct.expected,
    plan: {
      ...direct.expected.plan,
      consumptions: [
        { intentId: "direct", effect: { kind: "record", evidencePath: ".release-state.json" } },
        { intentId: "empty", effect: { kind: "remove" } },
      ],
    },
    permittedChanges: [
      ...direct.expected.permittedChanges.filter((change) => change.path !== ".intent/direct.md"),
      {
        path: ".release-state.json",
        classification: "state",
        kind: "modified",
        before: { type: "file", mode: "100644" },
        after: { type: "file", mode: "100644" },
        contentAuthority: "fixture-existing-state-guard",
      },
    ],
  },
  observed: {
    ...direct.observed,
    consumptions: [
      {
        intentId: "direct",
        digest: digest("8"),
        effect: { kind: "record", evidencePath: ".release-state.json" },
      },
      { intentId: "empty", digest: digest("9"), effect: { kind: "remove" } },
    ],
    diff: [
      ...direct.observed.diff.filter((change) => change.path !== ".intent/direct.md"),
      {
        path: ".release-state.json",
        classification: "state",
        kind: "modified",
        before: file("c"),
        after: file("d"),
      },
    ],
  },
};
// A Git repository need not have a root package manifest. All actual nested
// packages and complete repository-relative observations remain in the input.
const nested: ReleaseCandidateInput = {
  ...direct,
  expected: { ...direct.expected, packages: packages.filter((entry) => entry.root !== ".") },
  observed: {
    ...direct.observed,
    manifests: direct.observed.manifests.filter((entry) => entry.manifestPath !== "package.json"),
  },
};
export {
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
};
