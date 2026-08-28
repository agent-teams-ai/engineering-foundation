import type {
  AuthorityScaffoldPlan,
  AuthorityScaffoldRecoveryScope
} from "../contract/types.js";
import { legacyScaffoldingRepositoryPathProblem } from "../application/policies/legacy-scaffolding-repository-path.js";
import { ScaffoldError } from "../scaffold-error.js";

const recoveryScopeKeys = Object.freeze([
  "projectId",
  "configPath",
  "targetCatalogPath",
  "compositionId"
] as const);
const recoveryScopeKeySet = new Set<PropertyKey>(recoveryScopeKeys);
const authorityIdPattern = /^[a-z0-9][a-z0-9._/-]*$/u;
const textEncoder = new TextEncoder();

function invalidScope(message: string, cause?: unknown): never {
  throw new ScaffoldError(
    "SCAFFOLD_INPUT_INVALID",
    message,
    [],
    cause === undefined ? undefined : { cause }
  );
}

function snapshotDescriptors(value: unknown): PropertyDescriptorMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidScope("Scaffolding recovery scope must be a closed data object.");
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      invalidScope("Scaffolding recovery scope must be a closed data object.");
    }
    return Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof ScaffoldError) {
      throw error;
    }
    return invalidScope(
      "Scaffolding recovery scope properties cannot be inspected safely.",
      error
    );
  }
}

function scopeString(
  descriptors: PropertyDescriptorMap,
  key: (typeof recoveryScopeKeys)[number]
): string {
  const descriptor = descriptors[key];
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    return invalidScope(
      `Scaffolding recovery scope ${key} must be an own string data property.`
    );
  }
  return descriptor.value;
}

function assertAuthorityId(value: string, key: "compositionId" | "projectId"): void {
  if (value.length > 160 || !authorityIdPattern.test(value)) {
    invalidScope(
      `Scaffolding recovery scope ${key} must satisfy the authority ID contract.`
    );
  }
}

function assertRepositoryPath(
  value: string,
  key: "configPath" | "targetCatalogPath"
): void {
  const segments = value.split("/");
  if (
    legacyScaffoldingRepositoryPathProblem(value) !== undefined ||
    textEncoder.encode(value).byteLength > 512 ||
    segments.some(
      (segment) =>
        segment.endsWith(" ") ||
        textEncoder.encode(segment).byteLength > 255
    )
  ) {
    invalidScope(
      `Scaffolding recovery scope ${key} must be a portable repository-relative path.`
    );
  }
}

export function snapshotAuthorityScaffoldRecoveryScope(
  value: unknown
): AuthorityScaffoldRecoveryScope {
  const descriptors = snapshotDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== recoveryScopeKeys.length ||
    keys.some((key) => !recoveryScopeKeySet.has(key))
  ) {
    invalidScope(
      "Scaffolding recovery scope must contain exactly projectId, configPath, targetCatalogPath, and compositionId."
    );
  }
  const projectId = scopeString(descriptors, "projectId");
  const configPath = scopeString(descriptors, "configPath");
  const targetCatalogPath = scopeString(descriptors, "targetCatalogPath");
  const compositionId = scopeString(descriptors, "compositionId");
  assertAuthorityId(projectId, "projectId");
  assertRepositoryPath(configPath, "configPath");
  assertRepositoryPath(targetCatalogPath, "targetCatalogPath");
  assertAuthorityId(compositionId, "compositionId");
  return Object.freeze({
    projectId,
    configPath,
    targetCatalogPath,
    compositionId
  });
}

export function assertScaffoldRecoveryScopeMatchesPlan(
  scope: AuthorityScaffoldRecoveryScope,
  plan: AuthorityScaffoldPlan
): void {
  if (
    scope.projectId === plan.projectId &&
    scope.configPath === plan.authority.configPath &&
    scope.targetCatalogPath === plan.authority.targetCatalogPath &&
    scope.compositionId === plan.intent.compositionId &&
    scope.compositionId === plan.composition.id
  ) {
    return;
  }
  const message =
    "Scaffolding recovery scope does not match the prepared journal; the journal and outputs were preserved.";
  throw new ScaffoldError(
    "SCAFFOLD_RECOVERY_REQUIRED",
    message,
    Object.freeze([
      Object.freeze({
        ruleId: "scaffolding.recovery.scope-mismatch",
        severity: "error" as const,
        phase: "recovery" as const,
        subject: "scaffold-recovery-scope",
        message,
        remediation:
          "Retry only with the exact project, authority paths, and Composition expected by the caller."
      })
    ])
  );
}
