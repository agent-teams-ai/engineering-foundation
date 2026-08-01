import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../strict-yaml.js";
import type {
  ArchitectureBoundaryPolicy,
  SourceArchitecturePolicy
} from "../application/model/source-workspace.js";

export const CAPABILITY_ID = "architecture.source-dependencies" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "SOURCE_ARCHITECTURE_CONFIG_INVALID",
    message,
    phase: "source-architecture-config",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    inputError(`${field} must be an object.`);
  }
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    inputError(`${field} must be an array of strings.`);
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      inputError(`${field} must be an array of strings.`);
    }
    output.push(entry);
  }
  return output;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function pathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function validatePolicy(policy: SourceArchitecturePolicy): void {
  const boundaryIds = new Set<string>();
  const boundaryRoots = new Set<string>();
  for (const boundary of policy.boundaries) {
    if (boundaryIds.has(boundary.id)) {
      inputError(`Architecture boundary ID is duplicated: ${boundary.id}.`);
    }
    boundaryIds.add(boundary.id);
    for (const root of boundary.roots) {
      if (boundaryRoots.has(root)) {
        inputError(`Architecture boundary root is duplicated: ${root}.`);
      }
      if (!policy.governedRoots.some((governedRoot) => pathInside(root, governedRoot))) {
        inputError(`Architecture boundary root is outside governed roots: ${root}.`);
      }
      boundaryRoots.add(root);
    }
  }
  for (const boundary of policy.boundaries) {
    for (const target of boundary.allowedBoundaries) {
      if (target === boundary.id || !boundaryIds.has(target)) {
        inputError(`Boundary edge must target another declared boundary: ${boundary.id} -> ${target}.`);
      }
    }
  }
  for (const governedRoot of policy.governedRoots) {
    if (![...boundaryRoots].some((root) => pathInside(root, governedRoot))) {
      inputError(`Governed root has no architecture boundary: ${governedRoot}.`);
    }
  }
}

function mapBoundary(value: unknown, index: number): ArchitectureBoundaryPolicy {
  const boundary = record(value, `boundaries[${index}]`);
  const allow = record(boundary["allow"], `boundaries[${index}].allow`);
  return Object.freeze({
    id: string(boundary["id"], `boundaries[${index}].id`),
    roots: Object.freeze(strings(boundary["roots"], `boundaries[${index}].roots`)),
    allowedBoundaries: Object.freeze(
      strings(allow["boundaries"], `boundaries[${index}].allow.boundaries`)
    ),
    allowedPackages: Object.freeze(
      strings(allow["packages"], `boundaries[${index}].allow.packages`)
    ),
    allowedBuiltins: Object.freeze(
      strings(allow["builtins"], `boundaries[${index}].allow.builtins`)
    ),
    allowedRuntimeReferences: Object.freeze(
      strings(
        allow["runtimeReferences"],
        `boundaries[${index}].allow.runtimeReferences`
      ) as readonly ("commonjs" | "dynamic" | "type-query")[]
    )
  });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal
): Promise<SourceArchitecturePolicy> {
  const input = await loadStrictYamlFile(
    consumerRoot,
    configPath,
    "source-architecture-config",
    signal
  );
  await assertSchema(
    "architecture-source-dependencies/v1",
    input,
    "source-architecture-config"
  );
  const root = record(input, "source architecture config");
  const workspace = record(root["workspace"], "workspace");
  const boundaryInput = root["boundaries"];
  if (!Array.isArray(boundaryInput)) {
    inputError("boundaries must be an array.");
  }
  if (workspace["kind"] !== "pnpm" || workspace["manifest"] !== "pnpm-workspace.yaml") {
    inputError("workspace must select pnpm-workspace.yaml.");
  }
  const policy: SourceArchitecturePolicy = Object.freeze({
    workspaceManifestPath: "pnpm-workspace.yaml",
    governedRoots: Object.freeze(strings(root["governedRoots"], "governedRoots")),
    boundaries: Object.freeze(boundaryInput.map(mapBoundary))
  });
  validatePolicy(policy);
  return policy;
}
