import type { WorkspacePackage } from "../../../../workspace-inventory/api.js";
import type { SourceFileSnapshot } from "./source-file-snapshot.js";

export type SourceArchitectureConfigSchemaVersion = 1 | 2;

const SOURCE_DEPENDENCY_KINDS = [
  "commonjs",
  "dynamic",
  "export",
  "export-type",
  "import-equals",
  "import-equals-type",
  "static",
  "static-type",
  "type-query"
] as const;

export type SourceDependencyKind = (typeof SOURCE_DEPENDENCY_KINDS)[number];

export interface SourceDependencyReference {
  readonly kind: SourceDependencyKind;
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

export interface UnresolvedSourceDependency {
  readonly kind: "commonjs" | "dynamic" | "type-query";
  readonly start: number;
  readonly end: number;
}

export interface ParsedSourceDependencies {
  readonly parseErrorCount: number;
  readonly references: readonly SourceDependencyReference[];
  readonly unresolved: readonly UnresolvedSourceDependency[];
}

interface ParsedSourceFile extends SourceFileSnapshot {
  readonly parsed: ParsedSourceDependencies;
}

export interface ArchitectureBoundaryPolicy {
  readonly id: string;
  /** Runtime is the safe default; development admits runtime imports from devDependencies. */
  readonly dependencyMode: "runtime" | "development";
  readonly roots: readonly string[];
  /** Explicit inbound local-import surface declared by the consumer. */
  readonly entrypoints: readonly string[];
  /** Exact consumer-owned package export subpaths classified to this boundary. */
  readonly packageExports: readonly string[];
  readonly allowedBoundaries: readonly string[];
  readonly allowedPackages: readonly string[];
  readonly allowedBuiltins: readonly string[];
  readonly allowedRuntimeReferences: readonly UnresolvedSourceDependency["kind"][];
}

interface SourceArchitecturePolicyBase {
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly governedRoots: readonly string[];
  readonly boundaries: readonly ArchitectureBoundaryPolicy[];
}

export type SourceArchitecturePolicy =
  | (SourceArchitecturePolicyBase & {
      readonly schemaVersion: 1;
    })
  | (SourceArchitecturePolicyBase & {
      readonly schemaVersion: 2;
      /** Closed-world roots whose package manifests and source are governed. */
      readonly packageRoots: readonly string[];
    });

export interface ClassifiedSourceFile extends ParsedSourceFile {
  readonly boundary: ArchitectureBoundaryPolicy;
  readonly workspacePackage: WorkspacePackage;
}

export type ResolvedSourceDependency =
  | {
      readonly kind: "builtin";
      readonly specifier: string;
    }
  | {
      readonly kind: "external-package";
      readonly packageName: string;
      readonly declaration: "development" | "runtime" | "undeclared";
    }
  | {
      readonly kind: "local-file";
      readonly path: string;
      readonly workspacePackage: WorkspacePackage;
    }
  | {
      readonly kind: "generated-output-candidate";
      readonly path: string;
      readonly workspacePackage: WorkspacePackage;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: string;
    }
  | {
      readonly kind: "workspace-package";
      readonly workspacePackage: WorkspacePackage;
      readonly declaration: "development" | "runtime" | "undeclared";
      readonly exported: boolean;
      readonly subpath: string;
    }
  | {
      /**
       * This is intentionally distinct from workspace-package. A package-name
       * import back into the importing package has no source-boundary target
       * that the resolver can prove, so policies must fail closed.
       */
      readonly kind: "self-workspace-package";
      readonly workspacePackage: WorkspacePackage;
      readonly exported: boolean;
      readonly subpath: string;
    };

export type SourceDependencyEdgeMode = "runtime" | "type-only";

export interface ObservedSourceNode {
  readonly path: string;
  readonly boundaryId: string;
  readonly workspacePackageName: string;
  readonly workspacePackageManifestPath: string;
}

export type ObservedSourceDependencyResolution =
  | {
      readonly kind: "builtin";
      readonly specifier: string;
    }
  | {
      readonly kind: "external-package";
      readonly packageName: string;
      readonly declaration: "development" | "runtime" | "undeclared";
    }
  | {
      readonly kind: "local-file";
      readonly path: string;
      readonly workspacePackageName: string;
      readonly workspacePackageManifestPath: string;
      readonly targetBoundaryId: string | null;
    }
  | {
      readonly kind: "generated-output-candidate";
      readonly path: string;
      readonly workspacePackageName: string;
      readonly workspacePackageManifestPath: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: string;
    }
  | {
      readonly kind: "workspace-package";
      readonly workspacePackageName: string;
      readonly workspacePackageManifestPath: string;
      readonly declaration: "development" | "runtime" | "undeclared";
      readonly exported: boolean;
      readonly subpath: string;
    }
  | {
      readonly kind: "self-workspace-package";
      readonly workspacePackageName: string;
      readonly workspacePackageManifestPath: string;
      readonly exported: boolean;
      readonly subpath: string;
    };

export interface ObservedSourceDependencyEdge {
  readonly fromPath: string;
  readonly fromBoundaryId: string;
  readonly fromWorkspacePackageName: string;
  readonly fromWorkspacePackageManifestPath: string;
  readonly kind: SourceDependencyKind;
  readonly mode: SourceDependencyEdgeMode;
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
  readonly resolution: ObservedSourceDependencyResolution;
}

interface ObservedSourceParseFailure {
  readonly path: string;
  readonly parseErrorCount: number;
}

export interface ObservedUnresolvedRuntimeReference {
  readonly path: string;
  readonly boundaryId: string;
  readonly kind: UnresolvedSourceDependency["kind"];
  readonly start: number;
  readonly end: number;
}

/**
 * Immutable normalized evidence collected before architecture policies run.
 * It deliberately contains values only, never resolver-owned mutable objects.
 */
export interface ObservedSourceGraph {
  readonly nodes: readonly ObservedSourceNode[];
  readonly edges: readonly ObservedSourceDependencyEdge[];
  readonly parseFailures: readonly ObservedSourceParseFailure[];
  readonly unclassifiedSourcePaths: readonly string[];
  readonly unresolvedRuntimeReferences: readonly ObservedUnresolvedRuntimeReference[];
}
