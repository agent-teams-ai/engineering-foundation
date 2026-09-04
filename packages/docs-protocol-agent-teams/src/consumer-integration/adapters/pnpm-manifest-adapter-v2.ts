import type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  QualifiedDocsCohortBindingV2
} from "../domain/model.js";
import type { PnpmManifestPlanV1 } from "../application/ports/consumer-integration-planners.js";
import {
  qualifiedDocsCohortV2DirectPackageEntries,
  qualifiedDocsCohortV2PackageEntries
} from
  "../application/policies/qualified-docs-cohort-v2.js";
import {
  planPnpmManifestTargets,
  projectPnpmManifestCohortTargets
} from "./pnpm-manifest-adapter-v1.js";

function targets(cohort: QualifiedDocsCohortBindingV2) {
  return qualifiedDocsCohortV2DirectPackageEntries(cohort).map(({ name, version }) => ({
    name,
    version
  }));
}

function transitivePackageNames(cohort: QualifiedDocsCohortBindingV2): readonly string[] {
  return qualifiedDocsCohortV2PackageEntries(cohort)
    .filter(({ direct }) => !direct)
    .map(({ name }) => name);
}

function cohortPackageNames(cohort: QualifiedDocsCohortBindingV2): readonly string[] {
  return qualifiedDocsCohortV2PackageEntries(cohort).map(({ name }) => name);
}

export function projectPnpmManifestCohortPinsV2(input: {
  readonly bytes: Uint8Array;
  readonly cohort: QualifiedDocsCohortBindingV2;
}): Uint8Array {
  return projectPnpmManifestCohortTargets({
    bytes: input.bytes,
    targets: targets(input.cohort),
    transitivePackageNames: transitivePackageNames(input.cohort),
    forbiddenAliasTargetPackageNames: cohortPackageNames(input.cohort)
  });
}

export function planPnpmManifestV2(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly profilePath: string;
  readonly cohort: QualifiedDocsCohortBindingV2;
  readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;
}): PnpmManifestPlanV1 {
  return planPnpmManifestTargets({
    observation: input.observation,
    profilePath: input.profilePath,
    targets: targets(input.cohort),
    forbiddenRootPackageNames: transitivePackageNames(input.cohort),
    forbiddenAliasTargetPackageNames: cohortPackageNames(input.cohort),
    ...(input.knownPriorScriptsDigest === undefined
      ? {}
      : { knownPriorScriptsDigest: input.knownPriorScriptsDigest })
  });
}
