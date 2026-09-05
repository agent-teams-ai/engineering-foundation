import type { DiagnosticSeverity } from "../../../features/validation-reporting/api.js";
import { createUniqueRegistry } from "../../../features/validation-reporting/api.js";

export interface JsonSchemaReleaseRuleMetadata {
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly rationale: string;
  readonly remediation: string;
  readonly documentation: string;
  readonly requiresArchitectureReview: boolean;
}

function rule(
  suffix: string,
  rationale: string,
  remediation: string,
  requiresArchitectureReview = false
): JsonSchemaReleaseRuleMetadata {
  return Object.freeze({
    id: `contract.json-schema-releases.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/executable-capabilities.md",
    requiresArchitectureReview
  });
}

export const JSON_SCHEMA_RELEASE_RULES = Object.freeze({
  consumerEvidenceIncomplete: rule(
    "consumer-evidence-incomplete",
    "Every supported consumer must prove compatibility with the current fixture corpus.",
    "Run the consumer conformance suite and attach deterministic evidence for each supported consumer."
  ),
  fixtureExpectationFailed: rule(
    "fixture-expectation-failed",
    "A positive or negative fixture no longer has its declared validation outcome.",
    "Fix the schema or update the release version and its reviewed fixture corpus."
  ),
  immutableVersionMutated: rule(
    "immutable-version-mutated",
    "A published JSON Schema contract version cannot change its canonical schema set.",
    "Publish a new public contract version instead of mutating released schema content.",
    true
  ),
  publicVersionRegressed: rule(
    "public-version-regressed",
    "A public contract version cannot move backwards from its released baseline.",
    "Use an exact semantic version equal to or newer than the released contract version."
  )
});

export const JSON_SCHEMA_RELEASE_RULES_BY_ID: ReadonlyMap<
  string,
  JsonSchemaReleaseRuleMetadata
> = createUniqueRegistry(
  "rule",
  Object.values(JSON_SCHEMA_RELEASE_RULES).map((metadata) => [metadata.id, metadata])
);
