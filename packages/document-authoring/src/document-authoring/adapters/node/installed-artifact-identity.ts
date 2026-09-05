import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { computeInstalledArtifactBuildIdentity } from "@agent-teams/repository-mutation";

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
