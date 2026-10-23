import { createHash } from "node:crypto";

import { stringify } from "yaml";

import { describeCanonicalConsumerAssets } from "../dist/consumer-integration/index.js";
import { computePnpmRuntimeClosureDigestV2 } from "../dist/consumer-integration/adapters/pnpm-runtime-closure-v2.js";
import {
  createDocsProtocolQualificationV3,
  createDocsProtocolQualificationV3Observer,
} from "../dist/qualification/application-api.js";
import { observeQualifiedPnpmLockfileV2 } from "../dist/consumer-integration/adapters/pnpm-lockfile-validator-v2.js";
import type {
  DocsProtocolQualificationCohortEvidenceV3,
  DocsProtocolQualificationCohortV3Receipt,
  DocsProtocolQualificationCohortV3Request,
  DocsProtocolQualificationPackageKeyV3,
} from "../dist/qualification/index.js";
import type { DocsProtocolQualificationRuntimeObservation } from "../dist/qualification/application/model/v3-contract.js";
import type { ManagedSuccessorProfile } from "../dist/consumer-integration/domain/model.js";
import type { PackedManagedRuntimePolicy } from "../dist/consumer-integration/application/policies/qualified-docs-cohort-v3.js";

type Node26RuntimeFixture = {
  readonly nodeVersion: "26.11.1";
  readonly pnpmVersion: "11.20.0";
  readonly platform: "linux";
  readonly architecture: "x64";
};
export type PackedRuntimePolicyFixture = Omit<
  PackedManagedRuntimePolicy,
  "sourceDigest" | "pnpm" | "lanes"
> & {
  readonly sourceDigest: `sha256:${string}`;
  readonly pnpm: ">=11.17.0 <12";
  readonly lanes: {
    readonly "node-24-production-default": {
      readonly node: ">=24.18.0 <25";
      readonly qualificationRuntime: {
        readonly nodeVersion: "24.21.0";
        readonly pnpmVersion: "11.20.0";
        readonly platform: "linux";
        readonly architecture: "x64";
      };
      readonly default: false;
    };
    readonly "node-26-managed-qualified": {
      readonly node: ">=26.0.0 <27";
      readonly qualificationRuntime: Node26RuntimeFixture;
      readonly default: true;
    };
  };
};
type CohortFixture = Omit<
  ManagedSuccessorProfile["cohort"],
  "recordDigest" | "qualificationEventDigest" | "candidateDigest" | "runtime"
> & {
  readonly recordDigest: `sha256:${string}`;
  readonly qualificationEventDigest: `sha256:${string}`;
  readonly candidateDigest: `sha256:${string}`;
  readonly runtime: Omit<
    ManagedSuccessorProfile["cohort"]["runtime"],
    "policy" | "selectedLane" | "node" | "pnpm" | "qualificationRuntime"
  > & {
    readonly policy: {
      readonly id: "agent-teams.docs-protocol-current-policy";
      readonly version: "3.0.0";
      readonly digest: `sha256:${string}`;
    };
    readonly selectedLane: "node-26-managed-qualified";
    readonly node: ">=26.0.0 <27";
    readonly pnpm: ">=11.17.0 <12";
    readonly qualificationRuntime: Node26RuntimeFixture;
  };
};

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const integrity = (character: string): `sha512-${string}` => `sha512-${character.repeat(86)}==`;

type PackageKey = DocsProtocolQualificationPackageKeyV3;

