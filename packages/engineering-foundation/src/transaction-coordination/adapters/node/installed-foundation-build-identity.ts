import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { computeInstalledArtifactBuildIdentity } from "@agent-teams/repository-mutation";

import type { FoundationBuildIdentity } from "../../application/model/foundation-transaction-identity.js";

const packageRoot = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));

export function computeFoundationBuildIdentity(
  root: string,
  limits: { readonly maximumVisitedEntries?: number } = {}
): Promise<FoundationBuildIdentity> {
  return computeInstalledArtifactBuildIdentity(
    { packageRoot: root, roots: ["dist", "schemas", "presets", "assets"] },
    limits
  );
}

let installedIdentity: Promise<FoundationBuildIdentity> | undefined;
export function installedFoundationBuildIdentity(): Promise<FoundationBuildIdentity> {
  installedIdentity ??= computeFoundationBuildIdentity(packageRoot);
  return installedIdentity;
}
