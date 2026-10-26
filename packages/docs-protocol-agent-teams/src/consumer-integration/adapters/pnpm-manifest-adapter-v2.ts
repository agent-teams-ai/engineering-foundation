import {
  qualifiedDocsCohortV2DirectPackageEntries,
  qualifiedDocsCohortV2PackageEntries,
  type ConsumerIntegrationDigest,
  type ConsumerIntegrationFileObservation,
  type QualifiedDocsCohortBindingV2,
  type PnpmManifestPlanV1,
} from "../application-api.js";
import {
  planPnpmManifestTargets,
  projectPnpmManifestCohortTargets,
} from "./pnpm-manifest-adapter-v1.js";

function targets(cohort: Pick<QualifiedDocsCohortBindingV2, "packages">) {
  return qualifiedDocsCohortV2DirectPackageEntries(cohort).map(({ name, version }) => ({
    name,
    version,
  }));
}

function transitivePackageNames(
  cohort: Pick<QualifiedDocsCohortBindingV2, "packages">,
): readonly string[] {
  return qualifiedDocsCohortV2PackageEntries(cohort)
    .filter(({ direct }) => !direct)
    .map(({ name }) => name);
}

function cohortPackageNames(
  cohort: Pick<QualifiedDocsCohortBindingV2, "packages">,
): readonly string[] {
  return qualifiedDocsCohortV2PackageEntries(cohort).map(({ name }) => name);
}

export function projectPnpmManifestCohortPinsV2(input: {
  readonly bytes: Uint8Array;
  readonly cohort: Pick<QualifiedDocsCohortBindingV2, "packages">;
}): Uint8Array {
  return projectPnpmManifestCohortTargets({
    bytes: input.bytes,
    targets: targets(input.cohort),
    transitivePackageNames: transitivePackageNames(input.cohort),
    forbiddenAliasTargetPackageNames: cohortPackageNames(input.cohort),
  });
}

export function planPnpmManifestV2(input: {
  readonly observation: ConsumerIntegrationFileObservation;
  readonly profilePath: string;
  readonly cohort: Pick<QualifiedDocsCohortBindingV2, "packages">;
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
      : { knownPriorScriptsDigest: input.knownPriorScriptsDigest }),
  });
}
