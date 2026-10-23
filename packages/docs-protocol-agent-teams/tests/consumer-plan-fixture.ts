import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationSnapshot,
  QualifiedDocsCohortBindingV1,
} from "../dist/consumer-integration/index.js";
import {
  describeCanonicalConsumerAssets,
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
} from "../dist/consumer-integration/application/policies/consumer-integration-assets.js";
export const file = (value: string, mode = 0o644) => ({
  state: "file" as const,
  bytes: Buffer.from(value, "utf8"),
  mode,
});
export const absent = { state: "absent" as const };
const INTEGRITY: `sha512-${string}` = `sha512-${"A".repeat(86)}==`;

export function cohort(): QualifiedDocsCohortBindingV1 {
  const provisional: QualifiedDocsCohortBindingV1 = {
    schemaVersion: 1,
    cohortId: "docs-2026-08-16-rc1",
    channel: "rc",
    recordDigest: `sha256:${"1".repeat(64)}`,
    qualificationEventDigest: `sha256:${"2".repeat(64)}`,
    eligibleAfter: "2026-08-16T00:00:00Z",
    upgradeFrom: [],
    rollbackTo: [],
    packages: {
      docsProtocol: { version: "0.2.0-rc.0", integrity: INTEGRITY },
      engineeringFoundation: { version: "0.18.0-rc.0", integrity: INTEGRITY },
    },
    workflow: {
      repository: "agent-teams-ai/.github",
      path: ".github/workflows/docs-protocol-check.yml",
      revision: "1".repeat(40),
      blobSha: "2".repeat(40),
    },
    assets: {
      skillDigest: `sha256:${"0".repeat(64)}`,
      callerWorkflowDigest: `sha256:${"0".repeat(64)}`,
      assetCatalogDigest: `sha256:${"0".repeat(64)}`,
      transitionCatalogDigest: `sha256:${"0".repeat(64)}`,
    },
    schemas: { consumerIntegration: 1, managedState: 1, docsProtocol: 1 },
    runtime: {
      node: ">=24.18.0 <25",
      pnpm: ">=11.17.0 <12",
      runtimeClosureDigest:
        "sha256:09e935888b0ea01aa7dbfdc6101685ae9402a26a4e34fa8e124b40780cf0788a",
    },
  };
  return { ...provisional, assets: describeCanonicalConsumerAssets(provisional) };
}

export function desired(): ConsumerIntegrationDesiredStateV1 {
  return {
    schemaVersion: 1,
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
    cohort: cohort(),
  };
}

export function manifest(lineEnding = "\n") {
  return (
    JSON.stringify(
      {
        name: "consumer",
        private: true,
        scripts: Object.fromEntries(
          ["check", "doctor", "find", "info", "new", "recover"].map((command) => [
            `docs:${command}`,
            `agent-teams-docs ${command} --consumer . --profile architecture/foundation/docs-protocol.yaml`,
          ]),
        ),
        devDependencies: {
          "@agent-teams/docs-protocol": "0.2.0-rc.0",
          "@agent-teams/engineering-foundation": "0.18.0-rc.0",
          unrelated: "1.2.3",
        },
      },
      null,
      2,
    ).replaceAll("\n", lineEnding) + lineEnding
  );
}

export function snapshot(): ConsumerIntegrationSnapshot {
  const target = cohort();
  return {
    integrationProfile: file("profile\n"),
    lockfile: file("lockfile\n"),
    packageManifest: file(manifest()),
    agents: file(
      "# Agents\n\nUse [.agents/skills/docs-authoring/SKILL.md](.agents/skills/docs-authoring/SKILL.md) for documentation.\n",
    ),
    skill: file(CANONICAL_DOCS_SKILL_V2),
    callerWorkflow: file(canonicalCallerWorkflow(target)),
    managedState: absent,
  };
}
