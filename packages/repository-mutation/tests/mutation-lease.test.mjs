import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKnownFileTransaction,
  compileRepositoryMutationEnvelope,
  compileKnownFileTransactionPlan,
  canonicalJson,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  parseRepositoryMutationEnvelope,
  assertRepositoryMutationArtifactBindings,
  REPOSITORY_MUTATION_PACKAGE_NAME
} from "../dist/index.js";
import {
  acquireMutationLease,
  claimMutation,
  observeMutationState,
  releaseMutationLease
} from "../dist/node.js";

function genericEnvelopeInput(payload = { entries: ["one", { nested: true }] }) {
  const identity = {
    name: "fixture-owner",
    version: "1.0.0",
    buildIdentity: `sha256:${"1".repeat(64)}`
  };
  return {
    operationKind: "fixture-operation",
    recoveryHandler: { id: "fixture-handler/v1", contractVersion: 1 },
    ownerArtifact: identity,
    kernelArtifact: identity,
    adapterContractVersion: 1,
    payloadKind: "fixture-payload/v1",
    state: "PREPARED",
    payload
  };
}

test("generic persisted envelopes round-trip as deeply immutable library data", () => {
  const input = genericEnvelopeInput();
  const envelope = compileRepositoryMutationEnvelope(input);
  input.payload.entries[1].nested = false;
  assert.equal(envelope.payload.entries[1].nested, true);
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.payload));
  assert.ok(Object.isFrozen(envelope.payload.entries));
  assert.ok(Object.isFrozen(envelope.payload.entries[1]));
  assert.deepEqual(
    parseRepositoryMutationEnvelope(Buffer.from(JSON.stringify(envelope), "utf8")),
    envelope
  );
});

test("generic persisted envelopes reject malformed, unbounded, and tampered evidence", () => {
  assert.throws(
    () => compileRepositoryMutationEnvelope({ ...genericEnvelopeInput(), extra: true }),
    /unknown or missing/u
  );
  let invoked = false;
  const executable = genericEnvelopeInput();
  Object.defineProperty(executable, "state", {
    enumerable: true,
    get() {invoked = true; return "PREPARED";}
  });
  assert.throws(() => compileRepositoryMutationEnvelope(executable), /unknown or missing/u);
  assert.equal(invoked, false);
  const payloadArray = ["safe"];
  Object.defineProperty(payloadArray, "0", {
    enumerable: true,
    get() {invoked = true; return "unsafe";}
  });
  assert.throws(
    () => compileRepositoryMutationEnvelope(genericEnvelopeInput(payloadArray)),
    /enumerable data properties/u
  );
  assert.equal(invoked, false);
  assert.throws(
    () => compileRepositoryMutationEnvelope(genericEnvelopeInput(Object.create({ inherited: true }))),
    /plain or null prototype/u
  );
  let deep = "leaf";
  for (let index = 0; index < 66; index += 1) {deep = [deep];}
  assert.throws(
    () => compileRepositoryMutationEnvelope(genericEnvelopeInput(deep)),
    /too deep/u
  );
  const tampered = JSON.parse(JSON.stringify(compileRepositoryMutationEnvelope(genericEnvelopeInput())));
  tampered.payload.entries[0] = "changed";
  assert.throws(
    () => parseRepositoryMutationEnvelope(Buffer.from(JSON.stringify(tampered), "utf8")),
    /digest/u
  );
  assert.throws(
    () => parseRepositoryMutationEnvelope(Buffer.from('{"schemaVersion":6,"schemaVersion":6}', "utf8")),
    /strict UTF-8 JSON/u
  );
});

test("envelope payload validation preserves dense inert data and binary canonical ordering", () => {
  const payload = Object.assign(Object.create(null), {
    z: [null, true, { nested: [] }], A: 1, "é": "value", _: false
  });
  const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput(payload));
  assert.equal(canonicalJson(envelope.payload), '{"A":1,"_":false,"z":[null,true,{"nested":[]}],"é":"value"}');
  assert.ok(Object.isFrozen(envelope.payload.z[2].nested));
  assert.deepEqual(parseRepositoryMutationEnvelope(Buffer.from(canonicalJson(envelope))), envelope);
  const sparse = [];
  sparse.length = 1;
  for (const value of [undefined, () => null, Symbol("payload"), 1n, NaN, Infinity, -0,
    Object.assign(Object.create({ inherited: true }), { own: 1 }), sparse,
    Object.setPrototypeOf([], null), Object.assign([], { extra: true }),
    { [Symbol("key")]: true }]) {
    assert.throws(() => compileRepositoryMutationEnvelope(genericEnvelopeInput({ value })),
      /canonical|plain or null|JSON data model/u);
  }
  for (const container of [{ item: "safe" }, ["safe"]]) {
    const key = Array.isArray(container) ? "0" : "item";
    Object.defineProperty(container, key, {
      enumerable: true, configurable: true,
      get() { throw new Error("payload accessor was invoked"); }
    });
    assert.throws(() => compileRepositoryMutationEnvelope(genericEnvelopeInput(container)), /data properties/u);
    Object.defineProperty(container, key, { value: "safe", enumerable: false });
    assert.throws(() => compileRepositoryMutationEnvelope(genericEnvelopeInput(container)), /data properties/u);
  }
});

