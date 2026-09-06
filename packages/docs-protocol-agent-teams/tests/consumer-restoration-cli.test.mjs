import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("injected managed operations preserve restoration routing and exact CLI envelopes", () => {
  const cli = new URL("../dist/consumer-integration/adapters/inbound/consumer-integration-cli.js", import.meta.url).href;
  const digest = `sha256:${"a".repeat(64)}`;
  const cases = [
    {
      argv: ["upgrade", "--to", "target", "--target-generation", "2", "--source-generation", "1", "--restoration-proof", "/proof", "--prepare"],
      operation: "upgrade",
      options: { consumerRoot: ".", to: "target", targetGeneration: 2, prepare: true, sourceGeneration: 1, restorationProofPath: "/proof" },
      execution: { schemaVersion: 1, command: "consumer.upgrade", outcome: "prepared", issues: [], preparation: { path: "/proof.prepared", digest } },
      human: `consumer.upgrade: prepared\nPrepared intent: /proof.prepared\nSelect before mutation: ${digest}\n`
    },
    {
      argv: ["restore", "--from", "target", "--to", "origin", "--source-generation", "2", "--target-generation", "1", "--proof", "/proof", "--expect", digest, "--activation-only"],
      operation: "restore",
      options: { consumerRoot: ".", from: "target", to: "origin", proofPath: "/proof", expect: digest, sourceGeneration: 2, targetGeneration: 1, activationOnly: true },
      execution: { schemaVersion: 1, command: "consumer.restore", outcome: "activated-v1", issues: [], proofDigest: digest, inversePlanDigest: digest },
      human: "consumer.restore: activated-v1\n"
    },
    {
      argv: ["finalize", "--from", "origin", "--to", "target", "--source-generation", "1", "--target-generation", "2", "--preparation", "/proof.prepared", "--proof", "/proof", "--expect", digest],
      operation: "finalize",
      options: { consumerRoot: ".", from: "origin", to: "target", preparationPath: "/proof.prepared", proofPath: "/proof", expect: digest, sourceGeneration: 1, targetGeneration: 2 },
      execution: { schemaVersion: 1, command: "consumer.finalize", outcome: "blocked", issues: [] },
      human: "consumer.finalize: blocked\n"
    }
  ];
  for (const fixture of cases) {
    for (const json of [false, true]) {
      const script = `
import assert from 'node:assert/strict';
import { createManagedConsumerCommand } from ${JSON.stringify(cli)};
const fixture = ${JSON.stringify(fixture)};
let calls = 0;
const run = createManagedConsumerCommand({ [fixture.operation]: async options => {
  calls++; assert.deepEqual(options, fixture.options); return fixture.execution;
} });
const code = await run([...fixture.argv, ...(${json} ? ['--json'] : [])]);
assert.equal(calls, 1);
process.exitCode = code;
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(result.stderr, "");
      assert.equal(result.status, fixture.operation === "finalize" ? 1 : 0);
      assert.equal(result.stdout, json ? `${JSON.stringify(fixture.execution)}\n` : fixture.human);
    }
  }
});

test("restoration wire schemas compile before injected operations can mutate", () => {
  const cli = new URL("../dist/consumer-integration/adapters/inbound/consumer-integration-cli.js", import.meta.url).href;
  const digest = `sha256:${"a".repeat(64)}`;
  for (const command of ["upgrade", "finalize", "restore"]) {
    const args = command === "upgrade"
      ? [command, "--to", "target", "--target-generation", "2", "--source-generation", "1", "--restoration-proof", "/proof", "--prepare", "--json"]
      : [command, "--from", "origin", "--to", "target", "--source-generation", command === "restore" ? "2" : "1",
        "--target-generation", command === "restore" ? "1" : "2", "--proof", "/proof", "--expect", digest,
        ...(command === "finalize" ? ["--preparation", "/proof.prepared"] : []), "--json"];
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const readFile = fs.readFile;
fs.readFile = async (path, ...args) => String(path).includes('execution/v1.schema.json')
  ? '{"$ref":"https://invalid.test/missing-contract"}' : readFile(path, ...args);
syncBuiltinESMExports();
const { createManagedConsumerCommand } = await import(${JSON.stringify(cli)});
let calls = 0;
const mutate = async () => { calls++; throw new Error('operation must not run'); };
const code = await createManagedConsumerCommand({ upgrade: mutate, finalize: mutate, restore: mutate })(${JSON.stringify(args)});
assert.equal(calls, 0);
process.exitCode = code;
`], { encoding: "utf8" });
    assert.equal(result.stderr, "");
    assert.equal(result.status, 3);
    const execution = JSON.parse(result.stdout);
    assert.equal(execution.command, `consumer.${command}`);
    assert.equal(execution.outcome, "blocked");
    assert.equal(execution.issues[0].code, "DOCS_CONSUMER_EXECUTION_FAILURE");
    assert.match(execution.issues[0].message, /missing-contract/u);
  }
});

