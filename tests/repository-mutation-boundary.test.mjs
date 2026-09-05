import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tmpdir } from "node:os";
import { claimMutation, observeMutationState, releaseMutationLease } from "../packages/repository-mutation/dist/node.js";

import { compileRepositoryMutationEnvelope, parseRepositoryMutationEnvelope } from "../packages/repository-mutation/dist/index.js";
import * as genericCoordination from "../packages/repository-mutation/dist/coordination.js";
import { canonicalJson, sha256Json, sha256Text } from "../packages/repository-mutation/dist/serialization.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repositoryRoot, "packages", "repository-mutation");

async function filesBelow(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {files.push(...await filesBelow(path));}
    else if (entry.isFile()) {files.push(path);}
  }
  return files;
}

test("keeps Repository Mutation a zero-monorepo-dependency packed closure", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@agent-teams/repository-mutation");
  assert.match(manifest.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).toSorted(), [
    ".", "./coordination", "./known-file", "./node", "./package.json", "./paths", "./qualification", "./schemas/*", "./serialization"
  ]);

  const files = (await filesBelow(packageRoot)).filter((path) =>
    /(?:src|dist|schemas)[/\\]/u.test(relative(packageRoot, path)));
  assert.ok(files.length > 0);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /@agent-teams\/(?:engineering-foundation|docs-protocol)/u,
      relative(repositoryRoot, path));
  }
});

test("coordination has no reverse edge to file operations and application has no Node IO", async () => {
  const { parseSync } = await import("oxc-parser");
  const sources = (await filesBelow(join(packageRoot, "src"))).filter((path) => path.endsWith(".ts"));
  const { dirname, resolve, sep } = await import("node:path");
  const coordination = join(packageRoot, "src", "transaction-coordination");
  const operations = join(packageRoot, "src", "repository-mutation");
  const graph = new Map();
  for (const path of sources) {
    const source = await readFile(path, "utf8");
    const parsed = parseSync(path, source);
    assert.deepEqual(parsed.errors, [], path);
    const references = parsed.program.body.flatMap((node) =>
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source
        ? [node.source.value] : []);
    graph.set(path, references.filter((specifier) => specifier.startsWith(".")).map((specifier) =>
      resolve(dirname(path), specifier.replace(/\.js$/u, ".ts"))));
    if (path.includes(`${sep}application${sep}`) || path.endsWith("application-api.ts")) {
      for (const specifier of references) {
        assert.doesNotMatch(specifier, /(?:adapters|composition)|node:(?:fs|path|os|child_process|util)/u, path);
      }
    }
  }
  function reachesOperation(path, seen = new Set()) {
    if (path.startsWith(operations)) { return true; }
    if (seen.has(path)) { return false; }
    seen.add(path);
    return (graph.get(path) ?? []).some((target) => reachesOperation(target, seen));
  }
  for (const path of sources.filter((entry) => entry.startsWith(coordination))) {
    assert.equal(reachesOperation(path), false, `coordination reverse dependency from ${relative(packageRoot, path)}`);
  }
  const lease = await readFile(join(coordination, "application", "mutation-lease.ts"), "utf8");
  assert.doesNotMatch(lease, /node:|NodeMutationOperationLock|process\.|Date\.|Math\.random/u);
});

test("pure package surfaces expose only their exact contracts", async () => {
  const serialization = await import("../packages/repository-mutation/dist/serialization.js");
  const paths = await import("../packages/repository-mutation/dist/paths.js");
  const coordination = await import("../packages/repository-mutation/dist/coordination.js");
  const knownFile = await import("../packages/repository-mutation/dist/known-file.js");
  assert.deepEqual(Object.keys(serialization).toSorted(), [
    "CanonicalJsonError", "StrictJsonError", "canonicalJson", "parseStrictJson", "sha256Bytes", "sha256Json", "sha256Text"
  ]);
  assert.deepEqual(Object.keys(paths).toSorted(), ["portableRepositoryPathIdentity", "portableRepositoryPathProblem"]);
  assert.deepEqual(Object.keys(coordination).toSorted(), [
    "REPOSITORY_MUTATION_ENVELOPE_FORMAT", "REPOSITORY_MUTATION_PACKAGE_NAME", "RepositoryMutationEnvelopeError",
    "RepositoryMutationError", "assertRepositoryMutationArtifactBindings", "compileRepositoryMutationEnvelope", "parseRepositoryMutationEnvelope"
  ]);
  assert.deepEqual(Object.keys(knownFile).toSorted(), [
    "KnownFileTransactionError", "KnownFileTransactionPlanError", "assertKnownFileTransactionEnvelope",
    "assertKnownFileTransactionPlan", "canonicalKnownFileTransactionReceipt", "compileKnownFileTransactionPlan"
  ]);
});

