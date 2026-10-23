import { createHash } from "node:crypto";
import type {
  JsonRecord,
  ManagedState,
  CohortV2Authority,
  CohortV3Authority,
  Repository,
  QualificationProfileV2,
  QualificationProfileV3,
} from "./public-managed-registry-canary-qualification-types.mts";

export function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function managedState(value: unknown, label: string): ManagedState {
  const state = record(value, label);
  if (!isManagedState(state)) {
    throw new Error(`${label} has an invalid managed-state identity.`);
  }
  return state;
}

function isManagedState(value: unknown): value is ManagedState {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === "number" &&
    typeof value.stateDigest === "string"
  );
}

function withoutStateDigest(value: JsonRecord): JsonRecord {
  const { stateDigest: _stateDigest, ...body } = value;
  return body;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function qualificationProfile(
  cohort: CohortV2Authority,
  repository: Repository,
): QualificationProfileV2 {
  return Object.freeze({
    schemaVersion: 3,
    repository,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  });
}

export function qualificationProfileCohortV3(
  cohort: CohortV3Authority,
  repository: Repository,
): QualificationProfileV3 {
  return Object.freeze({
    schemaVersion: 4,
    repository,
    integrationRoot: ".",
    packageManager: "pnpm",
    profilePath: "architecture/foundation/docs-protocol.yaml",
    skillPath: ".agents/skills/docs-authoring/SKILL.md",
    callerWorkflowPath: ".github/workflows/docs-protocol.yml",
    managedStatePath: "architecture/foundation/docs-protocol-managed-state.json",
    qualification: {
      contractPath: "architecture/foundation/docs-protocol-qualification.json",
      gateCommand: "pnpm docs:protocol:check",
    },
    cohort,
  });
}

export function assertQualificationReceiptDigest(receipt: unknown): void {
  const value = record(receipt, "Qualification receipt");
  if (value.schemaVersion === 1) {
    assertCohortV3QualificationReceiptDigest(value);
    return;
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("Qualification v3 receipt digest is not independently canonical.");
  }
}

export function assertCohortV3QualificationReceiptDigest(receipt: unknown): void {
  const value = record(receipt, "Qualification Cohort v3 receipt");
  if (value.namespace !== "docs-protocol-cohort-v3-qualification-receipt/v1") {
    throw new Error("Qualification Cohort v3 receipt namespace is invalid.");
  }
  const { receiptDigest, ...body } = value;
  if (receiptDigest !== sha256(Buffer.from(canonicalJson(body), "utf8"))) {
    throw new Error("Qualification Cohort v3 receipt digest is not independently canonical.");
  }
}

export function assertCanonicalManagedState(serialization: string): ManagedState {
  if (typeof serialization !== "string" || !serialization.endsWith("\n")) {
    throw new Error("Managed-state v2 serialization is not newline terminated.");
  }
  const state = managedState(JSON.parse(serialization), "Managed state");
  if (serialization !== `${canonicalJson(state)}\n`) {
    throw new Error("Managed-state v2 serialization is not canonical JSON.");
  }
  const body = withoutStateDigest(state);
  if (state.schemaVersion === 3) {
    const expectedV3 = sha256(
      Buffer.from(
        canonicalJson({
          domain: "agent-teams.docs-protocol.managed-state/v3",
          body,
        }),
        "utf8",
      ),
    );
    if (state.stateDigest !== expectedV3) {
      throw new Error("Managed-state v3 stateDigest is invalid.");
    }
    return state;
  }
  const expected = sha256(
    Buffer.from(
      canonicalJson({
        domain: "agent-teams.docs-protocol.managed-state/v2",
        body,
      }),
      "utf8",
    ),
  );
  if (state.stateDigest !== expected) {
    throw new Error("Managed-state v2 stateDigest is invalid.");
  }
  return state;
}
