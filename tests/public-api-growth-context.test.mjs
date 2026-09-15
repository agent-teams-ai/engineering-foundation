import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFilesystemGrowthInputContext } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/growth-input-context.js";
import { growthDimensions } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/model/growth-observation.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";
import { currentBaseline } from "./support/public-api-fixtures.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const cancellation = { throwIfCancelled() {} };
const policy = { schemaVersion: 1, acceptedDecisionBaselinePath: "accepted.json", changesetDirectory: ".changeset",
  packages: [{ packageName: "@fixture/public-api", packageRoot: "pkg", manifestPath: "pkg/package.json",
    tsconfigPath: "pkg/tsconfig.json", releasedBaselinePath: "old.json", approvedBreakingChanges: [], nonTypeExports: [],
    entrypoints: [{ exportPath: ".", declarationEntryPoint: "pkg/index.d.ts" }] }] };
const request = { trustedBasePath: "base.json", decisionsPath: "decisions.json", released: [
  { packageName: "@fixture/public-api", kind: "released", observationPath: "released.json" }
] };
function baseObservation() {
  return { contractRevision: "foundation:sdk-growth:c0:5", observationVersion: "foundation:sdk-growth:observation:1",
    repository: "fixture/sdk", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40), topologyDigest: digest,
    lockDigest: digest, toolchainDigest: digest, artifactDigests: [digest],
    tool: { version: "fixture", artifactDigest: digest, extractorVersion: "7.58.12" },
    coverage: [{ packageName: "@fixture/public-api", classification: "governed", dimensions: growthDimensions.map(dimension => ({
      dimension, status: dimension === "decision" ? "unavailable" : "complete", reasons: dimension === "decision" ? ["pre-S3"] : []
    })) }], entries: [] };
}
const dependencies = { assertSchema, fingerprint: { sha256(value) { return createHash("sha256").update(value).digest("hex"); } },
  repository: { async readReleaseEvidence() { return { packageName: "@fixture/public-api", packageVersion: "1.2.3" }; } },
  acceptedDecisionEvidence: { async readAcceptedDecisionEvidence() { throw new Error("unconfigured governance must not run"); } } };
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sdk-context-")));
  try {
    await writeFile(join(root, "base.json"), JSON.stringify(baseObservation()));
    await writeFile(join(root, "decisions.json"), "[]");
    await writeFile(join(root, "released.json"), JSON.stringify({ typed: currentBaseline(), artifact: {
      ...currentBaseline(), extractorVersion: "package-artifact-inventory/1"
    } }));
    await run(root, createFilesystemGrowthInputContext({ consumerRoot: root, policy }, dependencies));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("filesystem growth context preserves v1 evidence and never grants history or owner authority", async () => fixture(async (root, adapter) => {
  const before = await readFile(join(root, "released.json"));
  const context = await adapter.read(request, cancellation);
  assert.equal(context.authority.status, "unverified");
  assert.equal(context.retainedHistory.status, "unavailable");
  assert.equal(context.acceptedBreakingDecisions.growthDecisionAuthority.status, "unavailable");
  assert.equal(context.trustedBase.status, "available");
  assert.equal(context.trustedBaseReference.value.sourceTree, "2".repeat(40));
  assert.deepEqual(context.released[0].evidence.typed.value, currentBaseline());
  assert.deepEqual(await adapter.read(request, cancellation), context);
  assert.deepEqual(await readFile(join(root, "released.json")), before);
}));

test("filesystem growth context rejects verified claims embedded in any input", async () => fixture(async (root, adapter) => {
  for (const path of ["base.json", "decisions.json", "released.json"]) {
    const before = await readFile(join(root, path));
    await writeFile(join(root, path), JSON.stringify([{ nested: { authority: { status: "verified", receiptDigest: digest } } }]));
    await assert.rejects(adapter.read(request, cancellation), /cannot contain verified authority claims/u);
    await writeFile(join(root, path), before);
  }
}));

test("filesystem growth context retains missing evidence and refuses forged initial history", async () => fixture(async (root, adapter) => {
  await rm(join(root, "base.json")); await rm(join(root, "released.json")); await rm(join(root, "decisions.json"));
  const missing = await adapter.read(request, cancellation);
  assert.equal(missing.trustedBase.status, "unavailable");
  assert.equal(missing.released[0].evidence.artifact.status, "unavailable");
  const initial = { ...request, released: [{ packageName: "@fixture/public-api", kind: "initial-unreleased", trustedHistoryPath: "history.json" }] };
  await writeFile(join(root, "history.json"), JSON.stringify({ historyDigest: digest }));
  assert.equal((await adapter.read(initial, cancellation)).released[0].evidence.history.status, "unavailable");
  await writeFile(join(root, "history.json"), JSON.stringify({ status: "verified" }));
  await assert.rejects(adapter.read(initial, cancellation), /verified authority/u);
}));

test("filesystem growth context refuses malformed, escaping and symlinked evidence", async () => fixture(async (root, adapter) => {
  await writeFile(join(root, "decisions.json"), "{broken");
  await assert.rejects(adapter.read(request, cancellation), /valid UTF-8 JSON/u);
  await writeFile(join(root, "decisions.json"), "{}");
  await assert.rejects(adapter.read(request, cancellation), /JSON array/u);
  await assert.rejects(adapter.read({ ...request, trustedBasePath: "../base.json" }, cancellation), /Invalid audit path/u);
  await symlink(join(root, "base.json"), join(root, "link.json"));
  await assert.rejects(adapter.read({ ...request, trustedBasePath: "link.json" }, cancellation), /symlink unsupported/u);
}));

test("filesystem growth context propagates cancellation and unexpected dependency errors", async () => fixture(async (root, adapter) => {
  const failure = new Error("independent dependency failure");
  await assert.rejects(adapter.read(request, { throwIfCancelled() { throw failure; } }), error => error === failure);
  const broken = createFilesystemGrowthInputContext({ consumerRoot: root, policy }, { ...dependencies,
    repository: { async readReleaseEvidence() { throw failure; } } });
  await assert.rejects(broken.read(request, cancellation), error => error === failure);
}));
