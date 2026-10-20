import type { WorkspaceDependencyDeclarationsSettings } from "../../../application/model/workspace-dependency-settings.js";

/** Maps configuration after the loader's shared schema assertion succeeds. */
export function parseCapabilityConfig(input: unknown): WorkspaceDependencyDeclarationsSettings {
  const root = input as Record<string, unknown>;
  const packageManager = root["packageManager"] as Record<string, unknown>;
  const policies = root["policies"] as Record<string, unknown>;
  return Object.freeze({
    packageManagerKind: packageManager["kind"] as "pnpm" | "bun",
    workspaceManifestPath: packageManager[
      "workspaceManifest"
    ] as "pnpm-workspace.yaml",
    policy: Object.freeze({
      reservedScopes: Object.freeze([...(policies["reservedScopes"] as string[])]),
      developmentOnlyPackages: Object.freeze([
        ...(policies["developmentOnlyPackages"] as string[])
      ]),
      exactRegistryDevelopmentOnlyPackages: Object.freeze([
        ...(policies["exactRegistryDevelopmentOnlyPackages"] as string[])
      ])
    })
  });
}
