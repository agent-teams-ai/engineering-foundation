import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCapabilityConfig } from "../dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { NodeChangeFingerprint } from "../dist/capabilities/public-api-compatibility/adapters/outbound/crypto/node-change-fingerprint.js";
import { createPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/module.js";
import { loadStrictYamlFile } from "../dist/features/configuration-input/node.js";
import { assertSchema } from "../dist/schema-catalog.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageName = "@agent-teams/docs-protocol-agent-teams";
// Closed, reviewed formatter delta; released and migration evidence remain byte-exact.
const formattedRestorationSignatures = [
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!ManagedRestorationLockV1Diagnostic#code:member",
    before: "readonly code: 'input' | 'derivation' | 'mismatch' | 'preservation';",
    after: 'readonly code: "input" | "derivation" | "mismatch" | "preservation";',
  },
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!ManagedRestorationLockV1Provenance#originalPackageManager:member",
    before: "readonly originalPackageManager: 'pnpm@11.20.0';",
    after: 'readonly originalPackageManager: "pnpm@11.20.0";',
  },
  {
    reference: "@agent-teams/docs-protocol-agent-teams!ManagedRestorationLockV1Result:type",
    before:
      "export type ManagedRestorationLockV1Result = {\n    readonly schemaVersion: 1;\n} & ({\n    readonly conformance: 'conformant';\n    readonly expectedLockDigest: `sha256:${string}`;\n    readonly provenance: ManagedRestorationLockV1Provenance;\n    readonly diagnostics: readonly [\n    ];\n} | {\n    readonly conformance: 'nonconformant';\n    readonly expectedLockDigest?: `sha256:${string}`;\n    readonly provenance?: ManagedRestorationLockV1Provenance;\n    readonly diagnostics: readonly ManagedRestorationLockV1Diagnostic[];\n});",
    after:
      'export type ManagedRestorationLockV1Result = {\n    readonly schemaVersion: 1;\n} & ({\n    readonly conformance: "conformant";\n    readonly expectedLockDigest: `sha256:${string}`;\n    readonly provenance: ManagedRestorationLockV1Provenance;\n    readonly diagnostics: readonly [\n    ];\n} | {\n    readonly conformance: "nonconformant";\n    readonly expectedLockDigest?: `sha256:${string}`;\n    readonly provenance?: ManagedRestorationLockV1Provenance;\n    readonly diagnostics: readonly ManagedRestorationLockV1Diagnostic[];\n});',
  },
];

const reviewedGeneration3Signatures = [
  {
    reference: "@agent-teams/docs-protocol-agent-teams!planPnpmManifestV2:function(1)",
    before:
      "export declare function planPnpmManifestV2(input: {\n    readonly observation: ConsumerIntegrationFileObservation;\n    readonly profilePath: string;\n    readonly cohort: QualifiedDocsCohortBindingV2;\n    readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;\n}): PnpmManifestPlanV1;",
    after:
      'export declare function planPnpmManifestV2(input: {\n    readonly observation: ConsumerIntegrationFileObservation;\n    readonly profilePath: string;\n    readonly cohort: Pick<QualifiedDocsCohortBindingV2, "packages">;\n    readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;\n}): PnpmManifestPlanV1;',
  },
  {
    reference: "@agent-teams/docs-protocol-agent-teams!upgradeConsumerIntegration:function(1)",
    before:
      "export declare function upgradeConsumerIntegration(options: {\n    readonly consumerRoot: string;\n    readonly authorityRevision?: string;\n    readonly to: string;\n}): Promise<ConsumerUpgradeExecutionV1>;",
    after:
      "export declare function upgradeConsumerIntegration(options: {\n    readonly targetGeneration: 1 | 2 | 3;\n    readonly consumerRoot: string;\n    readonly authorityRevision?: string;\n    readonly to: string;\n}): Promise<ConsumerUpgradeExecutionV1>;",
  },
];

