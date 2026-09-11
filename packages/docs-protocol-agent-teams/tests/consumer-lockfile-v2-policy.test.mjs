import { registerConsumerTargetLockfileTests } from "./fixtures/target-lockfile/consumer-target-lockfile-cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { stringify } from "yaml";

import {
  assertQualifiedPnpmLockfileV2
} from "../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js";
import {
  computePnpmRuntimeClosureDigestV2
} from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";

const coordinate = Object.freeze({
  version: "0.1.0",
  integrity: `sha512-${"A".repeat(86)}==`
});

const desired = Object.freeze({
  cohort: Object.freeze({
    packages: Object.freeze({
      repositoryMutation: coordinate,
      documentAuthoring: coordinate,
      docsProtocol: coordinate,
      docsProtocolAgentTeams: coordinate,
      engineeringFoundation: coordinate
    }),
    runtime: Object.freeze({ runtimeClosureDigest: `sha256:${"0".repeat(64)}` })
  })
});

function assertOverrideRejected(field, selector) {
  const lockfile = `lockfileVersion: '9.0'
${field}:
  '${selector}': 0.1.0
`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_LOCKFILE_OVERRIDE");
      return true;
    }
  );
}

test("Cohort v2 rejects a repository-mutation override", () => {
  assertOverrideRejected("overrides", "@agent-teams/repository-mutation");
});

test("Cohort v2 rejects a document-authoring patch", () => {
  assertOverrideRejected("patchedDependencies", "@agent-teams/document-authoring@0.1.0");
});

function assertLockfileAliasRejected(importerPath, field, target) {
  const nested = importerPath === "." ? "" : `  '${importerPath}':
    ${field}:
      managedAlias:
        specifier: 'npm:${target}@0.1.0'
        version: 'npm:${target}@0.1.0'
`;
  const root = importerPath === "." ? `  .:
    ${field}:
      managedAlias:
        specifier: 'npm:${target}@0.1.0'
        version: 'npm:${target}@0.1.0'
` : "  .: {}\n";
  const lockfile = `lockfileVersion: '9.0'
importers:
${root}
${nested}`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN");
      return true;
    }
  );
}

test("Cohort v2 rejects npm aliases in root and nested importers", () => {
  assertLockfileAliasRejected(
    ".",
    "devDependencies",
    "@agent-teams/repository-mutation"
  );
  assertLockfileAliasRejected(
    "packages/nested",
    "peerDependencies",
    "@agent-teams/document-authoring"
  );
});

