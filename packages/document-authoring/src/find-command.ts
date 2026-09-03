import { CapabilityInputError } from "./capability-runtime.js";
import { DocumentAuthoringError } from "./errors.js";
import type {
  DocumentDescriptor,
  DocumentationCatalogDiagnostic
} from "./application/model/document-catalog.js";
import type {
  DocumentFindResult
} from "./application/model/document-find.js";
import { DocumentCatalogError } from "./document-catalog-error.js";

const MAXIMUM_DOCUMENTS = 2_048;
const MAXIMUM_DIAGNOSTICS = 256;

interface CommandDiagnostic {
  readonly message: string;
  readonly phase: "authority" | "input" | "query";
  readonly ruleId: string;
  readonly severity: "error" | "warning";
  readonly subject: string;
}

interface DocumentFindEnvelope {
  readonly command: "docs.find";
  readonly diagnostics: readonly CommandDiagnostic[];
  readonly outcome:
    | "authority-stale"
    | "cancelled"
    | "execution-failure"
    | "invalid-input"
    | "partial"
    | "success";
  readonly result: {
    readonly documents: readonly DocumentDescriptor[];
    readonly kind: "find";
    readonly matches: number;
  };
  readonly schemaVersion: 1;
}

export interface DocumentFindCommandResult {
  readonly envelope: DocumentFindEnvelope;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}

function diagnostic(
  source: DocumentationCatalogDiagnostic,
  phase: CommandDiagnostic["phase"]
): CommandDiagnostic {
  return Object.freeze({
    message: source.message.slice(0, 1_000),
    phase,
    ruleId: source.ruleId,
    severity: source.severity,
    subject: source.subject.slice(0, 512)
  });
}

function boundDiagnostics(
  sources: readonly DocumentationCatalogDiagnostic[]
): readonly CommandDiagnostic[] {
  if (sources.length <= MAXIMUM_DIAGNOSTICS) {
    return Object.freeze(sources.map((source) => diagnostic(source, "query")));
  }
  return Object.freeze([
    ...sources
      .slice(0, MAXIMUM_DIAGNOSTICS - 1)
      .map((source) => diagnostic(source, "query")),
    Object.freeze({
      message: `Catalog returned ${sources.length} diagnostics; JSON output includes the first ${MAXIMUM_DIAGNOSTICS - 1}.`,
      phase: "query" as const,
      ruleId: "document.query.diagnostics-truncated",
      severity: "warning" as const,
      subject: "document.query"
    })
  ]);
}

function envelope(input: {
  readonly diagnostics?: readonly CommandDiagnostic[];
  readonly documents?: readonly DocumentDescriptor[];
  readonly matches?: number;
  readonly outcome: DocumentFindEnvelope["outcome"];
}): DocumentFindEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    command: "docs.find",
    outcome: input.outcome,
    diagnostics: Object.freeze([...(input.diagnostics ?? [])]),
    result: Object.freeze({
      kind: "find",
      matches: input.matches ?? 0,
      documents: Object.freeze([...(input.documents ?? [])])
    })
  });
}

export function documentFindFailure(
  error: unknown
): DocumentFindCommandResult {
  if (
    error instanceof CapabilityInputError &&
    error.problem.code === "EXECUTION_CANCELLED"
  ) {
    return Object.freeze({
      envelope: envelope({
        diagnostics: [
          Object.freeze({
            message: error.problem.message,
            phase: "query",
            ruleId: "document.query.cancelled",
            severity: "error",
            subject: "document.query"
          })
        ],
        outcome: "cancelled"
      }),
      exitCode: 130
    });
  }
  if (error instanceof CapabilityInputError) {
    return Object.freeze({
      envelope: envelope({
        diagnostics: [
          Object.freeze({
            message: error.problem.message.slice(0, 1_000),
            phase: "input",
            ruleId: "document.query.invalid-input",
            severity: "error",
            subject: "document.query"
          })
        ],
        outcome: "invalid-input"
      }),
      exitCode: 2
    });
  }
  if (error instanceof DocumentCatalogError) {
    const authorityStale = error.code === "DOCUMENT_CATALOG_AUTHORITY_CHANGED";
    return Object.freeze({
      envelope: envelope({
        diagnostics: [
          Object.freeze({
            message: error.message.slice(0, 1_000),
            phase: authorityStale ? "authority" : "input",
            ruleId: authorityStale
              ? "document.query.authority-stale"
              : "document.query.invalid-input",
            severity: "error",
            subject: "document.query"
          })
        ],
        outcome: authorityStale ? "authority-stale" : "invalid-input"
      }),
      exitCode: authorityStale ? 1 : 2
    });
  }
  if (error instanceof DocumentAuthoringError && error.code === "CONSUMER_INVALID") {
    return Object.freeze({
      envelope: envelope({
        diagnostics: [
          Object.freeze({
            message: error.message.slice(0, 1_000),
            phase: "input",
            ruleId: "document.query.invalid-input",
            severity: "error",
            subject: "document.query"
          })
        ],
        outcome: "invalid-input"
      }),
      exitCode: 2
    });
  }
  return Object.freeze({
    envelope: envelope({
      diagnostics: [
        Object.freeze({
          message: (error instanceof Error ? error.message : String(error)).slice(
            0,
            1_000
          ),
          phase: "query",
          ruleId: "document.query.execution-failure",
          severity: "error",
          subject: "document.query"
        })
      ],
      outcome: "execution-failure"
    }),
    exitCode: 3
  });
}

export function documentFindSuccess(
  result: DocumentFindResult
): DocumentFindCommandResult {
  const partial = result.catalogStatus === "partial";
  return Object.freeze({
    envelope: envelope({
      diagnostics: boundDiagnostics(result.diagnostics),
      documents: result.documents.slice(0, MAXIMUM_DOCUMENTS),
      matches: result.matches,
      outcome: partial ? "partial" : "success"
    }),
    exitCode: partial ? 1 : 0
  });
}
