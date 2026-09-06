import { loadStrictYamlFile } from "../features/configuration-input/node.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../source-inventory/node.js";
import { PnpmPackageManifestSnapshotReader } from "./adapters/outbound/pnpm/pnpm-package-manifest-snapshot-reader.js";
import { PnpmWorkspaceInventoryReader } from "./adapters/outbound/pnpm/pnpm-workspace-inventory-reader.js";

import type { WorkspaceObservationReader } from "./api.js";

export function createWorkspaceInventoryReader(): WorkspaceObservationReader {
  return new PnpmWorkspaceInventoryReader(
    { readYaml: loadStrictYamlFile },
    new PnpmPackageManifestSnapshotReader({ read: readContainedRegularFile, pathTraversesSymbolicLink })
  );
}
