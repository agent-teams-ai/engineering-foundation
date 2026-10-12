import { createHash } from "node:crypto";

import {
  bindUnselectedCohortV3,
  QUALIFIED_DOCS_COHORT_V2_PACKAGES,
  type PackedManagedRuntimePolicy,
  type UnselectedCohortV3
} from "../../../consumer-integration/application-api.js";
import type {
  DocsProtocolQualificationCohortEvidenceV3,
  DocsProtocolQualificationCohortV3Receipt,
  DocsProtocolQualificationCohortV3Request,
  DocsProtocolQualificationCheckCohortV3,
  DocsProtocolQualificationLockfileObservationV3,
  DocsProtocolQualificationCheckV3,
  DocsProtocolQualificationEvidenceV3,
  DocsProtocolQualificationReceiptV3,
  DocsProtocolQualificationRuntimeObserver,
  DocsProtocolQualificationV3Request
} from "../model/v3-contract.js";

const NONZERO_SHA256 = /^sha256:(?!0{64}$)[0-9a-f]{64}$/u;
const PACKAGE_KEYS = QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key }) => key);
const CHECKS: readonly DocsProtocolQualificationCheckV3[] = Object.freeze([
  "profile-v3",
  "cohort-v2",
  "five-package-closure",
  "exact-package-versions",
  "exact-package-integrities",
  "schema-bindings-3-2-1",
  "runtime-closure-digest"
]);
const COHORT_CHECKS: readonly DocsProtocolQualificationCheckCohortV3[] = Object.freeze([
  "profile-v4",
  "cohort-v3",
  "cohort-assets",
  "five-package-closure",
  "exact-package-versions",
  "exact-package-integrities",
  "schema-bindings-4-3-1-qualification-receipt-1",
  "runtime-closure-digest",
  "policy-identity-source-digest",
  "selected-lane-runtime",
  "observed-node-runtime"
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\u0000") === [...keys].toSorted().join("\u0000");
}

function assertEvidenceShape(evidence: DocsProtocolQualificationEvidenceV3): void {
  if (!hasExactKeys(evidence, ["packages", "schemas", "runtimeClosureDigest"]) ||
    !hasExactKeys(evidence.packages, PACKAGE_KEYS) ||
    !hasExactKeys(evidence.schemas, ["consumerIntegration", "managedState", "docsProtocol"]) ||
    !NONZERO_SHA256.test(evidence.runtimeClosureDigest)) {
    throw new TypeError("Qualification v3 evidence is invalid or incomplete.");
  }
  for (const { key } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
    if (!hasExactKeys(evidence.packages[key], ["version", "integrity"])) {
      throw new TypeError(`Qualification v3 package evidence for ${key} is invalid.`);
    }
  }
}

function assertCohortEvidenceShape(evidence: DocsProtocolQualificationCohortEvidenceV3): void {
  if (!hasExactKeys(evidence, ["cohort", "packages", "schemas", "policy", "runtime"]) ||
    !hasExactKeys(evidence.cohort, ["cohortId", "recordDigest", "qualificationEventDigest", "candidateDigest"]) ||
    !hasExactKeys(evidence.packages, PACKAGE_KEYS) ||
    !hasExactKeys(evidence.schemas, ["consumerIntegration", "managedState", "qualificationReceipt", "docsProtocol"]) ||
    !hasExactKeys(evidence.policy, ["id", "version", "sourceDigest"]) ||
    !hasExactKeys(evidence.runtime, [
      "selectedLane", "node", "pnpm", "qualificationRuntime", "runtimeClosureDigest"
    ]) ||
    !hasExactKeys(evidence.runtime.qualificationRuntime, [
      "nodeVersion", "pnpmVersion", "platform", "architecture"
    ]) ||
    !NONZERO_SHA256.test(evidence.cohort.recordDigest) ||
    !NONZERO_SHA256.test(evidence.cohort.qualificationEventDigest) ||
    !NONZERO_SHA256.test(evidence.cohort.candidateDigest) ||
    !NONZERO_SHA256.test(evidence.policy.sourceDigest) ||
    !NONZERO_SHA256.test(evidence.runtime.runtimeClosureDigest)) {
    throw new TypeError("Qualification Cohort v3 evidence is invalid or incomplete.");
  }
  for (const { key } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
    if (!hasExactKeys(evidence.packages[key], ["version", "integrity"])) {
      throw new TypeError(`Qualification Cohort v3 package evidence for ${key} is invalid.`);
    }
  }
}

function assertCohortAuthority(
  request: DocsProtocolQualificationCohortV3Request,
  policy: PackedManagedRuntimePolicy
): void {
  assertCohortEvidenceShape(request.evidence);
  bindUnselectedCohortV3(request.profile.cohort as UnselectedCohortV3, policy);
  const { cohort } = request.profile;
  const evidence = request.evidence;
  if (evidence.cohort.cohortId !== cohort.cohortId ||
    evidence.cohort.recordDigest !== cohort.recordDigest ||
    evidence.cohort.qualificationEventDigest !== cohort.qualificationEventDigest ||
    evidence.cohort.candidateDigest !== cohort.candidateDigest) {
    throw new Error("Qualification Cohort v3 identity evidence does not match the profile.");
  }
  if (evidence.policy.id !== cohort.runtime.policy.id ||
    evidence.policy.version !== cohort.runtime.policy.version ||
    evidence.policy.sourceDigest !== cohort.runtime.policy.digest) {
    throw new Error("Qualification Cohort v3 policy identity or source digest mismatch.");
  }
  const expectedRuntime = cohort.runtime;
  if (evidence.runtime.selectedLane !== expectedRuntime.selectedLane ||
    evidence.runtime.node !== expectedRuntime.node ||
    evidence.runtime.pnpm !== expectedRuntime.pnpm ||
    canonicalJson(evidence.runtime.qualificationRuntime) !==
      canonicalJson(expectedRuntime.qualificationRuntime)) {
    throw new Error("Qualification Cohort v3 runtime evidence mismatch.");
  }
  if (evidence.runtime.runtimeClosureDigest !== expectedRuntime.runtimeClosure.digest) {
    throw new Error("Qualification Cohort v3 runtime closure digest mismatch.");
  }
}

function qualifyCohortV3(
  request: DocsProtocolQualificationCohortV3Request,
  lockfileObservation: DocsProtocolQualificationLockfileObservationV3,
  observedRuntime: ReturnType<DocsProtocolQualificationRuntimeObserver>,
  policy: PackedManagedRuntimePolicy
): DocsProtocolQualificationCohortV3Receipt {
  assertCohortAuthority(request, policy);
  const { cohort } = request.profile;
  for (const { key, name } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
    const expected = cohort.packages[key];
    const observed = request.evidence.packages[key];
    if (observed.version !== expected.version) {
      throw new Error(`Qualification Cohort v3 version mismatch for ${name}.`);
    }
    if (observed.integrity !== expected.integrity) {
      throw new Error(`Qualification Cohort v3 integrity mismatch for ${name}.`);
    }
  }
  if (request.evidence.schemas.consumerIntegration !== 4 ||
    request.evidence.schemas.managedState !== 3 ||
    request.evidence.schemas.qualificationReceipt !== 1 ||
    request.evidence.schemas.docsProtocol !== 1) {
    throw new Error("Qualification Cohort v3 requires exact schema bindings 4/3/1/qualificationReceipt1.");
  }
  const expectedRuntime = cohort.runtime;
  if (expectedRuntime.selectedLane !== "node-26-managed-qualified" ||
    expectedRuntime.node !== ">=26.0.0 <27" ||
    expectedRuntime.pnpm !== ">=11.17.0 <12" ||
    expectedRuntime.qualificationRuntime.nodeVersion !== "26.11.1" ||
    expectedRuntime.qualificationRuntime.pnpmVersion !== "11.20.0" ||
    expectedRuntime.qualificationRuntime.platform !== "linux" ||
    expectedRuntime.qualificationRuntime.architecture !== "x64") {
    throw new Error("Qualification Cohort v3 requires the exact qualified Node 26 runtime.");
  }
  if (observedRuntime.nodeVersion !== expectedRuntime.qualificationRuntime.nodeVersion ||
    observedRuntime.platform !== expectedRuntime.qualificationRuntime.platform ||
    observedRuntime.architecture !== expectedRuntime.qualificationRuntime.architecture) {
    throw new Error("Qualification Cohort v3 observed Node runtime mismatch.");
  }
  if (lockfileObservation.runtimeClosureDigest !== expectedRuntime.runtimeClosure.digest) {
    throw new Error("Qualification Cohort v3 lockfile runtime closure digest mismatch.");
  }

  const body = Object.freeze({
    schemaVersion: 1 as const,
    namespace: "docs-protocol-cohort-v3-qualification-receipt/v1" as const,
    cohortAdmissible: true as const,
    profileSchemaVersion: 4 as const,
    cohort: Object.freeze({
      schemaVersion: 3 as const,
      cohortId: cohort.cohortId,
      recordDigest: cohort.recordDigest,
      qualificationEventDigest: cohort.qualificationEventDigest,
      candidateDigest: cohort.candidateDigest
    }),
    packages: Object.freeze(QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key, name }) =>
      Object.freeze({ key, name, ...cohort.packages[key] }))),
    schemas: Object.freeze({
      consumerIntegration: 4 as const,
      managedState: 3 as const,
      qualificationReceipt: 1 as const,
      docsProtocol: 1 as const
    }),
    policy: Object.freeze({
      id: cohort.runtime.policy.id,
      version: cohort.runtime.policy.version,
      sourceDigest: cohort.runtime.policy.digest
    }),
    runtime: Object.freeze({
      selectedLane: cohort.runtime.selectedLane,
      node: cohort.runtime.node,
      pnpm: cohort.runtime.pnpm,
      qualificationRuntime: Object.freeze({ ...cohort.runtime.qualificationRuntime }),
      runtimeClosure: Object.freeze({ ...cohort.runtime.runtimeClosure })
    }),
    checks: COHORT_CHECKS
  });
  return Object.freeze({ ...body, receiptDigest: digest(body) });
}

