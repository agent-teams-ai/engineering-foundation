import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { stringify } from "yaml";

import { describeCanonicalConsumerAssets } from "../packages/docs-protocol-agent-teams/dist/index.js";
import {
  observeDocsProtocolQualificationV3Lockfile,
  type ConsumerIntegrationDesiredStateV3,
  type DocsProtocolQualificationCheckCohortV3,
  type DocsProtocolQualificationCheckV3,
  type DocsProtocolQualificationCohortEvidenceV3,
  type DocsProtocolQualificationCohortV3Request,
  type DocsProtocolQualificationEvidenceV3,
  type QualifiedDocsCohortBindingV2,
} from "../packages/docs-protocol-agent-teams/dist/qualification/index.js";

type ManagedSuccessorProfile = DocsProtocolQualificationCohortV3Request["profile"];

export function sha256(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

export function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function integrity(byte: number): `sha512-${string}` {
  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

export const descriptors = [
  ["repositoryMutation", "@agent-teams/repository-mutation", false],
  ["documentAuthoring", "@agent-teams/document-authoring", false],
  ["docsProtocol", "@agent-teams/docs-protocol", true],
  ["docsProtocolAgentTeams", "@agent-teams/docs-protocol-agent-teams", true],
  ["engineeringFoundation", "@agent-teams/engineering-foundation", true],
] as const;

const cohort: QualifiedDocsCohortBindingV2 = {
  schemaVersion: 2,
  cohortId: "docs-v2-canary",
  channel: "stable",
  recordDigest: sha256("1"),
  qualificationEventDigest: sha256("2"),
  eligibleAfter: "2026-09-04T12:00:00Z",
  upgradeFrom: ["docs-v1"],
  rollbackTo: ["docs-v1"],
  packages: {
    repositoryMutation: { version: "1.0.0", integrity: integrity(1) },
    documentAuthoring: { version: "1.0.1", integrity: integrity(2) },
    docsProtocol: { version: "1.0.2", integrity: integrity(3) },
    docsProtocolAgentTeams: { version: "1.0.3", integrity: integrity(4) },
    engineeringFoundation: { version: "1.0.4", integrity: integrity(5) },
  },
  workflow: {
    repository: "agent-teams-ai/.github",
    path: ".github/workflows/docs-protocol-check.yml",
    revision: "3".repeat(40),
    blobSha: "4".repeat(40),
  },
  assets: {
    skillDigest: sha256("5"),
    callerWorkflowDigest: sha256("6"),
    assetCatalogDigest: sha256("7"),
    transitionCatalogDigest: sha256("8"),
  },
  schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
  runtime: {
    node: ">=24.18.0 <25",
    pnpm: ">=11.17.0 <12",
    runtimeClosureDigest: sha256("9"),
  },
};

const repository: ConsumerIntegrationDesiredStateV3["repository"] = {
  provider: "github",
  id: "1316243988",
  nameWithOwner: "agent-teams-ai/engineering-foundation",
};

export const legacyQualificationChecks = [
  "profile-v3",
  "cohort-v2",
  "five-package-closure",
  "exact-package-versions",
  "exact-package-integrities",
  "schema-bindings-3-2-1",
  "runtime-closure-digest",
] as const satisfies readonly DocsProtocolQualificationCheckV3[];

export const cohortV3QualificationChecks = [
  "profile-v4",
  "cohort-v3",
  "cohort-assets",
  "five-package-closure",
  "exact-package-versions",
  "exact-package-integrities",
  "schema-bindings-4-3-1-qualification-receipt-1",
  "runtime-closure-digest",
  "policy-identity-source-digest",
  "selected-lane-runtime",
  "observed-node-runtime",
] as const satisfies readonly DocsProtocolQualificationCheckCohortV3[];

interface RuntimePolicyFixture {
  readonly policyId: "agent-teams.docs-protocol-current-policy";
  readonly policyVersion: "3.0.0";
  readonly sourceDigest: `sha256:${string}`;
  readonly managedRuntime: {
    readonly pnpm: ">=11.17.0 <12";
    readonly status: string;
    readonly lane: {
      readonly node: ">=26.0.0 <27";
      readonly qualificationRuntime: {
        readonly nodeVersion: "26.11.1";
        readonly pnpmVersion: "11.20.0";
        readonly platform: "linux";
        readonly architecture: "x64";
      };
    };
  };
  readonly managedCandidate: {
    readonly selected: boolean;
    readonly status: string;
  };
}

export interface LegacyQualificationFixture {
  readonly evidence: DocsProtocolQualificationEvidenceV3;
  readonly lockfileBytes: Buffer;
  readonly profile: ConsumerIntegrationDesiredStateV3;
}

export interface SuccessorQualificationFixture {
  readonly evidence: DocsProtocolQualificationCohortEvidenceV3;
  readonly lockfileBytes: Buffer;
  readonly profile: ManagedSuccessorProfile;
  readonly runtimePolicy: RuntimePolicyFixture;
}

export interface SuccessorCentralRegistryFixture {
  readonly cohort: ManagedSuccessorProfile["cohort"];
  readonly registry: Record<string, unknown>;
  readonly repository: ManagedSuccessorProfile["repository"];
  readonly revision: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  const digestValue = requireString(value, label);
  if (!digestValue.startsWith("sha256:")) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return `sha256:${digestValue.slice("sha256:".length)}`;
}

function requireLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new TypeError(`${label} must be ${expected}`);
  }
  return expected;
}

