import type { WorkspaceInventory } from "../../../../workspace-inventory/application/model/workspace-inventory.js";
import type {
  ClassifiedSourceFile,
  ResolvedSourceDependency,
  SourceDependencyReference
} from "../model/source-workspace.js";

export interface ResolveSourceDependencyInput {
  readonly consumerRoot: string;
  readonly file: ClassifiedSourceFile;
  readonly governedFilePaths: ReadonlySet<string>;
  readonly inventory: WorkspaceInventory;
  readonly reference: SourceDependencyReference;
}

export interface SourceDependencyResolver {
  resolve(input: ResolveSourceDependencyInput): ResolvedSourceDependency;
}
