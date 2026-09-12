import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const policy = parse(
  await readFile("architecture/foundation/json-schema-releases.yaml", "utf8"),
);
const baseline = JSON.parse(
  await readFile("architecture/contracts/json-schema/docs-protocol-profile.json", "utf8"),
);

test("Foundation dogfoods one JSON Schema family with artifact-only remaining exports", () => {
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.contractId, "docs-protocol-profile");
  assert.equal(policy.publicContractVersion, "3.0.0");
  assert.deepEqual(policy.schemaPaths, [
    "packages/docs-protocol/schemas/docs-protocol-profile/v3.schema.json",
  ]);
  assert.equal(policy.releasedBaselinePath, "architecture/contracts/json-schema/docs-protocol-profile.json");
  assert.equal(baseline.contractId, "docs-protocol-profile");
  assert.equal(baseline.publicContractVersion, "3.0.0");
  assert.equal(baseline.schemaSetDigest, policy.currentConsumerEvidence[0].schemaSetDigest);
  assert.equal(policy.fixtures.some((fixture) => fixture.expectation === "valid"), true);
  assert.equal(policy.fixtures.some((fixture) => fixture.expectation === "invalid"), true);
});
