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
        assert.deepEqual(
          reviewedReleasedItem(toolChange, formatted, releasedIsNative, promotedFormatting),
          item,
          "released item must match the exact reviewed side for its extractor identity",
        );
      }
      const nativeItem = reviewedGeneration3Item(
        releasedIsNative ? item : (toolChange?.after ?? item),
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
