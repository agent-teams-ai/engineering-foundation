import { compareBinaryStrings } from "../../../binary-string-comparator.js";
import { assertNotCancelled } from "../../../cancellation.js";
import { CapabilityInputError } from "../../../capability-runtime.js";
import { assertSchema } from "../../../schema-catalog.js";
import { loadStrictYamlFile } from "../../../strict-yaml.js";
import {
  normalizeRepositoryPath,
  pathIsInside,
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../application/model/repository-path.js";
import type {
  ArchitectureBoundaryPolicy,
  SourceArchitectureConfigSchemaVersion,
  SourceArchitecturePolicy
} from "../application/model/source-workspace.js";

export const CAPABILITY_ID = "architecture.source-dependencies" as const;
export const CAPABILITY_CONFIG_SCHEMA_VERSION = 2 as const;

const SOURCE_ARCHITECTURE_SCHEMA_IDS = Object.freeze({
  1: "architecture-source-dependencies/v1",
  2: "architecture-source-dependencies/v2"
} as const);

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
  if (value === 1 || value === 2) {
    return value;
  }
  inputError("schemaVersion must be 1 or 2.");
}

async function assertSourceArchitectureSchema(
  input: unknown,
  version: SourceArchitectureConfigSchemaVersion
): Promise<void> {
  await assertSchema(
    SOURCE_ARCHITECTURE_SCHEMA_IDS[version],
    input,
    "source-architecture-config"
  );
}

function sortedStrings(value: unknown, field: string): readonly string[] {
  return Object.freeze(strings(value, field).toSorted());
}

function priorAncestor<T>(
  path: string,
  valuesByPath: ReadonlyMap<string, T>
): T | undefined {
  let candidate = path;
  while (true) {
    const value = valuesByPath.get(candidate);
    if (value !== undefined) {
      return value;
    }
    if (candidate === ".") {
      return undefined;
    }
    const separatorIndex = candidate.lastIndexOf("/");
    candidate = separatorIndex === -1 ? "." : candidate.slice(0, separatorIndex);
  }
}

interface PortableOwnedRoot {
  readonly boundaryId?: string;
  readonly identity: string;
  readonly root: string;
}

function comparePortableOwnedRoots(
  left: PortableOwnedRoot,
  right: PortableOwnedRoot
): number {
  return (
    compareBinaryStrings(left.identity, right.identity) ||
    compareBinaryStrings(left.root, right.root) ||
    compareBinaryStrings(left.boundaryId ?? "", right.boundaryId ?? "")
  );
}

function portableOwnedRoot(
  root: string,
  boundaryId?: string
): PortableOwnedRoot {
  return {
    ...(boundaryId === undefined ? {} : { boundaryId }),
    identity: portableRepositoryPathIdentity(root),
    root
  };
}

function sortedOverlapPair(
  left: PortableOwnedRoot,
  right: PortableOwnedRoot
): readonly [PortableOwnedRoot, PortableOwnedRoot] {
  return comparePortableOwnedRoots(left, right) <= 0
    ? [left, right]
    : [right, left];
}

function validateGovernedRootOverlap(policy: SourceArchitecturePolicy): void {
  if (policy.schemaVersion !== 2) {
    return;
  }
  const priorRoots = new Map<string, PortableOwnedRoot>();
  const roots = policy.governedRoots
    .map((root) => portableOwnedRoot(root))
    .toSorted(comparePortableOwnedRoots);
  for (const root of roots) {
    const overlap = priorAncestor(root.identity, priorRoots);
    if (overlap !== undefined) {
      const [first, second] = sortedOverlapPair(overlap, root);
      inputError(
        `Schema v2 governed roots overlap under portable path identity: ${first.root} and ${second.root}.`
      );
    }
    priorRoots.set(root.identity, root);
  }
}

function validateBoundaryRootOverlap(
  policy: SourceArchitecturePolicy,
  ownedBoundaryRoots: readonly {
    readonly boundaryId: string;
    readonly root: string;
  }[]
): void {
  if (policy.schemaVersion !== 2) {
    return;
  }
  const sortedRoots = ownedBoundaryRoots
    .map(({ boundaryId, root }) => portableOwnedRoot(root, boundaryId))
    .toSorted(comparePortableOwnedRoots);
  const priorRoots = new Map<string, PortableOwnedRoot>();
  for (const root of sortedRoots) {
    const overlap = priorAncestor(root.identity, priorRoots);
    if (overlap !== undefined) {
      const [first, second] = sortedOverlapPair(overlap, root);
      throw new CapabilityInputError({
        code: "SOURCE_BOUNDARY_AMBIGUOUS",
        message: `Schema v2 architecture boundary roots overlap under portable path identity: ${first.boundaryId}:${first.root} and ${second.boundaryId}:${second.root}.`,
        phase: "source-boundary-classification",
        retryable: false
      });
    }
    priorRoots.set(root.identity, root);
  }
}

