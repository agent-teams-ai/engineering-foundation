import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify as stringifyYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const jsonSchemaModule = await import(
  pathToFileURL(
    join(distRoot, "capabilities", "contract-json-schema-releases", "module.js"),
  ).href,
);

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

async function writeJson(root, path, value) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withContractFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-json-schema-release-"));
  try {
    await writeJson(root, "schemas/common.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/common.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string" } },
    });
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["id", "details"],
      properties: {
        id: { type: "string" },
        details: { $ref: "https://schemas.example.test/agent/common.schema.json" },
      },
    });
    await writeJson(root, "fixtures/valid.json", {
      id: "task-1",
      details: { kind: "created" },
    });
    await writeJson(root, "fixtures/invalid.json", {
      id: 42,
      details: { kind: 7 },
    });
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function request(root) {
  return {
    consumerRoot: root,
    schemaPaths: ["schemas/root.schema.json", "schemas/common.schema.json"],
    fixtures: [
      {
        id: "invalid-payload",
        path: "fixtures/invalid.json",
        schemaId: "https://schemas.example.test/agent/root.schema.json",
        expectation: "invalid",
      },
      {
        id: "valid-payload",
        path: "fixtures/valid.json",
        schemaId: "https://schemas.example.test/agent/root.schema.json",
        expectation: "valid",
      },
    ],
  };
}

function policy(observation) {
  return {
    contractId: "agent-runtime-events",
    publicContractVersion: "1.0.0",
    schemaPaths: ["schemas/root.schema.json", "schemas/common.schema.json"],
    fixtures: request("unused").fixtures,
    released: {
      schemaVersion: 1,
      contractId: "agent-runtime-events",
      publicContractVersion: "1.0.0",
      schemaSetDigest: observation.schemaSetDigest,
      fixtureCorpusDigest: observation.fixtureCorpusDigest,
      supportedConsumers: [
        {
          consumerId: "orchestrator-sdk",
          consumerVersion: "1.0.0",
          contractId: "agent-runtime-events",
          contractVersion: "1.0.0",
          schemaSetDigest: observation.schemaSetDigest,
          fixtureCorpusDigest: observation.fixtureCorpusDigest,
          evidenceDigest: digest("a"),
          outcome: "passed",
        },
      ],
    },
    currentConsumerEvidence: [
      {
        consumerId: "orchestrator-sdk",
        consumerVersion: "1.0.0",
        contractId: "agent-runtime-events",
        contractVersion: "1.0.0",
        schemaSetDigest: observation.schemaSetDigest,
        fixtureCorpusDigest: observation.fixtureCorpusDigest,
        evidenceDigest: digest("b"),
        outcome: "passed",
      },
    ],
  };
}

async function writeYaml(root, path, value) {
  await writeFile(join(root, path), stringifyYaml(value), "utf8");
}

test("uses Ajv strict 2020-12 over an explicit local schema set and fixture corpus", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const observation = await inspector.inspect(request(root));
    assert.deepEqual(observation.schemaIds, [
      "https://schemas.example.test/agent/common.schema.json",
      "https://schemas.example.test/agent/root.schema.json",
    ]);
    assert.deepEqual(observation.fixtureResults, [
      { id: "invalid-payload", expectation: "invalid", matched: true },
      { id: "valid-payload", expectation: "valid", matched: true },
    ]);

    const result = await jsonSchemaModule.verifyJsonSchemaRelease(
      { consumerRoot: root, policy: policy(observation) },
      inspector,
    );
    assert.deepEqual(result.diagnostics, []);
  });
});

test("rejects remote references and duplicate IDs before AJV can resolve anything", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      $ref: "https://untrusted.example.test/schema.json",
    });
    await assert.rejects(
      inspector.inspect(request(root)),
      /not declared in this local contract set/u,
    );

    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/common.schema.json",
      type: "object",
    });
    await assert.rejects(inspector.inspect(request(root)), /must be unique/u);

    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      unrecognizedFoundationKeyword: true,
    });
    await assert.rejects(inspector.inspect(request(root)), /AJV strict 2020-12/u);
  });
});

test("rejects schema evidence that escapes through a symbolic link", async () => {
  await withContractFixture(async (root) => {
    const external = await mkdtemp(join(tmpdir(), "foundation-json-schema-external-"));
    try {
      await writeJson(external, "outside.json", {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://schemas.example.test/agent/root.schema.json",
        type: "object",
      });
      const target = join(root, "schemas", "root.schema.json");
      await unlink(target);
      await symlink(join(external, "outside.json"), target);
      const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
      await assert.rejects(inspector.inspect(request(root)), /symbolic link/u);
    } finally {
      await rm(external, { force: true, recursive: true });
    }
  });
});

