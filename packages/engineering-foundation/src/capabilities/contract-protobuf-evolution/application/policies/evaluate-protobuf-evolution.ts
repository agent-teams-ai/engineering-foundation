import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import { isExactVersion, semanticVersionBumpBetween } from "../../../../semantic-version.js";
import type {
  BufGeneratorVersionEvidence,
  CurrentProtobufContractEvidence,
  ProtobufEvolutionPolicy,
  ReleasedProtobufContractEvidence,
  Sha256Digest
} from "../model/protobuf-release-evidence.js";
import {
  PROTOBUF_EVOLUTION_RULES,
  type ProtobufEvolutionRuleMetadata
} from "../rules.js";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTRACT_ID = /^[a-z][a-z0-9.-]{1,119}$/u;

function isPublishedContractVersion(value: string): boolean {
  return isExactVersion(value) && !value.includes("+");
}

function isVersionRegressed(current: string, released: string): boolean {
  return semanticVersionBumpBetween(current, released) !== undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "PROTOBUF_RELEASE_EVIDENCE_INVALID",
    message,
    phase: "protobuf-release-evidence",
    retryable: false
  });
}

function diagnostic(input: {
  readonly rule: ProtobufEvolutionRuleMetadata;
  readonly subject: string;
  readonly message: string;
  readonly evidence?: readonly { readonly kind: string; readonly value: string }[];
}): FoundationDiagnostic {
  return {
    ruleId: input.rule.id,
    severity: input.rule.severity,
    subject: input.subject,
    message: input.message,
    location: { path: input.subject },
    relatedLocations: [],
    evidence: input.evidence ?? [],
    remediation: input.rule.remediation,
    requiresArchitectureReview: input.rule.requiresArchitectureReview
  };
}

function assertDigest(value: unknown, field: string): asserts value is Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    inputError(`${field} must be a lowercase sha256 digest.`);
  }
}

function assertNonEmpty(value: unknown, field: string, maximum = 240): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    inputError(`${field} must be a non-empty printable string.`);
  }
}

function evidenceRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function generatorKey(value: BufGeneratorVersionEvidence): string {
  return `${value.name}\u0000${value.version}`;
}

function assertGeneratorVersions(
  values: unknown,
  field: string
): void {
  if (!Array.isArray(values) || values.length > 100) {
    inputError(`${field} exceeds the supported generator limit.`);
  }
  const candidates: readonly unknown[] = values;
  const keys = candidates.map((candidate, index) => {
    const value = candidate;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      inputError(`${field}[${index}] must be an object.`);
    }
    const generator = value as Record<string, unknown>;
    const name = generator["name"];
    const version = generator["version"];
    assertNonEmpty(name, `${field}[${index}].name`);
    assertNonEmpty(version, `${field}[${index}].version`);
    return generatorKey({ name, version });
  });
  const sorted = keys.toSorted();
  if (
    new Set(keys).size !== keys.length ||
    keys.some((value, index) => value !== sorted[index])
  ) {
    inputError(`${field} must be unique and sorted by name and version.`);
  }
}

function assertGenerationDriftEvidence(value: unknown): void {
  const evidence = evidenceRecord(value, "current.generationDrift");
  assertDigest(
    evidence["expectedGeneratedOutputDigest"],
    "current.generationDrift.expectedGeneratedOutputDigest"
  );
  assertDigest(
    evidence["observedGeneratedOutputDigest"],
    "current.generationDrift.observedGeneratedOutputDigest"
  );
}

function assertBreakingEvidence(value: unknown): void {
  const evidence = evidenceRecord(value, "current.breaking");
  const status = evidence["status"];
  if (status !== "compatible" && status !== "breaking" && status !== "not-run") {
    inputError("Current Protobuf breaking status is invalid.");
  }
  const approvalReference = evidence["approvalReference"];
  if (approvalReference !== undefined) {
    assertNonEmpty(approvalReference, "current.breaking.approvalReference", 240);
  }
  const fingerprint = evidence["fingerprint"];
  if (fingerprint !== undefined) {
    assertDigest(fingerprint, "current.breaking.fingerprint");
  }
  if ((status === "compatible" || status === "breaking") && fingerprint === undefined) {
    inputError("Completed Protobuf breaking evidence requires a deterministic fingerprint.");
  }
  if (status === "not-run" && (fingerprint !== undefined || approvalReference !== undefined)) {
    inputError("Unrun Protobuf breaking evidence cannot contain a fingerprint or approval reference.");
  }
}

function assertReleasedEvidence(evidence: ReleasedProtobufContractEvidence): void {
  if (evidence.schemaVersion !== 1) {
    inputError("Released Protobuf evidence has an unsupported schema version.");
  }
  if (!CONTRACT_ID.test(evidence.contractId)) {
    inputError("Released Protobuf evidence contractId is invalid.");
  }
  if (!isPublishedContractVersion(evidence.publicContractVersion)) {
    inputError("Released Protobuf evidence publicContractVersion must be exact SemVer without build metadata.");
  }
  assertNonEmpty(evidence.bufVersion, "released.bufVersion", 80);
  assertDigest(evidence.bufConfigDigest, "released.bufConfigDigest");
  assertDigest(evidence.descriptorImageDigest, "released.descriptorImageDigest");
  assertDigest(evidence.generatedOutputDigest, "released.generatedOutputDigest");
  assertGeneratorVersions(evidence.generatorVersions, "released.generatorVersions");
}