function readRuntimePolicy(): RuntimePolicyFixture {
  const parsed: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const root = requireRecord(parsed, "runtime policy");
  const managedRuntime = requireRecord(root["managedRuntime"], "runtime policy managedRuntime");
  const lanes = requireRecord(managedRuntime["lanes"], "runtime policy managedRuntime.lanes");
  const lane = requireRecord(lanes["node-26-managed-qualified"], "runtime policy Node 26 lane");
  const qualificationRuntime = requireRecord(
    lane["qualificationRuntime"],
    "runtime policy Node 26 qualificationRuntime",
  );
  const managedCandidate = requireRecord(
    root["managedCandidate"],
    "runtime policy managedCandidate",
  );
  return {
    policyId: requireLiteral(
      root["policyId"],
      "agent-teams.docs-protocol-current-policy",
      "runtime policy policyId",
    ),
    policyVersion: requireLiteral(root["policyVersion"], "3.0.0", "runtime policy policyVersion"),
    sourceDigest: requireDigest(root["sourceDigest"], "runtime policy sourceDigest"),
    managedRuntime: {
      pnpm: requireLiteral(
        managedRuntime["pnpm"],
        ">=11.17.0 <12",
        "runtime policy managedRuntime.pnpm",
      ),
      status: requireString(managedRuntime["status"], "runtime policy managedRuntime.status"),
      lane: {
        node: requireLiteral(lane["node"], ">=26.0.0 <27", "runtime policy Node 26 lane node"),
        qualificationRuntime: {
          nodeVersion: requireLiteral(
            qualificationRuntime["nodeVersion"],
            "26.11.1",
            "runtime policy qualificationRuntime.nodeVersion",
          ),
          pnpmVersion: requireLiteral(
            qualificationRuntime["pnpmVersion"],
            "11.20.0",
            "runtime policy qualificationRuntime.pnpmVersion",
          ),
          platform: requireLiteral(
            qualificationRuntime["platform"],
            "linux",
            "runtime policy qualificationRuntime.platform",
          ),
          architecture: requireLiteral(
            qualificationRuntime["architecture"],
            "x64",
            "runtime policy qualificationRuntime.architecture",
          ),
        },
      },
    },
    managedCandidate: {
      selected: requireBoolean(
        managedCandidate["selected"],
        "runtime policy managedCandidate.selected",
      ),
      status: requireString(managedCandidate["status"], "runtime policy managedCandidate.status"),
    },
  };
}

type QualificationPackages = QualifiedDocsCohortBindingV2["packages"];

