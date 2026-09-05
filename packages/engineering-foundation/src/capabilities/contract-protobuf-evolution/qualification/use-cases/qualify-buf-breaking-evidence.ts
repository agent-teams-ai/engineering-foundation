import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled, parseStrictYamlSource } from "../../../../strict-yaml.js";
import {
  assertExactBufFilePolicy,
  BUF_BREAKING_POLICY,
  BUF_FILE_BREAKING_CONFIG_SOURCE,
  BUF_QUALIFICATION_PRODUCER_ID,
  BUF_QUALIFICATION_PRODUCER_VERSION,
  BUF_QUALIFICATION_SCHEMA_VERSION,
  canonicalBufFindingSet,
  canonicalBufQualificationEvidence,
  canonicalBufQualificationInvocation,
  qualificationInvocationInput,
  serializeBufQualificationEvidence,
  sortAndValidateBufFindings
} from "../../application/model/buf-breaking-qualification.js";
import type {
  BufBreakingFinding,
  BufBreakingQualificationEvidence,
  ProtobufEvolutionConfiguration
} from "../../application/model/protobuf-release-evidence.js";
import type { Sha256DigestPort } from "../../application/ports/sha256-digest.js";
import type { BufQualificationArtifacts } from "../ports/buf-qualification-artifacts.js";
import type {
  BufQualificationRunner,
  BufQualificationRunResult
} from "../ports/buf-qualification-runner.js";

const MAX_BUF_CONFIG_BYTES = 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export interface QualifyBufBreakingEvidenceResult {
  readonly status: "compatible" | "breaking";
  readonly evidencePath: string;
  readonly evidenceDigest: `sha256:${string}`;
  readonly writeResult: "checked" | "created" | "updated" | "unchanged";
}

interface QualificationInputs {
  readonly baselineDescriptorImage: Uint8Array;
  readonly bufConfigBytes: Uint8Array;
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
    phase: "protobuf-buf-qualification",
    retryable: false
  });
}

function number(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", `${field} must be a positive integer.`);
  }
  return value as number;
}

function string(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", `${field} is invalid.`);
  }
  return value;
}