test("restoration admission preserves strict parser identity at the actual proof reader", async () => {
  const { parseConsumerRestorationPreparation, parseConsumerRestorationProof } = await import(
    "../dist/consumer-integration/application/policies/consumer-restoration-proof.js"
  );
  const { sha256Bytes, StrictJsonError } = await import("@agent-teams/repository-mutation");
  const { StrictJsonError: serializationError } = await import("@agent-teams/repository-mutation/serialization");
  assert.equal(StrictJsonError, serializationError);
  for (const parse of [parseConsumerRestorationPreparation, parseConsumerRestorationProof]) {
    for (const [text, failure] of [
      ['{"a":1,"a":2}', "duplicate-key"],
      ['{"a":1,"\\u0061":2}', "duplicate-key"],
      ['{"nested":[{"a":1,"\\u0061":2}]}', "duplicate-key"],
      ['{"nested":{"x":{"a":1,"a":2}}}', "duplicate-key"],
      ['{"a":1,"a":2,}', "duplicate-key"],
      ['{"nested":[1,]}', "syntax"],
      ['{"a":1} trailing', "syntax"],
      ['{"a":/*comment*/1}', "syntax"],
      ['"unterminated', "syntax"]
    ]) {
      const bytes = Buffer.from(text);
      assert.throws(() => parse(bytes, sha256Bytes(bytes)), (error) => {
        assert.ok(error instanceof StrictJsonError);
        assert.equal(error.name, "StrictJsonError");
        assert.equal(error.failure, failure);
        assert.equal(error.message, `Strict JSON parsing failed: ${failure}.`);
        return true;
      });
      assert.throws(() => parse(bytes, `sha256:${"0".repeat(64)}`), /separately retained selection digest/u);
    }
    // Equal keys in distinct objects are valid JSON; closed proof shape rejects later.
    const bytes = Buffer.from('{"objects":[{"a":1},{"a":2}]}');
    assert.throws(() => parse(bytes, sha256Bytes(bytes)), (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!(error instanceof StrictJsonError));
      assert.match(error.message, /invalid closed record/u);
      return true;
    });
  }
});

test("restoration admission preserves historical replacement and retry receipt semantics", async () => {
  const { assertFullyReplacedReceipt, assertObservedRestorationReceipt, inverseRestorationPlan } = await import(
    "../dist/consumer-integration/application/policies/consumer-restoration-proof.js"
  );
  const { compileKnownFileTransactionPlan, sha256Json } = await import("@agent-teams/repository-mutation");
  const plan = compileKnownFileTransactionPlan({ operations: [{ path: "managed.json",
    precondition: { state: "known-file", acceptedPreimages: [{ bytes: Buffer.from("historical-v1\n"), mode: 0o644 }] },
    postimage: { bytes: Buffer.from("current-v2\n"), mode: 0o644 }
  }] });
  const receipt = (outcome) => {
    const body = { schemaVersion: 1, protocol: plan.protocol, planDigest: plan.planDigest,
      outcome: outcome === "replaced" ? "applied" : "already-satisfied",
      operations: plan.operations.map(({ path, postimage }) => ({ path, outcome, resultDigest: postimage.digest })) };
    return { ...body, receiptDigest: sha256Json({ domain: "agent-teams.repository-mutation.known-file-receipt/v1", body }) };
  };
  const original = receipt("replaced"), retry = receipt("already-satisfied");
  assertFullyReplacedReceipt(plan, original);
  assertObservedRestorationReceipt(plan, original);
  assertObservedRestorationReceipt(plan, retry);
  assert.throws(() => assertFullyReplacedReceipt(plan, retry), /every exact replacement/u);
  assert.throws(() => assertObservedRestorationReceipt(plan, { ...retry, receiptDigest: original.receiptDigest }), /honest selected operation outcomes/u);
  const inverse = inverseRestorationPlan(plan);
  assert.deepEqual(inverse.operations[0].postimage, plan.operations[0].precondition.acceptedPreimages[0]);
  assert.deepEqual(inverse.operations[0].precondition.acceptedPreimages[0], plan.operations[0].postimage);
});
