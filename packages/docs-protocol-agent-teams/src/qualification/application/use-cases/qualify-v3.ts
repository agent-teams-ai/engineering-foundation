
import { createHash } from "node:crypto";

import {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES,
  type PackedManagedRuntimePolicy,
  type UnselectedCohortV3,
  assertPlainBoundedJson,
  assertConsumerIntegrationDesiredStateV3,
  assertManagedSuccessorProfileV4,
  bindUnselectedCohortV3
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
const MAXIMUM_LOCKFILE_BYTES = 32 * 1024 * 1024;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer"
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength"
)?.get;
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

function freezeJson(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) {
      freezeJson(entry);
    }
    Object.freeze(value);
  }
}

function assertQualificationRequestRoot(request: object): void {
  const prototype: unknown = Object.getPrototypeOf(request);
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if ((prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(request).length > 0 ||
    !hasExactKeys(descriptors, ["profile", "evidence", "lockfileBytes"])) {
    throw new TypeError("Qualification request must be stable plain JSON data with lockfile bytes.");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError("Qualification request must be stable plain JSON data with lockfile bytes.");
    }
  }
}

function isAdmittedNativeLockfileBytes(value: unknown): value is Uint8Array {
  try {
    if (typeof value !== "object" || value === null ||
      !(value instanceof Uint8Array) ||
      typeof TYPED_ARRAY_BUFFER_GETTER !== "function" ||
      typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function" ||
      typeof ARRAY_BUFFER_BYTE_LENGTH_GETTER !== "function") {
      return false;
    }
    const viewByteLength = Number(Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []));
    const backing = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (backing === null || typeof backing !== "object") {
      return false;
    }
    const backingByteLength = Number(Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH_GETTER, backing, []));
    return Number.isSafeInteger(viewByteLength) && Number.isSafeInteger(backingByteLength) &&
      viewByteLength >= 1 && backingByteLength >= 1 &&
      viewByteLength <= MAXIMUM_LOCKFILE_BYTES && backingByteLength <= MAXIMUM_LOCKFILE_BYTES;
  } catch {
    return false;
  }
}

function snapshotQualificationRequest<
  Request extends DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
>(request: Request): Request {
  try {
    assertQualificationRequestRoot(request);
  } catch {
    throw new TypeError("Qualification request must be stable plain JSON data with lockfile bytes.");
  }
  const { profile, evidence, lockfileBytes } = request;
  assertPlainBoundedJson(profile);
  assertPlainBoundedJson(evidence);
  if (!isAdmittedNativeLockfileBytes(lockfileBytes)) {
    throw new TypeError(`Qualification v3 lockfile must contain 1..${MAXIMUM_LOCKFILE_BYTES} bytes.`);
  }
  let snapshot: Request;
  try {
    snapshot = structuredClone(request);
  } catch {
    throw new TypeError("Qualification request must be stable plain JSON data with lockfile bytes.");
  }
  freezeJson(snapshot.profile);
  freezeJson(snapshot.evidence);
  return Object.freeze(snapshot);
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

function assertCohortEvidenceShape(value: unknown): value is DocsProtocolQualificationCohortEvidenceV3 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return false;}
  const evidence = value as DocsProtocolQualificationCohortEvidenceV3;
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
    typeof evidence.cohort.cohortId !== "string" ||
    !NONZERO_SHA256.test(evidence.cohort.recordDigest) ||
    !NONZERO_SHA256.test(evidence.cohort.qualificationEventDigest) ||
    !NONZERO_SHA256.test(evidence.cohort.candidateDigest) ||
    !NONZERO_SHA256.test(evidence.policy.sourceDigest) ||
    !NONZERO_SHA256.test(evidence.runtime.runtimeClosureDigest)) {
    return false;
  }
  return QUALIFIED_DOCS_COHORT_V2_PACKAGES.every(({ key }) =>
    hasExactKeys(evidence.packages[key], ["version", "integrity"]));
}

function isDocsProtocolQualificationCohortV3Request(
  request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
): request is DocsProtocolQualificationCohortV3Request {
  return request.profile.schemaVersion === 4 && assertCohortEvidenceShape(request.evidence);
}

function isDocsProtocolQualificationV3Request(
  request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
): request is DocsProtocolQualificationV3Request {
  return request.profile.schemaVersion === 3;
}

