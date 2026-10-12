import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import { stringify } from "yaml";

import { describeCanonicalConsumerAssets } from "../dist/consumer-integration/index.js";
import {
  computePnpmRuntimeClosureDigestV2
} from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import {
  createDocsProtocolQualificationV3,
  createDocsProtocolQualificationV3Observer
} from "../dist/qualification/application-api.js";
import { runDocsProtocolQualificationV3 } from "../dist/qualification/index.js";
import { createNodeDocsProtocolQualificationRuntimeObserver } from
  "../dist/qualification/adapters/outbound/node-qualification-runtime.js";
import { observeQualifiedPnpmLockfileV2 } from
  "../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js";
import type {
  DocsProtocolQualificationCohortEvidenceV3,
  DocsProtocolQualificationCohortV3Receipt,
  DocsProtocolQualificationCohortV3Request,
  DocsProtocolQualificationPackageKeyV3
} from "../dist/qualification/index.js";
import type {
  DocsProtocolQualificationRuntimeObservation
} from "../dist/qualification/application/model/v3-contract.js";
import type {
  ManagedSuccessorProfile
} from "../dist/consumer-integration/domain/model.js";
import type {
  PackedManagedRuntimePolicy
} from "../dist/consumer-integration/application/policies/qualified-docs-cohort-v3.js";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const integrity = (character: string): `sha512-${string}` =>
  `sha512-${character.repeat(86)}==`;

type PackageKey = DocsProtocolQualificationPackageKeyV3;

const packages: DocsProtocolQualificationCohortEvidenceV3["packages"] = {
  repositoryMutation: { version: "0.1.0", integrity: integrity("A") },
  documentAuthoring: { version: "0.1.0", integrity: integrity("B") },
  docsProtocol: { version: "0.5.0", integrity: integrity("C") },
  docsProtocolAgentTeams: { version: "0.1.0", integrity: integrity("D") },
  engineeringFoundation: { version: "1.0.0", integrity: integrity("E") }
};
const packageNames: Readonly<Record<PackageKey, `@agent-teams/${string}`>> = {
  repositoryMutation: "@agent-teams/repository-mutation",
  documentAuthoring: "@agent-teams/document-authoring",
  docsProtocol: "@agent-teams/docs-protocol",
  docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
  engineeringFoundation: "@agent-teams/engineering-foundation"
};
const internalDependencies: Readonly<Record<PackageKey, Readonly<Record<string, string>>>> = {
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
const packageKeys = [
  "repositoryMutation",
  "documentAuthoring",
  "docsProtocol",
  "docsProtocolAgentTeams",
  "engineeringFoundation"
] satisfies readonly PackageKey[];
const directPackageKeys = [
  "docsProtocol",
  "docsProtocolAgentTeams",
  "engineeringFoundation"
] satisfies readonly PackageKey[];
const lockfile: Record<string, unknown> = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      devDependencies: Object.fromEntries(directPackageKeys.map((key) => [
        packageNames[key],
        { specifier: packages[key].version, version: packages[key].version }
      ]))
    }
  },
  packages: Object.fromEntries(packageKeys.map((key) => [
    `${packageNames[key]}@${packages[key].version}`,
    { resolution: { integrity: packages[key].integrity } }
  ])),
  snapshots: Object.fromEntries(packageKeys.map((key) => [
    `${packageNames[key]}@${packages[key].version}`,
    Object.keys(internalDependencies[key]).length === 0
      ? {}
      : { dependencies: internalDependencies[key] }
  ]))
};
const lockfileBytes = Buffer.from(stringify(lockfile));
const sourceDigest = digest("f");
const policy: PackedManagedRuntimePolicy = {
  policyId: "agent-teams.docs-protocol-current-policy",
  policyVersion: "3.0.0",
  sourceDigest,
  pnpm: ">=11.17.0 <12",
  lanes: {
    "node-24-production-default": {
      node: ">=24.18.0 <25",
      qualificationRuntime: {
        nodeVersion: "24.21.0",
        pnpmVersion: "11.20.0",
        platform: "linux",
        architecture: "x64"
      },
      default: false
    },
    "node-26-managed-qualified": {
      node: ">=26.0.0 <27",
      qualificationRuntime: {
        nodeVersion: "26.11.1",
        pnpmVersion: "11.20.0",
        platform: "linux",
        architecture: "x64"
      },
      default: true
    }
  }
};
const cohortData: ManagedSuccessorProfile["cohort"] = {
  schemaVersion: 3,
  cohortId: "docs-v3-rc1",
  channel: "rc",
  recordDigest: digest("1"),
  qualificationEventDigest: digest("2"),
  eligibleAfter: "2026-09-28T00:00:00Z",
  upgradeFrom: ["docs-v2"],
  rollbackTo: ["docs-v2"],
  candidateDigest: digest("3"),
  packages,
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "4".repeat(40),
    blobSha: "5".repeat(40)
  },
  assets: {
    skillDigest: digest("6"),
    callerWorkflowDigest: digest("7"),
    assetCatalogDigest: digest("8"),
    transitionCatalogDigest: digest("9")
  },
  schemas: {
    consumerIntegration: 4,
    managedState: 3,
    qualificationReceipt: 1,
    docsProtocol: 1
  },
  runtime: {
    policy: {
      id: policy.policyId,
      version: policy.policyVersion,
      digest: sourceDigest
    },
    selectedLane: "node-26-managed-qualified",
    node: ">=26.0.0 <27",
    pnpm: policy.pnpm,
    qualificationRuntime: {
      nodeVersion: "26.11.1",
      pnpmVersion: "11.20.0",
      platform: "linux",
      architecture: "x64"
    },
    runtimeClosure: {
      domain: "agent-teams.docs-runtime-closure/v2",
      digest: digest("a")
    }
  }
};
const runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfile, cohortData);
const cohort: ManagedSuccessorProfile["cohort"] = {
  ...cohortData,
  assets: describeCanonicalConsumerAssets(cohortData),
  runtime: {
    ...cohortData.runtime,
    runtimeClosure: {
      domain: "agent-teams.docs-runtime-closure/v2",
      digest: runtimeClosureDigest
    }
  }
};
const profile: ManagedSuccessorProfile = {
  schemaVersion: 4,
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
  cohort
};
const evidence: DocsProtocolQualificationCohortEvidenceV3 = {
  cohort: {
    cohortId: cohort.cohortId,
    recordDigest: cohort.recordDigest,
    qualificationEventDigest: cohort.qualificationEventDigest,
    candidateDigest: cohort.candidateDigest
  },
  packages,
  schemas: cohort.schemas,
  policy: {
    id: policy.policyId,
    version: policy.policyVersion,
    sourceDigest
  },
  runtime: {
    selectedLane: cohort.runtime.selectedLane,
    node: cohort.runtime.node,
    pnpm: cohort.runtime.pnpm,
    qualificationRuntime: cohort.runtime.qualificationRuntime,
    runtimeClosureDigest
  }
};
const createRequestFixture = (): DocsProtocolQualificationCohortV3Request => ({
  // Clone each typed fixture independently at the request boundary. The source
  // fixtures intentionally share package/schema/runtime source data, but a
  // qualification request must not preserve that aliasing across its roots.
  profile: structuredClone(profile),
  evidence: structuredClone(evidence),
  lockfileBytes: new Uint8Array(lockfileBytes)
});
const request = createRequestFixture();
const exactRuntime: DocsProtocolQualificationRuntimeObservation = {
  nodeVersion: "26.11.1",
  platform: "linux",
  architecture: "x64"
};
const observeLockfile = createDocsProtocolQualificationV3Observer(observeQualifiedPnpmLockfileV2);
const observePackedPolicy = (): PackedManagedRuntimePolicy => policy;
const qualification = createDocsProtocolQualificationV3(
  observeLockfile,
  () => exactRuntime,
  observePackedPolicy
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};
const receiptDigest = (receipt: unknown): string => {
  const body = isRecord(receipt) ? { ...receipt } : receipt;
  if (isRecord(body)) {
    delete body.receiptDigest;
  }
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
};
const isCohortReceipt = (
  receipt: ReturnType<typeof qualification>
): receipt is DocsProtocolQualificationCohortV3Receipt => receipt.schemaVersion === 1;

