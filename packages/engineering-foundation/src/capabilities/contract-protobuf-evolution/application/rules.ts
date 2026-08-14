import type { DiagnosticSeverity } from "../../../check-contract.js";
import { createUniqueRegistry } from "../../../unique-registry.js";

export interface ProtobufEvolutionRuleMetadata {
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
): ProtobufEvolutionRuleMetadata {
  return Object.freeze({
    id: `contract.protobuf-evolution.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/architecture/executable-capabilities.md",
    requiresArchitectureReview
  });
}

export const PROTOBUF_EVOLUTION_RULES = Object.freeze({
  baselineMismatch: rule(
    "baseline-mismatch",
    "Buf compatibility evidence must be evaluated against the exact released descriptor image.",
    "Use the released descriptor image digest as the Buf breaking baseline."
  ),
  breakingAnalysisMissing: rule(
    "breaking-analysis-missing",
    "A release cannot claim compatibility without a completed Buf breaking analysis.",
    "Run the pinned Buf breaking command against the released descriptor image."
  ),
  breakingChangeNotApproved: rule(
    "breaking-change-not-approved",
    "Breaking Protobuf changes require an explicit architecture decision reference.",
    "Record an approved breaking-change reference before accepting the release.",
    true
  ),
  generationDrift: rule(
    "generation-drift",
    "Generated artifacts must match the output of the declared generator set.",
    "Regenerate artifacts with the pinned generators and commit the resulting output."
  ),
  immutableVersionMutated: rule(
    "immutable-version-mutated",
    "A published Protobuf contract version cannot change its descriptor image or generated output evidence.",
    "Publish a new public contract version instead of mutating released contract artifacts.",
    true
  ),
  publicVersionRegressed: rule(
    "public-version-regressed",
    "A public contract version cannot move backwards from its released baseline.",
    "Use an exact semantic version that is equal to or newer than the released contract version."
  ),
  toolchainMismatch: rule(
    "toolchain-mismatch",
    "Descriptor comparisons are reproducible only when Buf configuration and generator versions match the released evidence.",
    "Review and promote a new released baseline through the controlled contract release workflow.",
    true
  )
});

export const PROTOBUF_EVOLUTION_RULES_BY_ID: ReadonlyMap<
  string,
  ProtobufEvolutionRuleMetadata
> = createUniqueRegistry(
  "rule",
  Object.values(PROTOBUF_EVOLUTION_RULES).map((metadata) => [metadata.id, metadata])
);
