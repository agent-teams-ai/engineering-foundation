import { loadStrictYamlFile } from "../features/configuration-input/node.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../source-inventory/node.js";
import { PnpmPackageManifestSnapshotReader } from "./adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js";
import { PnpmWorkspaceInventoryReader } from "./adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";

import type { ContainedFileObservation } from "../source-inventory/api.js";
import type { WorkspaceObservationReader } from "./api.js";

export function createWorkspaceInventoryReader(
  input: {
    readonly readYaml?: typeof loadStrictYamlFile;
    readonly read?: ContainedFileObservation["read"];
    readonly pathTraversesSymbolicLink?: typeof pathTraversesSymbolicLink;
  } = {},
): WorkspaceObservationReader {
  return new PnpmWorkspaceInventoryReader(
    { readYaml: input.readYaml ?? loadStrictYamlFile },
    new PnpmPackageManifestSnapshotReader({
      read: input.read ?? readContainedRegularFile,
      pathTraversesSymbolicLink: input.pathTraversesSymbolicLink ?? pathTraversesSymbolicLink,
    }),
  );
}
