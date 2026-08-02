import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import {
  compareCanonicalReferences,
  type PublicApiEntrypointSnapshot,
  type PublicApiItem,
  type PublicApiPackagePolicy,
  type PublicApiSnapshot,
} from "../../../application/model/public-api.js";

type PublicApiBaselineSchemaId =
  | "package-public-api-baseline/v1"
  | "package-public-api-baseline/v2";

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PUBLIC_API_BASELINE_INVALID",
    message,
    phase: "public-api-evidence",
    retryable: false,
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function mapItem(value: unknown, index: number): PublicApiItem {
  const item = record(value, `items[${index}]`);
  return Object.freeze({
    canonicalReference: String(item["canonicalReference"]),
    kind: String(item["kind"]),
    ...(typeof item["parentReference"] === "string"
      ? { parentReference: item["parentReference"] }
      : {}),
    parentKind: String(item["parentKind"]),
    signature: String(item["signature"]),
  });
}

function validateSortedItems(items: readonly PublicApiItem[]): void {
  const references = items.map((item) => item.canonicalReference);
  const sortedReferences = references.toSorted(compareCanonicalReferences);
  if (
    new Set(references).size !== references.length ||
    references.some((value, index) => value !== sortedReferences[index])
  ) {
    inputError("Released API baseline items must have unique sorted canonical references.");
  }
}

function mapEntrypoint(value: unknown, index: number): PublicApiEntrypointSnapshot {
  const entrypoint = record(value, `entrypoints[${index}]`);
  const itemsInput = entrypoint["items"];
  if (!Array.isArray(itemsInput)) {
    inputError(`Released API baseline entrypoints[${index}].items must be an array.`);
  }
  const items = itemsInput.map(mapItem);
  validateSortedItems(items);
  return Object.freeze({
    exportPath: String(entrypoint["exportPath"]),
    items: Object.freeze(items),
  });
}

function validateSortedEntrypoints(
  entrypoints: readonly PublicApiEntrypointSnapshot[],
): void {
  const paths = entrypoints.map((entrypoint) => entrypoint.exportPath);
  const sortedPaths = paths.toSorted(compareCanonicalReferences);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((value, index) => value !== sortedPaths[index])
  ) {
    inputError("Released API baseline entrypoints must have unique sorted export paths.");
  }
}

function baselineIdentity(
  baseline: Record<string, unknown>,
  policy: PublicApiPackagePolicy,
): { readonly packageName: string; readonly packageVersion: string } {
  const packageName = String(baseline["packageName"]);
  if (packageName !== policy.packageName) {
    inputError(`Released API baseline package does not match ${policy.packageName}.`);
  }
  const packageVersion = String(baseline["packageVersion"]);
  if (!isExactVersion(packageVersion)) {
    inputError(`Released API baseline version is not exact SemVer: ${packageVersion}.`);
  }
  return Object.freeze({ packageName, packageVersion });
}

export function releasedBaselineSchemaId(input: unknown): PublicApiBaselineSchemaId {
  const baseline = record(input, "released API baseline");
  if (baseline["schemaVersion"] === 1) {
    return "package-public-api-baseline/v1";
  }
  if (baseline["schemaVersion"] === 2) {
    return "package-public-api-baseline/v2";
  }
  inputError("Released API baseline schemaVersion must be 1 or 2.");
}

export function promotionBaselineSchemaId(
  policy: PublicApiPackagePolicy,
): PublicApiBaselineSchemaId {
  return "entrypoints" in policy
    ? "package-public-api-baseline/v2"
    : "package-public-api-baseline/v1";
}

export function mapReleasedBaseline(
  input: unknown,
  policy: PublicApiPackagePolicy,
  allowReleaseMigration = false,
): PublicApiSnapshot {
  const baseline = record(input, "released API baseline");
  const identity = baselineIdentity(baseline, policy);
  const extractorVersion = String(baseline["extractorVersion"]);
  if (baseline["schemaVersion"] === 2) {
    if (!("entrypoints" in policy)) {
      inputError("A schema v1 policy cannot read a schema v2 released baseline.");
    }
    const entrypointsInput = baseline["entrypoints"];
    if (!Array.isArray(entrypointsInput)) {
      inputError("Released API baseline entrypoints must be an array.");
    }
    const entrypoints = entrypointsInput.map(mapEntrypoint);
    validateSortedEntrypoints(entrypoints);
    return Object.freeze({
      schemaVersion: 2,
      ...identity,
      extractorVersion,
      entrypoints: Object.freeze(entrypoints),
    });
  }
  const itemsInput = baseline["items"];
  if (!Array.isArray(itemsInput)) {
    inputError("Released API baseline items must be an array.");
  }
  const items = itemsInput.map(mapItem);
  validateSortedItems(items);
  const v1Snapshot = Object.freeze({
    schemaVersion: 1 as const,
    ...identity,
    extractorVersion,
    items: Object.freeze(items),
  });
  if (!("entrypoints" in policy) || allowReleaseMigration) {
    return v1Snapshot;
  }
  inputError(
    "A schema v2 policy requires a released schema v2 baseline. v1-to-v2 migration is release-owned and cannot reuse v1 evidence.",
  );
}

export function baselineMatchesPolicy(
  snapshot: PublicApiSnapshot,
  policy: PublicApiPackagePolicy,
): boolean {
  return ("entrypoints" in policy) === (snapshot.schemaVersion === 2);
}
