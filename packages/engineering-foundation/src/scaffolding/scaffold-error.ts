import type { ScaffoldDiagnostic } from "./contract/scaffold-contract.js";

export type ScaffoldErrorCode =
  | "SCAFFOLD_APPLY_CONFLICT"
  | "SCAFFOLD_INPUT_INVALID"
  | "SCAFFOLD_PLAN_INVALID"
  | "SCAFFOLD_RECEIPT_INVALID"
  | "SCAFFOLD_RECOVERY_REQUIRED";

export class ScaffoldError extends Error {
  readonly code: ScaffoldErrorCode;
  readonly diagnostics: readonly ScaffoldDiagnostic[];

  constructor(
    code: ScaffoldErrorCode,
    message: string,
    diagnostics: readonly ScaffoldDiagnostic[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScaffoldError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
