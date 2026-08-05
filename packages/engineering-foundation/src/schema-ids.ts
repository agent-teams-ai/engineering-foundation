export const FOUNDATION_SCHEMA_IDS = [
  "architecture-source-dependencies/v1",
  "contract-json-schema-release-baseline/v1",
  "contract-json-schema-releases/v1",
  "contract-protobuf-breaking-qualification/v1",
  "contract-protobuf-breaking-qualification/v2",
  "contract-protobuf-evolution-baseline/v1",
  "contract-protobuf-evolution/v1",
  "contract-protobuf-evolution/v2",
  "documentation-local-references/v1",
  "foundation-config/v1",
  "foundation-check-report/v1",
  "governance-architecture-decision-baseline/v1",
  "governance-architecture-decisions/v1",
  "package-public-api-baseline/v1",
  "package-public-api-baseline/v2",
  "package-public-api-compatibility/v1",
  "package-public-api-compatibility/v2",
  "quality-suppression-governance/v1",
  "repository-agent-workflow/v1",
  "repository-security-baseline/v1",
  "scaffold-authority-evidence",
  "scaffold-intent",
  "scaffold-plan",
  "scaffold-receipt",
  "scaffold-recovery-journal",
  "scaffold-target-catalog",
  "scaffolding-config",
  "workspace-dependency-declarations/v1"
] as const;

export type FoundationSchemaId = (typeof FOUNDATION_SCHEMA_IDS)[number];

const INTERNAL_SCAFFOLD_SCHEMA_IDS = [
  "scaffold-intent/v1",
  "scaffold-plan/v1",
  "scaffold-receipt/v1",
  "scaffold-target-catalog/v1",
  "scaffolding-config/v1"
] as const;

type InternalScaffoldSchemaId =
  (typeof INTERNAL_SCAFFOLD_SCHEMA_IDS)[number];

export type FoundationSchemaCatalogId =
  | FoundationSchemaId
  | InternalScaffoldSchemaId;
