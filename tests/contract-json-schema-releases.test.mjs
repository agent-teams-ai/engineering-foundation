import { schemaConfigurationDependencies } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  stat,
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
const jsonSchemaConfig = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "contract-json-schema-releases",
      "adapters",
      "inbound",
      "configuration",
      "load-capability-config.js",
    ),
  ).href,
);
const filesystemPathSafety = await import(
  pathToFileURL(join(distRoot, "source-inventory/node.js")).href,
);
const schemaFiles = { read: filesystemPathSafety.readContainedRegularFile };

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function containedFileReadOperations(overrides = {}) {
  return { lstat, open, realpath, stat, ...overrides };
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
      required: ["id", "contact", "details"],
      properties: {
        id: { type: "string" },
        contact: { type: "string", format: "email" },
        details: { $ref: "https://schemas.example.test/agent/common.schema.json" },
      },
    });
    await writeJson(root, "fixtures/valid.json", {
      id: "task-1",
      contact: "runtime@example.test",
      details: { kind: "created" },
    });
    await writeJson(root, "fixtures/invalid.json", {
      id: 42,
      contact: "not-an-email",
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
    schemaVersion: 1,
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

function releasedBaseline(observation) {
  return policy(observation).released;
}

function capabilityConfig(observation, releasedBaselinePath = "architecture/contracts/released.yaml") {
  const normalized = policy(observation);
  return {
    schemaVersion: normalized.schemaVersion,
    contractId: normalized.contractId,
    publicContractVersion: normalized.publicContractVersion,
    schemaPaths: normalized.schemaPaths,
    fixtures: normalized.fixtures,
    releasedBaselinePath,
    currentConsumerEvidence: normalized.currentConsumerEvidence,
  };
}

async function writeYaml(root, path, value) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(value), "utf8");
}

async function writeSeparatedPolicy(
  root,
  observation,
  releasedBaselinePath = "architecture/contracts/released.yaml",
) {
  if (releasedBaselinePath.endsWith(".json")) {
    await writeJson(root, releasedBaselinePath, releasedBaseline(observation));
  } else {
    await writeYaml(root, releasedBaselinePath, releasedBaseline(observation));
  }
  await writeYaml(root, "contract.yaml", capabilityConfig(observation, releasedBaselinePath));
}

test("schema file port preserves fixture results and supplies every bounded read", async () => {
  await withContractFixture(async (root) => {
    const expected = await new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles).inspect(request(root));
    const calls = [];
    const files = {
      calls,
      async read(input) {
        this.calls.push(input);
        return new Uint8Array(await schemaFiles.read(input));
      },
    };
    const actual = await new jsonSchemaModule.AjvJsonSchemaReleaseInspector(files).inspect(request(root));
    assert.deepEqual(actual, expected);
    const canonicalRoot = await realpath(root);
    assert.deepEqual(calls.map(({ candidate }) => candidate).toSorted(), [
      "schemas/common.schema.json", "schemas/root.schema.json", "fixtures/invalid.json", "fixtures/valid.json",
    ].map((path) => join(canonicalRoot, path)).toSorted());
    for (const call of calls) {
      assert.equal(call.root, canonicalRoot);
      assert.equal(call.maxBytes, 4 * 1024 * 1024);
    }
  });
});

for (const [failure, code] of [
  ["escape", "JSON_SCHEMA_PATH_ESCAPE"], ["symlink", "JSON_SCHEMA_SYMLINK_PROHIBITED"],
  ["invalid", "JSON_SCHEMA_FILE_INVALID"], ["changed", "JSON_SCHEMA_FILE_UNAVAILABLE"],
  ["missing", "JSON_SCHEMA_FILE_UNAVAILABLE"], ["unavailable", "JSON_SCHEMA_FILE_UNAVAILABLE"],
]) {
  test(`schema file port preserves ${failure} diagnostics`, async () => {
    await withContractFixture(async (root) => {
      const files = { async read() { throw new filesystemPathSafety.ContainedFileReadError(failure); } };
      await assert.rejects(new jsonSchemaModule.AjvJsonSchemaReleaseInspector(files).inspect(request(root)),
        ({ problem }) => problem?.code === code && problem.phase === "json-schema-release-inspection" && problem.retryable === false);
    });
  });
}

test("schema file port propagates unknown failures without a filesystem fallback", async () => {
  await withContractFixture(async (root) => {
    const failure = new Error("injected read failed");
    const files = { async read() { throw failure; } };
    await assert.rejects(new jsonSchemaModule.AjvJsonSchemaReleaseInspector(files).inspect(request(root)),
      (actual) => actual === failure);
  });
});

