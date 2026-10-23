import { readFileSync } from "node:fs";
import type {
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationSnapshot,
  QualifiedDocsCohortBindingV2,
  ManagedSuccessorProfile,
} from "../dist/consumer-integration/index.js";
import { describeCanonicalConsumerAssets } from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
interface FixtureRuntimePolicy {
  policyId: string;
  policyVersion: string;
  sourceDigest: string;
  managedRuntime: {
    lanes: Record<
      string,
      {
        node: string;
        qualificationRuntime: {
          nodeVersion: string;
          pnpmVersion: string;
          platform: string;
          architecture: string;
        };
      }
    >;
    pnpm: string;
  };
}
const INTEGRITY: `sha512-${string}` = `sha512-${"A".repeat(86)}==`;
export const absent = Object.freeze({ state: "absent" as const });
export const file = (value: string | Uint8Array) => ({
  state: "file" as const,
  bytes: Buffer.from(value),
  mode: 0o644,
});
export function desired(): ConsumerIntegrationDesiredStateV3 {
  const provisional: QualifiedDocsCohortBindingV2 = {
    schemaVersion: 2,
    cohortId: "docs-2026-09-v2",
    channel: "rc",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-09-04T00:00:00Z",
    upgradeFrom: ["docs-2026-08-v1"],
    rollbackTo: ["docs-2026-08-v1"],
    packages: {
      repositoryMutation: { version: "0.1.0", integrity: INTEGRITY },
      documentAuthoring: { version: "0.1.0", integrity: INTEGRITY },
      docsProtocol: { version: "0.5.0", integrity: INTEGRITY },
      docsProtocolAgentTeams: { version: "0.1.0", integrity: INTEGRITY },
      engineeringFoundation: { version: "1.0.0", integrity: INTEGRITY },
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "3".repeat(40),
      blobSha: "4".repeat(40),
    },
    assets: {
      skillDigest: `sha256:${"5".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"6".repeat(64)}`,
      assetCatalogDigest: `sha256:${"7".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"8".repeat(64)}`,
    },
    schemas: { consumerIntegration: 3, managedState: 2, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest: `sha256:${"9".repeat(64)}`,
    },
  };
  return {
    schemaVersion: 3,
    repository: {
      provider: "github",
      id: "1314129620",
      nameWithOwner: "agent-teams-ai/agent-runtime",
    },
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
    cohort: { ...provisional, assets: describeCanonicalConsumerAssets(provisional) },
  };
}

export function snapshot(): ConsumerIntegrationSnapshot {
  return {
    integrationProfile: file("profile\n"),
    lockfile: file("lockfile\n"),
    packageManifest: file("{}\n"),
    agents: file("# Agents\n"),
    skill: absent,
    callerWorkflow: absent,
    managedState: absent,
  };
}

export function managedDesired(): ManagedSuccessorProfile {
  const policy = JSON.parse(
    readFileSync(new URL("../assets/runtime-policy.v1.json", import.meta.url), "utf8"),
  ) as FixtureRuntimePolicy;
  const lane = policy.managedRuntime.lanes["node-26-managed-qualified"]!;
  const base = desired();
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 4,
      repository: base.repository,
      integrationRoot: ".",
      packageManager: "pnpm",
      profilePath: base.profilePath,
      skillPath: base.skillPath,
      callerWorkflowPath: base.callerWorkflowPath,
      managedStatePath: base.managedStatePath,
      qualification: base.qualification,
      cohort: {
        schemaVersion: 3,
        cohortId: "docs-2026-10-profile4",
        channel: "rc",
        recordDigest: `sha256:${"1".repeat(64)}`,
        qualificationEventDigest: `sha256:${"2".repeat(64)}`,
        eligibleAfter: "2026-10-12T00:00:00Z",
        upgradeFrom: ["docs-2026-09-v2"],
        rollbackTo: ["docs-2026-09-v2"],
        candidateDigest: `sha256:${"3".repeat(64)}`,
        packages: {
          repositoryMutation: { version: "1.0.0", integrity: INTEGRITY },
          documentAuthoring: { version: "1.0.0", integrity: INTEGRITY },
          docsProtocol: { version: "1.0.0", integrity: INTEGRITY },
          docsProtocolAgentTeams: { version: "1.0.0", integrity: INTEGRITY },
          engineeringFoundation: { version: "1.0.0", integrity: INTEGRITY },
        },
        workflow: base.cohort.workflow,
        assets: describeCanonicalConsumerAssets(base.cohort),
        schemas: {
          consumerIntegration: 4,
          managedState: 3,
          qualificationReceipt: 1,
          docsProtocol: 1,
        },
        runtime: {
          policy: {
            id: policy.policyId,
            version: policy.policyVersion,
            digest: policy.sourceDigest,
          },
          selectedLane: "node-26-managed-qualified",
          node: lane.node,
          pnpm: policy.managedRuntime.pnpm,
          qualificationRuntime: lane.qualificationRuntime,
          runtimeClosure: {
            domain: "agent-teams.docs-runtime-closure/v2",
            digest: `sha256:${"4".repeat(64)}`,
          },
        },
      },
    }),
  ) as ManagedSuccessorProfile;
}