function validatePortableV2Path(path: string, field: string): void {
  if (portableRepositoryPathProblem(path) !== undefined) {
    inputError(
      `Schema v2 ${field} must use a normalized portable repository-relative path: ${path}.`
    );
  }
}

function normalizePolicyPaths(
  value: unknown,
  field: string,
  version: SourceArchitectureConfigSchemaVersion
): readonly string[] {
  return Object.freeze(
    sortedStrings(value, field).map((path) => {
      if (version === 2) {
        validatePortableV2Path(path, field);
      }
      return normalizeRepositoryPath(path);
    })
  );
}

function validatePackageRootOverlap(policy: SourceArchitecturePolicy): void {
  if (policy.schemaVersion !== 2) {
    return;
  }
  const priorRoots = new Map<string, PortableOwnedRoot>();
  const roots = policy.packageRoots
    .map((root) => portableOwnedRoot(root))
    .toSorted(comparePortableOwnedRoots);
  for (const root of roots) {
    const overlap = priorAncestor(root.identity, priorRoots);
    if (overlap !== undefined) {
      const [first, second] = sortedOverlapPair(overlap, root);
      inputError(
        `Schema v2 package roots overlap under portable path identity: ${first.root} and ${second.root}.`
      );
    }
    priorRoots.set(root.identity, root);
  }
}

function policyPathIsInside(
  policy: SourceArchitecturePolicy,
  path: string,
  root: string
): boolean {
  if (policy.schemaVersion === 1) {
    return pathIsInside(path, root);
  }
  const pathIdentity = portableRepositoryPathIdentity(path);
  const rootIdentity = portableRepositoryPathIdentity(root);
  return (
    rootIdentity === "." ||
    pathIdentity === rootIdentity ||
    pathIdentity.startsWith(`${rootIdentity}/`)
  );
}

interface BoundaryLocationValidationInput {
  readonly boundary: ArchitectureBoundaryPolicy;
  readonly boundaryEntrypoints: Set<string>;
  readonly boundaryRoots: Set<string>;
  readonly ownedBoundaryRoots: Array<{
    readonly boundaryId: string;
    readonly root: string;
  }>;
  readonly policy: SourceArchitecturePolicy;
}

function validateBoundaryLocations(input: BoundaryLocationValidationInput): void {
  const { boundary, policy } = input;
  for (const root of boundary.roots) {
    if (policy.schemaVersion === 2) {
      validatePortableV2Path(root, "architecture boundary root");
    }
    if (policy.schemaVersion === 1 && input.boundaryRoots.has(root)) {
      inputError(`Architecture boundary root is duplicated: ${root}.`);
    }
    if (
      !policy.governedRoots.some((governedRoot) =>
        policyPathIsInside(policy, root, governedRoot)
      )
    ) {
      inputError(`Architecture boundary root is outside governed roots: ${root}.`);
    }
    input.boundaryRoots.add(root);
    input.ownedBoundaryRoots.push({ boundaryId: boundary.id, root });
  }
  for (const entrypoint of boundary.entrypoints) {
    if (policy.schemaVersion === 2) {
      validatePortableV2Path(entrypoint, "architecture boundary entrypoint");
    }
    if (input.boundaryEntrypoints.has(entrypoint)) {
      inputError(`Architecture boundary entrypoint is duplicated: ${entrypoint}.`);
    }
    if (
      !boundary.roots.some((root) =>
        policyPathIsInside(policy, entrypoint, root)
      )
    ) {
      inputError(
        `Architecture boundary entrypoint is outside its boundary roots: ${boundary.id}:${entrypoint}.`
      );
    }
    input.boundaryEntrypoints.add(entrypoint);
  }
}

