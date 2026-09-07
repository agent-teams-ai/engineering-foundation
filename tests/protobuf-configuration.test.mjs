import { readContainedRegularFile } from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertFeatureOutsideSchemaCycles, assertSchemaAssemblyImportRejected } from "./helpers/schema-assembly-boundaries.mjs";
import { loadCapabilityConfig } from "../packages/engineering-foundation/dist/capabilities/contract-protobuf-evolution/adapters/inbound/configuration/load-capability-config.js";
import { FilesystemBufBreakingQualificationEvidence } from "../packages/engineering-foundation/dist/capabilities/contract-protobuf-evolution/adapters/outbound/qualification/filesystem-buf-breaking-qualification-evidence.js";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

function baseline() {
  return { schemaVersion: 1, contractId: "example", publicContractVersion: "1.0.0", bufVersion: "1.72.0",
    bufConfigDigest: `sha256:${"a".repeat(64)}`, descriptorImageDigest: `sha256:${"b".repeat(64)}`,
    generatorVersions: [{ name: "buf.build/bufbuild/es:v2.2.3", version: "2.2.3" }],
    generatedOutputDigest: `sha256:${"c".repeat(64)}` };
}

function configuration() {
  const { generatedOutputDigest, ...current } = baseline();
  return { schemaVersion: 1, releasedBaselinePath: "architecture/contracts/released.yaml", approvedBreakingChanges: [],
    qualification: { modulePath: ".", bufConfigPath: "buf.yaml",
      releasedDescriptorImagePath: "architecture/contracts/released.binpb",
      evidencePath: "architecture/evidence/protobuf/qualification.json" },
    current: { ...current, generationDrift: {
      expectedGeneratedOutputDigest: generatedOutputDigest, observedGeneratedOutputDigest: generatedOutputDigest
    } }
  };
}

test("Protobuf configuration and qualification no longer join the module schema assembly cycle", async () => {
  await assertFeatureOutsideSchemaCycles("contract-protobuf-evolution");
});

for (const adapter of ["inbound/configuration/load-capability-config.ts", "outbound/qualification/filesystem-buf-breaking-qualification-evidence.ts"]) {
  test(`source policy rejects a schema assembly import in the Protobuf ${adapter}`, async () => {
    await assertSchemaAssemblyImportRejected(
      `packages/engineering-foundation/src/capabilities/contract-protobuf-evolution/adapters/${adapter}`,
      "../../../../../schema-catalog.js"
    );
  });
}

test("Protobuf loading validates configuration and released baseline in order with the original schemas", async () => {
  const input = configuration(), released = baseline(), calls = [], signal = new AbortController().signal;
  const policy = await loadCapabilityConfig({
    async readYaml(...args) { calls.push(["read", ...args]); return args[1] === "contract.yaml" ? input : released; },
    async assertSchema(...args) { calls.push(["schema", ...args]); await assertSchema(...args); }
  }, "explicit-memory-consumer", "contract.yaml", signal);
  assert.deepEqual(calls, [
    ["read", "explicit-memory-consumer", "contract.yaml", "protobuf-evolution-config", signal],
    ["schema", "contract-protobuf-evolution/v1", input, "protobuf-evolution-config"],
    ["read", "explicit-memory-consumer", input.releasedBaselinePath, "protobuf-evolution-baseline", signal],
    ["schema", "contract-protobuf-evolution-baseline/v1", released, "protobuf-evolution-baseline"]
  ]);
  assert.deepEqual(policy, { approvedBreakingChanges: [], qualification: input.qualification, released, current: input.current });
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.released.generatorVersions));
});

test("Protobuf approval reference validation still precedes baseline reading", async () => {
  const input = configuration();
  input.acceptedDecisionBaselinePath = "architecture/decisions/accepted-decisions.json";
  let reads = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { reads += 1; return input; }, async assertSchema() {}
  }, "explicit-memory-consumer", "contract.yaml"), (error) => {
    assert.equal(error.problem.code, "PROTOBUF_EVOLUTION_CONFIG_INVALID");
    assert.equal(error.problem.phase, "protobuf-evolution-config");
    assert.equal(error.message, "acceptedDecisionBaselinePath and governanceConfigPath must be declared together.");
    return true;
  });
  assert.equal(reads, 1);
});

test("Protobuf loading preserves schema failure identity at both validation stages", async () => {
  for (const failingStage of [1, 2]) {
    const failure = new Error(`schema stage ${failingStage}`);
    let reads = 0, validations = 0;
    await assert.rejects(loadCapabilityConfig({
      async readYaml() { reads += 1; return reads === 1 ? configuration() : baseline(); },
      async assertSchema() { validations += 1; if (validations === failingStage) { throw failure; } }
    }, "explicit-memory-consumer", "contract.yaml"), (error) => error === failure);
    assert.equal(reads, failingStage);
    assert.equal(validations, failingStage);
  }
});

test("Protobuf cancellation after configuration schema validation prevents baseline reading", async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(loadCapabilityConfig({
    async readYaml() { reads += 1; return configuration(); },
    async assertSchema() { controller.abort(); }
  }, "explicit-memory-consumer", "contract.yaml", controller.signal), /cancel/iu);
  assert.equal(reads, 1);
});

test("Protobuf evidence reader delegates the exact qualification schema before mapping or further file reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "protobuf-schema-evidence-"));
  try {
    const input = configuration(), evidence = { schemaVersion: 1 }, calls = [];
    const evidencePath = join(root, input.qualification.evidencePath);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence));
    const failure = new Error("qualification schema rejected");
    const reader = new FilesystemBufBreakingQualificationEvidence(async (...args) => { calls.push(args); throw failure; }, { read: readContainedRegularFile, parseYaml: parseStrictYamlSource });
    await assert.rejects(reader.read({ consumerRoot: root, configuration: input }), (error) => error === failure);
    assert.deepEqual(calls, [["contract-protobuf-breaking-qualification/v1", evidence, "protobuf-buf-qualification-evidence"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
