import { assertNotCancelled } from "../../cancellation.js";
import { CapabilityInputError } from "../../capability-runtime.js";
import type { DocumentTemplateSnapshot } from "../../application/model/document-planning.js";
import type { DocumentTemplateReader } from "../../application/ports/document-template-reader.js";
import { DocumentCatalogError } from "../../document-catalog-error.js";
import { DocumentPlanningError } from "../../document-planning-error.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";

const MAX_TEMPLATE_BYTES = 256 * 1024;

export class NodeDocumentTemplateReader implements DocumentTemplateReader {
  async read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentTemplateSnapshot> {
    assertNotCancelled(request.signal);
    try {
      const file = await readDocumentAuthorityFile({
        consumerRoot: request.consumerRoot,
        maxBytes: MAX_TEMPLATE_BYTES,
        path: request.path
      });
      assertNotCancelled(request.signal);
      return Object.freeze({ evidence: file.evidence, source: file.source });
    } catch (error) {
      if (error instanceof CapabilityInputError || error instanceof DocumentPlanningError) {
        throw error;
      }
      if (error instanceof DocumentCatalogError) {
        throw new DocumentPlanningError(
          error.code === "DOCUMENT_CATALOG_INPUT_INVALID"
            ? "DOCUMENT_PLANNING_INPUT_INVALID"
            : "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
          `Document template is unavailable or invalid: ${request.path}.`,
          { cause: error }
        );
      }
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
        `Document template is unavailable or invalid: ${request.path}.`,
        { cause: error }
      );
    }
  }
}
