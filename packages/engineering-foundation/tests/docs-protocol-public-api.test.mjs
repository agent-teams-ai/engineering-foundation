import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCapabilityConfig } from "../dist/capabilities/public-api-compatibility/adapters/inbound/configuration/load-capability-config.js";
import { MicrosoftPublicApiExtractor } from "../dist/capabilities/public-api-compatibility/adapters/outbound/api-extractor/microsoft-public-api-extractor.js";
import { loadStrictYamlFile } from "../dist/features/configuration-input/node.js";
import { assertSchema } from "../dist/schema-catalog.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("Docs Protocol entrypoints extract without exposing private authoring observations", async () => {
  const config = await loadCapabilityConfig({ readYaml: loadStrictYamlFile, assertSchema },
    repositoryRoot, "architecture/foundation/public-api-compatibility.yaml");
  const policy = config.packages.find((item) => item.packageName === "@agent-teams/docs-protocol");
  assert.ok(policy);
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "packages/docs-protocol/package.json"), "utf8"));
  const actual = await new MicrosoftPublicApiExtractor().extract(repositoryRoot, policy, manifest.version);
  const typedExports = Object.entries(manifest.exports)
    .filter(([, value]) => typeof value === "object" && typeof value.types === "string")
    .map(([name]) => name).toSorted();
  assert.deepEqual(typedExports, [".", "./qualification"]);
  assert.deepEqual(actual.entrypoints.map((item) => item.exportPath).toSorted(), typedExports);
  for (const entrypoint of actual.entrypoints) {
    for (const item of entrypoint.items) {
      assert.doesNotMatch(item.signature, /\b(?:AuthoringIntent|AuthoringReceipt|DocumentMetadataObject|docsProfilePath_2)\b/u,
        `${entrypoint.exportPath}: ${item.canonicalReference}`);
    }
  }
  const root = actual.entrypoints.find((item) => item.exportPath === ".");
  // Preserve the published function declaration contracts through composition.
  for (const name of [
    "docsCheckV2", "docsContextV1", "docsDoctorV2", "docsFindV2", "docsFindV3",
    "docsInfoV2", "docsInitApply", "docsInitPlan", "docsInitRecover", "docsNewV2",
    "docsProfilePath", "docsRecoverV2",
  ]) {
    const reference = `@agent-teams/docs-protocol!${name}:function(1)`;
    assert.equal(root.items.find((item) => item.canonicalReference === reference)?.kind,
      "Function", reference);
  }
  assert.ok(root.items.some((item) => /\bexpectedPlanDigest\??: string/u.test(item.signature)));
});
