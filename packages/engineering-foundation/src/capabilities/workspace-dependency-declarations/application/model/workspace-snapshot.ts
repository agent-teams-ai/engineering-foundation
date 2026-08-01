export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface DependencyDeclaration {
  readonly packageName: string;
  readonly manifestPath: string;
  readonly section: DependencySection;
  readonly dependencyName: string;
  readonly specifier: string;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly manifestPath: string;
  readonly packageManager?: string;
  readonly dependencies: readonly DependencyDeclaration[];
  readonly bundledDependencies: readonly string[];
}

export interface CatalogEntry {
  readonly catalogName: string;
  readonly dependencyName: string;
  readonly version: string;
}

export interface WorkspaceSnapshot {
  readonly catalogMode?: string;
  readonly catalogs: readonly CatalogEntry[];
  readonly packages: readonly WorkspacePackage[];
}
