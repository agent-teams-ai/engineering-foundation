export type {
  CatalogEntry, DependencyDeclaration, PackageExportEntry, PackageExportSurface,
  PackageExportTarget, WorkspaceInventory, WorkspacePackage
} from "./application/model/workspace-inventory.js";
export { DEPENDENCY_SECTIONS } from "./application/model/workspace-inventory.js";
export type { WorkspaceInventoryReader } from "./application/ports/workspace-inventory-reader.js";
export {
  exactAvailablePackageExport, exactPackageExportTargetPaths, resolvePackageExport
} from "./application/policies/package-export-matcher.js";
export type {
  PackageExportCondition, ResolvedPackageExport
} from "./application/policies/package-export-matcher.js";
export type { WorkspaceObservationReader } from "./application/ports/workspace-observation-reader.js";
