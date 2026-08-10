import type { DiagnosticSeverity } from "../../../check-contract.js";

export interface ExecutableSpecificationRuleMetadata {
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
): ExecutableSpecificationRuleMetadata {
  return Object.freeze({
    id: `quality.executable-specifications.${suffix}`,
    severity: "error",
    rationale,
    remediation,
    documentation: "docs/reference/executable-specifications.md",
    requiresArchitectureReview
  });
}

export const EXECUTABLE_SPECIFICATION_RULES = Object.freeze({
  artifactMissing: rule(
    "artifact-missing",
    "Every declared specification artifact must exist as a contained regular file.",
    "Create the declared artifact or correct the catalog path."
  ),
  documentInvalid: rule(
    "document-invalid",
    "Every JSON specification document must conform to its declared local schema.",
    "Correct the document or its schema binding."
  ),
  gateMissing: rule(
    "gate-missing",
    "Every consumer-owned executable gate must bind to an existing package script.",
    "Declare the package script and keep its catalog binding current."
  ),
  gateNotDistinct: rule(
    "gate-not-distinct",
    "Type generation, property, mutation, and optional state-model gates are independent evidence.",
    "Bind every gate role to a distinct package script.",
    true
  ),
  generatedTypeBindingDuplicate: rule(
    "generated-type-binding-duplicate",
    "A schema and generated output must each have one unambiguous type binding.",
    "Remove duplicate schema or output bindings."
  ),
  pathCollision: rule(
    "path-collision",
    "Generated outputs and executable model artifacts must not collide.",
    "Assign a unique repository path to every generated or executable artifact."
  ),
  schemaBindingUnknown: rule(
    "schema-binding-unknown",
    "Documents and generated types must bind to a schema in the specification's local set.",
    "Use a declared schema $id or add the schema to schemaPaths."
  ),
  specificationIdDuplicate: rule(
    "specification-id-duplicate",
    "Every executable specification must have one unambiguous catalog identity.",
    "Assign a unique normalized ID to every catalog entry."
  )
});

export const EXECUTABLE_SPECIFICATION_RULES_BY_ID: ReadonlyMap<
  string,
  ExecutableSpecificationRuleMetadata
> = new Map(
  Object.values(EXECUTABLE_SPECIFICATION_RULES).map((metadata) => [metadata.id, metadata])
);
