/** Schema identities consumed by the scaffolding inbound and persistence adapters. */
export type ScaffoldSchemaValidator = (
  schemaId:
    | "scaffolding-config/v1"
    | "scaffold-intent/v1"
    | "scaffold-target-catalog/v1"
    | "scaffold-authority-evidence/v1"
    | "scaffold-plan/v1"
    | "scaffold-receipt/v1"
    | "scaffold-recovery-journal/v1"
    | "foundation-transaction-envelope/v2",
  input: unknown,
  phase: string
) => Promise<void>;