function assertCohortAuthority(
  request: DocsProtocolQualificationCohortV3Request,
  policy: PackedManagedRuntimePolicy
): void {
  assertManagedSuccessorProfileV4(request.profile);
  if (!assertCohortEvidenceShape(request.evidence)) {
    throw new TypeError("Qualification Cohort v3 evidence is invalid or incomplete.");
  }
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
  const { evidence } = request;
  for (const { key, name } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
    const expected = cohort.packages[key];
    const observed = evidence.packages[key];
    if (observed.version !== expected.version) {
      throw new Error(`Qualification Cohort v3 version mismatch for ${name}.`);
    }
    if (observed.integrity !== expected.integrity) {
      throw new Error(`Qualification Cohort v3 integrity mismatch for ${name}.`);
    }
  }
  if (evidence.schemas.consumerIntegration !== 4 ||
    evidence.schemas.managedState !== 3 ||
    evidence.schemas.qualificationReceipt !== 1 ||
    evidence.schemas.docsProtocol !== 1) {
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
      recordDigest: evidence.cohort.recordDigest,
      qualificationEventDigest: evidence.cohort.qualificationEventDigest,
      candidateDigest: evidence.cohort.candidateDigest
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
      sourceDigest: evidence.policy.sourceDigest
    }),
    runtime: Object.freeze({
      selectedLane: evidence.runtime.selectedLane,
      node: evidence.runtime.node,
      pnpm: evidence.runtime.pnpm,
      qualificationRuntime: Object.freeze({ ...evidence.runtime.qualificationRuntime }),
      runtimeClosure: Object.freeze({
        domain: "agent-teams.docs-runtime-closure/v2" as const,
        digest: evidence.runtime.runtimeClosureDigest
      })
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
  observePackedPolicy: () => PackedManagedRuntimePolicy
) {
  return function runDocsProtocolQualificationV3(
    request: DocsProtocolQualificationV3Request | DocsProtocolQualificationCohortV3Request
  ): DocsProtocolQualificationReceiptV3 | DocsProtocolQualificationCohortV3Receipt {
    const admittedRequest = snapshotQualificationRequest(request);
    const generation = typeof admittedRequest.profile === "object" && admittedRequest.profile !== null
      ? admittedRequest.profile.schemaVersion
      : undefined;
    if (generation === 4) {
      if (!isDocsProtocolQualificationCohortV3Request(admittedRequest)) {
        throw new TypeError("Qualification Cohort v3 evidence is invalid or incomplete.");
      }
      assertManagedSuccessorProfileV4(admittedRequest.profile);
      return qualifyCohortV3(
        admittedRequest,
        observeLockfile(admittedRequest),
        observeRuntime(),
        observePackedPolicy()
      );
    }
    assertConsumerIntegrationDesiredStateV3(admittedRequest.profile);
    if (generation !== 3 || !isDocsProtocolQualificationV3Request(admittedRequest)) {
      throw new TypeError("Qualification request generation is invalid or unsupported.");
    }
    const legacyRequest = admittedRequest;
    const lockfileObservation = observeLockfile(legacyRequest);
    assertEvidenceShape(legacyRequest.evidence);
    const { cohort } = legacyRequest.profile;
    for (const { key, name } of QUALIFIED_DOCS_COHORT_V2_PACKAGES) {
      const expected = cohort.packages[key];
      const observed = legacyRequest.evidence.packages[key];
      if (observed.version !== expected.version) {
        throw new Error(`Qualification v3 version mismatch for ${name}.`);
      }
      if (observed.integrity !== expected.integrity) {
        throw new Error(`Qualification v3 integrity mismatch for ${name}.`);
      }
    }
    if (legacyRequest.evidence.schemas.consumerIntegration !== 3 ||
      legacyRequest.evidence.schemas.managedState !== 2 ||
      legacyRequest.evidence.schemas.docsProtocol !== 1) {
      throw new Error("Qualification v3 requires exact schema bindings 3/2/1.");
    }
    const runtimeClosureDigest = cohort.runtime.runtimeClosureDigest;
    if (legacyRequest.evidence.runtimeClosureDigest !== runtimeClosureDigest) {
      throw new Error("Qualification v3 runtime closure digest mismatch.");
    }
    if (lockfileObservation.runtimeClosureDigest !== runtimeClosureDigest) {
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
      runtime: Object.freeze({ runtimeClosureDigest }),
      checks: CHECKS
    });
    return Object.freeze({ ...body, receiptDigest: digest(body) });
  };
}
