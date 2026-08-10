import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import type {
  BufBreakingFinding,
  BufBreakingQualificationBinding,
  BufBreakingQualificationEvidence,
  CurrentProtobufContractDeclaration,
  ReleasedProtobufContractEvidence,
  Sha256Digest
} from "./protobuf-release-evidence.js";

export const BUF_QUALIFICATION_PRODUCER_ID =
  "agent-teams-foundation.buf-breaking-qualification" as const;
export const BUF_QUALIFICATION_PRODUCER_VERSION = 1 as const;
export const BUF_QUALIFICATION_SCHEMA_VERSION = 1 as const;
export const BUF_BREAKING_POLICY = "FILE" as const;
export const BUF_FILE_BREAKING_CONFIG_SOURCE =
  '{"version":"v2","modules":[{"path":"."}],"breaking":{"use":["FILE"]}}' as const;

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_FINDINGS = 10_000;

export function bufQualificationInvocationPlan(input: {
  readonly baselineDescriptorPath: string;
  readonly bufConfigPath: string;
  readonly candidateDescriptorPath: string;
  readonly modulePath: string;
}): {
  readonly breakingArguments: readonly string[];
  readonly buildArguments: readonly string[];
} {
  return Object.freeze({
    buildArguments: Object.freeze([
      "build",
      input.modulePath,
      "--config",
      input.bufConfigPath,
      "--disable-symlinks",
      "-o",
      input.candidateDescriptorPath
    ]),
    breakingArguments: Object.freeze([
      "breaking",
      input.candidateDescriptorPath,
      "--against",
      input.baselineDescriptorPath,
      "--config",
      BUF_FILE_BREAKING_CONFIG_SOURCE,
      "--against-config",
      BUF_FILE_BREAKING_CONFIG_SOURCE,
      "--disable-symlinks",
      "--error-format=json"
    ])
  });
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

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "protobuf-buf-qualification-evidence",
    retryable: false
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("BUF_QUALIFICATION_EVIDENCE_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertExactBufFilePolicy(value: unknown): void {
  const config = record(value, "Buf config");
  const breaking = record(config["breaking"], "Buf config breaking");
  if (
    Object.keys(breaking).length !== 1 ||
    !Object.hasOwn(breaking, "use") ||
    !Array.isArray(breaking["use"]) ||
    breaking["use"].length !== 1 ||
    breaking["use"][0] !== BUF_BREAKING_POLICY
  ) {
    inputError(
      "BUF_FILE_POLICY_INVALID",
      "Buf breaking configuration must contain exactly use: [FILE] without exclusions."
    );
  }
}

function string(value: unknown, field: string, maximum = 1000): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      `${field} must be a bounded printable string.`
    );
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      `${field} must be a positive safe integer.`
    );
  }
  return value as number;
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      `${field} must be a lowercase sha256 digest.`
    );
  }
  return value as Sha256Digest;
}

function findingKey(finding: BufBreakingFinding): string {
  return [
    finding.path,
    finding.startLine,
    finding.startColumn,
    finding.endLine,
    finding.endColumn,
    finding.type,
    finding.message
  ].join("\u0000");
}

function mapFinding(value: unknown, index: number): BufBreakingFinding {
  const source = record(value, `result.findings[${index}]`);
  return Object.freeze({
    path: string(source["path"], `result.findings[${index}].path`, 500),
    startLine: integer(source["startLine"], `result.findings[${index}].startLine`),
    startColumn: integer(source["startColumn"], `result.findings[${index}].startColumn`),
    endLine: integer(source["endLine"], `result.findings[${index}].endLine`),
    endColumn: integer(source["endColumn"], `result.findings[${index}].endColumn`),
    type: string(source["type"], `result.findings[${index}].type`, 240),
    message: string(source["message"], `result.findings[${index}].message`, 4000)
  });
}

