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

test("managed composition preserves published function declarations and planner overloads", async () => {
  const config = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema },
    repositoryRoot, "architecture/foundation/public-api-compatibility.yaml");
  const policy = config.packages.find((item) => item.packageName === packageName);
  assert.ok(policy);
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages/docs-protocol-agent-teams/package.json"), "utf8"));
  const actual = await createPublicApiExtractor().extract(repositoryRoot, policy, manifest.version);
  assert.deepEqual(actual.entrypoints.map((item) => item.exportPath).toSorted(), [".", "./qualification"]);
  for (const entrypoint of actual.entrypoints) {
    const functions = ["runDocsProtocolQualificationV2", "runDocsProtocolQualificationV3"];
    if (entrypoint.exportPath === ".") { functions.push("runManagedDocsCli", "planConsumerIntegration"); }
    else { functions.push("observeDocsProtocolQualificationV3Lockfile", "projectDocsProtocolQualificationV3Authority"); }
    for (const name of functions) {
      const reference = `${packageName}!${name}:function(1)`;
      assert.equal(entrypoint.items.find((item) => item.canonicalReference === reference)?.kind,
        "Function", `${entrypoint.exportPath}: ${reference}`);
    }
  }
  const root = actual.entrypoints.find((item) => item.exportPath === ".");
  const overloads = root.items.filter((item) => item.canonicalReference.startsWith(`${packageName}!planConsumerIntegration:function(`));
  assert.equal(overloads.length, 2);
  assert.match(overloads[0].signature, /ConsumerIntegrationDesiredStateV1/u);
  assert.match(overloads[1].signature, /ConsumerIntegrationDesiredStateV3/u);
  const released = JSON.parse(await readFile(join(repositoryRoot, policy.releasedBaselinePath), "utf8"));
  const reviewedBytes = await readFile(join(repositoryRoot, "scripts/native-public-api-migration/reviewed-tool-diff.json"));
  assert.equal(new NodeChangeFingerprint().sha256(reviewedBytes),
    "50eb0f44228640fba54d3317cac5430f568f7bc73890e3e4945718ea96521c5c");
  const reviewed = JSON.parse(reviewedBytes.toString("utf8")).packages.find((item) => item.packageName === packageName);
  assert.ok(reviewed);
  for (const entrypoint of released.entrypoints) {
    const current = actual.entrypoints.find((item) => item.exportPath === entrypoint.exportPath);
    const reviewedEntrypoint = reviewed.entrypoints.find((item) => item.exportPath === entrypoint.exportPath);
    assert.ok(reviewedEntrypoint);
    for (const item of entrypoint.items) {
      const toolChange = reviewedEntrypoint.changed.find((change) => change.id === item.canonicalReference);
      if (toolChange) { assert.deepEqual(toolChange.before, item, "reviewed tool projection must start from exact historical item"); }
      const nativeItem = toolChange?.after ?? item;
      const acceptedConsumerIntegrationDesiredState =
        item.canonicalReference === `${packageName}!ConsumerIntegrationDesiredState:type`
          ? {
              ...nativeItem,
              signature: "export type ConsumerIntegrationDesiredState = ConsumerIntegrationDesiredStateV1 | ConsumerIntegrationDesiredStateV3 | ManagedSuccessorProfile;"
            }
          : nativeItem;
      assert.deepEqual(current.items.find((candidate) => candidate.canonicalReference === item.canonicalReference),
        acceptedConsumerIntegrationDesiredState, `${entrypoint.exportPath}: ${item.canonicalReference}`);
    }
  }
});
