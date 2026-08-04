import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../strict-yaml.js";
import {
  normalizeRepositoryPath,
  pathIsInside
} from "../application/model/repository-path.js";
import type {
  ArchitectureBoundaryPolicy,
  SourceArchitectureConfigSchemaVersion,
  SourceArchitecturePolicy
} from "../application/model/source-workspace.js";

export const CAPABILITY_ID = "architecture.source-dependencies" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 1 as const;
const SOURCE_ARCHITECTURE_SCHEMA_ID =
  "architecture-source-dependencies/v1" as const;

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

function schemaVersion(value: unknown): SourceArchitectureConfigSchemaVersion {
  if (value === 1) {
    return value;
  }
  inputError("schemaVersion must be 1.");
}

async function assertSourceArchitectureSchema(
  input: unknown
): Promise<void> {
  await assertSchema(
    SOURCE_ARCHITECTURE_SCHEMA_ID,
    input,
    "source-architecture-config"
  );
}

function sortedStrings(value: unknown, field: string): readonly string[] {
  return Object.freeze(strings(value, field).toSorted());
}

function validatePolicy(policy: SourceArchitecturePolicy): void {
  const governedRoots = new Set<string>();
  const boundaryIds = new Set<string>();
  const boundaryRoots = new Set<string>();
  const boundaryEntrypoints = new Set<string>();
  for (const root of policy.governedRoots) {
    if (governedRoots.has(root)) {
      inputError(`Governed root is duplicated after normalization: ${root}.`);
    }
    governedRoots.add(root);
  }
  for (const boundary of policy.boundaries) {
    if (boundaryIds.has(boundary.id)) {
      inputError(`Architecture boundary ID is duplicated: ${boundary.id}.`);
    }
    boundaryIds.add(boundary.id);
    for (const root of boundary.roots) {
      if (boundaryRoots.has(root)) {
        inputError(`Architecture boundary root is duplicated: ${root}.`);
      }
      if (!policy.governedRoots.some((governedRoot) => pathIsInside(root, governedRoot))) {
        inputError(`Architecture boundary root is outside governed roots: ${root}.`);
      }
      boundaryRoots.add(root);
    }
    for (const entrypoint of boundary.entrypoints) {
      if (boundaryEntrypoints.has(entrypoint)) {
        inputError(`Architecture boundary entrypoint is duplicated: ${entrypoint}.`);
      }
      if (!boundary.roots.some((root) => pathIsInside(entrypoint, root))) {
        inputError(
          `Architecture boundary entrypoint is outside its boundary roots: ${boundary.id}:${entrypoint}.`
        );
      }
      boundaryEntrypoints.add(entrypoint);
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
    if (![...boundaryRoots].some((root) => pathIsInside(root, governedRoot))) {
      inputError(`Governed root has no architecture boundary: ${governedRoot}.`);
    }
  }
}

function mapBoundary(
  value: unknown,
  index: number
): ArchitectureBoundaryPolicy {
  const boundary = record(value, `boundaries[${index}]`);
  const allow = record(boundary["allow"], `boundaries[${index}].allow`);
  const entrypoints = Object.freeze(
    sortedStrings(
      boundary["entrypoints"],
      `boundaries[${index}].entrypoints`
    ).map(normalizeRepositoryPath)
  );
  return Object.freeze({
    id: string(boundary["id"], `boundaries[${index}].id`),
    roots: Object.freeze(
      sortedStrings(boundary["roots"], `boundaries[${index}].roots`).map(
        normalizeRepositoryPath
      )
    ),
    entrypoints,
    allowedBoundaries: sortedStrings(
      allow["boundaries"],
      `boundaries[${index}].allow.boundaries`
    ),
    allowedPackages: sortedStrings(
      allow["packages"],
      `boundaries[${index}].allow.packages`
    ),
    allowedBuiltins: sortedStrings(
      allow["builtins"],
      `boundaries[${index}].allow.builtins`
    ),
    allowedRuntimeReferences: sortedStrings(
      allow["runtimeReferences"],
      `boundaries[${index}].allow.runtimeReferences`
    ) as readonly ("commonjs" | "dynamic" | "type-query")[]
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
  const root = record(input, "source architecture config");
  const version = schemaVersion(root["schemaVersion"]);
  await assertSourceArchitectureSchema(input);
  const workspace = record(root["workspace"], "workspace");
  const boundaryInput = root["boundaries"];
  if (!Array.isArray(boundaryInput)) {
    inputError("boundaries must be an array.");
  }
  if (workspace["kind"] !== "pnpm" || workspace["manifest"] !== "pnpm-workspace.yaml") {
    inputError("workspace must select pnpm-workspace.yaml.");
  }
  const policy: SourceArchitecturePolicy = Object.freeze({
    schemaVersion: version,
    workspaceManifestPath: "pnpm-workspace.yaml",
    governedRoots: Object.freeze(
      sortedStrings(root["governedRoots"], "governedRoots").map(normalizeRepositoryPath)
    ),
    boundaries: Object.freeze(
      boundaryInput
        .map((boundary, index) => mapBoundary(boundary, index))
        .toSorted((left, right) => compareBinaryStrings(left.id, right.id))
    )
  });
  validatePolicy(policy);
  return policy;
}
