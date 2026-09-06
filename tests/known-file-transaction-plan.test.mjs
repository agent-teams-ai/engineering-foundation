import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertKnownFileTransactionPlan,
  canonicalJson,
  compileKnownFileTransactionPlan
} from "../packages/repository-mutation/dist/index.js";
import { assertKnownFileSchemaIdentity, readHistoricalKnownFileFixture, readKnownFileSchema } from "./support/known-file-transaction-schema-fixtures.mjs";

const bytes = (value) => Buffer.from(value, "utf8");
const compile = (operations) => compileKnownFileTransactionPlan({ operations });
const plain = (value) => Object.assign(Object.create(null), value);
const create = (path) => ({
  path,
  precondition: { state: "absent" },
  postimage: { bytes: bytes(`${path}\n`) }
});

test("frozen published schemas and current owner schemas retain their exact approved bytes", async () => {
  for (const [kind, owner, expected] of [
    ["plan", "historical", "80e5295d93bba425dcfde4e928f0a48986745b55a5e7b1177fbcb13571940df9"],
    ["receipt", "historical", "c400abd7cef88a4c987ac4dcbff7ceb8e63913c553440c49624f58279d2f6a61"],
    ["plan", "current", "1316943da981f5241a1d1c6fd51fbaab9ff0c049da9f2ab40055903423c023c5"],
    ["receipt", "current", "e538343201c757a98337d9b796b9360d546c61181bef8baf07d21c936015267c"]
  ]) {
    const { bytes: schemaBytes } = await readKnownFileSchema(kind, owner);
    assert.equal(createHash("sha256").update(schemaBytes).digest("hex"), expected);
  }
});

test("published Mutation schema paths retain their released bytes and accept its native compiler", async () => {
  for (const [kind, expected] of [
    ["plan", "ed9490e1d9a903f82853199cb69d8a196b7052ccf38f81c3546397291a0f3223"],
    ["receipt", "92e6396923f76421ae8c63dc4187a4f9b391e8a06ae61772d5eea947041b884e"]
  ]) {
    const { bytes: schemaBytes } = await readKnownFileSchema(kind, "published");
    assert.equal(createHash("sha256").update(schemaBytes).digest("hex"), expected);
  }
  const { schema } = await readKnownFileSchema("plan", "published");
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(compile([create("managed/result.txt")])), true, JSON.stringify(validate.errors));
  assert.equal(validate((await readHistoricalKnownFileFixture("plan")).value), false);
});

test("native Foundation and current compiler Plans reject the other owner's schema", async () => {
  const historical = await readHistoricalKnownFileFixture("plan");
  await assertKnownFileSchemaIdentity("plan", historical.value, "historical");
  assert.throws(() => assertKnownFileTransactionPlan(historical.value), /Known-file transaction Plan is invalid/u);
  const current = compile([{ ...create("managed/result.txt"), postimage: { bytes: bytes("created\n") } }]);
  await assertKnownFileSchemaIdentity("plan", current);
  assert.deepEqual(current.operations, historical.value.operations);
  assert.notEqual(current.planDigest, historical.value.planDigest);
  assertKnownFileTransactionPlan(current);
  assert.deepEqual((await readHistoricalKnownFileFixture("plan")).bytes, historical.bytes);
});

function permutations(values) {
  if (values.length < 2) {return [values];}
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1)
  ]).map((tail) => [value, ...tail]));
}

test("compiles a deterministic sorted create and replace-known Plan", () => {
  const replacement = {
    path: "package.json",
    precondition: {
      state: "known-file",
      acceptedPreimages: [
        { bytes: bytes("old-b\n"), mode: 0o644 },
        { bytes: bytes("old-a\n"), mode: 0o644 }
      ]
    },
    postimage: { bytes: bytes("new\n"), mode: 0o644 }
  };
  const creation = {
    path: ".agents/skills/docs-authoring/SKILL.md",
    precondition: { state: "absent" },
    postimage: { bytes: bytes("skill\n") }
  };
  const first = compile([replacement, creation]);
  const second = compile([creation, {
    ...replacement,
    precondition: {
      ...replacement.precondition,
      acceptedPreimages: replacement.precondition.acceptedPreimages.toReversed()
    }
  }]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.operations.map(({ path }) => path), [
    ".agents/skills/docs-authoring/SKILL.md",
    "package.json"
  ]);
  assert.match(first.planDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotThrow(() => assertKnownFileTransactionPlan(first));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.operations), true);
});