test("Cohort v2 rejects a catalog alias resolved to a Cohort identity", () => {
  const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      rmAlias:
        specifier: 'catalog:managed'
        version: '@agent-teams/repository-mutation@0.1.0'
`;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(Buffer.from(lockfile), desired),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_ALIAS_FORBIDDEN");
      return true;
    }
  );
});

function hostileCyclicLockfile() {
  const packageNames = [
    "@agent-teams/repository-mutation",
    "@agent-teams/document-authoring",
    "@agent-teams/docs-protocol",
    "@agent-teams/docs-protocol-agent-teams",
    "@agent-teams/engineering-foundation"
  ];
  const dependencies = (entries) => Object.fromEntries(
    entries.map((name) => [name, coordinate.version])
  );
  return {
    lockfileVersion: "9.0",
    importers: {
      ".": {
        devDependencies: Object.fromEntries([
          "@agent-teams/docs-protocol",
          "@agent-teams/docs-protocol-agent-teams",
          "@agent-teams/engineering-foundation"
        ].map((name) => [name, {
          specifier: coordinate.version,
          version: coordinate.version
        }]))
      }
    },
    packages: Object.fromEntries(packageNames.map((name) => [
      `${name}@${coordinate.version}`,
      { resolution: { integrity: coordinate.integrity } }
    ])),
    snapshots: {
      "@agent-teams/repository-mutation@0.1.0": {
        dependencies: dependencies(["@agent-teams/docs-protocol"])
      },
      "@agent-teams/document-authoring@0.1.0": {
        dependencies: dependencies(["@agent-teams/repository-mutation"])
      },
      "@agent-teams/docs-protocol@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation"
        ])
      },
      "@agent-teams/docs-protocol-agent-teams@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/docs-protocol",
          "@agent-teams/repository-mutation"
        ])
      },
      "@agent-teams/engineering-foundation@0.1.0": {
        dependencies: dependencies([
          "@agent-teams/document-authoring",
          "@agent-teams/repository-mutation"
        ])
      }
    }
  };
}

test("Cohort v2 rejects a digest-bound extra managed edge that creates a cycle", () => {
  const lockfile = hostileCyclicLockfile();
  // V2 now rejects the extra edge during projection, before a digest can be bound.
  assert.throws(() => computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort),
    (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH");
  const cohort = desired.cohort;
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(
      Buffer.from(stringify(lockfile)),
      { ...desired, cohort }
    ),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH");
      assert.match(error.message, /forbidden extra Cohort dependency/u);
      return true;
    }
  );
});

test("Cohort v2 rejects a required managed edge represented as optional", () => {
  const lockfile = hostileCyclicLockfile();
  delete lockfile.snapshots["@agent-teams/repository-mutation@0.1.0"].dependencies;
  const authoring = lockfile.snapshots["@agent-teams/document-authoring@0.1.0"];
  authoring.optionalDependencies = authoring.dependencies;
  delete authoring.dependencies;
  const cohort = {
    ...desired.cohort,
    runtime: {
      runtimeClosureDigest: computePnpmRuntimeClosureDigestV2(lockfile, desired.cohort)
    }
  };
  assert.throws(
    () => assertQualifiedPnpmLockfileV2(
      Buffer.from(stringify(lockfile)),
      { ...desired, cohort }
    ),
    (error) => {
      assert.equal(error?.code, "DOCS_CONSUMER_COHORT_DEPENDENCY_MISMATCH");
      assert.match(error.message, /must not optionally depend/u);
      return true;
    }
  );
});

// Independent central authority bytes, retained verbatim; never generated by this producer.
const accepted = JSON.parse(readFileSync(
  new URL("./fixtures/runtime-closure-v2-b8a.json", import.meta.url), "utf8"
));
const acceptedDigest = "sha256:b8a758df4203cba2350c2a44e03bce6177f555b852ae66620cb59c8b35e92a40";
const oldDigest = "sha256:9b74f2aeeeb8245e360ed1cb3526e8a12198368959afa2120ccdef7fbaabe31d";
const acceptedCohort = {
  packages: Object.fromEntries([
    "repositoryMutation", "documentAuthoring", "docsProtocol",
    "docsProtocolAgentTeams", "engineeringFoundation"
  ].map((key, index) => [key, {
    version: accepted.coordinates[index].version,
    integrity: accepted.coordinates[index].integrity
  }])),
  runtime: { runtimeClosureDigest: acceptedDigest }
};
const digest = (lock) => computePnpmRuntimeClosureDigestV2(lock, acceptedCohort);
const closureError = (error) => error?.code === "DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH";
const mutationLocator = "@agent-teams/repository-mutation@0.1.1";

function acceptedLock() {
  return structuredClone(accepted.pnpmLock);
}

test("V2 matches the independent accepted b8a wire contract", () => {
  assert.equal(accepted.packageCount, 82);
  assert.equal(digest(acceptedLock()), acceptedDigest);
});

function withUnrelatedRequiredRoot() {
  const lock = acceptedLock();
  lock.importers["."].devDependencies["consumer-tool"] = {
    specifier: "1.0.0", version: "1.0.0"
  };
  lock.packages["consumer-tool@1.0.0"] = { resolution: { integrity: coordinate.integrity } };
  lock.snapshots["consumer-tool@1.0.0"] = {
    dependencies: { "@emnapi/core": "1.11.2", "@emnapi/runtime": "1.11.2" }
  };
  for (const locator of [
    "@emnapi/core@1.11.2", "@emnapi/runtime@1.11.2", "@emnapi/wasi-threads@1.2.2", "tslib@2.8.1"
  ]) {
    delete lock.snapshots[locator].optional;
  }
  return lock;
}

test("V2 projects optionality from cohort roots despite unrelated required consumer paths", () => {
  const lock = withUnrelatedRequiredRoot();
  const original = structuredClone(lock);
  assert.equal(digest(lock), acceptedDigest);
  assert.doesNotThrow(() => assertQualifiedPnpmLockfileV2(
    Buffer.from(stringify(lock)), { cohort: acceptedCohort }
  ));
  assert.deepEqual(lock, original, "projection must never alter the consumer lock");
});

test("V2 still rejects version, integrity and optional-edge drift with shared required roots", () => {
  const mutations = [
    (lock) => {
      lock.packages["tslib@2.8.2"] = structuredClone(lock.packages["tslib@2.8.1"]);
      lock.snapshots["tslib@2.8.2"] = {};
      lock.snapshots["@emnapi/core@1.11.2"].dependencies.tslib = "2.8.2";
    },
    (lock) => { lock.packages["tslib@2.8.1"].resolution.integrity = coordinate.integrity; },
    (lock) => {
      const parser = lock.snapshots["oxc-parser@0.142.0"];
      parser.dependencies["@oxc-parser/binding-wasm32-wasi"] =
        parser.optionalDependencies["@oxc-parser/binding-wasm32-wasi"];
      delete parser.optionalDependencies["@oxc-parser/binding-wasm32-wasi"];
    }
  ];
  for (const mutate of mutations) {
    const lock = withUnrelatedRequiredRoot();
    mutate(lock);
    assert.notEqual(digest(lock), acceptedDigest);
    assert.throws(() => assertQualifiedPnpmLockfileV2(
      Buffer.from(stringify(lock)), { cohort: acceptedCohort }
    ), closureError);
  }
});

test("V2 validator accepts central b8a and rejects the old V1-style digest", () => {
  const bytes = Buffer.from(stringify(acceptedLock()));
  assert.doesNotThrow(() => assertQualifiedPnpmLockfileV2(bytes, { cohort: acceptedCohort }));
  assert.throws(() => assertQualifiedPnpmLockfileV2(bytes, {
    cohort: { ...acceptedCohort, runtime: { runtimeClosureDigest: oldDigest } }
  }), closureError);
});

function reverseObjects(value) {
  if (Array.isArray(value)) {
    return value.map(reverseObjects);
  }
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).toReversed().map(([key, entry]) =>
      [key, reverseObjects(entry)])) : value;
}

test("V2 ignores unreachable graph entries and object insertion order", () => {
  const lock = acceptedLock();
  lock.packages["unreachable@1.0.0"] = { resolution: { integrity: "invalid" } };
  lock.snapshots["unreachable@1.0.0"] = { dependencies: { missing: "file:missing" } };
  assert.equal(digest(reverseObjects(lock)), acceptedDigest);
});

test("V2 binds reachable SRI, optional edges, raw Node peer contexts and array order", () => {
  const leaf = "@types/node@24.13.3";
  const sri = acceptedLock();
  const external = Object.keys(sri.packages).find((key) => !key.startsWith("@agent-teams/"));
  sri.packages[external].resolution.integrity = coordinate.integrity;
  assert.notEqual(digest(sri), acceptedDigest);
  const optional = acceptedLock();
  optional.packages[leaf] = { resolution: { integrity: coordinate.integrity } };
  optional.snapshots[leaf] = {};
  optional.snapshots[mutationLocator].optionalDependencies = { "@types/node": "24.13.3" };
  optional.packages[mutationLocator].peerDependencies = { "@types/node": "*" };
  const optionalDigest = digest(optional);
  assert.notEqual(optionalDigest, acceptedDigest);
  const peer = structuredClone(optional);
  const rawLocator = `${mutationLocator}(@types/node@24.13.3)`;
  peer.snapshots[rawLocator] = peer.snapshots[mutationLocator];
  delete peer.snapshots[mutationLocator];
  for (const snapshot of Object.values(peer.snapshots)) {
    if (snapshot.dependencies?.["@agent-teams/repository-mutation"]) {
      snapshot.dependencies["@agent-teams/repository-mutation"] = "0.1.1(@types/node@24.13.3)";
    }
  }
  const peerDigest = digest(peer);
  assert.notEqual(peerDigest, optionalDigest);
  delete peer.snapshots[rawLocator].optionalDependencies;
  assert.notEqual(digest(peer), peerDigest);
  const arrays = acceptedLock();
  arrays.snapshots[mutationLocator].transitivePeerDependencies = ["peer-a", "peer-b"];
  const forward = digest(arrays);
  arrays.snapshots[mutationLocator].transitivePeerDependencies = ["peer-b", "peer-a"];
  assert.notEqual(digest(arrays), forward);
});

test("V2 fails closed on missing snapshots, malformed SRI and alias resolutions", () => {
  for (const mutate of [
    (lock) => { delete lock.snapshots[mutationLocator]; },
    (lock) => { lock.packages[mutationLocator].resolution.integrity = "sha512-invalid"; },
    (lock) => { lock.snapshots[mutationLocator].dependencies = { bad: "npm:other@1.0.0" }; }
  ]) {
    const lock = acceptedLock();
    mutate(lock);
    assert.throws(() => digest(lock), closureError);
  }
});

test("V2 retains package, dependency depth and serialized evidence bounds", () => {
  const wide = acceptedLock();
  wide.snapshots[mutationLocator].optionalDependencies = {};
  for (let index = 0; index < 2048; index += 1) {
    const name = `wide-${index}`;
    wide.snapshots[mutationLocator].optionalDependencies[name] = "1.0.0";
    wide.packages[`${name}@1.0.0`] = { resolution: { integrity: coordinate.integrity } };
    wide.snapshots[`${name}@1.0.0`] = {};
  }
  assert.throws(() => digest(wide), /maximum package count 2048/u);
  const deep = acceptedLock();
  let parent = deep.snapshots[mutationLocator];
  for (let index = 0; index < 66; index += 1) {
    const name = `deep-${index}`;
    parent.optionalDependencies = { [name]: "1.0.0" };
    deep.packages[`${name}@1.0.0`] = { resolution: { integrity: coordinate.integrity } };
    parent = {};
    deep.snapshots[`${name}@1.0.0`] = parent;
  }
  assert.throws(() => digest(deep), /maximum dependency depth 64/u);
  const large = acceptedLock();
  large.packages[mutationLocator].description = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => digest(large), /exceeds 2097152 bytes/u);
});


// Central retains every raw peer snapshot of one selected physical coordinate.
function coexistingPeerLock() {
  const lock = acceptedLock();
  lock.packages[mutationLocator].peerDependencies = { peer: "*" };
  lock.packages["peer@1.0.0"] = { resolution: { integrity: coordinate.integrity } };
  lock.snapshots["peer@1.0.0"] = {};
  lock.snapshots[`${mutationLocator}(peer@1.0.0)`] = { optionalDependencies: { peer: "1.0.0" } };
  lock.snapshots["@agent-teams/docs-protocol@0.5.1"]
    .dependencies["@agent-teams/repository-mutation"] = "0.1.1(peer@1.0.0)";
  return lock;
}

test("V2 binds coexisting raw peer snapshots of one managed physical coordinate", () => {
  const coexisting = coexistingPeerLock();
  const coexistingDigest = digest(coexisting);
  assert.notEqual(coexistingDigest, acceptedDigest);
  assert.doesNotThrow(() => assertQualifiedPnpmLockfileV2(
    Buffer.from(stringify(coexisting)),
    { cohort: { ...acceptedCohort, runtime: { runtimeClosureDigest: coexistingDigest } } }
  ));
  // Neither raw snapshot is dropped: editing either one moves the digest.
  const editedPeer = coexistingPeerLock();
  editedPeer.snapshots[`${mutationLocator}(peer@1.0.0)`].transitivePeerDependencies = ["peer"];
  assert.notEqual(digest(editedPeer), coexistingDigest);
  const editedBare = coexistingPeerLock();
  editedBare.snapshots[mutationLocator].transitivePeerDependencies = ["peer"];
  assert.notEqual(digest(editedBare), coexistingDigest);
  // Removing the last parent of the bare snapshot leaves only the peer-qualified one.
  const singlePeer = coexistingPeerLock();
  for (const snapshot of Object.values(singlePeer.snapshots)) {
    if (snapshot.dependencies?.["@agent-teams/repository-mutation"] === "0.1.1") {
      snapshot.dependencies["@agent-teams/repository-mutation"] = "0.1.1(peer@1.0.0)";
    }
  }
  assert.notEqual(digest(singlePeer), coexistingDigest);
});

function coexistingPeerLockOnEdgeSource() {
  // document-authoring has an outgoing managed edge (-> repository-mutation), unlike the
  // sink repository-mutation used by coexistingPeerLock(). Both raw variants keep that
  // edge, so this exercises managedEdges deduplication, not just physical-resolution binding.
  const authoringLocator = "@agent-teams/document-authoring@0.2.0";
  const lock = acceptedLock();
  lock.packages[authoringLocator].peerDependencies = { peer: "*" };
  lock.packages["peer@1.0.0"] = { resolution: { integrity: coordinate.integrity } };
  lock.snapshots["peer@1.0.0"] = {};
  lock.snapshots[`${authoringLocator}(peer@1.0.0)`] = {
    ...structuredClone(lock.snapshots[authoringLocator]),
    optionalDependencies: { peer: "1.0.0" }
  };
  lock.snapshots["@agent-teams/engineering-foundation@1.0.1"]
    .dependencies["@agent-teams/document-authoring"] = "0.2.0(peer@1.0.0)";
  return lock;
}

test("V2 dedupes a managed edge repeated by coexisting raw peer snapshots of its source", () => {
  const coexisting = coexistingPeerLockOnEdgeSource();
  // Before the managedEdges dedup fix this threw DOCS_CONSUMER_RUNTIME_CLOSURE_MISMATCH
  // ("edges are not exactly closed"): both the bare and peer-qualified document-authoring
  // snapshots re-emit the same documentAuthoring -> repositoryMutation managed edge.
  const coexistingDigest = digest(coexisting);
  assert.notEqual(coexistingDigest, acceptedDigest);
  assert.doesNotThrow(() => assertQualifiedPnpmLockfileV2(
    Buffer.from(stringify(coexisting)),
    { cohort: { ...acceptedCohort, runtime: { runtimeClosureDigest: coexistingDigest } } }
  ));
  // The edge is still real: dropping it from both raw snapshots must still be detected.
  const noEdge = coexistingPeerLockOnEdgeSource();
  delete noEdge.snapshots["@agent-teams/document-authoring@0.2.0"].dependencies["@agent-teams/repository-mutation"];
  delete noEdge.snapshots["@agent-teams/document-authoring@0.2.0(peer@1.0.0)"].dependencies["@agent-teams/repository-mutation"];
  assert.throws(() => digest(noEdge), closureError);
});

test("V2 rejects genuinely conflicting managed coordinates before hashing", () => {
  const twoVersions = coexistingPeerLock();
  twoVersions.packages["@agent-teams/repository-mutation@0.1.2"] = {
    resolution: { integrity: coordinate.integrity }
  };
  twoVersions.snapshots["@agent-teams/repository-mutation@0.1.2"] = {};
  twoVersions.snapshots["@agent-teams/document-authoring@0.2.0"]
    .dependencies["@agent-teams/repository-mutation"] = "0.1.2";
  assert.throws(() => digest(twoVersions), /coordinate differs/u);
  const absent = acceptedLock();
  for (const snapshot of Object.values(absent.snapshots)) {
    delete snapshot.dependencies?.["@agent-teams/repository-mutation"];
  }
  assert.throws(() => digest(absent), /coordinate differs/u);
  const drifted = structuredClone(acceptedCohort);
  drifted.packages.repositoryMutation.integrity = coordinate.integrity;
  assert.throws(() => computePnpmRuntimeClosureDigestV2(acceptedLock(), drifted), closureError);
});

test("V2 admits a Node-context-only edge pair and still rejects ambiguous versions", () => {
  const ambiguous = acceptedLock();
  ambiguous.snapshots[mutationLocator].dependencies = { leaf: "1.0.0" };
  ambiguous.snapshots[mutationLocator].optionalDependencies = { leaf: "2.0.0" };
  assert.throws(() => digest(ambiguous), /ambiguous dependency leaf/u);
  const pair = acceptedLock();
  pair.packages["peer-leaf@1.0.0"] = {
    resolution: { integrity: coordinate.integrity },
    peerDependencies: { "@types/node": "*" }
  };
  for (const node of ["24.13.3", "24.13.4"]) {
    pair.packages[`@types/node@${node}`] = { resolution: { integrity: coordinate.integrity } };
    pair.snapshots[`@types/node@${node}`] = {};
    pair.snapshots[`peer-leaf@1.0.0(@types/node@${node})`] = {
      optionalDependencies: { "@types/node": node }
    };
  }
  pair.snapshots[mutationLocator].dependencies = { "peer-leaf": "1.0.0(@types/node@24.13.3)" };
  pair.snapshots[mutationLocator].optionalDependencies = {
    "peer-leaf": "1.0.0(@types/node@24.13.4)"
  };
  const pairDigest = digest(pair);
  assert.notEqual(pairDigest, acceptedDigest);
  // Both raw references were traversed and bound, not collapsed onto one context.
  for (const node of ["24.13.3", "24.13.4"]) {
    const edited = structuredClone(pair);
    edited.snapshots[`peer-leaf@1.0.0(@types/node@${node})`].transitivePeerDependencies = ["x"];
    assert.notEqual(digest(edited), pairDigest);
  }
  const conflicting = structuredClone(pair);
  conflicting.packages["peer-leaf@2.0.0"] = { resolution: { integrity: coordinate.integrity } };
  conflicting.snapshots["peer-leaf@2.0.0(@types/node@24.13.4)"] = {};
  conflicting.snapshots[mutationLocator].optionalDependencies = {
    "peer-leaf": "2.0.0(@types/node@24.13.4)"
  };
  assert.throws(() => digest(conflicting), /ambiguous dependency peer-leaf/u);
});

registerConsumerTargetLockfileTests();