function qualificationLockfileBytes(cohortBinding: {
  readonly packages: QualificationPackages;
}): Buffer {
  const coordinates = {
    "@agent-teams/repository-mutation": cohortBinding.packages.repositoryMutation,
    "@agent-teams/document-authoring": cohortBinding.packages.documentAuthoring,
    "@agent-teams/docs-protocol": cohortBinding.packages.docsProtocol,
    "@agent-teams/docs-protocol-agent-teams": cohortBinding.packages.docsProtocolAgentTeams,
    "@agent-teams/engineering-foundation": cohortBinding.packages.engineeringFoundation,
  } as const;
  return Buffer.from(
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          devDependencies: {
            "@agent-teams/docs-protocol": {
              specifier: coordinates["@agent-teams/docs-protocol"].version,
              version: coordinates["@agent-teams/docs-protocol"].version,
            },
            "@agent-teams/docs-protocol-agent-teams": {
              specifier: coordinates["@agent-teams/docs-protocol-agent-teams"].version,
              version: coordinates["@agent-teams/docs-protocol-agent-teams"].version,
            },
            "@agent-teams/engineering-foundation": {
              specifier: coordinates["@agent-teams/engineering-foundation"].version,
              version: coordinates["@agent-teams/engineering-foundation"].version,
            },
          },
        },
      },
      packages: {
        "@agent-teams/repository-mutation@1.0.0": {
          resolution: { integrity: coordinates["@agent-teams/repository-mutation"].integrity },
        },
        "@agent-teams/document-authoring@1.0.1": {
          resolution: { integrity: coordinates["@agent-teams/document-authoring"].integrity },
        },
        "@agent-teams/docs-protocol@1.0.2": {
          resolution: { integrity: coordinates["@agent-teams/docs-protocol"].integrity },
        },
        "@agent-teams/docs-protocol-agent-teams@1.0.3": {
          resolution: {
            integrity: coordinates["@agent-teams/docs-protocol-agent-teams"].integrity,
          },
        },
        "@agent-teams/engineering-foundation@1.0.4": {
          resolution: { integrity: coordinates["@agent-teams/engineering-foundation"].integrity },
        },
      },
      snapshots: {
        "@agent-teams/repository-mutation@1.0.0": {},
        "@agent-teams/document-authoring@1.0.1": {
          dependencies: {
            "@agent-teams/repository-mutation":
              coordinates["@agent-teams/repository-mutation"].version,
          },
        },
        "@agent-teams/docs-protocol@1.0.2": {
          dependencies: {
            "@agent-teams/document-authoring":
              coordinates["@agent-teams/document-authoring"].version,
            "@agent-teams/repository-mutation":
              coordinates["@agent-teams/repository-mutation"].version,
          },
        },
        "@agent-teams/docs-protocol-agent-teams@1.0.3": {
          dependencies: {
            "@agent-teams/docs-protocol": coordinates["@agent-teams/docs-protocol"].version,
            "@agent-teams/repository-mutation":
              coordinates["@agent-teams/repository-mutation"].version,
          },
        },
        "@agent-teams/engineering-foundation@1.0.4": {
          dependencies: {
            "@agent-teams/document-authoring":
              coordinates["@agent-teams/document-authoring"].version,
            "@agent-teams/repository-mutation":
              coordinates["@agent-teams/repository-mutation"].version,
          },
        },
      },
    }),
  );
}

export function legacyQualificationFixture(): LegacyQualificationFixture {
  const assets = describeCanonicalConsumerAssets(cohort);
  const legacyCohortBeforeClosure: QualifiedDocsCohortBindingV2 = {
    ...cohort,
    assets,
  };
  const profileBeforeClosure: ConsumerIntegrationDesiredStateV3 = {
    schemaVersion: 3,
    repository,
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
    cohort: legacyCohortBeforeClosure,
  };
  const lockfileBytes = qualificationLockfileBytes(legacyCohortBeforeClosure);
  const legacyCohort: QualifiedDocsCohortBindingV2 = {
    ...legacyCohortBeforeClosure,
    runtime: {
      ...legacyCohortBeforeClosure.runtime,
      runtimeClosureDigest: observeDocsProtocolQualificationV3Lockfile({
        profile: profileBeforeClosure,
        lockfileBytes,
      }).runtimeClosureDigest,
    },
  };
  const profile: ConsumerIntegrationDesiredStateV3 = {
    ...profileBeforeClosure,
    cohort: legacyCohort,
  };
  return {
    evidence: {
      packages: structuredClone(legacyCohort.packages),
      schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
      runtimeClosureDigest: legacyCohort.runtime.runtimeClosureDigest,
    },
    lockfileBytes,
    profile,
  };
}

