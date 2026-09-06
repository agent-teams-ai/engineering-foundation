import { readContainedRegularFile } from "../packages/engineering-foundation/dist/source-inventory/node.js";
import { parseStrictYamlSource } from "../packages/engineering-foundation/dist/features/configuration-input/yaml.js";
import { createManagedProcessExecutor, schemaConfigurationDependencies } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRequire = createRequire(
  join(repositoryRoot, "packages", "engineering-foundation", "package.json"),
);
const { lock: lockFile } = packageRequire("proper-lockfile");
const distRoot = process.env.FOUNDATION_DIST_ROOT ?? join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
);
const qualificationModule = await import(
  pathToFileURL(
    join(distRoot, "capabilities", "contract-protobuf-evolution", "qualification", "module.js"),
  ).href,
);
const qualificationModel = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "contract-protobuf-evolution",
      "application",
      "model",
      "buf-breaking-qualification.js",
    ),
  ).href,
);
const evidenceAdapter = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "contract-protobuf-evolution",
      "adapters",
      "outbound",
      "qualification",
      "filesystem-buf-breaking-qualification-evidence.js",
    ),
  ).href,
);

const bufConfigSource = "version: v2\nmodules:\n  - path: contracts/protobuf\nbreaking:\n  use:\n    - FILE\n";
const releasedDescriptorImage = Buffer.from("released descriptor image\n", "utf8");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function configuration() {
  const releasedDescriptorImageDigest = sha256(releasedDescriptorImage);
  return {
    approvedBreakingChanges: [],
    qualification: {
      modulePath: "contracts/protobuf",
      bufConfigPath: "buf.yaml",
      releasedDescriptorImagePath: "architecture/contracts/released.binpb",
      evidencePath: "architecture/evidence/protobuf/qualification.json",
    },
    released: {
      schemaVersion: 1,
      contractId: "agent-runtime-control",
      publicContractVersion: "1.2.0",
      bufVersion: "1.72.0",
      bufConfigDigest: sha256(bufConfigSource),
      descriptorImageDigest: releasedDescriptorImageDigest,
      generatorVersions: [],
      generatedOutputDigest: sha256("generated"),
    },
    current: {
      schemaVersion: 1,
      contractId: "agent-runtime-control",
      publicContractVersion: "1.2.0",
      bufVersion: "1.72.0",
      bufConfigDigest: sha256(bufConfigSource),
      descriptorImageDigest: releasedDescriptorImageDigest,
      generatorVersions: [],
      generationDrift: {
        expectedGeneratedOutputDigest: sha256("generated"),
        observedGeneratedOutputDigest: sha256("generated"),
      },
    },
  };
}

function finalizeEvidence(evidenceWithoutDigest) {
  return {
    ...evidenceWithoutDigest,
    evidenceDigest: sha256(
      qualificationModel.canonicalBufQualificationEvidence(evidenceWithoutDigest),
    ),
  };
}

function qualifiedEvidence(config) {
  const evidenceWithoutDigest = {
    schemaVersion: 1,
    producerId: "agent-teams-foundation.buf-breaking-qualification",
    producerVersion: 1,
    policy: "FILE",
    contractId: config.current.contractId,
    bufVersion: config.current.bufVersion,
    modulePath: config.qualification.modulePath,
    bufConfigPath: config.qualification.bufConfigPath,
    evidencePath: config.qualification.evidencePath,
    bufConfigDigest: config.current.bufConfigDigest,
    baselineDescriptorImagePath: config.qualification.releasedDescriptorImagePath,
    baselineDescriptorImageDigest: config.released.descriptorImageDigest,
    candidateDescriptorImageDigest: config.current.descriptorImageDigest,
    breakingPolicyConfigDigest: sha256(
      qualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
    ),
    invocationDigest: sha256(
      qualificationModel.canonicalBufQualificationInvocation(
        qualificationModel.qualificationInvocationInput({
          ...config,
          breakingPolicyConfigDigest: sha256(
            qualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
          ),
        }),
      ),
    ),
    result: {
      status: "compatible",
      findings: [],
      findingSetDigest: sha256(qualificationModel.canonicalBufFindingSet([])),
      rawOutputDigest: sha256(""),
    },
  };
  return finalizeEvidence(evidenceWithoutDigest);
}