test("schema file port cannot bypass the JSON evidence byte limit", async () => {
  await withContractFixture(async (root) => {
    const files = { async read() { return new Uint8Array(4 * 1024 * 1024 + 1); } };
    await assert.rejects(new jsonSchemaModule.AjvJsonSchemaReleaseInspector(files).inspect(request(root)),
      ({ problem }) => problem?.code === "JSON_SCHEMA_FILE_INVALID");
  });
});

test("schema file port is not invoked after pre-cancellation", async () => {
  await withContractFixture(async (root) => {
    let calls = 0;
    const files = { async read() { calls += 1; throw new Error("must not read"); } };
    await assert.rejects(new jsonSchemaModule.AjvJsonSchemaReleaseInspector(files).inspect({
      ...request(root), signal: AbortSignal.abort(),
    }), ({ problem }) => problem?.code === "EXECUTION_CANCELLED");
    assert.equal(calls, 0);
  });
});

test("uses Ajv strict 2020-12 over an explicit local schema set and fixture corpus", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    const reorderedObservation = await inspector.inspect({
      ...request(root),
      schemaPaths: request(root).schemaPaths.toReversed(),
      fixtures: request(root).fixtures.toReversed(),
    });
    assert.deepEqual(observation.schemaIds, [
      "https://schemas.example.test/agent/common.schema.json",
      "https://schemas.example.test/agent/root.schema.json",
    ]);
    assert.deepEqual(observation.fixtureResults, [
      { id: "invalid-payload", expectation: "invalid", matched: true },
      { id: "valid-payload", expectation: "valid", matched: true },
    ]);
    assert.deepEqual(reorderedObservation, observation);

    const result = await jsonSchemaModule.verifyJsonSchemaRelease(
      { consumerRoot: root, policy: policy(observation) },
      inspector,
    );
    assert.deepEqual(result.diagnostics, []);
  });
});

test("accepts exact 4 MiB Ajv schema and document evidence and rejects one byte more", async () => {
  await withContractFixture(async (root) => {
    const schemaPath = "schemas/limit.schema.json";
    const fixturePath = "fixtures/limit.json";
    const schemaSource = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/limit/v1",
      type: "object",
    });
    const fixtureSource = JSON.stringify({ value: true });
    const requestAtLimit = {
      consumerRoot: root,
      schemaPaths: [schemaPath],
      fixtures: [{
        id: "limit-document",
        path: fixturePath,
        schemaId: "https://schemas.example.test/limit/v1",
        expectation: "valid",
      }],
      requireMixedExpectations: false,
    };
    for (const oversizedPath of [schemaPath, fixturePath]) {
      const sources = new Map([
        [schemaPath, Buffer.from(schemaSource.padEnd(4 * 1024 * 1024, " "))],
        [fixturePath, Buffer.from(fixtureSource.padEnd(4 * 1024 * 1024, " "))],
      ]);
      const exact = await new jsonSchemaModule.AjvJsonSchemaReleaseInspector(
        schemaFiles,
        async (path) => sources.get(path),
      ).inspect(requestAtLimit);
      assert.deepEqual(exact.fixtureResults, [
        { id: "limit-document", expectation: "valid", matched: true },
      ]);
      sources.set(oversizedPath, Buffer.concat([sources.get(oversizedPath), Buffer.from(" ")]));
      await assert.rejects(
        new jsonSchemaModule.AjvJsonSchemaReleaseInspector(
          schemaFiles,
          async (path) => sources.get(path),
        ).inspect(requestAtLimit),
        ({ problem }) => problem?.code === "JSON_SCHEMA_FILE_INVALID",
      );
    }
  });
});