test("rejects path collisions, unknown bytes, mode changes, and duplicate preimages", () => {
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [{
    path: ".agent-teams-local/foundation-operation.lock",
    precondition: { state: "absent" },
    postimage: { bytes: bytes("foreign") }
  }] }), /internal state namespace/u);
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [
    { path: "Docs/README.md", precondition: { state: "absent" }, postimage: { bytes: bytes("a") } },
    { path: "docs/README.md", precondition: { state: "absent" }, postimage: { bytes: bytes("b") } }
  ] }), /collide portably/u);
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [{
    path: "package.json",
    precondition: { state: "known-file", acceptedPreimages: [{ bytes: bytes("a"), mode: 0o644 }] },
    postimage: { bytes: bytes("b"), mode: 0o755 }
  }] }), /preserve the exact file mode/u);
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [{
    path: "package.json",
    precondition: { state: "known-file", acceptedPreimages: [
      { bytes: bytes("a"), mode: 0o644 },
      { bytes: bytes("a"), mode: 0o644 }
    ] },
    postimage: { bytes: bytes("b"), mode: 0o644 }
  }] }), /duplicate exact preimage/u);
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [0, 1, 2].map((index) => ({
    path: `large/${index}.bin`,
    precondition: { state: "absent" },
    postimage: { bytes: Buffer.alloc(6 * 1024 * 1024, index) }
  })) }), /Transaction evidence exceeds/u);
});

test("rejects operation paths that overlap as ancestor and descendant", () => {
  assert.throws(() => compileKnownFileTransactionPlan({ operations: [
    {
      path: "managed",
      precondition: { state: "absent" },
      postimage: { bytes: bytes("file\n") }
    },
    {
      path: "managed/child.txt",
      precondition: { state: "absent" },
      postimage: { bytes: bytes("child\n") }
    }
  ] }), /ancestor and descendant/u);
});

for (const paths of [
  ["managed", "managed-other", "managed/child.txt"],
  ["Managed", "managed-other", "managed/child.txt"],
  ["managed", "managed-other", "MANAGED/child.txt"],
  ["pkg/managed", "pkg/managed-other", "PKG/Managed/deep/child.txt"]
]) {
test(`rejects every permutation of ${paths.join(", ")} in compile and validate`, () => {
  // Independently valid single-operation Plans supply the image bytes. Wire
  // validation must reject the relationship before its final digest check.
  const singles = new Map(paths.map((path) => [path, compile([create(path)]).operations[0]]));
  for (const permutation of permutations(paths)) {
    assert.throws(
      () => compile(permutation.map(create)),
      /ancestor and descendant/u,
      permutation.join(", ")
    );
    assert.throws(() => assertKnownFileTransactionPlan({
      schemaVersion: 1,
      protocol: "agent-teams.repository-mutation.known-file/v1",
      operations: permutation.map((path) => singles.get(path)),
      planDigest: `sha256:${"0".repeat(64)}`
    }), /ancestor and descendant/u, permutation.join(", "));
  }
});
}

test("permits siblings and segment prefixes with stable binary ordering", () => {
  const paths = ["managed/first.txt", "managed-other", "MANAGED/second.txt"];
  const expected = compile(paths.map(create));
  assert.deepEqual(expected.operations.map(({ path }) => path), [
    "MANAGED/second.txt", "managed-other", "managed/first.txt"
  ]);
  for (const permutation of permutations(paths)) {
    assert.deepEqual(compile(permutation.map(create)), expected);
    assertKnownFileTransactionPlan(compile(permutation.map(create)));
  }
  assertKnownFileTransactionPlan(compile(["a", "a-b/c", "ab/c"].map(create)));
});