export function successorQualificationFixture(): SuccessorQualificationFixture {
  const runtimePolicy = readRuntimePolicy();
  const successorCohortBeforeAssets: ManagedSuccessorProfile["cohort"] = {
    schemaVersion: 3,
    cohortId: "docs-v3-canary",
    channel: "stable",
    recordDigest: sha256("c"),
    qualificationEventDigest: sha256("d"),
    eligibleAfter: "2026-10-12T00:00:00Z",
    upgradeFrom: ["docs-v2"],
    rollbackTo: ["docs-v2"],
    candidateDigest: sha256("e"),
    packages: structuredClone(cohort.packages),
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: cohort.workflow.revision,
      blobSha: cohort.workflow.blobSha,
    },
    assets: {
      skillDigest: sha256("f"),
      callerWorkflowDigest: sha256("a"),
      assetCatalogDigest: sha256("b"),
      transitionCatalogDigest: sha256("c"),
    },
    schemas: { consumerIntegration: 4, managedState: 3, qualificationReceipt: 1, docsProtocol: 1 },
    runtime: {
      policy: {
        id: runtimePolicy.policyId,
        version: runtimePolicy.policyVersion,
        digest: runtimePolicy.sourceDigest,
      },
      selectedLane: "node-26-managed-qualified",
      node: runtimePolicy.managedRuntime.lane.node,
      pnpm: runtimePolicy.managedRuntime.pnpm,
      qualificationRuntime: structuredClone(runtimePolicy.managedRuntime.lane.qualificationRuntime),
      runtimeClosure: { domain: "agent-teams.docs-runtime-closure/v2", digest: sha256("9") },
    },
  };
  const successorCohortBeforeClosure: ManagedSuccessorProfile["cohort"] = {
    ...successorCohortBeforeAssets,
    assets: describeCanonicalConsumerAssets(successorCohortBeforeAssets),
  };
  const profileBeforeClosure: ManagedSuccessorProfile = {
    schemaVersion: 4,
    repository,
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
    cohort: successorCohortBeforeClosure,
  };
  const lockfileBytes = qualificationLockfileBytes(successorCohortBeforeClosure);
  const successorCohort: ManagedSuccessorProfile["cohort"] = {
    ...successorCohortBeforeClosure,
    runtime: {
      ...successorCohortBeforeClosure.runtime,
      runtimeClosure: {
        ...successorCohortBeforeClosure.runtime.runtimeClosure,
        digest: observeDocsProtocolQualificationV3Lockfile({
          profile: profileBeforeClosure,
          lockfileBytes,
        }).runtimeClosureDigest,
      },
    },
  };
  const profile: ManagedSuccessorProfile = {
    ...profileBeforeClosure,
    cohort: successorCohort,
  };
  return {
    evidence: {
      cohort: {
        cohortId: successorCohort.cohortId,
        recordDigest: requireDigest(successorCohort.recordDigest, "successor cohort recordDigest"),
        qualificationEventDigest: requireDigest(
          successorCohort.qualificationEventDigest,
          "successor cohort qualificationEventDigest",
        ),
        candidateDigest: requireDigest(
          successorCohort.candidateDigest,
          "successor cohort candidateDigest",
        ),
      },
      packages: structuredClone(successorCohort.packages),
      schemas: structuredClone(successorCohort.schemas),
      policy: {
        id: successorCohort.runtime.policy.id,
        version: successorCohort.runtime.policy.version,
        sourceDigest: requireDigest(
          successorCohort.runtime.policy.digest,
          "successor cohort runtime policy digest",
        ),
      },
      runtime: {
        selectedLane: requireLiteral(
          successorCohort.runtime.selectedLane,
          "node-26-managed-qualified",
          "successor cohort selected lane",
        ),
        node: requireLiteral(
          successorCohort.runtime.node,
          ">=26.0.0 <27",
          "successor cohort Node runtime",
        ),
        pnpm: requireLiteral(
          successorCohort.runtime.pnpm,
          ">=11.17.0 <12",
          "successor cohort pnpm runtime",
        ),
        qualificationRuntime: {
          nodeVersion: requireLiteral(
            successorCohort.runtime.qualificationRuntime.nodeVersion,
            "26.11.1",
            "successor cohort qualification Node version",
          ),
          pnpmVersion: requireLiteral(
            successorCohort.runtime.qualificationRuntime.pnpmVersion,
            "11.20.0",
            "successor cohort qualification pnpm version",
          ),
          platform: requireLiteral(
            successorCohort.runtime.qualificationRuntime.platform,
            "linux",
            "successor cohort qualification platform",
          ),
          architecture: requireLiteral(
            successorCohort.runtime.qualificationRuntime.architecture,
            "x64",
            "successor cohort qualification architecture",
          ),
        },
        runtimeClosureDigest: requireDigest(
          successorCohort.runtime.runtimeClosure.digest,
          "successor cohort runtime closure digest",
        ),
      },
    },
    lockfileBytes,
    profile,
    runtimePolicy,
  };
}

function canonicalAuthorityJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalAuthorityJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalAuthorityJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function authorityDigest(domain: string, body: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalAuthorityJson({ domain, body }))
    .digest("hex")}`;
}

export function successorCentralRegistryFixture(): SuccessorCentralRegistryFixture {
  const { profile } = successorQualificationFixture();
  const binding = profile.cohort;
  const consumerRepository = profile.repository;
  const revision = "b".repeat(40);
  const publishedAt = "2026-10-11T00:00:00Z";
  const packageNames = {
    repositoryMutation: "@agent-teams/repository-mutation",
    documentAuthoring: "@agent-teams/document-authoring",
    docsProtocol: "@agent-teams/docs-protocol",
    docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
    engineeringFoundation: "@agent-teams/engineering-foundation",
  } as const;
  const packages = Object.entries(packageNames).map(([key, name], index) => ({
    name,
    role: ["docsProtocol", "docsProtocolAgentTeams", "engineeringFoundation"].includes(key)
      ? "direct"
      : "transitive",
    ...binding.packages[key as keyof typeof binding.packages],
    registry: "https://registry.npmjs.org/",
    published_at: publishedAt,
    provenance: {
      source_repository: "agent-teams-ai/engineering-foundation",
      source_repository_id: 1316243988,
      source_workflow: ".github/workflows/release.yml",
      source_commit: `${index + 1}`.repeat(40),
      workflow_run_id: 123,
      workflow_run_attempt: 1,
      registry_attestation_url: `https://registry.npmjs.org/-/npm/v1/attestations/${name.replaceAll("/", "%2f")}@${
        binding.packages[key as keyof typeof binding.packages].version
      }`,
      workflow_run_url: "https://github.com/agent-teams-ai/engineering-foundation/actions/runs/123",
      signature_verified: true,
    },
  }));
  const dependencyEdges = [
    ["@agent-teams/document-authoring", "@agent-teams/repository-mutation"],
    ["@agent-teams/docs-protocol", "@agent-teams/document-authoring"],
    ["@agent-teams/docs-protocol", "@agent-teams/repository-mutation"],
    ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/docs-protocol"],
    ["@agent-teams/docs-protocol-agent-teams", "@agent-teams/repository-mutation"],
    ["@agent-teams/engineering-foundation", "@agent-teams/document-authoring"],
    ["@agent-teams/engineering-foundation", "@agent-teams/repository-mutation"],
  ].map(([from, to]) => ({ from, to }));
  const recordBody = {
    cohort_generation: 3,
    cohort_id: binding.cohortId,
    channel: binding.channel,
    candidate_digest: binding.candidateDigest,
    policy_identity: binding.runtime.policy,
    packages,
    dependency_edges: dependencyEdges,
    reusable_workflow: {
      repository: binding.workflow.repository,
      repository_id: 1316243981,
      path: binding.workflow.path,
      revision: binding.workflow.revision,
      blob_sha: binding.workflow.blobSha,
    },
    schemas: {
      consumer_integration: 4,
      managed_state: 3,
      qualification_receipt: 1,
      docs_protocol: 1,
      foundation_plan: 1,
      foundation_journal: 1,
      foundation_receipt: 1,
      foundation_envelope: 5,
    },
    assets: {
      skill: {
        package: packageNames.docsProtocolAgentTeams,
        path: "skills/docs/SKILL.md",
        digest: binding.assets.skillDigest,
      },
      caller_workflow: {
        package: packageNames.docsProtocolAgentTeams,
        path: "assets/docs-protocol.yml",
        digest: digest("cohort3-caller-source"),
        rendered_digest: binding.assets.callerWorkflowDigest,
      },
      asset_catalog: {
        package: packageNames.docsProtocolAgentTeams,
        path: "assets/catalog.json",
        digest: binding.assets.assetCatalogDigest,
      },
      transition_catalog: {
        package: packageNames.docsProtocolAgentTeams,
        path: "assets/transition-catalog.json",
        digest: binding.assets.transitionCatalogDigest,
      },
    },
    runtime: {
      selected_lane: binding.runtime.selectedLane,
      node: binding.runtime.node,
      pnpm: binding.runtime.pnpm,
      qualification_runtime: {
        node_version: binding.runtime.qualificationRuntime.nodeVersion,
        pnpm_version: binding.runtime.qualificationRuntime.pnpmVersion,
        platform: binding.runtime.qualificationRuntime.platform,
        architecture: binding.runtime.qualificationRuntime.architecture,
      },
    },
    runtime_closure: {
      schema_version: 2,
      domain: binding.runtime.runtimeClosure.domain,
      package_manager: "pnpm@11.20.0",
      lockfile_version: "9.0",
      package_count: 5,
      projection_path: `governance/docs-runtime-closures/${binding.runtime.runtimeClosure.digest.replace(":", "-")}.json`,
      digest: binding.runtime.runtimeClosure.digest,
    },
    eligible_after: binding.eligibleAfter,
    upgrade_from: binding.upgradeFrom,
    rollback_to: binding.rollbackTo,
    canary_repositories: [
      {
        repository_id: Number(consumerRepository.id),
        repository: consumerRepository.nameWithOwner,
      },
    ],
    evidence_references: ["test:node26-cohort3-realistic-registry"],
  } as Record<string, unknown>;
  recordBody.record_digest = authorityDigest("agent-teams.docs-qualified-cohort/v3", recordBody);
  const event1Body = {
    sequence: 1,
    cohort_id: binding.cohortId,
    state: "PUBLISHED_UNQUALIFIED",
    effective_at: publishedAt,
    support_until: null,
    evidence_references: ["test:published"],
    canary_evidence: [],
    previous_event_digest: null,
  };
  const event1 = {
    ...event1Body,
    event_digest: authorityDigest("agent-teams.docs-qualified-cohort-event/v1", event1Body),
  };
  const event2Body = {
    sequence: 2,
    cohort_id: binding.cohortId,
    state: "QUALIFIED",
    effective_at: "2026-10-12T00:00:00Z",
    support_until: null,
    evidence_references: ["test:qualified"],
    canary_evidence: [],
    previous_event_digest: event1.event_digest,
  };
  const event2 = {
    ...event2Body,
    event_digest: authorityDigest("agent-teams.docs-qualified-cohort-event/v1", event2Body),
  };
  return {
    cohort: {
      ...binding,
      recordDigest: recordBody.record_digest as `sha256:${string}`,
      qualificationEventDigest: event2.event_digest,
    },
    registry: {
      $schema: "./docs-qualified-cohorts.schema.json",
      schema_version: 1,
      organization: "agent-teams-ai",
      policy: { name: "docs-qualified-cohorts", version: 1 },
      cohorts: [recordBody],
      events: [event1, event2],
    },
    repository: consumerRepository,
    revision,
  };
}
