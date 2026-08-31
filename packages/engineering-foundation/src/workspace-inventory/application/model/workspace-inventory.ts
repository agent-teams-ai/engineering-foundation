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
  /** Inert manifest data retained for ordered Node-condition resolution. */
  readonly target?: PackageExportTarget;
  readonly targetPaths?: readonly string[];
}

export type PackageExportTarget =
  | string
  | null
  | readonly PackageExportTarget[]
  | PackageExportConditions;

export interface PackageExportConditions {
  readonly [condition: string]: PackageExportTarget;
}

export interface PackageExportSurface {
  readonly explicit: boolean;
  readonly entries: readonly PackageExportEntry[];
}

export interface WorkspacePackage {
  readonly name: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  /** Node/TypeScript interpretation for ambiguous .js/.ts importers. */
  readonly moduleType: "commonjs" | "module";
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