test("fails closed when a contained JSON file grows after descriptor validation", async () => {
  await withContractFixture(async (root) => {
    const candidate = join(root, "fixtures", "mutable.json");
    await writeFile(candidate, "{}", "utf8");
    let mutated = false;

    await assert.rejects(
      filesystemPathSafety.readContainedRegularFile(
        { candidate, maxBytes: 8, root },
        containedFileReadOperations({
          async open(path, flags) {
            const handle = await open(path, flags);
            return {
              close: () => handle.close(),
              async read(...arguments_) {
                if (!mutated) {
                  mutated = true;
                  await writeFile(candidate, "123456789", "utf8");
                }
                return handle.read(...arguments_);
              },
              stat: () => handle.stat(),
            };
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof filesystemPathSafety.ContainedFileReadError);
        assert.equal(error.failure, "changed");
        return true;
      },
    );
    assert.equal(mutated, true);
  });
});

test("fails closed when the named JSON file identity changes after descriptor validation", async () => {
  await withContractFixture(async (root) => {
    const candidate = join(root, "fixtures", "identity.json");
    await writeFile(candidate, "{}", "utf8");
    let candidateStats = 0;

    await assert.rejects(
      filesystemPathSafety.readContainedRegularFile(
        { candidate, maxBytes: 8, root },
        containedFileReadOperations({
          async stat(path) {
            const metadata = await stat(path);
            if (!metadata.isFile()) {
              return metadata;
            }
            candidateStats += 1;
            return {
              ctimeMs: metadata.ctimeMs,
              dev: metadata.dev,
              ino: BigInt(metadata.ino) + 1n,
              isFile: () => true,
              mode: metadata.mode,
              mtimeMs: metadata.mtimeMs,
              size: metadata.size,
            };
          },
        }),
      ),
      (error) => {
        assert.ok(error instanceof filesystemPathSafety.ContainedFileReadError);
        assert.equal(error.failure, "changed");
        return true;
      },
    );
    assert.equal(candidateStats, 1);
  });
});

test("requires both positive and negative JSON Schema release fixtures", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    await assert.rejects(
      inspector.inspect({ ...request(root), fixtures: [] }),
      /at least one valid and one invalid example/u,
    );
    await assert.rejects(
      inspector.inspect({ ...request(root), fixtures: [request(root).fixtures[1]] }),
      /at least one valid and one invalid example/u,
    );
    const directPolicy = policy(observation);
    directPolicy.fixtures = [];
    assert.throws(
      () => jsonSchemaModule.evaluateJsonSchemaRelease(directPolicy, observation),
      /at least one valid and one invalid fixture/u,
    );
  });
});

test("rejects a JSON Schema released-baseline pointer outside the release-owned anchor", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    await writeSeparatedPolicy(root, observation);
    const config = capabilityConfig(observation, "tmp/reset-history.yaml");
    await writeYaml(root, "contract.yaml", config);
    await assert.rejects(
      jsonSchemaConfig.loadCapabilityConfig(schemaConfigurationDependencies(), root, "contract.yaml"),
      /releasedBaselinePath must match pattern/u,
    );
  });
});

test("rejects remote references and duplicate IDs before AJV can resolve anything", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
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

test("resolves local references from nested schema resource IDs", async () => {
  await withContractFixture(async (root) => {
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      $ref: "nested/child.schema.json",
      $defs: {
        child: {
          $id: "nested/child.schema.json",
          type: "object",
          additionalProperties: false,
          required: ["id", "contact", "details"],
          properties: {
            id: { type: "string" },
            contact: { type: "string", format: "email" },
            details: { $ref: "../common.schema.json" },
          },
        },
      },
    });

    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    assert.equal(observation.fixtureResults.every((fixture) => fixture.matched), true);
  });
});

test("rejects duplicate nested schema resource IDs before compilation", async () => {
  await withContractFixture(async (root) => {
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      $defs: {
        first: { $id: "nested/duplicate.schema.json", type: "string" },
        second: { $id: "nested/duplicate.schema.json", type: "number" },
      },
    });

    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    await assert.rejects(inspector.inspect(request(root)), /must be unique/u);
  });
});

test("does not interpret instance data named $ref as a schema reference", async () => {
  await withContractFixture(async (root) => {
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      properties: {
        metadata: {
          const: { $ref: "https://untrusted.example.test/instance-data.json" },
        },
      },
    });
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    await assert.doesNotReject(inspector.inspect(request(root)));
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
      const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
      await assert.rejects(inspector.inspect(request(root)), /symbolic link/u);
    } finally {
      await rm(external, { force: true, recursive: true });
    }
  });
});

test("detects immutable same-version changes and missing supported-consumer evidence", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const released = await inspector.inspect(request(root));
    await writeJson(root, "schemas/root.schema.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/agent/root.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["id", "contact", "details"],
      properties: {
        id: { type: "string", minLength: 1 },
        contact: { type: "string", format: "email" },
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
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const released = await inspector.inspect(request(root));
    await writeJson(root, "fixtures/valid.json", {
      id: "task-2",
      contact: "runtime-2@example.test",
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
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
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
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    await writeSeparatedPolicy(root, observation, "architecture/contracts/released.json");
    const capability = jsonSchemaModule.createJsonSchemaReleaseCapability({ assertSchema: schemaConfigurationDependencies().assertSchema });
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

    await writeFile(
      join(root, "contract.yaml"),
      "schemaVersion: 1\ncontractId: invalid\n",
      "utf8",
    );
    const invalid = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(invalid.outcome, "invalid-input");
    assert.equal(invalid.problem.code, "SCHEMA_INVALID");

    await writeSeparatedPolicy(root, observation);
    const failedCapability = jsonSchemaModule.createJsonSchemaReleaseCapability({
      assertSchema: schemaConfigurationDependencies().assertSchema,
      inspector: {
        async inspect() {
          throw new Error("unexpected adapter failure");
        },
      },
    });
    const failed = await failedCapability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.problem.code, "UNEXPECTED_FAILURE");
    assert.equal(failed.problem.message, "An unexpected failure occurred.");
  });
});

