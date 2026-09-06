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
