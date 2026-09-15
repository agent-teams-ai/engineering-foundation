import { GrowthObservationInvariantError, GrowthObservationUnavailableError, growthDimensions } from "../model/growth-observation.js";
import type { GrowthDigest, GrowthInvocation, GrowthSurfaceObservation } from "../model/growth-observation.js";
import { assertGrowthInvocationShape, assertGrowthObservationShape } from "./validate-growth-observation.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";

export function growthCanonicalJson(value: unknown): string {
  const serialized = serializeGrowthValue(value, new Set<object>());
  if (new TextEncoder().encode(serialized).byteLength > 32 * 1024 * 1024) {
    throw new GrowthObservationUnavailableError("growth-serialization-budget-exhausted");
  }
  return serialized;
}

export function growthUniqueSorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const ordered = values.map((value) => ({ value, key: key(value) })).toSorted((a, b) => compareGrowthStrings(a.key, b.key));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.key === ordered[index - 1]?.key) {
      throw new GrowthObservationInvariantError("duplicate-growth-collection-key");
    }
  }
  return ordered.map((entry) => entry.value);
}
function digest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new GrowthObservationInvariantError("invalid-growth-digest");
  }
}
export function normalizeGrowthInvocation(value: GrowthInvocation): GrowthInvocation {
  assertGrowthInvocationShape(value);
  if (!/^[a-f0-9]{40}$/u.test(value.sourceCommit) || !/^[a-f0-9]{40}$/u.test(value.sourceTree)) {
    throw new GrowthObservationInvariantError("invalid-growth-source-identity");
  }
  if ([value.repository, value.tool.version, value.tool.extractorVersion].some((entry) => entry.trim().length === 0)) {
    throw new GrowthObservationInvariantError("empty-growth-tool-or-repository");
  }
  for (const entry of [value.topologyDigest, value.lockDigest, value.toolchainDigest, value.tool.artifactDigest, ...value.artifactDigests]) { digest(entry); }
  return { ...value, tool: { ...value.tool }, artifactDigests: growthUniqueSorted(value.artifactDigests, (entry) => entry) };
}

/** The only growth aggregate normalization. Semantic sequences retain order.
 * Existing v1 compatibility snapshots never pass through this projection.
 */
export function normalizeGrowthObservation(value: GrowthSurfaceObservation): GrowthSurfaceObservation {
  assertGrowthObservationShape(value);
  if ((value.contractRevision as unknown) !== "foundation:sdk-growth:c0:5" || (value.observationVersion as unknown) !== "foundation:sdk-growth:observation:1") {
    throw new GrowthObservationInvariantError("invalid-growth-observation-version");
  }
  const coverage = growthUniqueSorted(value.coverage, (row) => row.packageName).map((row) => {
    const dimensions = growthUniqueSorted(row.dimensions, (entry) => entry.dimension);
    if (dimensions.length !== growthDimensions.length || growthDimensions.some((dimension) => !dimensions.some((entry) => entry.dimension === dimension))) {
      throw new GrowthObservationInvariantError("incomplete-growth-coverage-structure");
    }
    return { ...row, dimensions: dimensions.map((entry) => {
      if (entry.reasons.some((reason) => reason.trim().length === 0) || (entry.status !== "complete" && entry.reasons.length === 0)) {
        throw new GrowthObservationInvariantError("missing-growth-coverage-reason");
      }
      if (entry.dimension === "decision" && entry.status !== "unavailable") {
        throw new GrowthObservationInvariantError("s1-decision-evidence-unavailable");
      }
      return { ...entry, reasons: growthUniqueSorted(entry.reasons, (reason) => reason) };
    }) };
  });
  const entries = growthUniqueSorted(value.entries, (entry) => growthCanonicalJson(entry.coordinate));
  for (const entry of entries) {
    if (!coverage.some((row) => row.packageName === entry.coordinate.packageName)) {
      throw new GrowthObservationInvariantError("growth-entry-package-outside-topology");
    }
    if (entry.value.state === "present") { digest(entry.value.digest); }
    for (const step of entry.coordinate.resolutionBranch) {
      if ("index" in step && (!Number.isSafeInteger(step.index) || step.index < 0)) {
        throw new GrowthObservationInvariantError("invalid-growth-fallback-index");
      }
    }
  }
  return { ...value, ...normalizeGrowthInvocation({ repository: value.repository, sourceCommit: value.sourceCommit, sourceTree: value.sourceTree, topologyDigest: value.topologyDigest, lockDigest: value.lockDigest, toolchainDigest: value.toolchainDigest, artifactDigests: value.artifactDigests, tool: value.tool }), coverage, entries };
}

export function growthObservationDigest(value: GrowthSurfaceObservation, fingerprint: ChangeFingerprint): GrowthDigest {
  const payload = normalizeGrowthObservation(value);
  const result = `sha256:${fingerprint.sha256(growthCanonicalJson({ domain: "foundation:sdk-growth:observation:1", payload }))}` as const;
  digest(result);
  return result;
}

/** Raw UTF-16 ordering, with no locale or Unicode normalization (C0). */
export function compareGrowthStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Growth accepts canonical text without rewriting retained v1 strings. */
function serializeGrowthValue(value: unknown, ancestors: Set<object>): string {
  if (typeof value === "string" && value.normalize("NFC") !== value) { throw new GrowthObservationUnavailableError("growth-canonical-value-unsupported"); }
  if (value === null || typeof value === "boolean" || typeof value === "string") { return JSON.stringify(value); }
  if (typeof value === "number" && Number.isSafeInteger(value)) { return JSON.stringify(value); }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new GrowthObservationUnavailableError("growth-canonical-value-unsupported");
  }
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new GrowthObservationUnavailableError("growth-canonical-value-unsupported");
  }
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value).filter((key) => !array || key !== "length");
    if (array && keys.length !== value.length) { throw new GrowthObservationUnavailableError("growth-canonical-value-unsupported"); }
    const ordered = array ? Array.from({ length: value.length }, (_, index) => String(index)) : keys.toSorted((a, b) => compareGrowthStrings(String(a), String(b)));
    const entries = ordered.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || key.normalize("NFC") !== key || descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new GrowthObservationUnavailableError("growth-canonical-value-unsupported");
      }
      const item = serializeGrowthValue(descriptor.value, ancestors);
      return array ? item : `${JSON.stringify(key)}:${item}`;
    });
    return array ? `[${entries.join(",")}]` : `{${entries.join(",")}}`;
  } finally { ancestors.delete(value); }
}
