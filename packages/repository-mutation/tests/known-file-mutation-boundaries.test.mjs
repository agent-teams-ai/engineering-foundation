import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Mutation production boundaries have one layer owner and no outgoing violations", async () => {
  const invocation = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../../scripts/check-feature-modules.mjs", import.meta.url))
  ], { encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(invocation.error, undefined, invocation.error?.message);
  assert.ok(invocation.status === 0 || invocation.status === 1, invocation.stderr);
  const result = JSON.parse(invocation.stdout);
  assert.equal(result.modules, 6);
  const owned = result.problems.filter(({ code, message }) =>
    message.startsWith("packages/repository-mutation/") ||
    message.startsWith("repository-mutation.") ||
    ["input-error", "source-snapshot", "source-policy"].includes(code)
  );
  assert.deepEqual(owned, []);
});

const admission = await import("../dist/repository-mutation/application/policies/known-file-mutation-admission.js");
const codec = await import("../dist/repository-mutation/application/policies/known-file-transaction-envelope.js");
const { KnownFileTransactionError } = await import("../dist/index.js");
const { RepositoryMutationEnvelopeError } = await import("../dist/coordination.js");
const artifact = Object.freeze({
  name: "@agent-teams/repository-mutation", version: "0.1.0", buildIdentity: `sha256:${"1".repeat(64)}`
});
const planDigest = `sha256:${"2".repeat(64)}`;

for (const kind of ["apply-known-file", "recover-known-file"]) {
  test(`${kind} binds both exact artifacts and preserves the supplied claim`, async () => {
    const claim = Object.freeze({});
    const lease = Object.freeze({});
    const observation = Object.freeze({});
    const intent = {
      kind, ownerArtifact: artifact, kernelArtifact: artifact,
      ...(kind === "apply-known-file" ? { planDigest } : {})
    };
    const ensure = kind === "apply-known-file" ? admission.ensureApplyClaim : admission.ensureRecoveryClaim;
    let observed = 0;
    const port = {
      observeMutationState: async (value) => { assert.equal(value, lease); observed++; return observation; },
      claimMutation: async (value, snapshot, input) => {
        assert.equal(value, lease);
        assert.equal(snapshot, observation);
        assert.deepEqual(input, intent);
        assert.equal(input.ownerArtifact, artifact);
        assert.equal(input.kernelArtifact, artifact);
        return claim;
      }
    };
    assert.equal(await ensure(port, { artifact, claim, lease: undefined, planDigest }), claim);
    assert.equal(observed, 0, "A caller-owned claim must not acquire a second observation");
    assert.equal(await ensure(port, { artifact, claim: undefined, lease, planDigest }), claim);
    assert.equal(observed, 1);

    const admit = kind === "apply-known-file" ? admission.assertApplyClaim : admission.assertRecoveryClaim;
    const code = kind === "apply-known-file" ? "KNOWN_FILE_PLAN_INVALID" : "KNOWN_FILE_RECOVERY_CONFLICT";
    const inputs = [
      { ...intent, kind: "wrong-kind" },
      ...["ownerArtifact", "kernelArtifact"].flatMap((side) =>
        ["name", "version", "buildIdentity"].map((field) => ({
          ...intent, [side]: { ...artifact, [field]: "different" }
        }))
      ),
      ...(kind === "apply-known-file" ? [{ ...intent, planDigest: `sha256:${"3".repeat(64)}` }] : [])
    ];
    for (const invalid of inputs) {
      await assert.rejects(admit({
        mutationClaimIntent: (value) => { assert.equal(value, claim); return invalid; },
        consumeMutationClaim: () => assert.fail("An incompatible claim must not be consumed")
      }, { artifact, claim, planDigest, root: "/fixture" }), (error) =>
        error instanceof KnownFileTransactionError && error.code === code
      );
    }
    for (const root of ["/fixture", "/different-root"]) {
      const result = admit({
        mutationClaimIntent: () => intent,
        consumeMutationClaim: async (value, expectedKind) => {
          assert.equal(value, claim);
          assert.equal(expectedKind, kind);
          return root;
        }
      }, { artifact, claim, planDigest, root: "/fixture" });
      if (root === "/fixture") { await result; }
      else { await assert.rejects(result, (error) => error instanceof KnownFileTransactionError && error.code === code); }
    }
  });
}

