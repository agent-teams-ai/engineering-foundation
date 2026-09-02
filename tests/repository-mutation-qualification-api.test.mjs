import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes only the new Repository Mutation qualification seam", async () => {
  const [leaf, foundation, qualification, publicIndex] = await Promise.all([
    readFile(new URL("../packages/repository-mutation/package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../packages/engineering-foundation/package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../packages/repository-mutation/src/qualification/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/repository-mutation/src/index.ts", import.meta.url), "utf8")
  ]);
  assert.deepEqual(leaf.exports["./qualification"], {
    types: "./dist/qualification/index.d.ts",
    import: "./dist/qualification/index.js"
  });
  assert.deepEqual(leaf.exports["./node"], {
    types: "./dist/node.d.ts",
    import: "./dist/node.js"
  });
  assert.equal(Object.hasOwn(foundation.exports, "./mutation"), false);
  assert.equal(Object.hasOwn(foundation.exports, "./mutation/qualification"), false);
  assert.match(qualification, /KnownFileRecoveryFaultInjector/u);
  assert.match(qualification, /KnownFileTransactionFaultInjector/u);
  assert.match(qualification, /NodeMutationOperationLock/u);
  assert.match(qualification, /readBoundedRegularFileWithFaults/u);
  assert.match(qualification, /prepareExactSiblingTemporaryWithFaults/u);
  assert.match(qualification, /publishPreparedAbsentFileWithFaults/u);
  assert.match(qualification, /publishAbsentFileWithFaults/u);
  assert.doesNotMatch(publicIndex, /FaultInjector|FaultPoint/u);
  for (const lowLevel of [
    "acquireMutationLease",
    "createAndBindNodeDirectory",
    "prepareExactSiblingTemporary",
    "publishPreparedAbsentFile",
    "syncMutationStateDirectory"
  ]) {
    assert.doesNotMatch(publicIndex, new RegExp(`\\b${lowLevel}\\b`, "u"));
  }
});

test("production known-file APIs reject runtime excess and accessor properties", async () => {
  const { applyKnownFileTransaction, compileKnownFileTransactionPlan, recoverKnownFileTransaction } = await import(
    "../packages/repository-mutation/dist/index.js"
  );
  let invoked = false;
  const applyOptions = {
    consumerRoot: "/unused",
    plan: null,
    faultInjector() { invoked = true; }
  };
  await assert.rejects(applyKnownFileTransaction(applyOptions), /unknown, missing, or executable/u);
  const recoveryOptions = { consumerRoot: "/unused" };
  Object.defineProperty(recoveryOptions, "claim", {
    enumerable: true,
    get() { invoked = true; return null; }
  });
  await assert.rejects(recoverKnownFileTransaction(recoveryOptions), /unknown, missing, or executable/u);
  const compileInput = {};
  Object.defineProperty(compileInput, "operations", {
    enumerable: true,
    get() {invoked = true; return [];}
  });
  assert.throws(
    () => compileKnownFileTransactionPlan(compileInput),
    /plain operations record|at most/u
  );
  const operationArray = [];
  Object.defineProperty(operationArray, "0", {
    enumerable: true,
    get() {invoked = true; return null;}
  });
  assert.throws(
    () => compileKnownFileTransactionPlan({ operations: operationArray }),
    /enumerable data properties/u
  );
  assert.equal(invoked, false);
});

test("keeps production mutation signatures free of executable fault callbacks", async () => {
  const sources = await Promise.all([
    "node-known-file-transaction.ts",
    "node-known-file-transaction-recovery.ts",
    "node-bounded-regular-file.ts",
    "node-prepare-exact-sibling-temporary.ts",
    "node-publish-prepared-absent-file.ts",
    "node-absent-file-publication.ts"
  ].map((name) => readFile(new URL(
    `../packages/repository-mutation/src/repository-mutation/adapters/node/${name}`,
    import.meta.url
  ), "utf8")));
  const functionNames = [
    "applyKnownFileTransaction",
    "recoverKnownFileTransaction",
    "readBoundedRegularFile",
    "prepareExactSiblingTemporary",
    "publishPreparedAbsentFile",
    "publishAbsentFile"
  ];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const marker = `export function ${functionNames[index]}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const end = source.indexOf("): Promise", start);
    assert.notEqual(end, -1, marker);
    assert.doesNotMatch(source.slice(start, end), /faultInjector|FaultInjector/u);
  }
});

test("removes the obsolete Foundation root mutation namespace", async () => {
  const root = await readFile(new URL("../packages/engineering-foundation/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(root, /as mutation|\.\/mutation\/index/u);
});
