import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeInstalledArtifactBuildIdentity,
  installedRepositoryMutationBuildIdentity,
  installedRepositoryMutationVersion,
  REPOSITORY_MUTATION_PACKAGE_NAME
} from "@agent-teams/repository-mutation";
import type { DocumentTransactionEnvelope } from "../../application/model/document-transaction.js";

const packageRoot = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));

function computeDocumentAuthoringBuildIdentity(
  root: string,
  limits: { readonly maximumVisitedEntries?: number } = {}
): Promise<`sha256:${string}`> {
  return computeInstalledArtifactBuildIdentity(
    { packageRoot: root, roots: ["dist", "schemas"] }, limits
  );
}

let installedIdentity: Promise<`sha256:${string}`> | undefined;
export function installedDocumentAuthoringBuildIdentity(): Promise<`sha256:${string}`> {
  installedIdentity ??= computeDocumentAuthoringBuildIdentity(packageRoot);
  return installedIdentity;
}

export async function installedDocumentMutationArtifact(): Promise<DocumentTransactionEnvelope["kernelArtifact"]> {
  const [version, buildIdentity] = await Promise.all([
    installedRepositoryMutationVersion(), installedRepositoryMutationBuildIdentity()
  ]);
  return Object.freeze({ name: REPOSITORY_MUTATION_PACKAGE_NAME, version, buildIdentity });
}
