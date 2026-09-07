import {
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  REPOSITORY_MUTATION_PACKAGE_NAME,
  type RepositoryMutationArtifactIdentity
} from "@agent-teams/repository-mutation";
import { installedFoundationVersion } from "./installed-foundation-version.js";
import { installedFoundationBuildIdentity } from "./installed-foundation-build-identity.js";

interface InstalledEnvelopeArtifacts {
  readonly owner: RepositoryMutationArtifactIdentity;
  readonly kernel: RepositoryMutationArtifactIdentity;
}

let installedArtifacts: Promise<InstalledEnvelopeArtifacts> | undefined;

export async function resolveInstalledFoundationTransactionArtifacts(): Promise<InstalledEnvelopeArtifacts> {
  installedArtifacts ??= (async () => {
    const [ownerVersion, ownerBuildIdentity, kernelVersion, kernelBuildIdentity] =
      await Promise.all([
        installedFoundationVersion(),
        installedFoundationBuildIdentity(),
        installedRepositoryMutationVersion(),
        installedRepositoryMutationBuildIdentity()
      ]);
    return {
      owner: {
        name: "@agent-teams/engineering-foundation",
        version: ownerVersion,
        buildIdentity: ownerBuildIdentity
      },
      kernel: {
        name: REPOSITORY_MUTATION_PACKAGE_NAME,
        version: kernelVersion,
        buildIdentity: kernelBuildIdentity
      }
    };
  })();
  return installedArtifacts;
}