// Both providers run the same authority protocol; the memory provider has no Node IO.
for (const provider of ["memory", "node"]) {
  test(`lease authority protocol is substitutable with ${provider} observations`, async () => {
    const { createMutationLeaseOperations, consumeMutationClaim, retainMutationBarrier } = await import(
      "../packages/repository-mutation/dist/transaction-coordination/application/mutation-lease.js"
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), "mutation-port-parity-")));
    const released = [];
    let revision = 0;
    const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    const memoryPort = {
      canonicalRoot: async () => root,
      physicalRootIdentity: async () => identity,
      acquire: async () => async (options) => { released.push(options); },
      snapshot: async () => ({ fingerprint: `state-${revision}`, commonEvidence: revision > 0 })
    };
    const { nodeMutationLeasePort } = await import(
      "../packages/repository-mutation/dist/transaction-coordination/adapters/node/node-mutation-observation.js"
    );
    const selected = provider === "memory" ? memoryPort : nodeMutationLeasePort;
    const operations = createMutationLeaseOperations(selected);
    const fixtureArtifact = { name: "fixture-owner", version: "1.0.0", buildIdentity: `sha256:${"1".repeat(64)}` };
    let lease;
    try {
      lease = await operations.acquireMutationLease(root);
      await assert.rejects(observeMutationState({}), /forged, released/u);
      const observation = await observeMutationState(lease);
      const intent = { kind: "apply-known-file", planDigest: `sha256:${"4".repeat(64)}`,
        ownerArtifact: fixtureArtifact, kernelArtifact: fixtureArtifact };
      const claim = await claimMutation(lease, observation, intent);
      await assert.rejects(claimMutation(lease, observation, intent), /forged, stale/u);
      assert.equal(await consumeMutationClaim(claim, "apply-known-file"), root);
      await assert.rejects(consumeMutationClaim(claim, "apply-known-file"), /forged, consumed/u);
      const beforeEvidence = await observeMutationState(lease);
      if (provider === "memory") { revision += 1; }
      else { await writeFile(join(root, ".agent-teams-local", "scaffolding-transaction.json"), "unknown evidence"); }
      await assert.rejects(claimMutation(lease, beforeEvidence, intent), /became stale/u);
      await assert.rejects(claimMutation(lease, await observeMutationState(lease), intent), /must be recovered/u);
      const recovery = await claimMutation(lease, await observeMutationState(lease), {
        kind: "recover-known-file", ownerArtifact: fixtureArtifact, kernelArtifact: fixtureArtifact
      });
      assert.equal(await consumeMutationClaim(recovery, "recover-known-file"), root);
      retainMutationBarrier(lease);
      await releaseMutationLease(lease);
      await assert.rejects(observeMutationState(lease), /forged, released/u);
      lease = undefined;
      if (provider === "memory") { assert.deepEqual(released, [{ retainTransactionBarrier: true }]); }
      else { assert.match(await readFile(join(root, ".agent-teams-local", "foundation-operation.lock"), "utf8"), /barrier/iu); }
    } finally {
      if (lease !== undefined) { await releaseMutationLease(lease); }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an alternate lease port retains the barrier after physical root replacement", async () => {
  const { createMutationLeaseOperations } = await import("../packages/repository-mutation/dist/transaction-coordination/application/mutation-lease.js");
  let identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
  const released = [];
  const { acquireMutationLease: acquire } = createMutationLeaseOperations({
    canonicalRoot: async (root) => root,
    physicalRootIdentity: async () => identity,
    acquire: async () => async (options) => { released.push(options); },
    snapshot: async () => ({ fingerprint: "empty", commonEvidence: false })
  });
  const lease = await acquire("explicit-memory-root");
  identity = { ...identity, ino: 4n };
  await assert.rejects(observeMutationState(lease), /root changed/u);
  await releaseMutationLease(lease);
  assert.deepEqual(released, [{ retainTransactionBarrier: true }]);
});

