export const FOUNDATION_SCHEMA_IDS = [
  "architecture-source-dependencies/v1",
  "architecture-source-dependencies/v2",
  "contract-json-schema-release-baseline/v1",
  "contract-json-schema-releases/v1",
  "contract-protobuf-evolution-baseline/v1",
  "contract-protobuf-evolution/v1",
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
  "repository-security-baseline/v1",
  "workspace-dependency-declarations/v1"
] as const;

export type FoundationSchemaId = (typeof FOUNDATION_SCHEMA_IDS)[number];
