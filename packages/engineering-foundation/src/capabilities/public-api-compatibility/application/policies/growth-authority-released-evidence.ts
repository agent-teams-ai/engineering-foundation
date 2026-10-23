import type {
  GrowthAuthorityOwnerEvidence,
  GrowthAuthorityReleasedEvidence,
} from "../model/growth-authority.js";

import type { PublicApiSnapshot } from "../model/public-api.js";

import { normalizeGrowthObservation } from "./normalize-growth-observation.js";
import {
  array,
  digest,
  exactVersion,
  invalid,
  member,
  object,
  text,
} from "./validate-growth-authority-primitives.js";

export function validateOwnerEvidence(value: unknown): GrowthAuthorityOwnerEvidence {
  const row = object(value, [
    "decisionId",
    "ownerRef",
    "decisionDigest",
    "authenticatedSubjectId",
    "authorizationEvidenceDigest",
    "approvalEvidenceDigest",
    "sourceBindingDigest",
  ]);
  return {
    decisionId: text(row["decisionId"]),
    ownerRef: text(row["ownerRef"]),
    decisionDigest: digest(row["decisionDigest"]),
    authenticatedSubjectId: text(row["authenticatedSubjectId"]),
    authorizationEvidenceDigest: digest(row["authorizationEvidenceDigest"]),
    approvalEvidenceDigest: digest(row["approvalEvidenceDigest"]),
    sourceBindingDigest: digest(row["sourceBindingDigest"]),
  };
}
function validateReleaseEvidence(
  value: unknown,
  packageName: string,
): GrowthAuthorityReleasedEvidence["releaseEvidence"] {
  const declaredBumpInput = member(value, "declaredBump");
  const prereleaseInitialVersionInput = member(value, "prereleaseInitialVersion");
  const prereleaseTagInput = member(value, "prereleaseTag");
  const row = object(value, [
    "packageName",
    "packageVersion",
    ...(declaredBumpInput === undefined ? [] : ["declaredBump"]),
    ...(prereleaseInitialVersionInput === undefined ? [] : ["prereleaseInitialVersion"]),
    ...(prereleaseTagInput === undefined ? [] : ["prereleaseTag"]),
  ]);
  if (row["packageName"] !== packageName) {
    invalid("growth-authority-release-identity-mismatch");
  }
  const declaredBump = row["declaredBump"];
  if (
    declaredBump !== undefined &&
    declaredBump !== "patch" &&
    declaredBump !== "minor" &&
    declaredBump !== "major"
  ) {
    invalid("growth-authority-release-invalid");
  }
  const prereleaseInitialVersion = row["prereleaseInitialVersion"],
    prereleaseTag = row["prereleaseTag"];
  if ((prereleaseInitialVersion === undefined) !== (prereleaseTag === undefined)) {
    invalid("growth-authority-release-invalid");
  }
  return {
    packageName,
    packageVersion: exactVersion(row["packageVersion"]),
    ...(declaredBump === undefined ? {} : { declaredBump }),
    ...(prereleaseInitialVersion === undefined
      ? {}
      : {
          prereleaseInitialVersion: exactVersion(prereleaseInitialVersion),
          prereleaseTag: text(prereleaseTag),
        }),
  };
}
export type ProxyInspection = Readonly<{ isProxy(value: unknown): boolean }>;