test("requires an explicitly supported root configuration schema version", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    const capability = jsonSchemaModule.createJsonSchemaReleaseCapability({ assertSchema: schemaConfigurationDependencies().assertSchema });

    const missingVersion = capabilityConfig(observation);
    delete missingVersion.schemaVersion;
    await writeYaml(root, "contract.yaml", missingVersion);
    const missing = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(missing.outcome, "invalid-input");
    assert.equal(missing.problem.code, "JSON_SCHEMA_RELEASE_CONFIG_INVALID");

    const unknownVersion = capabilityConfig(observation);
    unknownVersion.schemaVersion = 2;
    await writeYaml(root, "contract.yaml", unknownVersion);
    const unknown = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(unknown.outcome, "invalid-input");
    assert.equal(unknown.problem.code, "JSON_SCHEMA_RELEASE_CONFIG_INVALID");
  });
});

test("rejects a released consumer baseline that was never proven passing", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    const evidence = policy(observation);
    evidence.released.supportedConsumers[0].outcome = "failed";
    assert.throws(
      () => jsonSchemaModule.evaluateJsonSchemaRelease(evidence, observation),
      /must be passed/u,
    );
  });
});

test("JSON Schema contract config and released baseline schemas accept verified shapes", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
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
    const config = capabilityConfig(observation);
    assert.equal(validate(config), true, JSON.stringify(validate.errors));

    const baselineSource = await readFile(
      join(
        repositoryRoot,
        "packages",
        "engineering-foundation",
        "schemas",
        "contract-json-schema-release-baseline",
        "v1.schema.json",
      ),
      "utf8",
    );
    const validateBaseline = new Ajv2020({ strict: true }).compile(
      JSON.parse(baselineSource),
    );
    assert.equal(
      validateBaseline(releasedBaseline(observation)),
      true,
      JSON.stringify(validateBaseline.errors),
    );

    const missingVersion = capabilityConfig(observation);
    delete missingVersion.schemaVersion;
    assert.equal(validate(missingVersion), false);

    const unknownVersion = capabilityConfig(observation);
    unknownVersion.schemaVersion = 2;
    assert.equal(validate(unknownVersion), false);
  });
});

test("loads a separate released baseline deterministically and rejects inline substitution", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    await writeSeparatedPolicy(root, observation);
    const capability = jsonSchemaModule.createJsonSchemaReleaseCapability({ assertSchema: schemaConfigurationDependencies().assertSchema });

    const first = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    const second = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(first.outcome, "passed");
    assert.deepEqual(second, first);

    const substituted = {
      ...capabilityConfig(observation),
      released: releasedBaseline(observation),
    };
    await writeYaml(root, "contract.yaml", substituted);
    const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "SCHEMA_INVALID");
  });
});

test("rejects missing, escaping, and invalid released JSON Schema baselines", async () => {
  await withContractFixture(async (root) => {
    const inspector = new jsonSchemaModule.AjvJsonSchemaReleaseInspector(schemaFiles);
    const observation = await inspector.inspect(request(root));
    const capability = jsonSchemaModule.createJsonSchemaReleaseCapability({ assertSchema: schemaConfigurationDependencies().assertSchema });
    const config = capabilityConfig(observation);
    await writeYaml(root, "contract.yaml", config);

    const missing = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(missing.outcome, "invalid-input");
    assert.equal(missing.problem.code, "CONFIG_FILE_UNAVAILABLE");

    const external = await mkdtemp(join(tmpdir(), "foundation-json-schema-baseline-external-"));
    try {
      await writeYaml(external, "released.yaml", releasedBaseline(observation));
      await mkdir(join(root, "architecture", "contracts"), { recursive: true });
      await symlink(
        join(external, "released.yaml"),
        join(root, "architecture", "contracts", "released.yaml"),
      );
      const unsafe = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
      assert.equal(unsafe.outcome, "invalid-input");
      assert.equal(unsafe.problem.code, "CONFIG_SYMLINK_PROHIBITED");
      await unlink(join(root, "architecture", "contracts", "released.yaml"));
    } finally {
      await rm(external, { force: true, recursive: true });
    }

    await writeYaml(root, "architecture/contracts/released.yaml", { schemaVersion: 1 });
    const invalid = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(invalid.outcome, "invalid-input");
    assert.equal(invalid.problem.code, "SCHEMA_INVALID");
  });
});
