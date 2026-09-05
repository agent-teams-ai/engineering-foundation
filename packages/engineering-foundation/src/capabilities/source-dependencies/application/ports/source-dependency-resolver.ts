import type { WorkspaceInventory } from "../../../../workspace-inventory/api.js";

import type {
  ClassifiedSourceFile,
  ResolvedSourceDependency,
  SourceDependencyReference
} from "../model/source-workspace.js";

export interface ResolveSourceDependencyInput {
  readonly consumerRoot: string;
  readonly consumerRootIdentity?: {
    readonly device: string;
    readonly inode: string;
  };
  readonly enforceWorkspaceBindings?: boolean;
  readonly file: ClassifiedSourceFile;
  readonly governedFilePaths: ReadonlySet<string>;
  readonly governedWorkspacePackageManifestPaths?: ReadonlySet<string>;
  readonly inventory: WorkspaceInventory;
  readonly packageTypeScopes?: readonly {
    readonly moduleType: "commonjs" | "module";
    readonly rootPath: string;
  }[];
  readonly reference: SourceDependencyReference;
  readonly workspacePackageRootIdentity?: {
    readonly device: string;
    readonly inode: string;
  };
}

export interface SourceDependencyResolver {
  resolve(input: ResolveSourceDependencyInput): ResolvedSourceDependency;
}
