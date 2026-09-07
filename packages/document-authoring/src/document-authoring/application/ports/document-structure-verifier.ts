import type { DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";

export interface DocumentStructureDiagnostic {
  readonly ruleId: string;
  readonly message: string;
  readonly subject: string;
}

export interface DocumentStructureVerifier {
  verify(input: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly diagnostics: readonly DocumentStructureDiagnostic[];
    readonly valid: boolean;
  }>;
}