test("envelope parsing rejects duplicate decoded keys inside nested objects and arrays", () => {
  const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput());
  for (const payload of ['[{"key":1,"\\u006bey":2}]', '{"nested":[{"key":1,"key":2}]}']) {
    const source = JSON.stringify(envelope).replace(JSON.stringify(envelope.payload), payload);
    assert.throws(() => parseRepositoryMutationEnvelope(Buffer.from(source)), /strict UTF-8 JSON/u);
  }
});

test("artifact binding checks all owner and kernel identity fields", () => {
  const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput());
  assert.doesNotThrow(() => assertRepositoryMutationArtifactBindings(
    envelope, envelope.ownerArtifact, envelope.kernelArtifact
  ));
  for (const side of ["owner", "kernel"]) {
    const drifted = { ...envelope[`${side}Artifact`], buildIdentity: `sha256:${"2".repeat(64)}` };
    assert.throws(
      () => assertRepositoryMutationArtifactBindings(
        envelope,
        side === "owner" ? drifted : envelope.ownerArtifact,
        side === "kernel" ? drifted : envelope.kernelArtifact
      ),
      /exact owner and kernel artifacts/u
    );
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "repository-mutation-lease-"));
  t.after(async () => {await rm(root, { recursive: true, force: true });});
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

test("binds an external claim to the acquired physical repository root", async (t) => {
  const root = await fixture(t);
  const displaced = `${root}.displaced`;
  t.after(async () => {await rm(displaced, { force: true, recursive: true });});
  const selectedPlan = plan();
  const lease = await acquireMutationLease(root);
  const claim = await validClaim(lease, selectedPlan);
  await rename(root, displaced);
  await mkdir(root);
  try {
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan: selectedPlan, claim }),
      /physical lease|repository root changed/u
    );
    await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
    await rename(displaced, root);
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

test("intent snapshots reject arbitrary JS values while accepting null-prototype data", async (t) => {
  const root = await fixture(t);
  const lease = await acquireMutationLease(root);
  try {
    const identity = await artifact();
    const valid = {
      kind: "apply-known-file", planDigest: plan().planDigest,
      ownerArtifact: identity, kernelArtifact: identity
    };
    const observation = await observeMutationState(lease);
    for (const candidate of [null, undefined, 1, false, "intent", Symbol("intent"), [], () => null,
      Object.assign(Object.create({ inherited: true }), valid)]) {
      await assert.rejects(claimMutation(lease, observation, candidate), /not inert record data/u);
    }
    for (const side of ["ownerArtifact", "kernelArtifact"]) {
      for (const value of [null, undefined, [], Object.create(identity)]) {
        await assert.rejects(claimMutation(lease, observation, { ...valid, [side]: value }),
          /not inert record data/u);
      }
    }
    const intent = Object.assign(Object.create(null), {
      ...valid,
      ownerArtifact: Object.assign(Object.create(null), identity),
      kernelArtifact: Object.assign(Object.create(null), identity)
    });
    const claim = await claimMutation(lease, observation, intent);
    const options = Object.assign(Object.create(null), { consumerRoot: root, plan: plan(), claim });
    assert.equal((await applyKnownFileTransaction(options)).outcome, "applied");
    assert.equal(await readFile(join(root, "owned.txt"), "utf8"), "owned\n");
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

for (const residue of [
  "Scaffolding-transaction.json",
  "Scaffolding-transaction.json.completed-known-file-evidence",
  "scaffolding-transaction.json.unknown-owner",
  "foundation-transaction.cleanup-residue.fixture"
]) {
  test(`fails closed on common evidence residue ${residue}`, async (t) => {
    const root = await fixture(t);
    const state = join(root, ".agent-teams-local");
    await mkdir(state);
    await writeFile(join(state, residue), "preserved\n");
    await assert.rejects(
      applyKnownFileTransaction({ consumerRoot: root, plan: plan() }),
      /Common transaction evidence|recovered before apply/u
    );
    await assert.rejects(readFile(join(root, "owned.txt")), { code: "ENOENT" });
  });
}
