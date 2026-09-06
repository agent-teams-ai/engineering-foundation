import type { DocumentPlanContract as DocumentPlan } from "../model/document-planning.js";

export type DocumentAuthorityAssessment =
  | { readonly state: "current"; readonly plan: DocumentPlan }
  | { readonly state: "stale"; readonly reason: string }
  | { readonly state: "unverifiable"; readonly reason: string };

export interface DocumentAuthorityRecompiler {
  assess(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentAuthorityAssessment>;
}