// ADR-0076 approves these five literal successors in both existing entrypoints.
const reviewedPatchedRuntimeApprovals = [
  {
    fingerprint: "sha256:ee676005b5cae772bb6b1d995d9ee74a4659292c5beb6410b937427dae189ad2",
    decisionId: "ADR-0076",
  },
  {
    fingerprint: "sha256:4801d0cfab99299ac947cbb01032c1151f20e0c1e9d4b2e31fb639c797b9c88c",
    decisionId: "ADR-0076",
  },
];
const reviewedPatchedRuntimeSignatures = [
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!DocsProtocolQualificationCohortEvidenceV3#policy:member",
    before:
      'readonly policy: {\n    readonly id: "agent-teams.docs-protocol-current-policy";\n    readonly version: "3.0.0";\n    readonly sourceDigest: `sha256:${string}`;\n};',
    after:
      'readonly policy: {\n    readonly id: "agent-teams.docs-protocol-current-policy";\n    readonly version: "3.1.0";\n    readonly sourceDigest: `sha256:${string}`;\n};',
  },
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!DocsProtocolQualificationCohortEvidenceV3#runtime:member",
    before:
      'readonly runtime: {\n    readonly selectedLane: "node-26-managed-qualified";\n    readonly node: ">=26.0.0 <27";\n    readonly pnpm: ">=11.17.0 <12";\n    readonly qualificationRuntime: {\n        readonly nodeVersion: "26.11.1";\n        readonly pnpmVersion: "11.20.0";\n        readonly platform: "linux";\n        readonly architecture: "x64";\n    };\n    readonly runtimeClosureDigest: `sha256:${string}`;\n};',
    after:
      'readonly runtime: {\n    readonly selectedLane: "node-26-managed-qualified";\n    readonly node: ">=26.12.1 <27";\n    readonly pnpm: ">=11.17.0 <12";\n    readonly qualificationRuntime: {\n        readonly nodeVersion: "26.12.1";\n        readonly pnpmVersion: "11.20.0";\n        readonly platform: "linux";\n        readonly architecture: "x64";\n    };\n    readonly runtimeClosureDigest: `sha256:${string}`;\n};',
  },
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!DocsProtocolQualificationCohortV3Receipt#policy:member",
    before:
      'readonly policy: {\n    readonly id: "agent-teams.docs-protocol-current-policy";\n    readonly version: "3.0.0";\n    readonly sourceDigest: `sha256:${string}`;\n};',
    after:
      'readonly policy: {\n    readonly id: "agent-teams.docs-protocol-current-policy";\n    readonly version: "3.1.0";\n    readonly sourceDigest: `sha256:${string}`;\n};',
  },
  {
    reference:
      "@agent-teams/docs-protocol-agent-teams!DocsProtocolQualificationCohortV3Receipt#runtime:member",
    before:
      'readonly runtime: {\n    readonly selectedLane: "node-26-managed-qualified";\n    readonly node: ">=26.0.0 <27";\n    readonly pnpm: ">=11.17.0 <12";\n    readonly qualificationRuntime: {\n        readonly nodeVersion: "26.11.1";\n        readonly pnpmVersion: "11.20.0";\n        readonly platform: "linux";\n        readonly architecture: "x64";\n    };\n    readonly runtimeClosure: {\n        readonly domain: "agent-teams.docs-runtime-closure/v2";\n        readonly digest: `sha256:${string}`;\n    };\n};',
    after:
      'readonly runtime: {\n    readonly selectedLane: "node-26-managed-qualified";\n    readonly node: ">=26.12.1 <27";\n    readonly pnpm: ">=11.17.0 <12";\n    readonly qualificationRuntime: {\n        readonly nodeVersion: "26.12.1";\n        readonly pnpmVersion: "11.20.0";\n        readonly platform: "linux";\n        readonly architecture: "x64";\n    };\n    readonly runtimeClosure: {\n        readonly domain: "agent-teams.docs-runtime-closure/v2";\n        readonly digest: `sha256:${string}`;\n    };\n};',
  },
  {
    reference: "@agent-teams/docs-protocol-agent-teams!UnselectedCohortV3#runtime:member",
    before:
      'readonly runtime: {\n    readonly policy: {\n        readonly id: "agent-teams.docs-protocol-current-policy";\n        readonly version: "3.0.0";\n        readonly digest: string;\n    };\n    readonly selectedLane: "node-24-production-default" | "node-26-managed-qualified";\n    readonly node: string;\n    readonly pnpm: string;\n    readonly qualificationRuntime: {\n        readonly nodeVersion: string;\n        readonly pnpmVersion: string;\n        readonly platform: string;\n        readonly architecture: string;\n    };\n    readonly runtimeClosure: {\n        readonly domain: "agent-teams.docs-runtime-closure/v2";\n        readonly digest: string;\n    };\n};',
    after:
      'readonly runtime: {\n    readonly policy: {\n        readonly id: "agent-teams.docs-protocol-current-policy";\n        readonly version: "3.1.0";\n        readonly digest: string;\n    };\n    readonly selectedLane: "node-24-production-default" | "node-26-managed-qualified";\n    readonly node: string;\n    readonly pnpm: string;\n    readonly qualificationRuntime: {\n        readonly nodeVersion: string;\n        readonly pnpmVersion: string;\n        readonly platform: string;\n        readonly architecture: string;\n    };\n    readonly runtimeClosure: {\n        readonly domain: "agent-teams.docs-runtime-closure/v2";\n        readonly digest: string;\n    };\n};',
  },
];

