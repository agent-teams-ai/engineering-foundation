import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const protobufModule = await import(
  pathToFileURL(
    join(distRoot, "capabilities", "contract-protobuf-evolution", "module.js"),
  ).href,
);
const protobufQualification = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "contract-protobuf-evolution",
      "qualification",
      "module.js",
    ),
  ).href,
);

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function policy() {
  return {
    schemaVersion: 1,
    released: {
      schemaVersion: 1,
      contractId: "agent-runtime-control",
      publicContractVersion: "1.2.0",
      bufVersion: "1.72.0",
      bufConfigDigest: digest("a"),
      descriptorImageDigest: digest("b"),
      generatorVersions: [
        { name: "buf.build/connectrpc/es:v1.6.1", version: "1.6.1" },
        { name: "buf.build/bufbuild/es:v2.2.3", version: "2.2.3" },
      ].toSorted((left, right) => `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`)),
      generatedOutputDigest: digest("c"),
    },
    current: {
      schemaVersion: 1,
      contractId: "agent-runtime-control",
      publicContractVersion: "1.2.0",
      bufVersion: "1.72.0",
      bufConfigDigest: digest("a"),
      descriptorImageDigest: digest("b"),
      releasedDescriptorImageDigest: digest("b"),
      generatorVersions: [
        { name: "buf.build/connectrpc/es:v1.6.1", version: "1.6.1" },
        { name: "buf.build/bufbuild/es:v2.2.3", version: "2.2.3" },
      ].toSorted((left, right) => `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`)),
      generationDrift: {
        expectedGeneratedOutputDigest: digest("c"),
        observedGeneratedOutputDigest: digest("c"),
      },
      breaking: { status: "compatible", fingerprint: digest("d") },
    },
  };
}

async function withConfig(value, callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-protobuf-evolution-"));
  try {
    await writeFile(join(root, "contract.yaml"), stringifyYaml(value), "utf8");
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("accepts released Buf evidence with exact baseline and clean generation", () => {
  assert.deepEqual(protobufModule.evaluateProtobufEvolution(policy()), []);
  assert.equal(Object.hasOwn(protobufModule, "ProcessBufExecutable"), false);
  assert.equal(Object.hasOwn(protobufModule, "verifyPinnedBufVersion"), false);
});

test("reports only explicit violations for stale baseline, toolchain drift, generation drift, and unapproved break", () => {
  const evidence = policy();
  evidence.current.publicContractVersion = "1.3.0";
  evidence.current.releasedDescriptorImageDigest = digest("f");
  evidence.current.bufVersion = "1.73.0";
  evidence.current.generationDrift.observedGeneratedOutputDigest = digest("f");
  evidence.current.breaking = { status: "breaking", fingerprint: digest("a") };

  assert.deepEqual(
    protobufModule
      .evaluateProtobufEvolution(evidence)
      .map((diagnostic) => diagnostic.ruleId),
    [
      "contract.protobuf-evolution.baseline-mismatch",
      "contract.protobuf-evolution.toolchain-mismatch",
      "contract.protobuf-evolution.generation-drift",
      "contract.protobuf-evolution.breaking-change-not-approved",
    ],
  );
});

test("rejects descriptor or generated output mutation under the same public version", () => {
  const evidence = policy();
  evidence.current.descriptorImageDigest = digest("d");
  evidence.current.generationDrift.expectedGeneratedOutputDigest = digest("e");
  evidence.current.generationDrift.observedGeneratedOutputDigest = digest("e");

  assert.deepEqual(
    protobufModule
      .evaluateProtobufEvolution(evidence)
      .map((diagnostic) => diagnostic.ruleId),
    ["contract.protobuf-evolution.immutable-version-mutated"],
  );
});

test("rejects malformed release evidence instead of silently normalizing it", () => {
  const evidence = policy();
  evidence.current.generatorVersions = [
    { name: "z", version: "1.0.0" },
    { name: "a", version: "1.0.0" },
  ];
  assert.throws(
    () => protobufModule.evaluateProtobufEvolution(evidence),
    /must be unique and sorted/u,
  );
  const duplicate = policy();
  duplicate.current.generatorVersions = [
    { name: "same", version: "1.0.0" },
    { name: "same", version: "1.0.0" },
  ];
  assert.throws(
    () => protobufModule.evaluateProtobufEvolution(duplicate),
    /must be unique and sorted/u,
  );
});

test("rejects breaking evidence that is not bound to a deterministic fingerprint", () => {
  const evidence = policy();
  evidence.current.breaking = {
    status: "breaking",
    approvalReference: "ADR-0042",
  };

  assert.throws(
    () => protobufModule.evaluateProtobufEvolution(evidence),
    /requires a deterministic fingerprint/u,
  );
});

test("rejects public release versions with build metadata and detects prerelease regression", () => {
  const buildMetadata = policy();
  buildMetadata.current.publicContractVersion = "1.2.0+ci.1";
  assert.throws(
    () => protobufModule.evaluateProtobufEvolution(buildMetadata),
    /without build metadata/u,
  );

  const prerelease = policy();
  prerelease.current.publicContractVersion = "1.2.0-rc.1";
  assert.deepEqual(
    protobufModule
      .evaluateProtobufEvolution(prerelease)
      .map((diagnostic) => diagnostic.ruleId),
    ["contract.protobuf-evolution.public-version-regressed"],
  );
});

test("runs as a deterministic read-only Foundation capability with closed input handling", async () => {
  await withConfig(policy(), async (root) => {
    const moduleSource = await readFile(
      join(distRoot, "capabilities", "contract-protobuf-evolution", "module.js"),
      "utf8",
    );
    assert.doesNotMatch(moduleSource, /qualification|child_process|node:child_process/u);

    const capability = protobufModule.createProtobufEvolutionCapability();
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

    await writeFile(join(root, "contract.yaml"), "schemaVersion: 1\nreleased: []\n", "utf8");
    const invalid = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(invalid.outcome, "invalid-input");
    assert.equal(invalid.problem.code, "SCHEMA_INVALID");
  });
});

test("requires an explicitly supported root configuration schema version", async () => {
  const capability = protobufModule.createProtobufEvolutionCapability();

  const missingVersion = policy();
  delete missingVersion.schemaVersion;
  await withConfig(missingVersion, async (root) => {
    const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "PROTOBUF_EVOLUTION_CONFIG_INVALID");
  });

  const unknownVersion = policy();
  unknownVersion.schemaVersion = 2;
  await withConfig(unknownVersion, async (root) => {
    const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "PROTOBUF_EVOLUTION_CONFIG_INVALID");
  });
});

