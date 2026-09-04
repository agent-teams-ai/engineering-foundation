import { createHash } from "node:crypto";

import {
  QUALIFIED_DOCS_COHORT_V2_PACKAGES
} from "../consumer-integration/composition/qualification-v3-boundary.js";
import { observeDocsProtocolQualificationV3Lockfile } from "./qualification-v3-observer.js";
import type {
  DocsProtocolQualificationCheckV3,
  DocsProtocolQualificationEvidenceV3,
  DocsProtocolQualificationReceiptV3,
  DocsProtocolQualificationV3Request
} from "./v3-contract.js";

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

/**
 * Admits only explicit profile-v3 evidence for the closed five-package Cohort v2.
 * Collection/execution belongs to the disposable public-registry canary lane.
 */
export function runDocsProtocolQualificationV3(
  request: DocsProtocolQualificationV3Request
): DocsProtocolQualificationReceiptV3 {
  const lockfileObservation = observeDocsProtocolQualificationV3Lockfile(request);
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
}
