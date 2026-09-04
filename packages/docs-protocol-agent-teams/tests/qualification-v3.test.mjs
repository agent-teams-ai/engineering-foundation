import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";

import { describeCanonicalConsumerAssets } from "../dist/consumer-integration/index.js";
import { computePnpmRuntimeClosureDigestV2 } from
  "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import { runDocsProtocolQualificationV3 } from "../dist/qualification/index.js";

const sha256 = (character) => `sha256:${character.repeat(64)}`;
const integrity = (character) => `sha512-${character.repeat(86)}==`;
const packages = {
  repositoryMutation: { version: "0.1.0", integrity: integrity("A") },
  documentAuthoring: { version: "0.1.0", integrity: integrity("B") },
  docsProtocol: { version: "0.5.0", integrity: integrity("C") },
  docsProtocolAgentTeams: { version: "0.1.0", integrity: integrity("D") },
  engineeringFoundation: { version: "1.0.0", integrity: integrity("E") }
};
const packageNames = {
  repositoryMutation: "@agent-teams/repository-mutation",
  documentAuthoring: "@agent-teams/document-authoring",
  docsProtocol: "@agent-teams/docs-protocol",
  docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
  engineeringFoundation: "@agent-teams/engineering-foundation"
};
const internalDependencies = {
  repositoryMutation: {},
  documentAuthoring: { [packageNames.repositoryMutation]: packages.repositoryMutation.version },
  docsProtocol: {
    [packageNames.documentAuthoring]: packages.documentAuthoring.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version
  },
  docsProtocolAgentTeams: {
    [packageNames.docsProtocol]: packages.docsProtocol.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version
  },
  engineeringFoundation: {
    [packageNames.documentAuthoring]: packages.documentAuthoring.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version
  }
};
const directPackageKeys = ["docsProtocol", "docsProtocolAgentTeams", "engineeringFoundation"];
const lockfile = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      devDependencies: Object.fromEntries(directPackageKeys.map((key) => [
        packageNames[key],
        { specifier: packages[key].version, version: packages[key].version }
      ]))
    }
  },
  packages: Object.fromEntries(Object.keys(packages).map((key) => [
    `${packageNames[key]}@${packages[key].version}`,
    { resolution: { integrity: packages[key].integrity } }
  ])),
  snapshots: Object.fromEntries(Object.keys(packages).map((key) => [
    `${packageNames[key]}@${packages[key].version}`,
    Object.keys(internalDependencies[key]).length === 0
      ? {}
      : { dependencies: internalDependencies[key] }
  ]))
};
const lockfileBytes = Buffer.from(stringify(lockfile));
const profile = {
  schemaVersion: 3,
  repository: { provider: "github", id: "123", nameWithOwner: "example/docs" },
  integrationRoot: ".",
  packageManager: "pnpm",
  profilePath: "architecture/foundation/docs-protocol.yaml",
  skillPath: ".agents/skills/docs-authoring/SKILL.md",
  callerWorkflowPath: ".github/workflows/docs-protocol.yml",
  managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
  qualification: {
    contractPath: "architecture/foundation/docs-protocol-qualification.json",
    gateCommand: "pnpm docs:protocol:check"
  },
  cohort: {
    schemaVersion: 2,
    cohortId: "docs-v2-rc1",
    channel: "rc",
    recordDigest: sha256("1"),
    qualificationEventDigest: sha256("2"),
    eligibleAfter: "2026-09-04T12:00:00Z",
    upgradeFrom: ["docs-v1"],
    rollbackTo: ["docs-v1"],
    packages,
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "3".repeat(40),
      blobSha: "4".repeat(40)
    },
    assets: {
      skillDigest: sha256("5"),
      callerWorkflowDigest: sha256("6"),
      assetCatalogDigest: sha256("7"),
      transitionCatalogDigest: sha256("8")
    },
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: sha256("9")
    }
  }
};
profile.cohort.runtime.runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(
  lockfile,
  profile.cohort
);
profile.cohort.assets = describeCanonicalConsumerAssets(profile.cohort);
const evidence = {
  packages,
  schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  runtimeClosureDigest: profile.cohort.runtime.runtimeClosureDigest
};

const qualify = (candidateProfile = profile, candidateEvidence = evidence) =>
  runDocsProtocolQualificationV3({
    profile: candidateProfile,
    evidence: candidateEvidence,
    lockfileBytes
  });

test("qualification v3 admits the explicit five-package Cohort v2 and emits a valid canonical receipt", async () => {
  const receipt = qualify();
  assert.equal(receipt.cohortAdmissible, true);
  assert.deepEqual(receipt.packages.map(({ key }) => key), [
    "repositoryMutation",
    "documentAuthoring",
    "docsProtocol",
    "docsProtocolAgentTeams",
    "engineeringFoundation"
  ]);
  assert.equal(
    qualify(structuredClone(profile), structuredClone(evidence)).receiptDigest,
    receipt.receiptDigest
  );
  const schema = JSON.parse(await readFile(
    new URL("../schemas/docs-protocol-qualification-receipt/v3.schema.json", import.meta.url),
    "utf8"
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
});

test("qualification v3 fails closed on a missing package instead of inferring the closure", () => {
  const incomplete = structuredClone(evidence);
  delete incomplete.packages.documentAuthoring;
  assert.throws(
    () => qualify(profile, incomplete),
    /evidence is invalid or incomplete/u
  );
});

test("qualification v3 rejects version, integrity, schema, and runtime closure drift", () => {
  for (const mutation of [
    (candidate) => { candidate.packages.docsProtocol.version = "0.5.1"; },
    (candidate) => { candidate.packages.docsProtocol.integrity = integrity("Z"); },
    (candidate) => { candidate.schemas.managedState = 1; },
    (candidate) => { candidate.runtimeClosureDigest = sha256("a"); }
  ]) {
    const drifted = structuredClone(evidence);
    mutation(drifted);
    assert.throws(() => qualify(profile, drifted));
  }
});

test("qualification v3 rejects legacy profile schema versions", () => {
  assert.throws(
    () => qualify({ ...profile, schemaVersion: 2 }),
    /desired state v3 is invalid or unsupported/u
  );
});

test("qualification v3 rejects Cohort assets that the consumer planner cannot apply", () => {
  const blockedProfile = structuredClone(profile);
  blockedProfile.cohort.assets.skillDigest = sha256("f");
  assert.throws(
    () => qualify(blockedProfile),
    /asset digests do not match this exact package build/u
  );
});

test("qualification v3 rejects coordinated profile and evidence forgery against trusted lockfile bytes", () => {
  const forgedProfile = structuredClone(profile);
  const forgedEvidence = structuredClone(evidence);
  const forgedIntegrity = integrity("Z");
  forgedProfile.cohort.packages.docsProtocol.integrity = forgedIntegrity;
  forgedEvidence.packages.docsProtocol.integrity = forgedIntegrity;
  forgedProfile.cohort.runtime.runtimeClosureDigest = sha256("a");
  forgedEvidence.runtimeClosureDigest = sha256("a");
  assert.throws(
    () => qualify(forgedProfile, forgedEvidence),
    (error) => error?.code === "DOCS_CONSUMER_LOCKFILE_INTEGRITY_MISMATCH"
  );
});

test("qualification v3 rejects an oversized lockfile before YAML parsing", () => {
  const oversized = new Uint8Array(32 * 1024 * 1024 + 1);
  assert.throws(
    () => runDocsProtocolQualificationV3({ profile, evidence, lockfileBytes: oversized }),
    /lockfile must contain 1\.\.33554432 bytes/u
  );
});
