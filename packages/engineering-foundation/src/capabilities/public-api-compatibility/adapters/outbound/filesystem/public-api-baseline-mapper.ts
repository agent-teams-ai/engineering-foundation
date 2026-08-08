import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { isExactVersion } from "../../../../../semantic-version.js";
import {
  compareCanonicalReferences,
  type PublicApiEntrypointSnapshot,
  type PublicApiItem,
  type PublicApiPackagePolicy,
  type PublicApiSnapshot
} from "../../../application/model/public-api.js";

type PublicApiBaselineSchemaId = "package-public-api-baseline/v1";

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PUBLIC_API_BASELINE_INVALID",
    message,
    phase: "public-api-evidence",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    inputError(`${field} must be a string.`);
  }
  return value;
}

function mapItem(value: unknown, index: number): PublicApiItem {
  const item = record(value, `items[${index}]`);
  return Object.freeze({
    canonicalReference: string(item["canonicalReference"], `items[${index}].canonicalReference`),
    kind: string(item["kind"], `items[${index}].kind`),
    ...(typeof item["parentReference"] === "string"
      ? { parentReference: item["parentReference"] }
      : {}),
    parentKind: string(item["parentKind"], `items[${index}].parentKind`),
    signature: string(item["signature"], `items[${index}].signature`)
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
    exportPath: string(entrypoint["exportPath"], `entrypoints[${index}].exportPath`),
    items: Object.freeze(items)
  });
}

function validateSortedEntrypoints(
  entrypoints: readonly PublicApiEntrypointSnapshot[]
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
  policy: PublicApiPackagePolicy
): { readonly packageName: string; readonly packageVersion: string } {
  const packageName = string(baseline["packageName"], "packageName");
  if (packageName !== policy.packageName) {
    inputError(`Released API baseline package does not match ${policy.packageName}.`);
  }
  const packageVersion = string(baseline["packageVersion"], "packageVersion");
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
  inputError("Released API baseline schemaVersion must be 1.");
}

export function promotionBaselineSchemaId(
  _policy: PublicApiPackagePolicy
): PublicApiBaselineSchemaId {
  return "package-public-api-baseline/v1";
}

export function mapReleasedBaseline(
  input: unknown,
  policy: PublicApiPackagePolicy,
  _allowReleaseMigration = false
): PublicApiSnapshot {
  const baseline = record(input, "released API baseline");
  if (baseline["schemaVersion"] !== 1) {
    inputError("Released API baseline schemaVersion must be 1.");
  }
  const entrypointsInput = baseline["entrypoints"];
  if (!Array.isArray(entrypointsInput)) {
    inputError("Released API baseline entrypoints must be an array.");
  }
  const entrypoints = entrypointsInput.map(mapEntrypoint);
  validateSortedEntrypoints(entrypoints);
  return Object.freeze({
    schemaVersion: 1,
    ...baselineIdentity(baseline, policy),
    extractorVersion: string(baseline["extractorVersion"], "extractorVersion"),
    entrypoints: Object.freeze(entrypoints)
  });
}

export function baselineMatchesPolicy(
  _snapshot: PublicApiSnapshot,
  _policy: PublicApiPackagePolicy
): boolean {
  return true;
}
