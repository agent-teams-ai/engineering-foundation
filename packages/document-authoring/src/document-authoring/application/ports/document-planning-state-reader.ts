import type { DocumentPlanningStateSnapshot } from "../model/document-planning.js";

export interface DocumentPlanningStateReader {
  observe(request: {
    readonly consumerRoot: string;
    readonly destination: string;
    readonly parentPolicy?: "create-missing-real-directories";
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanningStateSnapshot>;
}