const packages: DocsProtocolQualificationCohortEvidenceV3["packages"] = {
  repositoryMutation: { version: "0.1.0", integrity: integrity("A") },
  documentAuthoring: { version: "0.1.0", integrity: integrity("B") },
  docsProtocol: { version: "0.5.0", integrity: integrity("C") },
  docsProtocolAgentTeams: { version: "0.1.0", integrity: integrity("D") },
  engineeringFoundation: { version: "1.0.0", integrity: integrity("E") },
};
const packageNames: Readonly<Record<PackageKey, `@agent-teams/${string}`>> = {
  repositoryMutation: "@agent-teams/repository-mutation",
  documentAuthoring: "@agent-teams/document-authoring",
  docsProtocol: "@agent-teams/docs-protocol",
  docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
  engineeringFoundation: "@agent-teams/engineering-foundation",
};
const internalDependencies: Readonly<Record<PackageKey, Readonly<Record<string, string>>>> = {
  repositoryMutation: {},
  documentAuthoring: { [packageNames.repositoryMutation]: packages.repositoryMutation.version },
  docsProtocol: {
    [packageNames.documentAuthoring]: packages.documentAuthoring.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version,
  },
  docsProtocolAgentTeams: {
    [packageNames.docsProtocol]: packages.docsProtocol.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version,
  },
  engineeringFoundation: {
    [packageNames.documentAuthoring]: packages.documentAuthoring.version,
    [packageNames.repositoryMutation]: packages.repositoryMutation.version,
  },
};
const packageKeys = [
  "repositoryMutation",
  "documentAuthoring",
  "docsProtocol",
  "docsProtocolAgentTeams",
  "engineeringFoundation",
] satisfies readonly PackageKey[];
const directPackageKeys = [
  "docsProtocol",
  "docsProtocolAgentTeams",
  "engineeringFoundation",
] satisfies readonly PackageKey[];
const lockfile: Record<string, unknown> = {
  lockfileVersion: "9.0",
  importers: {
    ".": {
      devDependencies: Object.fromEntries(
        directPackageKeys.map((key) => [
          packageNames[key],
          { specifier: packages[key].version, version: packages[key].version },
        ]),
      ),
    },
  },
  packages: Object.fromEntries(
    packageKeys.map((key) => [
      `${packageNames[key]}@${packages[key].version}`,
      { resolution: { integrity: packages[key].integrity } },
    ]),
  ),
  snapshots: Object.fromEntries(
    packageKeys.map((key) => [
      `${packageNames[key]}@${packages[key].version}`,
      Object.keys(internalDependencies[key]).length === 0
        ? {}
        : { dependencies: internalDependencies[key] },
    ]),
  ),
};
const lockfileBytes = Buffer.from(stringify(lockfile));
const sourceDigest = digest("f");
export const policy: PackedRuntimePolicyFixture = {
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
        architecture: "x64",
      },
      default: false,
    },
    "node-26-managed-qualified": {
      node: ">=26.0.0 <27",
      qualificationRuntime: {
        nodeVersion: "26.11.1",
        pnpmVersion: "11.20.0",
        platform: "linux",
        architecture: "x64",
      },
      default: true,
    },
  },
};
export const createRequestFixture = (
  fixturePolicy: PackedRuntimePolicyFixture,
): DocsProtocolQualificationCohortV3Request => {
  const selectedLane = "node-26-managed-qualified";
  const selectedRuntime = fixturePolicy.lanes[selectedLane];
  const cohortData: CohortFixture = {
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
      blobSha: "5".repeat(40),
    },
    assets: {
      skillDigest: digest("6"),
      callerWorkflowDigest: digest("7"),
      assetCatalogDigest: digest("8"),
      transitionCatalogDigest: digest("9"),
    },
    schemas: {
      consumerIntegration: 4,
      managedState: 3,
      qualificationReceipt: 1,
      docsProtocol: 1,
    },
    runtime: {
      policy: {
        id: fixturePolicy.policyId,
        version: fixturePolicy.policyVersion,
        digest: fixturePolicy.sourceDigest,
      },
      selectedLane,
      node: selectedRuntime.node,
      pnpm: fixturePolicy.pnpm,
      qualificationRuntime: selectedRuntime.qualificationRuntime,
      runtimeClosure: {
        domain: "agent-teams.docs-runtime-closure/v2",
        digest: digest("a"),
      },
    },
  };
  const runtimeClosureDigest = computePnpmRuntimeClosureDigestV2(lockfile, cohortData);
  const cohort: CohortFixture = {
    ...cohortData,
    assets: describeCanonicalConsumerAssets(cohortData),
    runtime: {
      ...cohortData.runtime,
      runtimeClosure: {
        domain: "agent-teams.docs-runtime-closure/v2",
        digest: runtimeClosureDigest,
      },
    },
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
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  };
  const evidence: DocsProtocolQualificationCohortEvidenceV3 = {
    cohort: {
      cohortId: cohort.cohortId,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
      candidateDigest: cohort.candidateDigest,
    },
    packages,
    schemas: cohort.schemas,
    policy: {
      id: fixturePolicy.policyId,
      version: fixturePolicy.policyVersion,
      sourceDigest: fixturePolicy.sourceDigest,
    },
    runtime: {
      selectedLane: cohort.runtime.selectedLane,
      node: cohort.runtime.node,
      pnpm: cohort.runtime.pnpm,
      qualificationRuntime: cohort.runtime.qualificationRuntime,
      runtimeClosureDigest,
    },
  };
  return {
    profile: structuredClone(profile),
    evidence: structuredClone(evidence),
    lockfileBytes: new Uint8Array(lockfileBytes),
  };
};
export const request = createRequestFixture(policy);
export const exactRuntime: DocsProtocolQualificationRuntimeObservation = {
  nodeVersion: "26.11.1",
  pnpmVersion: "11.20.0",
  platform: "linux",
  architecture: "x64",
};
export const observeLockfile = createDocsProtocolQualificationV3Observer(
  observeQualifiedPnpmLockfileV2,
);
export const observePackedPolicy = (): PackedManagedRuntimePolicy => policy;
export const qualification = createDocsProtocolQualificationV3(
  observeLockfile,
  () => exactRuntime,
  observePackedPolicy,
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
export const receiptDigest = (receipt: unknown): string => {
  const body = isRecord(receipt) ? { ...receipt } : receipt;
  if (isRecord(body)) {
    delete body.receiptDigest;
  }
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
};
export const isCohortReceipt = (
  receipt: ReturnType<typeof qualification>,
): receipt is DocsProtocolQualificationCohortV3Receipt => receipt.schemaVersion === 1;
