// Published schema identities contributed by their semantic owner. Schema bytes stay in schemas/.
export const TRANSACTION_COORDINATION_SCHEMA_IDS = [
  "foundation-transaction-envelope/v2"
] as const;

// The legacy envelope keeps the exact Foundation 0.21.0 dependency bytes.
export const TRANSACTION_SCHEMA_FILES = {
  "document-plan/v1": "assets/transaction-coordination/historical/document-plan-v1.schema.json"
} as const;

export const TRANSACTION_SCHEMA_DEPENDENCIES = {
  "foundation-transaction-envelope/v2": [
    "document-intent/v1",
    "document-plan/v1",
    "scaffold-plan/v1",
    "scaffold-recovery-journal/v1"
  ]
} as const;
