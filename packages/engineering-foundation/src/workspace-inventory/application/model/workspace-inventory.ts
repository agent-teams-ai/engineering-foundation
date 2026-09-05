export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

type DependencyDeclarationProvenance =
  | { readonly kind: "manifest" }
  | { readonly kind: "catalog"; readonly catalogName: string };

export interface DependencyDeclaration {
  readonly packageName: string;
  readonly manifestPath: string;
  readonly section: DependencySection;
  readonly dependencyName: string;
  /** Raw manifest specifier, retained independently from its effective value. */
  readonly specifier: string;
  /** Package installed at the declaration slot after resolving a valid npm alias. */
  readonly targetPackageName: string;
  /** Catalog-resolved specifier before npm-alias interpretation. */
  readonly effectiveSpecifier: string;
  /** Version/range portion governing the resolved target. */
  readonly effectiveVersionSpecifier: string;
  /** Malformed alias bytes remain evidence and cannot authorize a package edge. */
  readonly normalizationProblem?: "invalid-npm-alias";
  readonly provenance: DependencyDeclarationProvenance;
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

interface PackageExportConditions {
  readonly [condition: string]: PackageExportTarget;
}

export interface PackageExportSurface {
  readonly explicit: boolean;
  /** A top-level null exports value disables Node's self-reference lookup. */
  readonly selfReferenceDisabled?: true;
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
