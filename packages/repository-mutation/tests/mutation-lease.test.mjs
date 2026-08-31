import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireMutationLease,
  applyKnownFileTransaction,
  claimMutation,
  compileKnownFileTransactionPlan,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  observeMutationState,
  releaseMutationLease,
  REPOSITORY_MUTATION_PACKAGE_NAME
} from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "repository-mutation-lease-"));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  return root;
}

function plan() {
  return compileKnownFileTransactionPlan({ operations: [{
    path: "owned.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("owned\n", "utf8") }
  }] });
}

async function artifact() {
  return {
    name: REPOSITORY_MUTATION_PACKAGE_NAME,
    version: await installedRepositoryMutationVersion(),
    buildIdentity: await installedRepositoryMutationBuildIdentity()
  };
}

async function validClaim(lease, selectedPlan) {
  const identity = await artifact();
  return claimMutation(lease, await observeMutationState(lease), {
    kind: "apply-known-file",
    planDigest: selectedPlan.planDigest,
    ownerArtifact: identity,
    kernelArtifact: identity
  });
}

test("rejects forged claims before effects", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: plan(), claim: Object.freeze({}) }),
    /forged|consumed/u
  );
  await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
});

test("rejects reused and wrong-root claims before effects", async (t) => {
  const firstRoot = await fixture(t);
  const secondRoot = await fixture(t);
  const selectedPlan = plan();
  const lease = await acquireMutationLease(firstRoot);
  try {
    const wrongRootClaim = await validClaim(lease, selectedPlan);
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: secondRoot, plan: selectedPlan, claim: wrongRootClaim }),
      /another repository root/u
    );
    const claim = await validClaim(lease, selectedPlan);
    await applyKnownFileTransaction({ consumerRoot: firstRoot, plan: selectedPlan, claim });
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: firstRoot, plan: selectedPlan, claim }),
      /consumed/u
    );
  } finally {
    await releaseMutationLease(lease);
  }
});

test("rejects released leases and stale observations", async (t) => {
  const root = await fixture(t);
  const lease = await acquireMutationLease(root);
  const observation = await observeMutationState(lease);
  const identity = await artifact();
  await claimMutation(lease, observation, {
    kind: "apply-known-file", planDigest: plan().planDigest,
    ownerArtifact: identity, kernelArtifact: identity
  });
  await assert.rejects(
    claimMutation(lease, observation, {
      kind: "apply-known-file", planDigest: plan().planDigest,
      ownerArtifact: identity, kernelArtifact: identity
    }),
    /stale/u
  );
  await releaseMutationLease(lease);
  await assert.rejects(observeMutationState(lease), /released/u);
});

test("rejects superseded claims and observations captured before consumption", async (t) => {
  const root = await fixture(t);
  const selectedPlan = plan();
  const lease = await acquireMutationLease(root);
  try {
    const supersededClaim = await validClaim(lease, selectedPlan);
    const observationBeforeSecondClaim = await observeMutationState(lease);
    const currentClaim = await validClaim(lease, selectedPlan);
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim: supersededClaim }),
      /generation became stale/u
    );
    const observationBeforeConsumption = await observeMutationState(lease);
    await applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim: currentClaim });
    const identity = await artifact();
    for (const staleObservation of [observationBeforeSecondClaim, observationBeforeConsumption]) {
      await assert.rejects(
        claimMutation(lease, staleObservation, {
          kind: "apply-known-file", planDigest: selectedPlan.planDigest,
          ownerArtifact: identity, kernelArtifact: identity
        }),
        /stale/u
      );
    }
  } finally {
    await releaseMutationLease(lease);
  }
});

for (const drifted of ["ownerArtifact", "kernelArtifact"]) {
  test(`rejects ${drifted} build drift before effects`, async (t) => {
    const root = await fixture(t);
    const selectedPlan = plan();
    const lease = await acquireMutationLease(root);
    try {
      const identity = await artifact();
      const changed = { ...identity, buildIdentity: `sha256:${"0".repeat(64)}` };
      const claim = await claimMutation(lease, await observeMutationState(lease), {
        kind: "apply-known-file",
        planDigest: selectedPlan.planDigest,
        ownerArtifact: drifted === "ownerArtifact" ? changed : identity,
        kernelArtifact: drifted === "kernelArtifact" ? changed : identity
      });
      await assert.rejects(
        applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim }),
        /claim belongs|wrong intent/u
      );
      await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
    } finally {
      await releaseMutationLease(lease);
    }
  });
}

test("captures a closed immutable intent instead of caller-owned nested objects", async (t) => {
  const root = await fixture(t);
  const selectedPlan = plan();
  const otherPlan = compileKnownFileTransactionPlan({ operations: [{
    path: "other.txt",
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.from("other\n", "utf8") }
  }] });
  const lease = await acquireMutationLease(root);
  try {
    const identity = await artifact();
    const intent = {
      kind: "apply-known-file",
      planDigest: selectedPlan.planDigest,
      ownerArtifact: { ...identity },
      kernelArtifact: { ...identity }
    };
    const claim = await claimMutation(
      lease,
      await observeMutationState(lease),
      intent
    );
    intent.planDigest = otherPlan.planDigest;
    intent.ownerArtifact.buildIdentity = `sha256:${"0".repeat(64)}`;
    intent.kernelArtifact.name = "foreign-kernel";
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan: otherPlan, claim }),
      /belongs to another repository root|wrong intent/u
    );
    await assert.rejects(readFile(join(root, "other.txt")), { code: "ENOENT" });
    assert.equal(
      (await applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim })).outcome,
      "applied"
    );
    assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "owned\n");
  } finally {
    await releaseMutationLease(lease);
  }
});

test("rejects executable, symbolic, and hidden intent properties without invoking them", async (t) => {
  const root = await fixture(t);
  const selectedPlan = plan();
  const lease = await acquireMutationLease(root);
  try {
    const identity = await artifact();
    let invoked = false;
    const executable = {
      kind: "apply-known-file",
      planDigest: selectedPlan.planDigest,
      get ownerArtifact() { invoked = true; return identity; },
      kernelArtifact: identity
    };
    await assert.rejects(
      claimMutation(lease, await observeMutationState(lease), executable),
      /enumerable data properties/u
    );
    assert.equal(invoked, false);

    for (const decorate of [
      (intent) => { intent[Symbol("executable")] = () => null; },
      (intent) => { Object.defineProperty(intent, "hidden", { value: true }); }
    ]) {
      const intent = {
        kind: "apply-known-file", planDigest: selectedPlan.planDigest,
        ownerArtifact: identity, kernelArtifact: identity
      };
      decorate(intent);
      await assert.rejects(
        claimMutation(lease, await observeMutationState(lease), intent),
        /invalid shape/u
      );
    }
  } finally {
    await releaseMutationLease(lease);
  }
});

test("revalidates common evidence before an already-satisfied no-op", async (t) => {
  const root = await fixture(t);
  const selectedPlan = plan();
  await writeFile(join(root, "owned.txt"), "owned\n");
  const lease = await acquireMutationLease(root);
  const claim = await validClaim(lease, selectedPlan);
  const journal = join(root, ".agent-teams-local", "scaffolding-transaction.json");
  await writeFile(journal, "{\"foreign\":true}\n");
  await assert.rejects(
    applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim }),
    /evidence became stale/u
  );
  assert.equal(await readFile(journal, "utf8"), "{\"foreign\":true}\n");
  await releaseMutationLease(lease);
  assert.match(
    await readFile(join(root, ".agent-teams-local", "foundation-operation.lock"), "utf8"),
    /transaction-barrier/u
  );
});