function genericEnvelopeInput(payload) {
  const identity = { name: "fixture-owner", version: "1.0.0", buildIdentity: `sha256:${"1".repeat(64)}` };
  return { operationKind: "fixture-operation", recoveryHandler: { id: "fixture-handler/v1", contractVersion: 1 },
    ownerArtifact: identity, kernelArtifact: identity, adapterContractVersion: 1,
    payloadKind: "fixture-payload/v1", state: "PREPARED", payload };
}

test("generic envelope cloning preserves the admitted own __proto__ key", () => {
  const payload = JSON.parse('{"__proto__":null,"retained":true}');
  const envelope = genericCoordination.compileRepositoryMutationEnvelope(genericEnvelopeInput(payload));
  assert.equal(canonicalJson(envelope.payload), '{"__proto__":null,"retained":true}');
  assert.ok(Object.hasOwn(envelope.payload, "__proto__"));
  assert.equal(Object.getPrototypeOf(envelope.payload), Object.prototype);
  assert.equal(genericCoordination.compileRepositoryMutationEnvelope, compileRepositoryMutationEnvelope);
  assert.equal(genericCoordination.parseRepositoryMutationEnvelope, parseRepositoryMutationEnvelope);
});

function assertDetachedFrozenPayload(actual, input) {
  if (input === null || typeof input !== "object") {
    assert.equal(actual, input);
    return;
  }
  assert.notEqual(actual, input);
  assert.ok(Object.isFrozen(actual));
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.getPrototypeOf(actual), Array.isArray(input) ? Array.prototype : Object.prototype);
  assert.deepEqual(Object.keys(actual), Object.keys(input));
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key);
    assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
    assertDetachedFrozenPayload(descriptor.value, input[key]);
  }
}

for (const jsonValue of ["null", "0", '"text"', "false", "[]",
  '[null,{"__proto__":{"nested":[true]}}]',
  '{"__proto__":null,"entries":[{"constructor":1,"prototype":2,"then":3}]}']) {
  for (const prototype of [Object.prototype, null]) {
    test(`generic envelope preserves prototype-named data ${jsonValue} with ${prototype === null ? "null" : "plain"} prototype`, () => {
      const record = JSON.parse(`{"__proto__":${jsonValue},"constructor":${jsonValue},"prototype":${jsonValue},"then":${jsonValue}}`);
      Object.setPrototypeOf(record, prototype);
      const payload = { nested: [record, null, true, 42, "leaf"] };
      const before = canonicalJson(payload);
      const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
      const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput(payload));
      assert.equal(canonicalJson(envelope.payload), before);
      assert.equal(envelope.payloadDigest, sha256Text(before));
      assertDetachedFrozenPayload(envelope.payload, payload);
      for (const serialize of [canonicalJson, JSON.stringify]) {
        const parsed = parseRepositoryMutationEnvelope(Buffer.from(serialize(envelope)));
        assert.deepEqual(parsed, envelope);
        assertDetachedFrozenPayload(parsed.payload, payload);
      }
      assert.equal(canonicalJson(payload), before);
      assert.equal(Object.getPrototypeOf(record), prototype);
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
      record.__proto__ = "caller edit";
      payload.nested.push("caller append");
      assert.equal(canonicalJson(envelope.payload), before);
    });
  }
}

test("generic envelope cloning retains root JSON values and binary key order", () => {
  for (const payload of [null, false, true, 0, 42, "", "é", [], [null, 1, false], {}]) {
    const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput(payload));
    assert.deepEqual(envelope.payload, payload);
    assert.deepEqual(parseRepositoryMutationEnvelope(Buffer.from(canonicalJson(envelope))), envelope);
  }
  const payload = JSON.parse('{"é":1,"then":2,"prototype":3,"constructor":4,"__proto__":null,"a":5,"Z":6,"2":7,"10":8,"!":9}');
  const expected = '{"!":9,"10":8,"2":7,"Z":6,"__proto__":null,"a":5,"constructor":4,"prototype":3,"then":2,"é":1}';
  const envelope = compileRepositoryMutationEnvelope(genericEnvelopeInput(payload));
  assert.equal(canonicalJson(envelope.payload), expected);
  assert.equal(envelope.payloadDigest, sha256Text(expected));
});

