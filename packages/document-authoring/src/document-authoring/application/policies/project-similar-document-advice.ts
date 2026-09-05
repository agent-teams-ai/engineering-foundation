import type { DocumentCommandDiagnostic } from "../model/document-command.js";
import type { SimilarDocumentAdvice } from "../ports/similar-document-advisor.js";

export function projectSimilarDocumentAdvice(
  advice: SimilarDocumentAdvice,
): readonly DocumentCommandDiagnostic[] {
  if (advice.matches.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze([Object.freeze({
    ruleId: "document.new.similar-documents",
    severity: "info",
    phase: "planning",
    subject: "document.new",
    message: `${advice.matches.length} existing document(s) contain the exact title query. Review them before publishing if they overlap.`,
    remediation: Object.freeze({
      commandId: "docs.find",
      args: Object.freeze({ text: advice.query }),
    }),
  })]);
}
