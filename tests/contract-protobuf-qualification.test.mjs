import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
      schemaVersion: 2,
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
    bufConfigDigest: config.current.bufConfigDigest,
    baselineDescriptorImagePath: config.qualification.releasedDescriptorImagePath,
    baselineDescriptorImageDigest: config.released.descriptorImageDigest,
    candidateDescriptorImageDigest: config.current.descriptorImageDigest,
    invocationDigest: sha256(
      qualificationModel.canonicalBufQualificationInvocation(
        qualificationModel.qualificationInvocationInput(config),
      ),
    ),
    result: {
      status: "compatible",
      findings: [],
      findingSetDigest: sha256(qualificationModel.canonicalBufFindingSet([])),
      rawOutputDigest: sha256(""),
    },
  };
  return {
    ...evidenceWithoutDigest,
    evidenceDigest: sha256(
      qualificationModel.canonicalBufQualificationEvidence(evidenceWithoutDigest),
    ),
  };
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
    const adapter = new evidenceAdapter.FilesystemBufBreakingQualificationEvidence();
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

test("atomically replaces an existing evidence file larger than the new evidence", async () => {
  await withFixture(async ({ config, root }) => {
    const evidencePath = join(root, config.qualification.evidencePath);
    await writeFile(evidencePath, "x".repeat(64 * 1024), "utf8");
    const artifacts = new qualificationModule.FilesystemBufQualificationArtifacts();

    assert.equal(
      await artifacts.writeEvidence({
        consumerRoot: root,
        path: config.qualification.evidencePath,
        source: "{}\n",
      }),
      "updated",
    );
  });
});