export function sortAndValidateBufFindings(
  values: readonly BufBreakingFinding[]
): readonly BufBreakingFinding[] {
  if (values.length > MAX_FINDINGS) {
    inputError(
      "BUF_QUALIFICATION_FINDINGS_INVALID",
      `Buf breaking output exceeds the supported ${MAX_FINDINGS} finding limit.`
    );
  }
  const sorted = values.toSorted((left, right) =>
    compareBinaryStrings(findingKey(left), findingKey(right))
  );
  const keys = sorted.map(findingKey);
  if (new Set(keys).size !== keys.length) {
    inputError(
      "BUF_QUALIFICATION_FINDINGS_INVALID",
      "Buf breaking output contains duplicate findings."
    );
  }
  return Object.freeze(sorted.map((finding) => Object.freeze({ ...finding })));
}

export function mapBufBreakingQualificationEvidence(
  value: unknown
): BufBreakingQualificationEvidence {
  const source = record(value, "qualification evidence");
  const result = record(source["result"], "result");
  if (!Array.isArray(result["findings"])) {
    inputError("BUF_QUALIFICATION_EVIDENCE_INVALID", "result.findings must be an array.");
  }
  const mappedFindings = result["findings"].map((finding, index) =>
    mapFinding(finding, index)
  );
  const findings = sortAndValidateBufFindings(mappedFindings);
  if (mappedFindings.some((finding, index) => findingKey(finding) !== findingKey(findings[index]!))) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      "Buf qualification findings must be stored in deterministic order."
    );
  }
  const status = result["status"];
  if (status !== "compatible" && status !== "breaking") {
    inputError("BUF_QUALIFICATION_EVIDENCE_INVALID", "result.status is invalid.");
  }
  if (
    (status === "compatible" && findings.length !== 0) ||
    (status === "breaking" && findings.length === 0)
  ) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      "Buf result status and finding count are inconsistent."
    );
  }
  if (
    source["schemaVersion"] !== BUF_QUALIFICATION_SCHEMA_VERSION ||
    source["producerId"] !== BUF_QUALIFICATION_PRODUCER_ID ||
    source["producerVersion"] !== BUF_QUALIFICATION_PRODUCER_VERSION ||
    source["policy"] !== BUF_BREAKING_POLICY
  ) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_INVALID",
      "Buf qualification producer, schema, or FILE policy is invalid."
    );
  }
  return Object.freeze({
    schemaVersion: BUF_QUALIFICATION_SCHEMA_VERSION,
    producerId: BUF_QUALIFICATION_PRODUCER_ID,
    producerVersion: BUF_QUALIFICATION_PRODUCER_VERSION,
    policy: BUF_BREAKING_POLICY,
    contractId: string(source["contractId"], "contractId", 120),
    bufVersion: string(source["bufVersion"], "bufVersion", 80),
    modulePath: string(source["modulePath"], "modulePath", 300),
    bufConfigPath: string(source["bufConfigPath"], "bufConfigPath", 300),
    evidencePath: string(source["evidencePath"], "evidencePath", 300),
    bufConfigDigest: digest(source["bufConfigDigest"], "bufConfigDigest"),
    baselineDescriptorImagePath: string(
      source["baselineDescriptorImagePath"],
      "baselineDescriptorImagePath",
      300
    ),
    baselineDescriptorImageDigest: digest(
      source["baselineDescriptorImageDigest"],
      "baselineDescriptorImageDigest"
    ),
    candidateDescriptorImageDigest: digest(
      source["candidateDescriptorImageDigest"],
      "candidateDescriptorImageDigest"
    ),
    breakingPolicyConfigDigest: digest(
      source["breakingPolicyConfigDigest"],
      "breakingPolicyConfigDigest"
    ),
    invocationDigest: digest(source["invocationDigest"], "invocationDigest"),
    result: Object.freeze({
      status,
      findings,
      findingSetDigest: digest(result["findingSetDigest"], "result.findingSetDigest"),
      rawOutputDigest: digest(result["rawOutputDigest"], "result.rawOutputDigest")
    }),
    evidenceDigest: digest(source["evidenceDigest"], "evidenceDigest")
  });
}

export function canonicalBufFindingSet(
  findings: readonly BufBreakingFinding[]
): string {
  return JSON.stringify(
    sortAndValidateBufFindings(findings).map((finding) => ({
      path: finding.path,
      startLine: finding.startLine,
      startColumn: finding.startColumn,
      endLine: finding.endLine,
      endColumn: finding.endColumn,
      type: finding.type,
      message: finding.message
    }))
  );
}

