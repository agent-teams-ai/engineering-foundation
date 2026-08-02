import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { CapabilityInputError } from "../../../../capability-runtime.js";
import { isExactVersion, semanticVersionBumpBetween } from "../../../../semantic-version.js";
import type {
  JsonSchemaConsumerEvidence,
  JsonSchemaInspection,
  JsonSchemaReleasePolicy,
  JsonSchemaDigest
} from "../model/json-schema-release.js";
import {
  JSON_SCHEMA_RELEASE_RULES,
  type JsonSchemaReleaseRuleMetadata
} from "../rules.js";

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTRACT_ID = /^[a-z][a-z0-9.-]{1,119}$/u;
const CONSUMER_ID = /^[a-z][a-z0-9.-]{1,119}$/u;

function inputError(message: string): never {
  throw new CapabilityInputError({
    code: "JSON_SCHEMA_RELEASE_EVIDENCE_INVALID",
    message,
    phase: "json-schema-release-evidence",
    retryable: false
  });
}

function diagnostic(input: {
  readonly rule: JsonSchemaReleaseRuleMetadata;
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

function assertDigest(value: unknown, field: string): asserts value is JsonSchemaDigest {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    inputError(`${field} must be a lowercase sha256 digest.`);
  }
}

function assertConsumerEvidence(
  values: unknown,
  field: string,
  requirePassingEvidence = false
): void {
  if (!Array.isArray(values) || values.length > 10_000) {
    inputError(`${field} exceeds the supported consumer evidence limit.`);
  }
  const ids = new Set<string>();
  const candidates: readonly unknown[] = values;
  for (const [index, candidate] of candidates.entries()) {
    const item = `${field}[${index}]`;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      inputError(`${item} must be an object.`);
    }
    const value = candidate as Record<string, unknown>;
    const consumerId = value["consumerId"];
    const consumerVersion = value["consumerVersion"];
    const contractVersion = value["contractVersion"];
    const fixtureCorpusDigest = value["fixtureCorpusDigest"];
    const evidenceDigest = value["evidenceDigest"];
    const outcome = value["outcome"];
    if (typeof consumerId !== "string" || !CONSUMER_ID.test(consumerId)) {
      inputError(`${item}.consumerId is invalid.`);
    }
    if (
      typeof consumerVersion !== "string" ||
      typeof contractVersion !== "string" ||
      !isExactVersion(consumerVersion) ||
      !isExactVersion(contractVersion)
    ) {
      inputError(`${item} requires exact consumerVersion and contractVersion.`);
    }
    assertDigest(fixtureCorpusDigest, `${item}.fixtureCorpusDigest`);
    assertDigest(evidenceDigest, `${item}.evidenceDigest`);
    if (outcome !== "passed" && outcome !== "failed") {
      inputError(`${item}.outcome is invalid.`);
    }
    if (requirePassingEvidence && outcome !== "passed") {
      inputError(`${item}.outcome must be passed for released supported consumer evidence.`);
    }
    if (ids.has(consumerId)) {
      inputError(`${field} has duplicate consumer evidence: ${consumerId}.`);
    }
    ids.add(consumerId);
  }
}

function assertPolicy(policy: JsonSchemaReleasePolicy, observation: JsonSchemaInspection): void {
  if (!CONTRACT_ID.test(policy.contractId) || policy.released.contractId !== policy.contractId) {
    inputError("Contract identity must match released JSON Schema evidence.");
  }
  if (
    policy.released.schemaVersion !== 1 ||
    !isExactVersion(policy.publicContractVersion) ||
    !isExactVersion(policy.released.publicContractVersion)
  ) {
    inputError("JSON Schema release evidence requires exact public contract versions.");
  }
  assertDigest(policy.released.schemaSetDigest, "released.schemaSetDigest");
  assertDigest(policy.released.fixtureCorpusDigest, "released.fixtureCorpusDigest");
  assertDigest(observation.schemaSetDigest, "observation.schemaSetDigest");
  assertDigest(observation.fixtureCorpusDigest, "observation.fixtureCorpusDigest");
  assertConsumerEvidence(policy.released.supportedConsumers, "released.supportedConsumers", true);
  assertConsumerEvidence(policy.currentConsumerEvidence, "currentConsumerEvidence");
  if (new Set(policy.schemaPaths).size !== policy.schemaPaths.length) {
    inputError("JSON Schema policy has duplicate schema paths.");
  }
  const fixtureIds = policy.fixtures.map((fixture) => fixture.id);
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    inputError("JSON Schema policy has duplicate fixture IDs.");
  }
}

function matchingCurrentEvidence(
  consumer: JsonSchemaConsumerEvidence,
  current: readonly JsonSchemaConsumerEvidence[]
): JsonSchemaConsumerEvidence | undefined {
  return current.find((candidate) => candidate.consumerId === consumer.consumerId);
}

export function evaluateJsonSchemaRelease(
  policy: JsonSchemaReleasePolicy,
  observation: JsonSchemaInspection
): readonly FoundationDiagnostic[] {
  assertPolicy(policy, observation);
  const diagnostics: FoundationDiagnostic[] = [];
  const subject = policy.contractId;
  if (
    semanticVersionBumpBetween(
      policy.publicContractVersion,
      policy.released.publicContractVersion
    ) !== undefined
  ) {
    diagnostics.push(
      diagnostic({
        rule: JSON_SCHEMA_RELEASE_RULES.publicVersionRegressed,
        subject,
        message: `Current public contract version ${policy.publicContractVersion} is older than released ${policy.released.publicContractVersion}.`
      })
    );
  }
  if (
    policy.publicContractVersion === policy.released.publicContractVersion &&
    observation.schemaSetDigest !== policy.released.schemaSetDigest
  ) {
    diagnostics.push(
      diagnostic({
        rule: JSON_SCHEMA_RELEASE_RULES.immutableVersionMutated,
        subject,
        message: "Current schema digest differs from the released digest for the same public contract version.",
        evidence: [
          { kind: "released-schema-digest", value: policy.released.schemaSetDigest },
          { kind: "current-schema-digest", value: observation.schemaSetDigest }
        ]
      })
    );
  }
  for (const fixture of observation.fixtureResults) {
    if (!fixture.matched) {
      diagnostics.push(
        diagnostic({
          rule: JSON_SCHEMA_RELEASE_RULES.fixtureExpectationFailed,
          subject: fixture.id,
          message: `Fixture ${fixture.id} did not produce its declared ${fixture.expectation} result.`
        })
      );
    }
  }
  for (const required of policy.released.supportedConsumers.toSorted((left, right) =>
    left.consumerId.localeCompare(right.consumerId)
  )) {
    const current = matchingCurrentEvidence(required, policy.currentConsumerEvidence);
    if (
      current === undefined ||
      current.outcome !== "passed" ||
      current.contractVersion !== policy.publicContractVersion ||
      current.fixtureCorpusDigest !== observation.fixtureCorpusDigest
    ) {
      diagnostics.push(
        diagnostic({
          rule: JSON_SCHEMA_RELEASE_RULES.consumerEvidenceIncomplete,
          subject: required.consumerId,
          message: `Supported consumer ${required.consumerId} has no passing evidence for the current contract version and fixture corpus.`
        })
      );
    }
  }
  return Object.freeze(diagnostics);
}
