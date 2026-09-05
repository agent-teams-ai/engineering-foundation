import type { WorkspaceDependencyPolicy } from "./workspace-dependency-policy.js";

export interface WorkspaceDependencyDeclarationsSettings {
  readonly packageManagerKind: "pnpm";
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly policy: WorkspaceDependencyPolicy;
}