function validatePolicy(policy: SourceArchitecturePolicy): void {
  const governedRoots = new Set<string>();
  const boundaryIds = new Set<string>();
  const boundaryRoots = new Set<string>();
  const boundaryEntrypoints = new Set<string>();
  const ownedBoundaryRoots: Array<{
    readonly boundaryId: string;
    readonly root: string;
  }> = [];
  validatePackageRootOverlap(policy);
  for (const root of policy.governedRoots) {
    if (policy.schemaVersion === 2) {
      validatePortableV2Path(root, "governed root");
    }
    if (governedRoots.has(root)) {
      inputError(`Governed root is duplicated after normalization: ${root}.`);
    }
    governedRoots.add(root);
  }
  validateGovernedRootOverlap(policy);
  for (const boundary of policy.boundaries) {
    if (boundaryIds.has(boundary.id)) {
      inputError(`Architecture boundary ID is duplicated: ${boundary.id}.`);
    }
    boundaryIds.add(boundary.id);
    validateBoundaryLocations({
      boundary,
      boundaryEntrypoints,
      boundaryRoots,
      ownedBoundaryRoots,
      policy
    });
  }
  validateBoundaryRootOverlap(policy, ownedBoundaryRoots);
  for (const boundary of policy.boundaries) {
    for (const target of boundary.allowedBoundaries) {
      if (target === boundary.id || !boundaryIds.has(target)) {
        inputError(`Boundary edge must target another declared boundary: ${boundary.id} -> ${target}.`);
      }
    }
  }
  for (const governedRoot of policy.governedRoots) {
    if (
      ![...boundaryRoots].some((root) =>
        policyPathIsInside(policy, root, governedRoot)
      )
    ) {
      inputError(`Governed root has no architecture boundary: ${governedRoot}.`);
    }
  }
}

function mapBoundary(
  value: unknown,
  index: number,
  version: SourceArchitectureConfigSchemaVersion
): ArchitectureBoundaryPolicy {
  const indexedField = `boundaries[${index}]`;
  const boundary = record(value, indexedField);
  const id = string(boundary["id"], `${indexedField}.id`);
  const field = version === 2 ? `boundary ${JSON.stringify(id)}` : indexedField;
  const allow = record(boundary["allow"], `${field}.allow`);
  const entrypoints = normalizePolicyPaths(
    boundary["entrypoints"],
    `${field}.entrypoints`,
    version
  );
  const dependencyMode = boundary["dependencyMode"] ?? "runtime";
  if (dependencyMode !== "runtime" && dependencyMode !== "development") {
    inputError(`${field}.dependencyMode is invalid.`);
  }
  return Object.freeze({
    id,
    dependencyMode,
    packageExports: version === 2
      ? sortedStrings(boundary["packageExports"] ?? [], `${field}.packageExports`)
      : Object.freeze([]),
    roots: normalizePolicyPaths(
      boundary["roots"],
      `${field}.roots`,
      version
    ),
    entrypoints,
    allowedBoundaries: sortedStrings(
      allow["boundaries"],
      `${field}.allow.boundaries`
    ),
    allowedPackages: sortedStrings(
      allow["packages"],
      `${field}.allow.packages`
    ),
    allowedBuiltins: sortedStrings(
      allow["builtins"],
      `${field}.allow.builtins`
    ),
    allowedRuntimeReferences: sortedStrings(
      allow["runtimeReferences"],
      `${field}.allow.runtimeReferences`
    ) as readonly ("commonjs" | "dynamic" | "type-query")[]
  });
}

export async function loadCapabilityConfig(
  consumerRoot: string,
  configPath: string,
  signal?: AbortSignal,
  observeSchemaVersion?: (
    version: SourceArchitectureConfigSchemaVersion
  ) => void
): Promise<SourceArchitecturePolicy> {
  let input: unknown;
  try {
    // This contained read is bounded. Completing it once lets cancellation
    // reports retain the requested v1/v2 schema version without a second read.
    input = await loadStrictYamlFile(
      consumerRoot,
      configPath,
      "source-architecture-config"
    );
  } catch (error) {
    assertNotCancelled(signal);
    throw error;
  }
  const root = record(input, "source architecture config");
  const version = schemaVersion(root["schemaVersion"]);
  observeSchemaVersion?.(version);
  assertNotCancelled(signal);
  await assertSourceArchitectureSchema(input, version);
  const workspace = record(root["workspace"], "workspace");
  const boundaryInput = root["boundaries"];
  if (!Array.isArray(boundaryInput)) {
    inputError("boundaries must be an array.");
  }
  if (workspace["kind"] !== "pnpm" || workspace["manifest"] !== "pnpm-workspace.yaml") {
    inputError("workspace must select pnpm-workspace.yaml.");
  }
  const common = {
    schemaVersion: version,
    workspaceManifestPath: "pnpm-workspace.yaml",
    governedRoots: normalizePolicyPaths(
      root["governedRoots"],
      "governedRoots",
      version
    ),
    boundaries: Object.freeze(
      boundaryInput
        .map((boundary, index) => mapBoundary(boundary, index, version))
        .toSorted((left, right) => compareBinaryStrings(left.id, right.id))
    )
  } as const;
  const policy: SourceArchitecturePolicy =
    version === 1
      ? Object.freeze({ ...common, schemaVersion: 1 })
      : Object.freeze({
          ...common,
          schemaVersion: 2,
          packageRoots: normalizePolicyPaths(
            root["packageRoots"],
            "packageRoots",
            version
          )
        });
  validatePolicy(policy);
  return policy;
}
