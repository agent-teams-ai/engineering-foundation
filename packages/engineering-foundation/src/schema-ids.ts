export const FOUNDATION_SCHEMA_IDS = [
  "architecture-source-dependencies/v1",
  "foundation-config/v1",
  "foundation-check-report/v1",
  "package-public-api-baseline/v1",
  "package-public-api-compatibility/v1",
  "quality-suppression-governance/v1",
  "repository-security-baseline/v1",
  "scaffold-intent/v1",
  "scaffold-plan/v1",
  "scaffold-receipt/v1",
  "scaffold-target-catalog/v1",
  "scaffolding-config/v1",
  "workspace-dependency-declarations/v1"
] as const;

export type FoundationSchemaId = (typeof FOUNDATION_SCHEMA_IDS)[number];