test("recovery retains its newly acquired claim when consumption is cancelled", {
  skip: process.platform === "win32" ? "Windows rejects recovery before acquisition; covered by existing platform suite" : false
}, async (t) => {
  const { mkdtemp, realpath, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { recoverKnownFileTransactionWithFaults } = await import("../dist/repository-mutation/adapters/node/node-known-file-transaction-recovery.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "mutation-admission-cancel-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const abort = new DOMException("cancelled at admission", "AbortError");
  const claim = Object.freeze({});
  const lease = Object.freeze({});
  const events = [];
  const port = {
    acquireMutationLease: async (value) => { assert.equal(value, root); return lease; },
    installedRepositoryMutationVersion: async () => artifact.version,
    installedRepositoryMutationBuildIdentity: async () => artifact.buildIdentity,
    observeMutationState: async (value) => { assert.equal(value, lease); return Object.freeze({}); },
    claimMutation: async () => claim,
    mutationClaimIntent: () => ({ kind: "recover-known-file", ownerArtifact: artifact, kernelArtifact: artifact }),
    consumeMutationClaim: async () => { throw abort; },
    retainMutationClaimBarrierOnEvidence: async (value) => { assert.equal(value, claim); events.push("claim-retained"); },
    retainMutationBarrierOnEvidence: async (value) => { assert.equal(value, lease); events.push("lease-evidence-retained"); return true; },
    retainMutationBarrier: (value) => { assert.equal(value, lease); events.push("barrier-retained"); },
    releaseMutationLease: async (value) => { assert.equal(value, lease); events.push("released"); }
  };
  await assert.rejects(recoverKnownFileTransactionWithFaults(port, { consumerRoot: root }), (error) => error === abort);
  assert.deepEqual(events, ["claim-retained", "lease-evidence-retained", "barrier-retained", "released"]);
  assert.deepEqual(await readdir(root), [], "Cancellation before journal creation must leave no effects");
});

test("the journal codec reproduces historical valid bytes and exact rejection identities", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixtures = new URL("../../../tests/fixtures/repository-mutation-known-file/", import.meta.url);
  const bytes = await readFile(new URL("base-valid-applying-envelope.json", fixtures));
  const copy = Buffer.from(bytes);
  const stored = JSON.parse(bytes);
  const decoded = codec.decodeKnownFileTransactionEnvelope(bytes, stored.ownerArtifact, stored.kernelArtifact);
  assert.deepEqual(codec.encodeKnownFileTransactionEnvelope(decoded), bytes);
  assert.equal(decoded.envelopeDigest, "sha256:43d2d9ac1875b007510ff0fb3f89fcab64f1d4642f56a15c15836f07fd451d45");
  assert.deepEqual(decoded.payload.plan.operations.map(({ path }) => path), ["managed/a.txt", "managed/b.txt"]);
  for (const side of ["ownerArtifact", "kernelArtifact"]) {
    for (const field of ["name", "version", "buildIdentity"]) {
      const changed = { ...stored[side], [field]: "different" };
      assert.throws(() => codec.decodeKnownFileTransactionEnvelope(bytes,
        side === "ownerArtifact" ? changed : stored.ownerArtifact,
        side === "kernelArtifact" ? changed : stored.kernelArtifact
      ), RepositoryMutationEnvelopeError);
    }
  }
  assert.throws(() => codec.decodeKnownFileTransactionEnvelope(Buffer.from("not json"), stored.ownerArtifact, stored.kernelArtifact), RepositoryMutationEnvelopeError);
  assert.throws(() => codec.decodeKnownFileTransactionEnvelope(Buffer.from(JSON.stringify(stored, null, 2)), stored.ownerArtifact, stored.kernelArtifact), /journal bytes are not canonical/u);
  assert.deepEqual(bytes, copy);
});
