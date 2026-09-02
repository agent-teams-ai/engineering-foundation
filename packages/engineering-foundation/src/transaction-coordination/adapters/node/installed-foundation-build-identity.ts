import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { computeInstalledArtifactBuildIdentity } from "@agent-teams/repository-mutation";

import type { Sha256Digest } from "../../../scaffolding/contract/types.js";

const packageRoot = dirname(fileURLToPath(new URL("../../../../package.json", import.meta.url)));

export function computeFoundationBuildIdentity(
  root: string,
  limits: { readonly maximumVisitedEntries?: number } = {}
): Promise<Sha256Digest> {
  return computeInstalledArtifactBuildIdentity(
    { packageRoot: root, roots: ["dist", "schemas", "presets"] },
    limits
  );
}

let installedIdentity: Promise<Sha256Digest> | undefined;
export function installedFoundationBuildIdentity(): Promise<Sha256Digest> {
  installedIdentity ??= computeFoundationBuildIdentity(packageRoot);
  return installedIdentity;
}