export function canonicalBufQualificationInvocation(input: {
  readonly binding: BufBreakingQualificationBinding;
  readonly contractId: string;
  readonly bufVersion: string;
  readonly bufConfigDigest: Sha256Digest;
  readonly baselineDescriptorImageDigest: Sha256Digest;
  readonly candidateDescriptorImageDigest: Sha256Digest;
  readonly breakingPolicyConfigDigest: Sha256Digest;
}): string {
  const invocation = bufQualificationInvocationPlan({
    baselineDescriptorPath: "<baseline-descriptor>",
    bufConfigPath: input.binding.bufConfigPath,
    candidateDescriptorPath: "<candidate-descriptor>",
    modulePath: input.binding.modulePath
  });
  return JSON.stringify({
    schemaVersion: BUF_QUALIFICATION_SCHEMA_VERSION,
    producerId: BUF_QUALIFICATION_PRODUCER_ID,
    producerVersion: BUF_QUALIFICATION_PRODUCER_VERSION,
    policy: BUF_BREAKING_POLICY,
    contractId: input.contractId,
    bufVersion: input.bufVersion,
    modulePath: input.binding.modulePath,
    bufConfigPath: input.binding.bufConfigPath,
    evidencePath: input.binding.evidencePath,
    bufConfigDigest: input.bufConfigDigest,
    baselineDescriptorImagePath: input.binding.releasedDescriptorImagePath,
    baselineDescriptorImageDigest: input.baselineDescriptorImageDigest,
    candidateDescriptorImageDigest: input.candidateDescriptorImageDigest,
    breakingPolicyConfigDigest: input.breakingPolicyConfigDigest,
    buildArguments: invocation.buildArguments,
    breakingArguments: invocation.breakingArguments
  });
}

export function canonicalBufQualificationEvidence(
  evidence: Omit<BufBreakingQualificationEvidence, "evidenceDigest">
): string {
  return JSON.stringify({
    schemaVersion: evidence.schemaVersion,
    producerId: evidence.producerId,
    producerVersion: evidence.producerVersion,
    policy: evidence.policy,
    contractId: evidence.contractId,
    bufVersion: evidence.bufVersion,
    modulePath: evidence.modulePath,
    bufConfigPath: evidence.bufConfigPath,
    evidencePath: evidence.evidencePath,
    bufConfigDigest: evidence.bufConfigDigest,
    baselineDescriptorImagePath: evidence.baselineDescriptorImagePath,
    baselineDescriptorImageDigest: evidence.baselineDescriptorImageDigest,
    candidateDescriptorImageDigest: evidence.candidateDescriptorImageDigest,
    breakingPolicyConfigDigest: evidence.breakingPolicyConfigDigest,
    invocationDigest: evidence.invocationDigest,
    result: {
      status: evidence.result.status,
      findings: sortAndValidateBufFindings(evidence.result.findings).map((finding) => ({
        path: finding.path,
        startLine: finding.startLine,
        startColumn: finding.startColumn,
        endLine: finding.endLine,
        endColumn: finding.endColumn,
        type: finding.type,
        message: finding.message
      })),
      findingSetDigest: evidence.result.findingSetDigest,
      rawOutputDigest: evidence.result.rawOutputDigest
    }
  });
}

export function serializeBufQualificationEvidence(
  evidence: BufBreakingQualificationEvidence
): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

export function qualificationInvocationInput(input: {
  readonly qualification: BufBreakingQualificationBinding;
  readonly current: CurrentProtobufContractDeclaration;
  readonly released: ReleasedProtobufContractEvidence;
  readonly breakingPolicyConfigDigest: Sha256Digest;
}): Parameters<typeof canonicalBufQualificationInvocation>[0] {
  return {
    binding: input.qualification,
    contractId: input.current.contractId,
    bufVersion: input.current.bufVersion,
    bufConfigDigest: input.current.bufConfigDigest,
    baselineDescriptorImageDigest: input.released.descriptorImageDigest,
    candidateDescriptorImageDigest: input.current.descriptorImageDigest,
    breakingPolicyConfigDigest: input.breakingPolicyConfigDigest
  };
}
