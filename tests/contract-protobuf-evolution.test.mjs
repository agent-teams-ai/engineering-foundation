import { createManagedProcessExecutor, protobufAdapters, readAcceptedArchitectureDecisionEvidence, promoteArchitectureDecisionBaseline } from "./support/capability-adapters.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
const { compareBinaryStrings } = await import(
  pathToFileURL(join(distRoot, "binary-string-comparator.js")).href
);
const protobufModule = await import(
  pathToFileURL(
    join(distRoot, "capabilities", "contract-protobuf-evolution", "module.js"),
  ).href,
);
const protobufConfig = await import(
  pathToFileURL(
    join(distRoot, "capabilities", "contract-protobuf-evolution", "contract", "config.js"),
  ).href,
);
const protobufGovernanceAcl = await import(
  pathToFileURL(
    join(
      distRoot,
      "capabilities",
      "contract-protobuf-evolution",
      "adapters",
      "outbound",
      "governance",
      "governance-accepted-decision-evidence-acl.js",
    ),
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
const protobufQualificationModel = await import(
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

const bufConfigSource = "version: v2\nmodules:\n  - path: contracts/protobuf\nbreaking:\n  use:\n    - FILE\n";
const releasedDescriptorImage = Buffer.from("released descriptor image\n", "utf8");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function policy() {
  return {
    schemaVersion: 1,
    acceptedDecisionIds: [],
    approvedBreakingChanges: [],
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
      ].toSorted((left, right) => compareBinaryStrings(
        `${left.name}\0${left.version}`,
        `${right.name}\0${right.version}`,
      )),
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
      ].toSorted((left, right) => compareBinaryStrings(
        `${left.name}\0${left.version}`,
        `${right.name}\0${right.version}`,
      )),
      generationDrift: {
        expectedGeneratedOutputDigest: digest("c"),
        observedGeneratedOutputDigest: digest("c"),
      },
      breaking: { status: "compatible", fingerprint: digest("d") },
    },
  };
}

function releasedBaseline() {
  return {
    ...policy().released,
    bufConfigDigest: sha256(bufConfigSource),
    descriptorImageDigest: sha256(releasedDescriptorImage),
  };
}

function capabilityConfig(releasedBaselinePath = "architecture/contracts/released.yaml") {
  const released = releasedBaseline();
  return {
    schemaVersion: 1,
    releasedBaselinePath,
    approvedBreakingChanges: [],
    qualification: {
      modulePath: "contracts/protobuf",
      bufConfigPath: "buf.yaml",
      releasedDescriptorImagePath: "architecture/contracts/released.binpb",
      evidencePath: "architecture/evidence/protobuf/qualification.json",
    },
    current: {
      schemaVersion: 1,
      contractId: released.contractId,
      publicContractVersion: released.publicContractVersion,
      bufVersion: released.bufVersion,
      bufConfigDigest: released.bufConfigDigest,
      descriptorImageDigest: released.descriptorImageDigest,
      generatorVersions: released.generatorVersions,
      generationDrift: {
        expectedGeneratedOutputDigest: released.generatedOutputDigest,
        observedGeneratedOutputDigest: released.generatedOutputDigest,
      },
    },
  };
}

function qualificationEvidence(config, baseline) {
  const findingSetDigest = sha256(
    protobufQualificationModel.canonicalBufFindingSet([]),
  );
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
    baselineDescriptorImageDigest: baseline.descriptorImageDigest,
    candidateDescriptorImageDigest: config.current.descriptorImageDigest,
    breakingPolicyConfigDigest: sha256(
      protobufQualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
    ),
    invocationDigest: sha256(
      protobufQualificationModel.canonicalBufQualificationInvocation(
        protobufQualificationModel.qualificationInvocationInput({
          qualification: config.qualification,
          current: config.current,
          released: baseline,
          breakingPolicyConfigDigest: sha256(
            protobufQualificationModel.BUF_FILE_BREAKING_CONFIG_SOURCE,
          ),
        }),
      ),
    ),
    result: {
      status: "compatible",
      findings: [],
      findingSetDigest,
      rawOutputDigest: sha256(""),
    },
  };
  return {
    ...evidenceWithoutDigest,
    evidenceDigest: sha256(
      protobufQualificationModel.canonicalBufQualificationEvidence(
        evidenceWithoutDigest,
      ),
    ),
  };
}