function parseFinding(line: string, index: number): BufBreakingFinding {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    inputError("BUF_BREAKING_OUTPUT_INVALID", `Buf finding ${index} is not valid JSON.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", `Buf finding ${index} must be an object.`);
  }
  const source = value as Record<string, unknown>;
  const expectedKeys = [
    "end_column",
    "end_line",
    "message",
    "path",
    "start_column",
    "start_line",
    "type"
  ];
  if (
    Object.keys(source).length !== expectedKeys.length ||
    Object.keys(source).toSorted().some((key, keyIndex) => key !== expectedKeys[keyIndex])
  ) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", `Buf finding ${index} has an unsupported shape.`);
  }
  return Object.freeze({
    path: string(source["path"], `finding ${index} path`, 500),
    startLine: number(source["start_line"], `finding ${index} start_line`),
    startColumn: number(source["start_column"], `finding ${index} start_column`),
    endLine: number(source["end_line"], `finding ${index} end_line`),
    endColumn: number(source["end_column"], `finding ${index} end_column`),
    type: string(source["type"], `finding ${index} type`, 240),
    message: string(source["message"], `finding ${index} message`, 4000)
  });
}

function normalizedOutput(source: string): { readonly source: string; readonly findings: readonly BufBreakingFinding[] } {
  if (source.includes("\u0000")) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", "Buf output contains a NUL byte.");
  }
  const unix = source.replace(/\r\n/gu, "\n");
  const withoutTerminalNewline = unix.endsWith("\n") ? unix.slice(0, -1) : unix;
  if (withoutTerminalNewline.endsWith("\n")) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", "Buf output contains blank trailing records.");
  }
  const lines = withoutTerminalNewline.length === 0 ? [] : withoutTerminalNewline.split("\n");
  if (lines.some((line) => line.length === 0)) {
    inputError("BUF_BREAKING_OUTPUT_INVALID", "Buf output contains a blank record.");
  }
  return {
    source: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    findings: sortAndValidateBufFindings(lines.map(parseFinding))
  };
}

async function readQualificationInputs(
  consumerRoot: string,
  configuration: ProtobufEvolutionConfiguration,
  artifacts: BufQualificationArtifacts
): Promise<QualificationInputs> {
  const [bufConfigBytes, baselineDescriptorImage] = await Promise.all([
    artifacts.readInput({
      consumerRoot,
      path: configuration.qualification.bufConfigPath,
      maxBytes: MAX_BUF_CONFIG_BYTES,
      label: "Buf configuration"
    }),
    artifacts.readInput({
      consumerRoot,
      path: configuration.qualification.releasedDescriptorImagePath,
      maxBytes: MAX_DESCRIPTOR_BYTES,
      label: "Released descriptor image"
    })
  ]);
  return { baselineDescriptorImage, bufConfigBytes };
}

function assertFilePolicy(bufConfigBytes: Uint8Array): void {
  assertExactBufFilePolicy(
    parseStrictYamlSource(Buffer.from(bufConfigBytes).toString("utf8"), "protobuf-buf-config")
  );
}

function assertDeclaredInputDigests(
  configuration: ProtobufEvolutionConfiguration,
  observedConfigDigest: string,
  observedBaselineDigest: string
): void {
  if (
    observedConfigDigest !== configuration.current.bufConfigDigest ||
    observedBaselineDigest !== configuration.released.descriptorImageDigest
  ) {
    inputError(
      "BUF_QUALIFICATION_INPUT_DIGEST_MISMATCH",
      "Buf configuration or released descriptor bytes do not match declared digests."
    );
  }
}

function validateExecutionOutput(execution: BufQualificationRunResult): ReturnType<typeof normalizedOutput> {
  const output = normalizedOutput(execution.rawOutput);
  if (
    (execution.status === "compatible" && output.findings.length !== 0) ||
    (execution.status === "breaking" && output.findings.length === 0)
  ) {
    inputError(
      "BUF_BREAKING_OUTPUT_INVALID",
      "Buf exit status and normalized finding set are inconsistent."
    );
  }
  return output;
}

export async function qualifyBufBreakingEvidence(
  input: {
    readonly consumerRoot: string;
    readonly executablePath: string;
    readonly configuration: ProtobufEvolutionConfiguration;
    readonly write: boolean;
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly artifacts: BufQualificationArtifacts;
    readonly digest: Sha256DigestPort;
    readonly runner: BufQualificationRunner;
  }
): Promise<QualifyBufBreakingEvidenceResult> {
  assertNotCancelled(input.signal);
  const { baselineDescriptorImage, bufConfigBytes } = await readQualificationInputs(
    input.consumerRoot,
    input.configuration,
    dependencies.artifacts
  );
  assertNotCancelled(input.signal);
  assertFilePolicy(bufConfigBytes);
  const observedConfigDigest = dependencies.digest.digest(bufConfigBytes);
  const observedBaselineDigest = dependencies.digest.digest(baselineDescriptorImage);
  const breakingPolicyConfigDigest = dependencies.digest.digest(
    BUF_FILE_BREAKING_CONFIG_SOURCE
  );
  assertDeclaredInputDigests(
    input.configuration,
    observedConfigDigest,
    observedBaselineDigest
  );

  const execution = await dependencies.runner.run({
    executablePath: input.executablePath,
    workingDirectory: input.consumerRoot,
    expectedVersion: input.configuration.current.bufVersion,
    modulePath: input.configuration.qualification.modulePath,
    bufConfigPath: input.configuration.qualification.bufConfigPath,
    baselineDescriptorImage,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  assertNotCancelled(input.signal);
  const {
    baselineDescriptorImage: confirmedBaselineDescriptorImage,
    bufConfigBytes: confirmedBufConfigBytes
  } = await readQualificationInputs(
    input.consumerRoot,
    input.configuration,
    dependencies.artifacts
  );
  assertNotCancelled(input.signal);
  assertFilePolicy(confirmedBufConfigBytes);
  if (
    dependencies.digest.digest(confirmedBufConfigBytes) !== observedConfigDigest ||
    dependencies.digest.digest(confirmedBaselineDescriptorImage) !== observedBaselineDigest
  ) {
    inputError(
      "BUF_QUALIFICATION_INPUT_CHANGED",
      "Buf configuration or released descriptor changed while qualification was running."
    );
  }
  const candidateDescriptorImageDigest = dependencies.digest.digest(
    execution.candidateDescriptorImage
  );
  if (candidateDescriptorImageDigest !== input.configuration.current.descriptorImageDigest) {
    inputError(
      "BUF_CANDIDATE_DESCRIPTOR_MISMATCH",
      "Buf candidate descriptor does not match the declared current descriptor digest."
    );
  }
  const output = validateExecutionOutput(execution);

  const invocationDigest = dependencies.digest.digest(
    canonicalBufQualificationInvocation(
      qualificationInvocationInput({
        ...input.configuration,
        breakingPolicyConfigDigest
      })
    )
  );
  const findingSetDigest = dependencies.digest.digest(
    canonicalBufFindingSet(output.findings)
  );
  const evidenceWithoutDigest: Omit<BufBreakingQualificationEvidence, "evidenceDigest"> = {
    schemaVersion: BUF_QUALIFICATION_SCHEMA_VERSION,
    producerId: BUF_QUALIFICATION_PRODUCER_ID,
    producerVersion: BUF_QUALIFICATION_PRODUCER_VERSION,
    policy: BUF_BREAKING_POLICY,
    contractId: input.configuration.current.contractId,
    bufVersion: input.configuration.current.bufVersion,
    modulePath: input.configuration.qualification.modulePath,
    bufConfigPath: input.configuration.qualification.bufConfigPath,
    evidencePath: input.configuration.qualification.evidencePath,
    bufConfigDigest: observedConfigDigest,
    baselineDescriptorImagePath:
      input.configuration.qualification.releasedDescriptorImagePath,
    baselineDescriptorImageDigest: observedBaselineDigest,
    candidateDescriptorImageDigest,
    breakingPolicyConfigDigest,
    invocationDigest,
    result: Object.freeze({
      status: execution.status,
      findings: output.findings,
      findingSetDigest,
      rawOutputDigest: dependencies.digest.digest(output.source)
    })
  };
  const evidence: BufBreakingQualificationEvidence = Object.freeze({
    ...evidenceWithoutDigest,
    evidenceDigest: dependencies.digest.digest(
      canonicalBufQualificationEvidence(evidenceWithoutDigest)
    )
  });
  const source = serializeBufQualificationEvidence(evidence);
  if (Buffer.byteLength(source, "utf8") > MAX_EVIDENCE_BYTES) {
    inputError(
      "BUF_QUALIFICATION_EVIDENCE_TOO_LARGE",
      "Canonical Buf qualification evidence exceeds the supported size limit."
    );
  }
  let writeResult: QualifyBufBreakingEvidenceResult["writeResult"];
  if (input.write) {
    assertNotCancelled(input.signal);
    writeResult = await dependencies.artifacts.writeEvidence({
      consumerRoot: input.consumerRoot,
      path: input.configuration.qualification.evidencePath,
      source,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  } else {
    const existing = await dependencies.artifacts.readExistingEvidence({
      consumerRoot: input.consumerRoot,
      path: input.configuration.qualification.evidencePath,
      maxBytes: MAX_EVIDENCE_BYTES
    });
    if (existing !== source) {
      inputError(
        "BUF_QUALIFICATION_EVIDENCE_MISMATCH",
        "Committed Buf qualification evidence is missing, stale, fabricated, or not canonical. Run the qualifier with --write and review the result."
      );
    }
    writeResult = "checked";
  }
  return Object.freeze({
    status: execution.status,
    evidencePath: input.configuration.qualification.evidencePath,
    evidenceDigest: evidence.evidenceDigest,
    writeResult
  });
}