test("Gen3 valid observation and lock closure emits the exact namespace receipt", async () => {
  const result = qualification(request);
  if (!isCohortReceipt(result)) {
    assert.fail("Gen3 request must emit a Cohort v3 receipt.");
  }
  const receipt = result;
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.namespace, "docs-protocol-cohort-v3-qualification-receipt/v1");
  assert.equal(receipt.profileSchemaVersion, 4);
  assert.equal(receipt.cohort.schemaVersion, 3);
  assert.deepEqual(receipt.packages.map(({ key }) => key), [
    "repositoryMutation",
    "documentAuthoring",
    "docsProtocol",
    "docsProtocolAgentTeams",
    "engineeringFoundation"
  ]);
  assert.equal(receipt.schemas.qualificationReceipt, 1);
  assert.equal(receipt.runtime.runtimeClosure.domain, "agent-teams.docs-runtime-closure/v2");
  assert.equal(receipt.receiptDigest, receiptDigest(receipt));
  assert.notEqual(
    receipt.receiptDigest,
    receiptDigest({ ...receipt, namespace: "docs-protocol-cohort-v3-qualification-receipt/v2" })
  );
  const schema = JSON.parse(await readFile(
    new URL("../schemas/docs-protocol-cohort-v3-qualification-receipt/v1.schema.json", import.meta.url),
    "utf8"
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
});

test("public runDocsProtocolQualificationV3 observes the actual process without a blanket skip", () => {
  const observed = createNodeDocsProtocolQualificationRuntimeObserver()();
  const isExactRuntime = observed.nodeVersion === exactRuntime.nodeVersion &&
    observed.platform === exactRuntime.platform &&
    observed.architecture === exactRuntime.architecture;
  assert.notEqual(runDocsProtocolQualificationV3, qualification);
  if (isExactRuntime) {
    const publicReceipt = runDocsProtocolQualificationV3(request);
    if (!isCohortReceipt(publicReceipt)) {
      assert.fail("Public Gen3 request must emit a Cohort v3 receipt.");
    }
    assert.equal(publicReceipt.namespace, "docs-protocol-cohort-v3-qualification-receipt/v1");
    assert.equal(publicReceipt.receiptDigest, qualification(request).receiptDigest);
  } else {
    assert.throws(
      () => runDocsProtocolQualificationV3(request),
      /observed Node runtime mismatch/u
    );
  }
});

test("real process observer reflects the current process and fake injection remains distinct", () => {
  const observeCurrent = createNodeDocsProtocolQualificationRuntimeObserver();
  const observed = observeCurrent();
  assert.equal(observed.nodeVersion, process.versions.node);
  assert.equal(observed.platform, process.platform);
  assert.equal(observed.architecture, process.arch);

  let fakeCalls = 0;
  const fakeRuntime: DocsProtocolQualificationRuntimeObservation = { ...exactRuntime };
  const fakeObserver = (): DocsProtocolQualificationRuntimeObservation => {
    fakeCalls++;
    return fakeRuntime;
  };
  const injected = createDocsProtocolQualificationV3(observeLockfile, fakeObserver, observePackedPolicy);
  injected(request);
  assert.equal(fakeCalls, 1);
  assert.notStrictEqual(fakeRuntime, observed);
  assert.notStrictEqual(fakeObserver, observeCurrent);
});

test("packed policy thunk is lazy and generation-4-only", () => {
  let policyCalls = 0;
  const countingPolicy = (): PackedManagedRuntimePolicy => {
    policyCalls++;
    return policy;
  };
  const lazyQualification = createDocsProtocolQualificationV3(
    observeLockfile,
    () => exactRuntime,
    countingPolicy
  );
  const malformed = structuredClone(request);
  Reflect.deleteProperty(malformed.evidence, "cohort");
  assert.throws(
    () => lazyQualification(malformed),
    /evidence is invalid or incomplete/u
  );
  assert.equal(policyCalls, 0);
  const legacyShaped = structuredClone(request);
  Object.defineProperty(legacyShaped.profile, "schemaVersion", {
    value: 3,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => lazyQualification(legacyShaped), /invalid or unsupported/u);
  assert.equal(policyCalls, 0);
  lazyQualification(request);
  assert.equal(policyCalls, 1);
});

test("real process observer refuses caller-spoofed runtime and declared profile alone cannot green", () => {
  const spoofed = structuredClone(request);
  Object.defineProperty(spoofed.evidence.runtime.qualificationRuntime, "nodeVersion", {
    value: "26.10.0",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(spoofed), /runtime evidence mismatch/u);
  const wrongObserver = createDocsProtocolQualificationV3(observeLockfile, () => ({
    nodeVersion: "26.10.0",
    platform: "linux",
    architecture: "x64"
  }), observePackedPolicy);
  assert.throws(() => wrongObserver(request), /observed Node runtime mismatch/u);
  const wrongPlatform = createDocsProtocolQualificationV3(observeLockfile, () => ({
    ...exactRuntime,
    platform: "macos"
  }), observePackedPolicy);
  assert.throws(() => wrongPlatform(request), /observed Node runtime mismatch/u);
});

test("Gen3 rejects mixed generations, schemas and package coordinates", () => {
  const wrongGeneration = structuredClone(request);
  Object.defineProperty(wrongGeneration.profile.cohort, "schemaVersion", {
    value: 2,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongGeneration), /invalid or unsupported/u);
  const wrongSchema = structuredClone(request);
  Object.defineProperty(wrongSchema.evidence.schemas, "managedState", {
    value: 2,
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongSchema), /schema bindings 4\/3\/1/u);
  const wrongPackage = structuredClone(request);
  Object.defineProperty(wrongPackage.evidence.packages.docsProtocol, "version", {
    value: "0.5.1",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongPackage), /version mismatch/u);
  const wrongCoordinate = structuredClone(request);
  Object.defineProperty(wrongCoordinate.profile.cohort.packages.docsProtocol, "version", {
    value: "0.5.1",
    enumerable: true,
    configurable: true,
    writable: true
  });
  assert.throws(() => qualification(wrongCoordinate), /runtime closure/u);
});

test("legacy receipt v3 bytes and digest are independent of the new namespace schema", async () => {
  const bytes = await readFile(
    new URL("../schemas/docs-protocol-qualification-receipt/v3.schema.json", import.meta.url)
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "cc8e8fb12c461bbce4922dec9996a42a79bbab010395c4f60821a6d588e738fe"
  );
  const schema = JSON.parse(bytes.toString("utf8"));
  assert.equal(schema.$id, "https://agent-teams.ai/schemas/docs-protocol-qualification-receipt/v3");
  assert.equal(schema.properties.schemaVersion.const, 3);
});