function breakingEvidence(config, findings) {
  const compatible = qualifiedEvidence(config);
  const { evidenceDigest: _evidenceDigest, ...withoutDigest } = compatible;
  const normalizedFindings = qualificationModel.sortAndValidateBufFindings(findings);
  return finalizeEvidence({
    ...withoutDigest,
    result: {
      status: "breaking",
      findings: normalizedFindings,
      findingSetDigest: sha256(
        qualificationModel.canonicalBufFindingSet(normalizedFindings),
      ),
      rawOutputDigest: sha256("breaking output\n"),
    },
  });
}

async function writeFixture(root, config, evidence = qualifiedEvidence(config)) {
  await mkdir(join(root, "contracts", "protobuf"), { recursive: true });
  await mkdir(join(root, "architecture", "contracts"), { recursive: true });
  await mkdir(join(root, "architecture", "evidence", "protobuf"), { recursive: true });
  await writeFile(join(root, "buf.yaml"), bufConfigSource, "utf8");
  await writeFile(join(root, "architecture", "contracts", "released.binpb"), releasedDescriptorImage);
  await writeFile(
    join(root, "architecture", "evidence", "protobuf", "qualification.json"),
    stringifyYaml(evidence),
    "utf8",
  );
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "foundation-buf-qualification-"));
  const config = configuration();
  try {
    await writeFixture(root, config);
    return await callback({ config, root });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("qualification producer writes canonical evidence and reruns Buf before accepting it", async () => {
  await withFixture(async ({ config, root }) => {
    let evidenceSource;
    let runnerStatus = "compatible";
    let runnerOutput = "";
    const dependencies = {
      artifacts: {
        async readInput({ path }) {
          return path === config.qualification.bufConfigPath
            ? Buffer.from(bufConfigSource, "utf8")
            : releasedDescriptorImage;
        },
        async readExistingEvidence() { return evidenceSource; },
        async writeEvidence({ source }) {
          const result = evidenceSource === undefined ? "created" : "updated";
          evidenceSource = source;
          return result;
        },
      },
      digest: { digest: sha256 },
      runner: {
        async run() {
          return {
            status: runnerStatus,
            candidateDescriptorImage: releasedDescriptorImage,
            rawOutput: runnerOutput,
          };
        },
      },
    };
    const input = { consumerRoot: root, executablePath: "/trusted/buf", configuration: config };
    const written = await qualificationModule.qualifyBufBreakingEvidence(
      { ...input, write: true },
      dependencies,
    );
    assert.equal(written.writeResult, "created");
    assert.equal(JSON.parse(evidenceSource).policy, "FILE");
    assert.equal(
      (await qualificationModule.qualifyBufBreakingEvidence(
        { ...input, write: false },
        dependencies,
      )).writeResult,
      "checked",
    );

    runnerStatus = "breaking";
    runnerOutput = `${JSON.stringify({
      path: "control.proto",
      start_line: 5,
      start_column: 3,
      end_line: 5,
      end_column: 22,
      type: "FIELD_SAME_JSON_NAME",
      message: "Field renamed.",
    })}\n`;
    await assert.rejects(
      qualificationModule.qualifyBufBreakingEvidence(
        { ...input, write: false },
        dependencies,
      ),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_EVIDENCE_MISMATCH",
    );
  });
});

test("evidence reader rejects stale bindings, weakened FILE policy, and changed inputs", async () => {
  await withFixture(async ({ config, root }) => {
    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(schemaConfigurationDependencies().assertSchema, { read: readContainedRegularFile, parseYaml: parseStrictYamlSource });
    const stale = qualifiedEvidence(config);
    stale.candidateDescriptorImageDigest = `sha256:${"f".repeat(64)}`;
    await writeFixture(root, config, stale);
    await assert.rejects(
      adapter.read({ consumerRoot: root, configuration: config }),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_EVIDENCE_MISMATCH",
    );

    await writeFixture(root, config);
    await writeFile(
      join(root, "buf.yaml"),
      "version: v2\nbreaking:\n  use:\n    - PACKAGE\n",
      "utf8",
    );
    await assert.rejects(
      adapter.read({ consumerRoot: root, configuration: config }),
      (error) => error?.problem?.code === "BUF_FILE_POLICY_INVALID",
    );

    await writeFixture(root, config);
    await writeFile(join(root, "architecture", "contracts", "released.binpb"), "changed baseline");
    await assert.rejects(
      adapter.read({ consumerRoot: root, configuration: config }),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_INPUT_DIGEST_MISMATCH",
    );

    await writeFixture(root, config);
    const rebound = structuredClone(config);
    rebound.qualification.evidencePath = "architecture/evidence/protobuf/rebound.json";
    await writeFile(
      join(root, rebound.qualification.evidencePath),
      stringifyYaml(qualifiedEvidence(config)),
      "utf8",
    );
    await assert.rejects(
      adapter.read({ consumerRoot: root, configuration: rebound }),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_EVIDENCE_MISMATCH",
    );
  });
});

test("rejects duplicate Buf JSON findings before evidence is written", async () => {
  await withFixture(async ({ config, root }) => {
    const finding = JSON.stringify({
      path: "control.proto",
      start_line: 5,
      start_column: 3,
      end_line: 5,
      end_column: 22,
      type: "FIELD_SAME_JSON_NAME",
      message: "Field renamed.",
    });
    await assert.rejects(
      qualificationModule.qualifyBufBreakingEvidence(
        { consumerRoot: root, executablePath: "/trusted/buf", configuration: config, write: true },
        {
          artifacts: {
            async readInput({ path }) {
              return path === config.qualification.bufConfigPath
                ? Buffer.from(bufConfigSource, "utf8")
                : releasedDescriptorImage;
            },
            async readExistingEvidence() { return; },
            async writeEvidence() { throw new Error("must not write invalid evidence"); },
          },
          digest: { digest: sha256 },
          runner: {
            async run() {
              return {
                status: "breaking",
                candidateDescriptorImage: releasedDescriptorImage,
                rawOutput: `${finding}\n${finding}\n`,
              };
            },
          },
        },
      ),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_FINDINGS_INVALID",
    );
  });
});

test("atomically replaces oversized existing evidence without reading it into memory", async () => {
  await withFixture(async ({ config, root }) => {
    const evidencePath = join(root, config.qualification.evidencePath);
    await writeFile(evidencePath, "x".repeat((8 * 1024 * 1024) + 1), "utf8");
    const artifacts = new qualificationModule.FilesystemBufQualificationArtifacts();

    assert.equal(
      await artifacts.writeEvidence({
        consumerRoot: root,
        path: config.qualification.evidencePath,
        source: "{}\n",
      }),
      "updated",
    );
    assert.equal(await readFile(evidencePath, "utf8"), "{}\n");
  });
});

test("binds breaking approval fingerprints to the complete qualified transition", async () => {
  await withFixture(async ({ config, root }) => {
    const finding = {
      path: "control.proto",
      startLine: 5,
      startColumn: 3,
      endLine: 5,
      endColumn: 22,
      type: "FIELD_SAME_JSON_NAME",
      message: "Field renamed.",
    };
    const firstEvidence = breakingEvidence(config, [finding]);
    await writeFixture(root, config, firstEvidence);
    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(schemaConfigurationDependencies().assertSchema, { read: readContainedRegularFile, parseYaml: parseStrictYamlSource });
    const first = await adapter.read({ consumerRoot: root, configuration: config });
    assert.equal(first.breaking.fingerprint, firstEvidence.evidenceDigest);
    assert.notEqual(first.breaking.fingerprint, firstEvidence.result.findingSetDigest);

    const successor = structuredClone(config);
    successor.current.contractId = "agent-runtime-successor";
    successor.released.contractId = "agent-runtime-successor";
    const successorEvidence = breakingEvidence(successor, [finding]);
    await writeFixture(root, successor, successorEvidence);
    const second = await adapter.read({ consumerRoot: root, configuration: successor });
    assert.notEqual(second.breaking.fingerprint, first.breaking.fingerprint);
  });
});

test("normal evidence reader accepts the producer's full bounded evidence size", async () => {
  await withFixture(async ({ config, root }) => {
    const findings = Array.from({ length: 300 }, (_, index) => ({
      path: `contract-${String(index).padStart(3, "0")}.proto`,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
      type: "FIELD_SAME_NAME",
      message: `${String(index)}:${"x".repeat(3900)}`,
    }));
    const evidence = breakingEvidence(config, findings);
    const source = stringifyYaml(evidence);
    assert.ok(Buffer.byteLength(source, "utf8") > 1024 * 1024);
    await writeFixture(root, config, evidence);

    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(schemaConfigurationDependencies().assertSchema, { read: readContainedRegularFile, parseYaml: parseStrictYamlSource });
    assert.equal(
      (await adapter.read({ consumerRoot: root, configuration: config })).breaking.fingerprint,
      evidence.evidenceDigest,
    );
  });
});

test("runner uses one canonical inline FILE policy for both sides of breaking analysis", async () => {
  await withFixture(async ({ config, root }) => {
    let observedPolicy;
    const executable = {
      async run(invocation) {
        if (invocation.arguments[0] === "--version") {
          return { exitCode: 0, stdout: `${config.current.bufVersion}\n`, stderr: "" };
        }
        if (invocation.arguments[0] === "build") {
          const outputIndex = invocation.arguments.indexOf("-o");
          await writeFile(invocation.arguments[outputIndex + 1], releasedDescriptorImage);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const configIndex = invocation.arguments.indexOf("--config");
        const againstConfigIndex = invocation.arguments.indexOf("--against-config");
        observedPolicy = invocation.arguments[configIndex + 1];
        assert.equal(invocation.arguments[againstConfigIndex + 1], observedPolicy);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const runner = new qualificationModule.ProcessBufQualificationRunner(executable);
    await runner.run({
      executablePath: "/trusted/buf",
      workingDirectory: root,
      expectedVersion: config.current.bufVersion,
      modulePath: config.qualification.modulePath,
      bufConfigPath: config.qualification.bufConfigPath,
      baselineDescriptorImage: releasedDescriptorImage,
    });
    assert.equal(observedPolicy, qualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE);
  });
});

test(
  "runner rejects a candidate descriptor replaced with a symbolic link",
  { skip: process.platform === "win32" },
  async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), "foundation-buf-external-descriptor-"));
    const externalDescriptor = join(externalRoot, "candidate.binpb");
    try {
      await writeFile(externalDescriptor, releasedDescriptorImage);
      await withFixture(async ({ config, root }) => {
        const executable = {
          async run(invocation) {
            if (invocation.arguments[0] === "--version") {
              return { exitCode: 0, stdout: `${config.current.bufVersion}\n`, stderr: "" };
            }
            if (invocation.arguments[0] === "build") {
              const outputIndex = invocation.arguments.indexOf("-o");
              await symlink(externalDescriptor, invocation.arguments[outputIndex + 1]);
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            throw new Error("Buf breaking must not run for an unsafe descriptor.");
          },
        };
        const runner = new qualificationModule.ProcessBufQualificationRunner(executable);
        await assert.rejects(
          runner.run({
            executablePath: "/trusted/buf",
            workingDirectory: root,
            expectedVersion: config.current.bufVersion,
            modulePath: config.qualification.modulePath,
            bufConfigPath: config.qualification.bufConfigPath,
            baselineDescriptorImage: releasedDescriptorImage,
          }),
          (error) => error?.problem?.code === "BUF_CANDIDATE_DESCRIPTOR_INVALID",
        );
      });
    } finally {
      await rm(externalRoot, { force: true, recursive: true });
    }
  },
);

test("cancellation after Buf execution prevents evidence publication", async () => {
  await withFixture(async ({ config, root }) => {
    const controller = new AbortController();
    await assert.rejects(
      qualificationModule.qualifyBufBreakingEvidence(
        {
          consumerRoot: root,
          executablePath: "/trusted/buf",
          configuration: config,
          write: true,
          signal: controller.signal,
        },
        {
          artifacts: {
            async readInput({ path }) {
              return path === config.qualification.bufConfigPath
                ? Buffer.from(bufConfigSource, "utf8")
                : releasedDescriptorImage;
            },
            async readExistingEvidence() { return; },
            async writeEvidence() { throw new Error("cancelled evidence must not be written"); },
          },
          digest: { digest: sha256 },
          runner: {
            async run() {
              controller.abort();
              return {
                status: "compatible",
                candidateDescriptorImage: releasedDescriptorImage,
                rawOutput: "",
              };
            },
          },
        },
      ),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );
  });
});

test("input mutation during Buf execution prevents evidence publication", async () => {
  await withFixture(async ({ config, root }) => {
    let configReads = 0;
    await assert.rejects(
      qualificationModule.qualifyBufBreakingEvidence(
        {
          consumerRoot: root,
          executablePath: "/trusted/buf",
          configuration: config,
          write: true,
        },
        {
          artifacts: {
            async readInput({ path }) {
              if (path !== config.qualification.bufConfigPath) {
                return releasedDescriptorImage;
              }
              configReads += 1;
              return Buffer.from(
                configReads === 1 ? bufConfigSource : `${bufConfigSource}# changed\n`,
                "utf8",
              );
            },
            async readExistingEvidence() { return; },
            async writeEvidence() { throw new Error("changed input must not be published"); },
          },
          digest: { digest: sha256 },
          runner: {
            async run() {
              return {
                status: "compatible",
                candidateDescriptorImage: releasedDescriptorImage,
                rawOutput: "",
              };
            },
          },
        },
      ),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_INPUT_CHANGED",
    );
  });
});

test("evidence writer rejects a symbolic-link parent before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-buf-write-root-"));
  const external = await mkdtemp(join(tmpdir(), "foundation-buf-write-external-"));
  try {
    await mkdir(join(root, "architecture", "evidence"), { recursive: true });
    await symlink(
      external,
      join(root, "architecture", "evidence", "protobuf"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const artifacts = new qualificationModule.FilesystemBufQualificationArtifacts();
    await assert.rejects(
      artifacts.writeEvidence({
        consumerRoot: root,
        path: "architecture/evidence/protobuf/qualification.json",
        source: "{}\n",
      }),
      (error) => error?.problem?.code === "BUF_QUALIFICATION_PATH_UNSAFE",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(external, { force: true, recursive: true });
  }
});

test("evidence writer cancels while waiting for its cooperative lock", async () => {
  await withFixture(async ({ config, root }) => {
    const evidencePath = join(root, config.qualification.evidencePath);
    const release = await lockFile(evidencePath, { realpath: false });
    const controller = new AbortController();
    try {
      const write = new qualificationModule.FilesystemBufQualificationArtifacts().writeEvidence({
        consumerRoot: root,
        path: config.qualification.evidencePath,
        source: "{}\n",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);
      await assert.rejects(
        write,
        (error) => error?.problem?.code === "EXECUTION_CANCELLED",
      );
    } finally {
      await release();
    }
  });
});

test("Buf process execution enforces a bounded deadline", async () => {
  await withFixture(async ({ root }) => {
    const executable = new qualificationModule.ProcessBufExecutable(createManagedProcessExecutor(), 50);
    await assert.rejects(
      executable.run({
        executablePath: process.execPath,
        workingDirectory: root,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      }),
      (error) => error?.problem?.code === "BUF_EXECUTION_UNAVAILABLE",
    );
  });
});

test("qualification observation port preserves bounded reads, parser/schema ordering and digests", async () => {
  const config = configuration(), calls = [];
  const root = join(tmpdir(), "explicit-observation-fixture");
  const sourceByPath = new Map([
    [join(root, config.qualification.evidencePath), JSON.stringify(qualifiedEvidence(config))],
    [join(root, config.qualification.bufConfigPath), bufConfigSource],
    [join(root, config.qualification.releasedDescriptorImagePath), releasedDescriptorImage],
  ]);
  const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(
    async (...args) => { calls.push(["schema", args[0], args[2]]); await schemaConfigurationDependencies().assertSchema(...args); },
    {
      async read(input) {
        calls.push(["read", input]);
        return Buffer.from(sourceByPath.get(input.candidate));
      },
      parseYaml(source, phase) { calls.push(["parse", phase]); return parseStrictYamlSource(source, phase); },
    },
  );
  const result = await adapter.read({ consumerRoot: root, configuration: config });
  assert.deepEqual(result, {
    breaking: { status: "compatible", fingerprint: qualifiedEvidence(config).evidenceDigest },
    releasedDescriptorImageDigest: config.released.descriptorImageDigest,
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.breaking));
  assert.deepEqual(calls, [
    ["read", { candidate: join(root, config.qualification.evidencePath), root, maxBytes: 8 * 1024 * 1024 }],
    ["parse", "protobuf-buf-qualification-evidence"],
    ["schema", "contract-protobuf-breaking-qualification/v1", "protobuf-buf-qualification-evidence"],
    ["read", { candidate: join(root, config.qualification.bufConfigPath), root, maxBytes: 1024 * 1024 }],
    ["read", { candidate: join(root, config.qualification.releasedDescriptorImagePath), root, maxBytes: 64 * 1024 * 1024 }],
    ["parse", "protobuf-buf-config"],
  ]);
});

test("qualification observation failure policy recognizes only the existing error identity", async () => {
  const { ContainedFileReadError } = await import("../packages/engineering-foundation/dist/source-inventory/api.js");
  for (const failure of ["changed", "escape", "invalid", "missing", "symlink", "unavailable"]) {
    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(
      () => assert.fail("schema must not run"),
      { async read() { throw new ContainedFileReadError(failure); }, parseYaml() { assert.fail("parser must not run"); } },
    );
    await assert.rejects(adapter.read({ consumerRoot: "/explicit-observation-fixture", configuration: configuration() }), (error) => {
      assert.equal(error.problem.code, ["symlink", "escape"].includes(failure)
        ? "BUF_QUALIFICATION_PATH_UNSAFE" : "BUF_QUALIFICATION_INPUT_UNAVAILABLE");
      return true;
    });
  }
  for (const failure of [new Error("unknown"), { name: "ContainedFileReadError", failure: "symlink" }, null, "unknown"]) {
    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(
      () => assert.fail("schema must not run"),
      { async read() { throw failure; }, parseYaml() { assert.fail("parser must not run"); } },
    );
    await assert.rejects(adapter.read({ consumerRoot: "/explicit-observation-fixture", configuration: configuration() }), (error) => error === failure);
  }
});

test("qualification observation cancellation precedes parsing and unknown parser failures retain identity", async () => {
  const controller = new AbortController();
  const cancelled = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(
    () => assert.fail("schema must not run"),
    { async read() { controller.abort(); return Buffer.from("{}"); }, parseYaml() { assert.fail("parser must not run"); } },
  );
  await assert.rejects(cancelled.read({ consumerRoot: "/explicit-observation-fixture", configuration: configuration(), signal: controller.signal }), /cancel/iu);
  const sentinel = { parser: "unknown thrown identity" };
  const brokenParser = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence(
    () => assert.fail("schema must not run"),
    { async read() { return Buffer.from("{}"); }, parseYaml() { throw sentinel; } },
  );
  await assert.rejects(brokenParser.read({ consumerRoot: "/explicit-observation-fixture", configuration: configuration() }), (error) => error === sentinel);
});