function breakingQualificationEvidence(fingerprint = digest("f")) {
  return {
    async read({ configuration }) {
      return {
        breaking: { status: "breaking", fingerprint },
        releasedDescriptorImageDigest: configuration.released.descriptorImageDigest,
      };
    },
  };
}

async function writeYaml(root, path, value) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringifyYaml(value), "utf8");
}

async function withConfig(value, callback, baseline = releasedBaseline()) {
  const root = await mkdtemp(join(tmpdir(), "foundation-protobuf-evolution-"));
  try {
    await writeYaml(root, "contract.yaml", value);
    await writeYaml(root, "architecture/contracts/released.yaml", baseline);
    await mkdir(join(root, "contracts", "protobuf"), { recursive: true });
    await writeFile(join(root, "buf.yaml"), bufConfigSource, "utf8");
    await mkdir(join(root, "architecture", "contracts"), { recursive: true });
    await writeFile(
      join(root, "architecture", "contracts", "released.binpb"),
      releasedDescriptorImage,
    );
    if (value.qualification !== undefined && value.current !== undefined) {
      await writeYaml(
        root,
        value.qualification.evidencePath,
        qualificationEvidence(value, baseline),
      );
    }
    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const governanceConfigPath =
  "architecture/foundation/governance-architecture-decisions.yaml";
const acceptedDecisionBaselinePath =
  "architecture/decisions/accepted-decisions.json";

async function writeGovernedDecisionEvidence(root, decisionId = "ADR-0042") {
  const number = decisionId.slice("ADR-".length);
  const slug = `${number}-approve-protobuf-contract-break`;
  const decisionPath = `docs/decisions/${slug}.md`;
  await writeYaml(root, governanceConfigPath, {
    schemaVersion: 1,
    adrRoots: ["docs/decisions"],
    index: {
      path: "docs/decisions/README.md",
      sections: {
        proposed: "Proposed",
        accepted: "Accepted",
        superseded: "Superseded",
      },
    },
    acceptedBaselinePath: acceptedDecisionBaselinePath,
  });
  await mkdir(join(root, "docs", "decisions"), { recursive: true });
  await writeFile(
    join(root, "docs", "decisions", "README.md"),
    `# Architecture Decisions\n\n## Proposed\n\n## Accepted\n\n- [${decisionId}: Approve Protobuf contract break](${slug}.md)\n\n## Superseded\n`,
    "utf8",
  );
  await writeFile(
    join(root, decisionPath),
    `---\nid: ${decisionId}\nstatus: accepted\nsupersedes: []\nsuperseded_by: []\n---\n\n# ${decisionId}: Approve Protobuf Contract Break\n\nThe breaking Protobuf contract change is explicitly reviewed.\n`,
    "utf8",
  );
  await promoteArchitectureDecisionBaseline({
    consumerRoot: root,
    configPath: governanceConfigPath,
  });
}

test("accepts released Buf evidence with exact baseline and clean generation", () => {
  assert.deepEqual(protobufModule.evaluateProtobufEvolution(policy()), []);
  assert.equal(Object.hasOwn(protobufModule, "ProcessBufExecutable"), false);
  assert.equal(Object.hasOwn(protobufModule, "verifyPinnedBufVersion"), false);
});

test("rejects Protobuf baseline pointers outside stable governance anchors", async () => {
  await withConfig(capabilityConfig(), async (root) => {
    const releasedReset = capabilityConfig("tmp/reset-history.yaml");
    await writeYaml(root, "contract.yaml", releasedReset);
    await assert.rejects(
      protobufConfig.loadCapabilityConfig(root, "contract.yaml"),
      /releasedBaselinePath must match pattern/u,
    );

    const decisionReset = capabilityConfig();
    decisionReset.approvedBreakingChanges = [
      { decisionId: "ADR-0001", fingerprint: digest("a") },
    ];
    decisionReset.acceptedDecisionBaselinePath = "architecture/decisions/reset-history.json";
    await writeYaml(root, "contract.yaml", decisionReset);
    await assert.rejects(
      protobufConfig.loadCapabilityConfig(root, "contract.yaml"),
      /acceptedDecisionBaselinePath must be equal to constant/u,
    );

    const incompleteGovernanceEvidence = capabilityConfig();
    incompleteGovernanceEvidence.approvedBreakingChanges = [
      { decisionId: "ADR-0001", fingerprint: digest("a") },
    ];
    incompleteGovernanceEvidence.acceptedDecisionBaselinePath =
      acceptedDecisionBaselinePath;
    await writeYaml(root, "contract.yaml", incompleteGovernanceEvidence);
    await assert.rejects(
      protobufConfig.loadCapabilityConfig(root, "contract.yaml"),
      /acceptedDecisionBaselinePath and governanceConfigPath must be declared together/u,
    );
  });
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
  };

  assert.throws(
    () => protobufModule.evaluateProtobufEvolution(evidence),
    /requires a deterministic fingerprint/u,
  );
});

test("binds a breaking fingerprint to an immutable accepted architecture decision", () => {
  const evidence = policy();
  evidence.current.breaking = {
    status: "breaking",
    fingerprint: digest("f"),
  };
  evidence.approvedBreakingChanges = [
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  assert.deepEqual(
    protobufModule
      .evaluateProtobufEvolution(evidence)
      .map((diagnostic) => diagnostic.ruleId),
    ["contract.protobuf-evolution.breaking-change-not-approved"],
  );

  evidence.acceptedDecisionIds = ["ADR-0042"];
  assert.deepEqual(protobufModule.evaluateProtobufEvolution(evidence), []);
});

test("accepts any matching breaking approval backed by an accepted decision", () => {
  const evidence = policy();
  evidence.current.breaking = {
    status: "breaking",
    fingerprint: digest("f"),
  };
  evidence.approvedBreakingChanges = [
    { decisionId: "ADR-0041", fingerprint: digest("f") },
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  evidence.acceptedDecisionIds = ["ADR-0042"];

  assert.deepEqual(protobufModule.evaluateProtobufEvolution(evidence), []);
});

test("keeps governance evidence as an opaque protobuf configuration reference", async () => {
  const config = capabilityConfig();
  config.approvedBreakingChanges = [
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  config.acceptedDecisionBaselinePath = acceptedDecisionBaselinePath;
  config.governanceConfigPath = governanceConfigPath;

  await withConfig(config, async (root) => {
    const configuration = await protobufConfig.loadCapabilityConfig(root, "contract.yaml");
    assert.equal(
      configuration.acceptedDecisionBaselinePath,
      acceptedDecisionBaselinePath,
    );
    assert.equal(configuration.governanceConfigPath, governanceConfigPath);
    assert.equal(Object.hasOwn(configuration, "acceptedDecisionIds"), false);
  });
});

test("accepts the repository root as an explicit Buf module path", async () => {
  const config = capabilityConfig();
  config.qualification.modulePath = ".";
  await withConfig(config, async (root) => assert.equal(
    (await protobufConfig.loadCapabilityConfig(root, "contract.yaml")).qualification.modulePath,
    ".",
  ));
});

test("resolves accepted decision evidence through the consumer-owned port", async () => {
  const config = capabilityConfig();
  config.approvedBreakingChanges = [
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  config.acceptedDecisionBaselinePath = acceptedDecisionBaselinePath;
  config.governanceConfigPath = governanceConfigPath;
  const calls = [];
  let consumerRoot;

  await withConfig(config, async (root) => {
    consumerRoot = root;
    const capability = protobufModule.createProtobufEvolutionCapability({
      acceptedDecisionEvidence: {
        async readAcceptedDecisionEvidence(input) {
          calls.push(input);
          return { acceptedDecisionIds: ["ADR-0042"] };
        },
      },
      bufBreakingQualificationEvidence: breakingQualificationEvidence(),
    });
    const result = await capability.run({
      consumerRoot: root,
      configPath: "contract.yaml",
    });
    assert.equal(result.outcome, "passed");
  });

  assert.deepEqual(calls, [
    {
      consumerRoot,
      baselinePath: acceptedDecisionBaselinePath,
      governanceConfigPath,
    },
  ]);
});

test("rejects a fabricated accepted-decision baseline without immutable governance evidence", async () => {
  const config = capabilityConfig();
  config.approvedBreakingChanges = [
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  config.acceptedDecisionBaselinePath = acceptedDecisionBaselinePath;
  config.governanceConfigPath = governanceConfigPath;
  await withConfig(config, async (root) => {
    await writeYaml(root, governanceConfigPath, {
      schemaVersion: 1,
      adrRoots: ["docs/decisions"],
      index: {
        path: "docs/decisions/README.md",
        sections: {
          proposed: "Proposed",
          accepted: "Accepted",
          superseded: "Superseded",
        },
      },
      acceptedBaselinePath: acceptedDecisionBaselinePath,
    });
    const baselinePath = join(
      root,
      "architecture",
      "decisions",
      "accepted-decisions.json",
    );
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      `${JSON.stringify({
        schemaVersion: 1,
        algorithm: "sha256",
        decisions: [
          {
            id: "ADR-0042",
            path: "docs/decisions/0042-approve-runtime-contract-break.md",
            immutableDigest: digest("e"),
          },
        ],
      })}\n`,
      "utf8",
    );
    const capability = protobufModule.createProtobufEvolutionCapability(protobufAdapters());
    const result = await capability.run({
      consumerRoot: root,
      configPath: "contract.yaml",
    });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(
      result.problem?.code,
      "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
    );
  });
});

test("loads a breaking approval only from a complete immutable governance catalog", async () => {
  const config = capabilityConfig();
  config.approvedBreakingChanges = [
    { decisionId: "ADR-0042", fingerprint: digest("f") },
  ];
  config.acceptedDecisionBaselinePath = acceptedDecisionBaselinePath;
  config.governanceConfigPath = governanceConfigPath;
  await withConfig(config, async (root) => {
    await writeGovernedDecisionEvidence(root);
    const result = await protobufModule.createProtobufEvolutionCapability({
      ...protobufAdapters(),
      bufBreakingQualificationEvidence: breakingQualificationEvidence(),
    }).run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "passed");
  });
});

test("governance evidence ACL preserves deterministic mapping, cancellation, and containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-protobuf-governance-acl-"));
  const external = await mkdtemp(join(tmpdir(), "foundation-protobuf-governance-external-"));
  try {
    await writeGovernedDecisionEvidence(root);
    const acl = new protobufGovernanceAcl.GovernanceAcceptedDecisionEvidenceAcl(readAcceptedArchitectureDecisionEvidence);
    assert.deepEqual(
      await acl.readAcceptedDecisionEvidence({
        consumerRoot: root,
        baselinePath: acceptedDecisionBaselinePath,
        governanceConfigPath,
      }),
      { acceptedDecisionIds: ["ADR-0042"] },
    );
    await assert.rejects(
      acl.readAcceptedDecisionEvidence({
        consumerRoot: root,
        baselinePath: acceptedDecisionBaselinePath,
        governanceConfigPath,
        signal: AbortSignal.abort(),
      }),
      (error) => error?.problem?.code === "EXECUTION_CANCELLED",
    );

    const externalBaselinePath = join(external, "accepted-decisions.json");
    await writeFile(
      externalBaselinePath,
      await readFile(join(root, acceptedDecisionBaselinePath), "utf8"),
    );
    await unlink(join(root, acceptedDecisionBaselinePath));
    await symlink(externalBaselinePath, join(root, acceptedDecisionBaselinePath));
    await assert.rejects(
      acl.readAcceptedDecisionEvidence({
        consumerRoot: root,
        baselinePath: acceptedDecisionBaselinePath,
        governanceConfigPath,
      }),
      (error) => error?.problem?.code === "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(external, { force: true, recursive: true });
  }
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
  await withConfig(capabilityConfig(), async (root) => {
    const moduleSource = await readFile(
      join(distRoot, "capabilities", "contract-protobuf-evolution", "module.js"),
      "utf8",
    );
    assert.doesNotMatch(moduleSource, /child_process|node:child_process|ProcessBuf/u);
    const commandHostSource = await readFile(join(distRoot, "composition", "command-host.js"), "utf8");
    assert.doesNotMatch(commandHostSource, /^import .*contract-protobuf-evolution\/qualification\/module/mu);
    assert.match(
      commandHostSource,
      /await import\(\s*"\.\.\/capabilities\/contract-protobuf-evolution\/qualification\/module\.js"\s*\)/u,
    );

    const capability = protobufModule.createProtobufEvolutionCapability(protobufAdapters());
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
      "schemaVersion: 1\nreleasedBaselinePath: architecture/contracts/released.yaml\nreleased: []\n",
      "utf8",
    );
    const invalid = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(invalid.outcome, "invalid-input");
    assert.equal(invalid.problem.code, "SCHEMA_INVALID");
  });
});

test("requires an explicitly supported root configuration schema version", async () => {
  const capability = protobufModule.createProtobufEvolutionCapability(protobufAdapters());

  const missingVersion = capabilityConfig();
  delete missingVersion.schemaVersion;
  await withConfig(missingVersion, async (root) => {
    const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "PROTOBUF_EVOLUTION_CONFIG_INVALID");
  });

  for (const schemaVersion of [2, 3]) {
    const unsupportedVersion = capabilityConfig();
    unsupportedVersion.schemaVersion = schemaVersion;
    await withConfig(unsupportedVersion, async (root) => {
      const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
      assert.equal(result.outcome, "invalid-input");
      assert.equal(result.problem.code, "PROTOBUF_EVOLUTION_CONFIG_INVALID");
    });
  }
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
  const executable = new protobufQualification.ProcessBufExecutable(createManagedProcessExecutor());
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

test("Protobuf contract config and released baseline schemas accept verified shapes", async () => {
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
  assert.equal(validate(capabilityConfig()), true, JSON.stringify(validate.errors));

  const baselineSource = await readFile(
    join(
      repositoryRoot,
      "packages",
      "engineering-foundation",
      "schemas",
      "contract-protobuf-evolution-baseline",
      "v1.schema.json",
    ),
    "utf8",
  );
  const validateBaseline = new Ajv2020({ strict: true }).compile(JSON.parse(baselineSource));
  assert.equal(validateBaseline(releasedBaseline()), true, JSON.stringify(validateBaseline.errors));

  const evidenceSource = await readFile(
    join(
      repositoryRoot,
      "packages",
      "engineering-foundation",
      "schemas",
      "contract-protobuf-breaking-qualification",
      "v1.schema.json",
    ),
    "utf8",
  );
  const validateEvidence = new Ajv2020({ strict: true }).compile(JSON.parse(evidenceSource));
  assert.equal(
    validateEvidence(qualificationEvidence(capabilityConfig(), releasedBaseline())),
    true,
    JSON.stringify(validateEvidence.errors),
  );

  const missingVersion = capabilityConfig();
  delete missingVersion.schemaVersion;
  assert.equal(validate(missingVersion), false);

  const unknownVersion = capabilityConfig();
  unknownVersion.schemaVersion = 3;
  assert.equal(validate(unknownVersion), false);
});

test("loads a separate released Protobuf baseline deterministically and rejects inline substitution", async () => {
  await withConfig(capabilityConfig(), async (root) => {
    const capability = protobufModule.createProtobufEvolutionCapability(protobufAdapters());
    const first = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    const second = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(first.outcome, "passed");
    assert.deepEqual(second, first);

    await writeYaml(root, "contract.yaml", {
      ...capabilityConfig(),
      released: releasedBaseline(),
    });
    const result = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(result.outcome, "invalid-input");
    assert.equal(result.problem.code, "SCHEMA_INVALID");
  });
});

test("rejects missing, escaping, and invalid released Protobuf baselines", async () => {
  await withConfig(capabilityConfig(), async (root) => {
    const capability = protobufModule.createProtobufEvolutionCapability(protobufAdapters());
    await unlink(join(root, "architecture", "contracts", "released.yaml"));
    const missing = await capability.run({ consumerRoot: root, configPath: "contract.yaml" });
    assert.equal(missing.outcome, "invalid-input");
    assert.equal(missing.problem.code, "CONFIG_FILE_UNAVAILABLE");

    const external = await mkdtemp(join(tmpdir(), "foundation-protobuf-baseline-external-"));
    try {
      await writeYaml(external, "released.yaml", releasedBaseline());
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
