import type { GrowthWorkspaceReader } from "../../../application/ports/growth-workspace.js";

/** Select only the observed facts owned by growth policy; retain ordered targets. */
export function createWorkspaceGrowthReader(workspace: GrowthWorkspaceReader): GrowthWorkspaceReader {
  return {
    async read(consumerRoot, workspaceManifestPath, signal) {
      const inventory = await workspace.read(consumerRoot, workspaceManifestPath, signal);
      return { packages: inventory.packages.map((pkg) => ({
        name: pkg.name, rootPath: pkg.rootPath, manifestPath: pkg.manifestPath, moduleType: pkg.moduleType,
        exportSurface: { explicit: pkg.exportSurface.explicit, entries: pkg.exportSurface.entries.map((entry) => ({
          subpath: entry.subpath, ...(entry.target === undefined ? {} : { target: structuredClone(entry.target) })
        })) }
      })) };
    }
  };
}