/**
 * Admits only explicit profile-v3 evidence for the closed five-package Cohort v2.
 * Collection/execution belongs to the disposable public-registry canary lane.
 */
export function createDocsProtocolQualificationV3(observeLockfile: (
  request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
) => DocsProtocolQualificationLockfileObservationV3,
  observeRuntime: DocsProtocolQualificationRuntimeObserver,
  policy: PackedManagedRuntimePolicy
) {
  return function runDocsProtocolQualificationV3(
    request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
  ): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt {
    const generation = typeof request.profile === "object" && request.profile !== null
      ? request.profile.schemaVersion
      : undefined;
    if (generation === 4) {
      return qualifyCohortV3(request, observeLockfile(request), observeRuntime(), policy);
    }
    if (generation !== 3) {
      throw new TypeError("Qualification request generation is invalid or unsupported.");
    }
    const lockfileObservation = observeLockfile(request);
    assertEvidenceShape(request.evidence);
    const { cohort } = request.profile;
    for (const { key, name } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
      const expected = cohort.packages[key];
      const observed = request.evidence.packages[key];
      if (observed.version !== expected.version) {
        throw new Error(`Qualification v3 version mismatch for ${name}.`);
      }
      if (observed.integrity !== expected.integrity) {
        throw new Error(`Qualification v3 integrity mismatch for ${name}.`);
      }
    }
    if (request.evidence.schemas.consumerIntegration !== 3 ||
      request.evidence.schemas.managedState !== 2 ||
      request.evidence.schemas.docsProtocol !== 1) {
      throw new Error("Qualification v3 requires exact schema bindings 3/2/1.");
    }
    if (request.evidence.runtimeClosureDigest !== cohort.runtime.runtimeClosureDigest) {
      throw new Error("Qualification v3 runtime closure digest mismatch.");
    }
    if (lockfileObservation.runtimeClosureDigest !== cohort.runtime.runtimeClosureDigest) {
      throw new Error("Qualification v3 lockfile runtime closure digest mismatch.");
    }

    const body = Object.freeze({
      schemaVersion: 3 as const,
      cohortAdmissible: true as const,
      profileSchemaVersion: 3 as const,
      cohort: Object.freeze({
        schemaVersion: 2 as const,
        cohortId: cohort.cohortId,
        recordDigest: cohort.recordDigest,
        qualificationEventDigest: cohort.qualificationEventDigest
      }),
      packages: Object.freeze(QUALIFIED_DOCS_COHORT_V2_PACKAGES.map(({ key, name }) =>
        Object.freeze({ key, name, ...cohort.packages[key] }))),
      schemas: Object.freeze({
        consumerIntegration: 3 as const,
        managedState: 2 as const,
        docsProtocol: 1 as const
      }),
      runtime: Object.freeze({ runtimeClosureDigest: cohort.runtime.runtimeClosureDigest }),
      checks: CHECKS
    });
    return Object.freeze({ ...body, receiptDigest: digest(body) });
  };
}
