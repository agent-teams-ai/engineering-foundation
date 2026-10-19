import type { WorkspaceDependencyPolicy } from "./workspace-dependency-policy.js";

export interface WorkspaceDependencyDeclarationsSettings {
  readonly packageManagerKind: "pnpm" | "bun";
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly policy: WorkspaceDependencyPolicy;
}