test("generic envelope admission still rejects executable or non-data prototype-named values", () => {
  let invoked = 0;
  for (const key of ["__proto__", "constructor", "prototype", "then"]) {
    for (const descriptor of [
      { enumerable: true, get() { invoked += 1; return null; } },
      { enumerable: true, set(_value) { invoked += 1; } },
      { enumerable: false, value: null },
      { enumerable: true, value: () => { invoked += 1; } },
      { enumerable: true, value: Symbol("value") }
    ]) {
      const payload = Object.defineProperty({}, key, descriptor);
      assert.throws(() => compileRepositoryMutationEnvelope(genericEnvelopeInput({ nested: [payload] })),
        /data properties|JSON data model/u);
    }
  }
  assert.equal(invoked, 0);
  const symbolic = JSON.parse('{"__proto__":null}');
  symbolic[Symbol("key")] = true;
  const cyclic = JSON.parse('{"__proto__":null}');
  cyclic.__proto__ = cyclic;
  const arrayCycle = [];
  arrayCycle.push(arrayCycle);
  for (const payload of [symbolic, cyclic, arrayCycle, { __proto__: { inherited: true } }]) {
    assert.throws(() => compileRepositoryMutationEnvelope(genericEnvelopeInput(payload)),
      /noncanonical object key|too deep|cycles|plain or null prototype/u);
  }
});

test("generic envelope parsing binds own prototype-named data and rejects tampering", () => {
  const payload = JSON.parse('{"__proto__":{"then":[null]},"constructor":1,"prototype":2}');
  const body = { ...genericEnvelopeInput(payload), schemaVersion: 6,
    format: "agent-teams.repository-mutation.transaction-envelope/v1", payloadDigest: sha256Json(payload) };
  const wire = { ...body, envelopeDigest: sha256Json(body) };
  assert.equal(canonicalJson(parseRepositoryMutationEnvelope(Buffer.from(JSON.stringify(wire)))), canonicalJson(wire));
  const tampered = JSON.parse(JSON.stringify(wire));
  delete tampered.payload.__proto__;
  assert.throws(() => parseRepositoryMutationEnvelope(Buffer.from(JSON.stringify(tampered))), /digest/u);
  const duplicate = JSON.stringify(wire).replace('"__proto__":', '"\\u005f_proto__":null,"__proto__":');
  assert.throws(() => parseRepositoryMutationEnvelope(Buffer.from(duplicate)), /strict UTF-8 JSON/u);
});

test("generic envelope parsing preserves historical payloads whose own key was already lost", () => {
  // Captured from candidate 68d96b5 before the cloning correction; never infer lost data.
  const historical = { ...genericEnvelopeInput({ retained: true }), schemaVersion: 6,
    format: "agent-teams.repository-mutation.transaction-envelope/v1",
    payloadDigest: "sha256:af7e0e60ef1cb6299c9cf719e651eac394d2005ba01ea0028f5b8c88c6ef992d",
    envelopeDigest: "sha256:117ae9757cb149e4babd4787337252eb5d43685cde798c23fe63b69c69c3325a" };
  const bytes = Buffer.from(canonicalJson(historical));
  const parsed = parseRepositoryMutationEnvelope(bytes);
  assert.equal(canonicalJson(parsed), bytes.toString("utf8"));
  assert.equal(Object.hasOwn(parsed.payload, "__proto__"), false);
  assert.deepEqual(compileRepositoryMutationEnvelope(genericEnvelopeInput({ retained: true })), parsed);
  const corrected = compileRepositoryMutationEnvelope(genericEnvelopeInput(JSON.parse('{"__proto__":null,"retained":true}')));
  assert.notEqual(corrected.payloadDigest, parsed.payloadDigest);
  assert.notEqual(corrected.envelopeDigest, parsed.envelopeDigest);
});
