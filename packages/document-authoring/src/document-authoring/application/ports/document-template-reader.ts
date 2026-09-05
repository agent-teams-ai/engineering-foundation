import type { DocumentTemplateSnapshot } from "../model/document-planning.js";

export interface DocumentTemplateReader {
  read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentTemplateSnapshot>;
}
