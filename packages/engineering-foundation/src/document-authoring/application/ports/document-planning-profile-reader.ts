import type { DocumentPlanningProfileSnapshot } from "../model/document-planning.js";

export interface DocumentPlanningProfileReader {
  read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentPlanningProfileSnapshot>;
}
