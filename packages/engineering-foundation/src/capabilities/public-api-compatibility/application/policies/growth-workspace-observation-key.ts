import type { GrowthWorkspaceInventory } from "../model/growth-workspace.js";
import { growthUniqueSorted } from "./normalize-growth-observation.js";
import { projectGrowthResolution } from "./project-growth-resolution.js";

/** Private equality evidence, not a C0 digest or a new persisted identity.
 * Package/export enumeration order is inert; condition and fallback order is not.
 * Project conditions into sequences before serialization so their order survives.
 */
export function growthWorkspaceObservationKey(inventory: GrowthWorkspaceInventory): string {
  return JSON.stringify(
    growthUniqueSorted(inventory.packages, (pkg) => pkg.manifestPath).map((pkg) => ({
      name: pkg.name,
      rootPath: pkg.rootPath,
      manifestPath: pkg.manifestPath,
      moduleType: pkg.moduleType,
      exportSurface: {
        explicit: pkg.exportSurface.explicit,
        entries: growthUniqueSorted(pkg.exportSurface.entries, (entry) => entry.subpath).map(
          (entry) => ({
            subpath: entry.subpath,
            ...(entry.target === undefined
              ? {}
              : { target: projectGrowthResolution(entry.target) }),
          }),
        ),
      },
    })),
  );
}
