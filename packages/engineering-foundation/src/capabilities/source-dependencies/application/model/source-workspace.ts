import type { WorkspacePackage } from "../../../../workspace-inventory/application/model/workspace-inventory.js";
import type { SourceFileSnapshot } from "../../../../source-inventory/application/model/source-file-snapshot.js";

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
  readonly roots: readonly string[];
  readonly allowedBoundaries: readonly string[];
  readonly allowedPackages: readonly string[];
  readonly allowedBuiltins: readonly string[];
  readonly allowedRuntimeReferences: readonly UnresolvedSourceDependency["kind"][];
}

export interface SourceArchitecturePolicy {
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly governedRoots: readonly string[];
  readonly boundaries: readonly ArchitectureBoundaryPolicy[];
}

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
    };
