import { canonicalConsumerIntegrationJson, digestBytes } from "./consumer-integration-assets.js";
import type { UnselectedCohortV3 } from "./qualified-docs-cohort-v3.js";

export interface ManagedSuccessorProfile {
  readonly schemaVersion: 4;
  readonly repository: { readonly provider: "github"; readonly id: string; readonly nameWithOwner: string };
  readonly integrationRoot: ".";
  readonly packageManager: "pnpm";
  readonly profilePath: string;
  readonly skillPath: string;
  readonly callerWorkflowPath: string;
  readonly managedStatePath: string;
  readonly qualification: { readonly contractPath: string; readonly gateCommand: string };
  readonly governedDocsRoots?: readonly string[];
  readonly cohort: UnselectedCohortV3;
}

export interface ManagedSuccessorAssetDigests {
  readonly skillDigest: string;
  readonly callerWorkflowDigest: string;
  readonly assetCatalogDigest: string;
  readonly transitionCatalogDigest: string;
  readonly agentsRouteDigest: string;
  readonly docsScriptsDigest: string;
}

const DIGEST = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const ASSET_KEYS = ["skillDigest", "callerWorkflowDigest", "assetCatalogDigest",
  "transitionCatalogDigest", "agentsRouteDigest", "docsScriptsDigest"] as const;

/** Projects inert successor data; it neither selects a cohort nor writes a consumer file. */
export function projectManagedSuccessorState(
  profile: ManagedSuccessorProfile,
  assets: ManagedSuccessorAssetDigests
): string {
  if (Object.keys(assets).toSorted().join("\0") !== [...ASSET_KEYS].toSorted().join("\0") ||
      !ASSET_KEYS.every((key) => DIGEST.test(assets[key])) ||
      assets.skillDigest !== profile.cohort.assets.skillDigest ||
      assets.callerWorkflowDigest !== profile.cohort.assets.callerWorkflowDigest ||
      assets.assetCatalogDigest !== profile.cohort.assets.assetCatalogDigest ||
      assets.transitionCatalogDigest !== profile.cohort.assets.transitionCatalogDigest) {
    throw new TypeError("Successor state assets do not bind the cohort.");
  }
  const cohort = profile.cohort;
  const body = {
    schemaVersion: 3,
    cohortId: cohort.cohortId,
    cohortAuthority: {
      channel: cohort.channel,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
      eligibleAfter: cohort.eligibleAfter,
      upgradeFrom: cohort.upgradeFrom,
      rollbackTo: cohort.rollbackTo,
      candidateDigest: cohort.candidateDigest
    },
    repository: profile.repository,
    packages: cohort.packages,
    schemas: cohort.schemas,
    runtime: cohort.runtime,
    workflow: cohort.workflow,
    profilePath: profile.profilePath,
    skillPath: profile.skillPath,
    callerWorkflowPath: profile.callerWorkflowPath,
    managedStatePath: profile.managedStatePath,
    assets
  };
  const stateDigest = digestBytes(Buffer.from(canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-protocol.managed-state/v3", body
  }), "utf8"));
  return `${canonicalConsumerIntegrationJson({ ...body, stateDigest })}\n`;
}