test("detects immutable same-version changes and missing supported-consumer evidence", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const released = await inspector.inspect(request(root));
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["id", "details"],
      properties: {
        id: { type: "string", minLength: 1 },
        details: { $ref: "https://schemas.example.test/agent/common.schema.json" },
      },
    });
    const current = await inspector.inspect(request(root));
    const evidence = policy(released);
    evidence.currentConsumerEvidence = [];
    assert.deepEqual(
      jsonSchemaModule
        .evaluateJsonSchemaRelease(evidence, current)
        .map((diagnostic) => diagnostic.ruleId),
      [
        "contract.json-schema-releases.immutable-version-mutated",
        "contract.json-schema-releases.consumer-evidence-incomplete",
      ],
    );
  });
});

test("treats fixture corpus mutation as immutable same-version contract mutation", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const released = await inspector.inspect(request(root));
    await writeJson(root, "fixtures/valid.json", {
      id: "task-2",
      details: { kind: "created" },
    });
    const current = await inspector.inspect(request(root));
    assert.deepEqual(
      jsonSchemaModule
        .evaluateJsonSchemaRelease(policy(released), current)
        .map((diagnostic) => diagnostic.ruleId),
      [
        "contract.json-schema-releases.immutable-version-mutated",
        "contract.json-schema-releases.consumer-evidence-incomplete",
      ],
    );
  });
});

test("binds consumer evidence to contract and schema digest and handles public SemVer ordering", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const observation = await inspector.inspect(request(root));
    const incoherentReleased = policy(observation);
    incoherentReleased.released.supportedConsumers[0].schemaSetDigest = digest("f");
    assert.throws(
      () => jsonSchemaModule.evaluateJsonSchemaRelease(incoherentReleased, observation),
      /exact released contract evidence/u,
    );

    const prerelease = policy(observation);
    prerelease.publicContractVersion = "1.0.0-rc.1";
    prerelease.currentConsumerEvidence[0].contractVersion = "1.0.0-rc.1";
    assert.deepEqual(
      jsonSchemaModule
        .evaluateJsonSchemaRelease(prerelease, observation)
        .map((diagnostic) => diagnostic.ruleId),
      ["contract.json-schema-releases.public-version-regressed"],
    );

    const buildMetadata = policy(observation);
    buildMetadata.publicContractVersion = "1.0.0+ci.1";
    assert.throws(
      () => jsonSchemaModule.evaluateJsonSchemaRelease(buildMetadata, observation),
      /without build metadata/u,
    );
  });
});

test("runs as a deterministic capability and closes unexpected inspector failures", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const observation = await inspector.inspect(request(root));
    await writeYaml(root, "contract.yaml", policy(observation));
    const capability = jsonSchemaModule.createJsonSchemaReleaseCapability();
    const first = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    const second = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(first.outcome, "passed");
    assert.deepEqual(second, first);

    const cancelled = await capability.run({
      consumerRoot: root,
      configPath: "contract.yaml",
      signal: AbortSignal.abort(),
    });
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(cancelled.problem.code, "EXECUTION_CANCELLED");

    await writeFile(join(root, "contract.yaml"), "contractId: invalid\n", "utf8");
    const invalid = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(invalid.outcome, "invalid-input");
    assert.equal(invalid.problem.code, "SCHEMA_INVALID");

    await writeYaml(root, "contract.yaml", policy(observation));
    const failedCapability = jsonSchemaModule.createJsonSchemaReleaseCapability({
      inspector: {
        async inspect() {
          throw new Error("unexpected adapter failure");
        },
      },
    });
    const failed = await failedCapability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.problem.code, "CAPABILITY_EXECUTION_FAILED");
    assert.equal(failed.problem.message, "JSON Schema release capability execution failed.");
  });
});

test("rejects a released consumer baseline that was never proven passing", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const observation = await inspector.inspect(request(root));
    const evidence = policy(observation);
    evidence.released.supportedConsumers[0].outcome = "failed";
    assert.throws(
      () => jsonSchemaModule.evaluateJsonSchemaRelease(evidence, observation),
      /must be passed/u,
    );
  });
});

test("JSON Schema release evidence schema accepts the verified policy shape", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector();
    const observation = await inspector.inspect(request(root));
    const source = await readFile(
      join(
        repositoryRoot,
        "packages",
        "engineering-foundation",
        "schemas",
        "contract-json-schema-releases",
        "v1.schema.json",
      ),
      "utf8",
    );
    const validate = new Ajv2020({ strict: true }).compile(JSON.parse(source));
    assert.equal(validate(policy(observation)), true, JSON.stringify(validate.errors));
  });
});
