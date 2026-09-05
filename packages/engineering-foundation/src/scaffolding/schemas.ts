// Published schema identities contributed by their semantic owner. Schema bytes stay in schemas/.
export const SCAFFOLDING_SCHEMA_IDS = [
  "scaffold-authority-evidence/v1",
  "scaffold-intent/v1",
  "scaffold-plan/v1",
  "scaffold-receipt/v1",
  "scaffold-recovery-journal/v1",
  "scaffold-target-catalog/v1",
  "scaffolding-config/v1"
] as const;

export const SCAFFOLD_SCHEMA_DEPENDENCIES = {
  "scaffold-recovery-journal/v1": ["scaffold-plan/v1"]
} as const;
