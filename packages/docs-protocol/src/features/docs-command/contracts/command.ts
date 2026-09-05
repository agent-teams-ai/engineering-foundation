import { type DocsCommandOutcome, type DocsDiagnostic, DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION, type DocsCommandV2, type DocsCommandV3 } from "../application/command-operations.js";
export interface DocsCommandEnvelopeV2<Result = unknown> {
  readonly schemaVersion: 2;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly command: DocsCommandV2;
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

export interface DocsExecutionV2<Result> {
  readonly envelope: DocsCommandEnvelopeV2<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}

export interface DocsCommandEnvelopeV3<Result = unknown> {
  readonly schemaVersion: 3;
  readonly protocol: {
    readonly id: typeof DOCS_PROTOCOL_ID;
    readonly version: typeof DOCS_PROTOCOL_VERSION;
  };
  readonly command: DocsCommandV3;
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

export interface DocsExecutionV3<Result> {
  readonly envelope: DocsCommandEnvelopeV3<Result>;
  readonly exitCode: 0 | 1 | 2 | 3 | 130;
}
