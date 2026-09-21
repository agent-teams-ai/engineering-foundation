import assert from "node:assert/strict";
import test from "node:test";

import { preflightPublicApiPromotions } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/use-cases/preflight-public-api-promotions.js";

const item = { canonicalReference: "(function): stable", kind: "Function", parentKind: "EntryPoint", signature: "export function stable(): void;" };
const snapshot = (version, suffix = "") => ({ schemaVersion: 1, packageName: `fixture${suffix}`, packageVersion: version,
  extractorVersion: "7.58.12", entrypoints: [{ exportPath: ".", items: [item] }] });
const policy = suffix => ({ packageName: `fixture${suffix}`, packageRoot: `packages/fixture${suffix}`, manifestPath: `packages/fixture${suffix}/package.json`,
  tsconfigPath: `packages/fixture${suffix}/tsconfig.json`, releasedBaselinePath: `architecture/public-api/fixture${suffix}.json`,
  approvedBreakingChanges: [], entrypoints: [{ exportPath: ".", declarationEntryPoint: "dist/index.d.ts" }], nonTypeExports: [] });

function surface(suffix, writes) {
  const released = snapshot("1.0.0", suffix), current = snapshot("1.1.0", suffix);
  return { extractor: { async extract() { return current; } }, fingerprint: { sha256() { return "a".repeat(64); } },
    acceptedDecisionEvidence: { async readAcceptedDecisionEvidence() { throw new Error("unused"); } }, repository: {
      async readReleasedBaseline() { return released; }, async readReleaseEvidence() { return { packageName: `fixture${suffix}`, packageVersion: "1.1.0", declaredBump: "minor" }; },
      async describeReleasedBaselineWrite(_root, packagePolicy, _snapshot, operation) { return { destination: packagePolicy.releasedBaselinePath,
        operation, preimageDigest: `sha256:${"1".repeat(64)}`, proposedDigest: `sha256:${(suffix === "" ? "2" : "3").repeat(64)}` }; },
      async writeReleasedBaseline() { writes.push(suffix); }
    } };
}

test("one rejected exact promotion plan prevents every baseline write", async () => {
  const writes = [], surfaces = [surface("", writes), surface("-artifact", writes)];
  const input = { consumerRoot: "/fixture", policy: { schemaVersion: 1, acceptedDecisionBaselinePath: "architecture/decisions.json",
    changesetDirectory: ".changeset", packages: [policy("")] } };
  surfaces[1].repository.readReleaseEvidence = async () => ({ packageName: "fixture", packageVersion: "1.1.0", declaredBump: "minor" });
  surfaces[1].repository.readReleasedBaseline = async () => ({ ...snapshot("1.0.0"), extractorVersion: "7.58.12" });
  surfaces[1].extractor.extract = async () => snapshot("1.1.0");
  await assert.rejects(preflightPublicApiPromotions(input, surfaces, async plan => {
    assert.equal(plan.length, 2);
    throw new Error("forged or mismatched receipt");
  }), /forged or mismatched receipt/);
  assert.deepEqual(writes, []);
});

test("authorization precedes all writes and exact replay retains an empty plan", async () => {
  const writes = [], events = [], one = surface("", writes);
  const input = { consumerRoot: "/fixture", policy: { schemaVersion: 1, acceptedDecisionBaselinePath: "architecture/decisions.json",
    changesetDirectory: ".changeset", packages: [policy("")] } };
  await preflightPublicApiPromotions(input, [one], async plan => { events.push(["authorize", plan.length]); });
  assert.deepEqual(events, [["authorize", 1]]);
  assert.deepEqual(writes, [""]);
  one.repository.readReleaseEvidence = async () => ({ packageName: "fixture", packageVersion: "1.0.0" });
  one.extractor.extract = async () => snapshot("1.0.0");
  await preflightPublicApiPromotions(input, [one], async plan => { events.push(["replay", plan.length]); });
  assert.deepEqual(events.at(-1), ["replay", 0]);
});