test("preserves the existing ASCII-only contract for NFC and decomposed paths", () => {
  const single = compile([create("ascii")]).operations[0];
  for (const spelling of ["caf\u00e9", "cafe\u0301"]) {
    for (const permutation of permutations([spelling, `${spelling}-other`, `${spelling}/child.txt`])) {
      assert.throws(() => compile(permutation.map(create)), /not portable: invalid-character/u);
      assert.throws(() => assertKnownFileTransactionPlan({
        schemaVersion: 1,
        protocol: "agent-teams.repository-mutation.known-file/v1",
        operations: permutation.map((path) => ({ ...single, path })),
        planDigest: `sha256:${"0".repeat(64)}`
      }), /not portable: invalid-character/u);
    }
  }
});

test("inert input checks preserve plain/null prototypes and never invoke accessors", () => {
  const operation = create("managed/a.txt");
  const expected = compile([operation]);
  assert.deepEqual(compileKnownFileTransactionPlan(plain({ operations: [plain({
    ...operation, precondition: plain(operation.precondition), postimage: plain(operation.postimage)
  })] })), expected);
  for (const input of [null, [], Object.create({ operations: [operation] })]) {
    assert.throws(() => compileKnownFileTransactionPlan(input), /plain operations record/u);
  }
  let reads = 0;
  const accessor = { enumerable: true, get() { reads += 1; return [operation]; } };
  assert.throws(() => compileKnownFileTransactionPlan(Object.defineProperty({}, "operations", accessor)), /at most/u);
  assert.throws(() => compile([Object.defineProperty({}, "path", accessor)]), /enumerable data properties/u);
  assert.throws(() => compile([Object.create(operation)]), /plain data/u);
  assert.equal(reads, 0);
});

test("preserves the base valid Plan order and digest", async () => {
  const envelope = JSON.parse(await readFile(new URL(
    "./fixtures/repository-mutation-known-file/base-valid-applying-envelope.json",
    import.meta.url
  ), "utf8"));
  const compiled = compile([
    { ...create("managed/b.txt"), postimage: { bytes: bytes("b\n") } },
    { ...create("managed/a.txt"), postimage: { bytes: bytes("a\n") } }
  ]);
  assert.deepEqual(compiled.operations.map(({ path }) => path), [
    "managed/a.txt",
    "managed/b.txt"
  ]);
  assert.equal(compiled.planDigest, envelope.payload.plan.planDigest);
  assert.equal(canonicalJson(compiled), canonicalJson(envelope.payload.plan));
  assertKnownFileTransactionPlan(envelope.payload.plan);
});

test("rejects the original compiler's canonical impossible Plan without altering it", async () => {
  const envelope = JSON.parse(await readFile(new URL(
    "./fixtures/repository-mutation-known-file/base-impossible-applying-envelope.json",
    import.meta.url
  ), "utf8"));
  const before = canonicalJson(envelope);
  assert.throws(() => assertKnownFileTransactionPlan(envelope.payload.plan), /ancestor and descendant/u);
  assert.equal(canonicalJson(envelope), before);
});

test("rejects non-canonical or tampered wire Plans", () => {
  const plan = compileKnownFileTransactionPlan({ operations: [{
    path: "package.json",
    precondition: { state: "known-file", acceptedPreimages: [{ bytes: bytes("old\n"), mode: 0o644 }] },
    postimage: { bytes: bytes("new\n"), mode: 0o644 }
  }] });
  assert.throws(() => assertKnownFileTransactionPlan({ ...plan, planDigest: `sha256:${"0".repeat(64)}` }), /not canonical|invalid digest/u);
  const tampered = structuredClone(plan);
  tampered.operations[0].postimage.contentBase64 = Buffer.from("other\n").toString("base64");
  assert.throws(() => assertKnownFileTransactionPlan(tampered), /bytes or digest/u);
});

test("validates canonical create Plans with an explicit non-default mode", () => {
  const plan = compileKnownFileTransactionPlan({ operations: [{
    path: "bin/tool",
    precondition: { state: "absent" },
    postimage: { bytes: bytes("#!/bin/sh\n"), mode: 0o755 }
  }] });
  assert.equal(plan.operations[0].postimage.mode, 0o755);
  assert.doesNotThrow(() => assertKnownFileTransactionPlan(plan));
});