function assertCurrentEvidence(evidence: CurrentProtobufContractEvidence): void {
  if (evidence.schemaVersion !== 1) {
    inputError("Current Protobuf evidence has an unsupported schema version.");
  }
  if (!CONTRACT_ID.test(evidence.contractId)) {
    inputError("Current Protobuf evidence contractId is invalid.");
  }
  if (!isPublishedContractVersion(evidence.publicContractVersion)) {
    inputError("Current Protobuf evidence publicContractVersion must be exact SemVer without build metadata.");
  }
  assertNonEmpty(evidence.bufVersion, "current.bufVersion", 80);
  assertDigest(evidence.bufConfigDigest, "current.bufConfigDigest");
  assertDigest(evidence.descriptorImageDigest, "current.descriptorImageDigest");
  assertDigest(
    evidence.releasedDescriptorImageDigest,
    "current.releasedDescriptorImageDigest"
  );
  assertGenerationDriftEvidence(evidence.generationDrift);
  assertGeneratorVersions(evidence.generatorVersions, "current.generatorVersions");
  assertBreakingEvidence(evidence.breaking);
}

function generatorVersionsEqual(
  left: readonly BufGeneratorVersionEvidence[],
  right: readonly BufGeneratorVersionEvidence[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (candidate, index) =>
        right[index] !== undefined &&
        candidate.name === right[index].name &&
        candidate.version === right[index].version
    )
  );
}

export function evaluateProtobufEvolution(
  policy: ProtobufEvolutionPolicy
): readonly FoundationDiagnostic[] {
  assertReleasedEvidence(policy.released);
  assertCurrentEvidence(policy.current);
  if (policy.released.contractId !== policy.current.contractId) {
    inputError("Released and current Protobuf evidence must identify the same contract.");
  }

  const subject = policy.current.contractId;
  const diagnostics: FoundationDiagnostic[] = [];
  if (isVersionRegressed(policy.current.publicContractVersion, policy.released.publicContractVersion)) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.publicVersionRegressed,
        subject,
        message: `Current public contract version ${policy.current.publicContractVersion} is older than released ${policy.released.publicContractVersion}.`
      })
    );
  }
  if (
    policy.current.releasedDescriptorImageDigest !== policy.released.descriptorImageDigest
  ) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.baselineMismatch,
        subject,
        message: "Buf breaking evidence does not reference the released descriptor image digest.",
        evidence: [
          { kind: "released-image", value: policy.released.descriptorImageDigest },
          { kind: "observed-baseline-image", value: policy.current.releasedDescriptorImageDigest }
        ]
      })
    );
  }
  if (
    policy.current.publicContractVersion === policy.released.publicContractVersion &&
    (policy.current.descriptorImageDigest !== policy.released.descriptorImageDigest ||
      policy.current.generationDrift.expectedGeneratedOutputDigest !==
        policy.released.generatedOutputDigest)
  ) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.immutableVersionMutated,
        subject,
        message: "Current descriptor or generated output evidence differs from the released evidence for the same public contract version.",
        evidence: [
          { kind: "released-descriptor-image", value: policy.released.descriptorImageDigest },
          { kind: "current-descriptor-image", value: policy.current.descriptorImageDigest },
          { kind: "released-generated-output", value: policy.released.generatedOutputDigest },
          {
            kind: "current-generated-output",
            value: policy.current.generationDrift.expectedGeneratedOutputDigest
          }
        ]
      })
    );
  }
  if (
    policy.current.bufVersion !== policy.released.bufVersion ||
    policy.current.bufConfigDigest !== policy.released.bufConfigDigest ||
    !generatorVersionsEqual(policy.current.generatorVersions, policy.released.generatorVersions)
  ) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.toolchainMismatch,
        subject,
        message: "Current Buf version, configuration digest, or generator versions differ from released evidence."
      })
    );
  }
  if (
    policy.current.generationDrift.expectedGeneratedOutputDigest !==
    policy.current.generationDrift.observedGeneratedOutputDigest
  ) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.generationDrift,
        subject,
        message: "Generated artifact digest differs from the declared generator output digest.",
        evidence: [
          {
            kind: "expected-generated-output",
            value: policy.current.generationDrift.expectedGeneratedOutputDigest
          },
          {
            kind: "observed-generated-output",
            value: policy.current.generationDrift.observedGeneratedOutputDigest
          }
        ]
      })
    );
  }
  if (policy.current.breaking.status === "not-run") {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.breakingAnalysisMissing,
        subject,
        message: "Buf breaking analysis has not completed for this contract evidence."
      })
    );
  }
  if (
    policy.current.breaking.status === "breaking" &&
    policy.current.breaking.approvalReference === undefined
  ) {
    diagnostics.push(
      diagnostic({
        rule: PROTOBUF_EVOLUTION_RULES.breakingChangeNotApproved,
        subject,
        message: "Breaking Buf evidence has no architecture decision reference.",
        evidence:
          policy.current.breaking.fingerprint === undefined
            ? []
            : [{ kind: "breaking-fingerprint", value: policy.current.breaking.fingerprint }]
      })
    );
  }
  return Object.freeze(diagnostics);
}
