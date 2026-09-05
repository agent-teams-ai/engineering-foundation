import { Ajv2020 } from "ajv/dist/2020.js";
import { CapabilityInputError } from "../../../capability-runtime.js";
import type { WorkspaceDependencyPolicy } from "../application/model/workspace-dependency-policy.js";

export const CAPABILITY_ID = "workspace.dependency-declarations" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

export interface WorkspaceDependencyDeclarationsSettings {
  readonly packageManagerKind: "pnpm";
  readonly workspaceManifestPath: "pnpm-workspace.yaml";
  readonly policy: WorkspaceDependencyPolicy;
}

/** Canonical schema and input are explicit data; this parser has no I/O authority. */
export function parseCapabilityConfig(
  input: unknown,
  schema: object
): WorkspaceDependencyDeclarationsSettings {
  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTuples: false,
    validateFormats: false
  }).compile(schema);
  if (!validate(input)) {
    throw new CapabilityInputError({
      code: "SCHEMA_INVALID",
      message: (validate.errors ?? [])
        .slice(0, 8)
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")
        .slice(0, 1000) || "Input does not match the required schema.",
      phase: "workspace-dependency-declarations-config",
      retryable: false
    });
  }

  const root = input as Record<string, unknown>;
  const packageManager = root["packageManager"] as Record<string, unknown>;
  const policies = root["policies"] as Record<string, unknown>;
  return Object.freeze({
    packageManagerKind: packageManager["kind"] as "pnpm",
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