test("checks the pinned Buf executable through an injected port", async () => {
  const invocations = [];
  await protobufQualification.verifyPinnedBufVersion(
    {
      invocation: {
        executablePath: "/trusted/toolchain/buf",
        workingDirectory: repositoryRoot,
      },
      expectedVersion: "1.72.0",
    },
    {
      async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 0, stdout: "1.72.0\n", stderr: "" };
      },
    },
  );
  assert.deepEqual(invocations, [
    {
      executablePath: "/trusted/toolchain/buf",
      workingDirectory: repositoryRoot,
      arguments: ["--version"],
    },
  ]);
});

test("Buf process adapter rejects relative executables and control-character arguments before spawning", async () => {
  const executable = new protobufQualification.ProcessBufExecutable();
  await assert.rejects(
    executable.run({
      executablePath: "buf",
      workingDirectory: repositoryRoot,
      arguments: [],
    }),
    /must be absolute/u,
  );
  await assert.rejects(
    executable.run({
      executablePath: process.execPath,
      workingDirectory: repositoryRoot,
      arguments: ["--version\nnot-a-command"],
    }),
    /argument 0 is invalid/u,
  );
});

test("Protobuf evidence JSON Schema accepts the valid release proof shape", async () => {
  const source = await readFile(
    join(
      repositoryRoot,
      "packages",
      "engineering-foundation",
      "schemas",
      "contract-protobuf-evolution",
      "v1.schema.json",
    ),
    "utf8",
  );
  const validate = new Ajv2020({ strict: true }).compile(JSON.parse(source));
  assert.equal(validate(policy()), true, JSON.stringify(validate.errors));

  const missingVersion = policy();
  delete missingVersion.schemaVersion;
  assert.equal(validate(missingVersion), false);

  const unknownVersion = policy();
  unknownVersion.schemaVersion = 2;
  assert.equal(validate(unknownVersion), false);
});