function reviewedPatchedRuntimeItem(item, approvals) {
  const row = reviewedPatchedRuntimeSignatures.find(
    ({ reference }) => reference === item.canonicalReference,
  );
  if (row === undefined) {
    return item;
  }
  assert.deepEqual(
    approvals.filter(({ decisionId }) => decisionId === "ADR-0076"),
    reviewedPatchedRuntimeApprovals,
    "Patched runtime signatures require the exact ADR-0076 compatibility approvals.",
  );
  assert.ok(
    item.signature === row.before || item.signature === row.after,
    "Patched runtime signature must match the exact reviewed released or promoted form.",
  );
  return { ...item, signature: row.after };
}

test("ADR-0076 runtime signatures bind the exact approved delta and reject unknown text", () => {
  const changed = reviewedPatchedRuntimeSignatures.map((row) => {
    const before = {
      canonicalReference: row.reference,
      kind: "PropertySignature",
      parentReference: `${row.reference.split("#")[0]}:interface`,
      parentKind: "Interface",
      signature: row.before,
    };
    const after = { ...before, signature: row.after };
    assert.deepEqual(reviewedPatchedRuntimeItem(before, reviewedPatchedRuntimeApprovals), after);
    assert.deepEqual(reviewedPatchedRuntimeItem(after, reviewedPatchedRuntimeApprovals), after);
    assert.throws(
      () =>
        reviewedPatchedRuntimeItem(
          { ...after, signature: `${row.after}\n` },
          reviewedPatchedRuntimeApprovals,
        ),
      /exact reviewed released or promoted form/u,
    );
    assert.throws(
      () => reviewedPatchedRuntimeItem(before, reviewedPatchedRuntimeApprovals.slice(0, 1)),
      /exact ADR-0076 compatibility approvals/u,
    );
    return { before, after };
  });
  const evidence = {
    addedEntrypoints: [],
    removedEntrypoints: [],
    entrypoints: [".", "./qualification"].map((exportPath) => ({
      exportPath,
      added: [],
      changed,
      removed: [],
    })),
  };
  assert.equal(
    `sha256:${new NodeChangeFingerprint().sha256(JSON.stringify(evidence))}`,
    reviewedPatchedRuntimeApprovals[1].fingerprint,
  );
  const historical = {
    canonicalReference: `${packageName}!QualifiedDocsCohortV1#runtime:member`,
    signature: 'readonly runtime: { readonly node: ">=26.0.0 <27"; };',
  };
  assert.equal(reviewedPatchedRuntimeItem(historical, []), historical);
});

function reviewedGeneration3Item(item) {
  const row = reviewedGeneration3Signatures.find(
    ({ reference }) => reference === item.canonicalReference,
  );
  if (row === undefined) {
    return item;
  }
  assert.ok(
    item.signature === row.before || item.signature === row.after,
    "Generation 3 signature must match the exact reviewed released or promoted form.",
  );
  return { ...item, signature: row.after };
}

test("Generation 3 signature review admits exact promotion rows and rejects unknown text", () => {
  for (const row of reviewedGeneration3Signatures) {
    const expected = {
      canonicalReference: row.reference,
      kind: "Function",
      parentReference: `${packageName}!`,
      parentKind: "EntryPoint",
      signature: row.after,
    };
    assert.deepEqual(reviewedGeneration3Item({ ...expected, signature: row.before }), expected);
    assert.deepEqual(reviewedGeneration3Item(expected), expected);
    assert.throws(
      () => reviewedGeneration3Item({ ...expected, signature: `${row.after}\n` }),
      /exact reviewed released or promoted form/u,
    );
  }
});

function reviewedReleasedItem(toolChange, formatted, releasedIsNative, promotedFormatting) {
  const reviewedItem = releasedIsNative ? toolChange.after : toolChange.before;
  if (formatted && releasedIsNative) {
    assert.equal(reviewedItem.signature, formatted.before, "exact reviewed migration signature");
  }
  return formatted && promotedFormatting
    ? { ...reviewedItem, signature: formatted.after }
    : reviewedItem;
}

