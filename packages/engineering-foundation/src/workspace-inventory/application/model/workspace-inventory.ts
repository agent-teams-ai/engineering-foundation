export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface DependencyDeclaration {
  readonly packageName: string;
  readonly manifestPath: string;
  readonly section: DependencySection;
  readonly dependencyName: string;
  readonly specifier: string;
}

export interface PackageExportEntry {
  readonly subpath: string;
  readonly availability: "available" | "blocked";
}

export interface PackageExportSurface {
  readonly explicit: boolean;
  readonly entries: readonly PackageExportEntry[];
}

export interface WorkspacePackage {
  readonly name: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly packageManager?: string;
  readonly dependencies: readonly DependencyDeclaration[];
  readonly bundledDependencies: readonly string[];
  readonly exportSurface: PackageExportSurface;
}

export interface CatalogEntry {
  readonly catalogName: string;
  readonly dependencyName: string;
  readonly version: string;
}

export interface WorkspaceInventory {
  readonly catalogMode?: string;
  readonly catalogs: readonly CatalogEntry[];
  readonly packages: readonly WorkspacePackage[];
}
