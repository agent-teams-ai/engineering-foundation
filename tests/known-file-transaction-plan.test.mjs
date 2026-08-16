import assert from "node:assert/strict";
import test from "node:test";

import {
  assertKnownFileTransactionPlan,
  compileKnownFileTransactionPlan
} from "../packages/engineering-foundation/dist/mutation/index.js";

const bytes = (value) => Buffer.from(value, "utf8");
const compile = (operations) => compileKnownFileTransactionPlan({ operations });

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