test("managed composition preserves published function declarations and planner overloads", async () => {
  const config = await loadCapabilityConfig(
    { readYaml: loadStrictYamlFile, assertSchema },
    repositoryRoot,
    "architecture/foundation/public-api-compatibility.yaml",
  );
  const policy = config.packages.find((item) => item.packageName === packageName);
  assert.ok(policy);
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "packages/docs-protocol-agent-teams/package.json"), "utf8"),
  );
  const actual = await createPublicApiExtractor().extract(repositoryRoot, policy, manifest.version);
  assert.equal(actual.extractorVersion, "typescript-native/7.0.2");
  assert.deepEqual(actual.entrypoints.map((item) => item.exportPath).toSorted(), [
    ".",
    "./qualification",
  ]);
  for (const entrypoint of actual.entrypoints) {
    const functions = ["runDocsProtocolQualificationV2", "runDocsProtocolQualificationV3"];
    if (entrypoint.exportPath === ".") {
      functions.push("runManagedDocsCli", "planConsumerIntegration");
    } else {
      functions.push(
        "observeDocsProtocolQualificationV3Lockfile",
        "projectDocsProtocolQualificationV3Authority",
      );
    }
    for (const name of functions) {
      const reference = `${packageName}!${name}:function(1)`;
      assert.equal(
        entrypoint.items.find((item) => item.canonicalReference === reference)?.kind,
        "Function",
        `${entrypoint.exportPath}: ${reference}`,
      );
    }
  }
  const root = actual.entrypoints.find((item) => item.exportPath === ".");
  const overloads = root.items.filter((item) =>
    item.canonicalReference.startsWith(`${packageName}!planConsumerIntegration:function(`),
  );
  assert.equal(overloads.length, 2);
  assert.match(overloads[0].signature, /ConsumerIntegrationDesiredStateV1/u);
  assert.match(overloads[1].signature, /ConsumerIntegrationDesiredStateV3/u);
  const released = JSON.parse(
    await readFile(join(repositoryRoot, policy.releasedBaselinePath), "utf8"),
  );
  assert.ok(["7.58.12", "typescript-native/7.0.2"].includes(released.extractorVersion));
  const releasedIsNative = released.extractorVersion === "typescript-native/7.0.2";
  const reviewedBytes = await readFile(
    join(repositoryRoot, "scripts/native-public-api-migration/reviewed-tool-diff.json"),
  );
  assert.equal(
    new NodeChangeFingerprint().sha256(reviewedBytes),
    "50eb0f44228640fba54d3317cac5430f568f7bc73890e3e4945718ea96521c5c",
  );
  const reviewed = JSON.parse(reviewedBytes.toString("utf8")).packages.find(
    (item) => item.packageName === packageName,
  );
  assert.ok(reviewed);
  for (const entrypoint of released.entrypoints) {
    const current = actual.entrypoints.find((item) => item.exportPath === entrypoint.exportPath);
    const reviewedEntrypoint = reviewed.entrypoints.find(
      (item) => item.exportPath === entrypoint.exportPath,
    );
    assert.ok(reviewedEntrypoint);
    for (const item of entrypoint.items) {
      const formatted = formattedRestorationSignatures.find(
        (row) => row.reference === item.canonicalReference,
      );
      const promotedFormatting = releasedIsNative && released.packageVersion !== "0.5.4";
      const toolChange = reviewedEntrypoint.changed.find(
        (change) => change.id === item.canonicalReference,
      );
      if (toolChange) {
        const reviewedItem = reviewedReleasedItem(
          toolChange,
          formatted,
          releasedIsNative,
          promotedFormatting,
        );
        assert.deepEqual(
          releasedIsNative
            ? reviewedPatchedRuntimeItem(reviewedItem, policy.approvedBreakingChanges)
            : reviewedItem,
          releasedIsNative
            ? reviewedPatchedRuntimeItem(item, policy.approvedBreakingChanges)
            : item,
          "released item must match its exact reviewed extractor side and approved successor",
        );
      }
      const nativeItem = reviewedPatchedRuntimeItem(
        reviewedGeneration3Item(releasedIsNative ? item : (toolChange?.after ?? item)),
        policy.approvedBreakingChanges,
      );
      const acceptedConsumerIntegrationDesiredState =
        item.canonicalReference === `${packageName}!ConsumerIntegrationDesiredState:type`
          ? {
              ...nativeItem,
              signature:
                "export type ConsumerIntegrationDesiredState = ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile;",
            }
          : nativeItem;
      if (formatted) {
        // 0.5.4 is the retained pre-format baseline. Ordinary release promotion
        // records the already-reviewed formatted spelling in its successor.
        assert.equal(
          nativeItem.signature,
          promotedFormatting ? formatted.after : formatted.before,
          "exact reviewed signature for the released baseline generation",
        );
      }
      assert.deepEqual(
        current.items.find((candidate) => candidate.canonicalReference === item.canonicalReference),
        formatted
          ? { ...acceptedConsumerIntegrationDesiredState, signature: formatted.after }
          : acceptedConsumerIntegrationDesiredState,
        `${entrypoint.exportPath}: ${item.canonicalReference}`,
      );
    }
  }
});