function rejectSnapshotProxy(value: unknown, inspection: ProxyInspection, reason: string): void {
  try {
    if (inspection.isProxy(value)) {
      invalid(reason);
    }
  } catch {
    invalid(reason);
  }
}
function snapshotObject(
  value: unknown,
  keys: readonly string[],
  inspection: ProxyInspection,
  reason: string,
): Record<string, unknown> {
  rejectSnapshotProxy(value, inspection, reason);
  return object(value, keys, reason);
}
function snapshotArray(
  value: unknown,
  limit: number,
  inspection: ProxyInspection,
  reason: string,
): readonly unknown[] {
  rejectSnapshotProxy(value, inspection, reason);
  return array(value, limit, reason);
}
function snapshotSignature(value: unknown, reason: string): string {
  if (typeof value !== "string") {
    invalid(reason);
  }
  let length = 0;
  for (const codePoint of value) {
    if (codePoint !== "") {
      length += 1;
    }
    if (length > 10_000) {
      invalid(reason);
    }
  }
  return value;
}
function validatePublicApiSnapshot(value: unknown, inspection: ProxyInspection): PublicApiSnapshot {
  const reason = "growth-authority-release-snapshot-invalid";
  const row = snapshotObject(
    value,
    ["schemaVersion", "packageName", "packageVersion", "extractorVersion", "entrypoints"],
    inspection,
    reason,
  );
  if (row["schemaVersion"] !== 1) {
    invalid(reason);
  }
  const packageName = text(row["packageName"]);
  const entrypoints = snapshotArray(row["entrypoints"], 10_000, inspection, reason).map(
    (entrypointInput) => {
      const entrypoint = snapshotObject(
        entrypointInput,
        ["exportPath", "items"],
        inspection,
        reason,
      );
      const items = snapshotArray(entrypoint["items"], 100_000, inspection, reason).map(
        (itemInput) => {
          rejectSnapshotProxy(itemInput, inspection, reason);
          const parentReference = member(itemInput, "parentReference");
          const item = snapshotObject(
            itemInput,
            [
              "canonicalReference",
              "kind",
              ...(parentReference === undefined ? [] : ["parentReference"]),
              "parentKind",
              "signature",
            ],
            inspection,
            reason,
          );
          return {
            canonicalReference: text(item["canonicalReference"]),
            kind: text(item["kind"]),
            ...(parentReference === undefined ? {} : { parentReference: text(parentReference) }),
            parentKind: text(item["parentKind"]),
            signature: snapshotSignature(item["signature"], reason),
          };
        },
      );
      return { exportPath: text(entrypoint["exportPath"]), items };
    },
  );
  return {
    schemaVersion: 1,
    packageName,
    packageVersion: exactVersion(row["packageVersion"]),
    extractorVersion: text(row["extractorVersion"]),
    entrypoints,
  };
}
export function validateReleased(
  value: unknown,
  repositoryIdentity: string,
  inspection: ProxyInspection,
): GrowthAuthorityReleasedEvidence {
  const observationInput = member(value, "observation");
  const row = object(value, [
    "packageName",
    "releaseEvidence",
    ...(observationInput === undefined ? [] : ["observation"]),
    "evidence",
  ]);
  const packageName = text(row["packageName"]),
    releaseEvidence = validateReleaseEvidence(row["releaseEvidence"], packageName);
  const evidence = row["evidence"],
    kind = member(evidence, "kind");
  if (kind !== "released" && kind !== "initial-unreleased") {
    return invalid("growth-authority-release-kind-invalid");
  }
  const wire = object(
    evidence,
    kind === "released" ? ["kind", "typed", "artifact"] : ["kind", "historyDigest"],
    kind === "released"
      ? "growth-authority-release-snapshot-invalid"
      : "growth-authority-contract-invalid",
  );
  const observation =
    observationInput === undefined
      ? undefined
      : normalizeGrowthObservation(
          observationInput as NonNullable<GrowthAuthorityReleasedEvidence["observation"]>,
        );
  if (observation !== undefined && observation.repository !== repositoryIdentity) {
    invalid("growth-authority-release-repository-mismatch");
  }
  if (wire["kind"] === "released") {
    const typed = validatePublicApiSnapshot(wire["typed"], inspection);
    const artifact = validatePublicApiSnapshot(wire["artifact"], inspection);
    return {
      packageName,
      releaseEvidence,
      ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "released", typed, artifact },
    };
  }
  if (wire["kind"] === "initial-unreleased") {
    return {
      packageName,
      releaseEvidence,
      ...(observation === undefined ? {} : { observation }),
      evidence: { kind: "initial-unreleased", historyDigest: digest(wire["historyDigest"]) },
    };
  }
  return invalid("growth-authority-release-kind-invalid");
}
