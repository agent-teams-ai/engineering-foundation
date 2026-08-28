import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsCommandOutcome,
  type DocsDiagnostic,
  type DocsFindDocument,
  type DocsFindQuery
} from "./model.js";
import type { DocsCommandV2, FoundationDocsPortV2 } from "./model-v2.js";

export type DocsCommandV3 = DocsCommandV2 | "docs.context" | "docs.init";

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

export interface DocsFindQueryV3 extends DocsFindQuery {
  readonly ranking?: "binary-default" | "fuzzy-advisory";
}

export interface DocsFindResultV3 {
  readonly kind: "find";
  readonly matches: number;
  readonly documents: readonly DocsFindDocument[];
  readonly ranking?: "fuzzy-advisory";
}

export interface DocsContextRequestV1 {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly query: DocsFindQueryV3;
  readonly limits?: {
    readonly maxBytes?: number;
    readonly maxDocuments?: number;
  };
  readonly signal?: AbortSignal;
}

export interface DocsContextSelectionV1 {
  readonly ranking: "binary-default" | "fuzzy-advisory";
  readonly query: Readonly<Omit<DocsFindQuery, "ranking">>;
}

export interface DocsContextLimitsV1 {
  readonly maxBytes: number;
  readonly maxDocuments: number;
}

export interface DocsContextResultV1 {
  readonly kind: "context";
  readonly format: "llms.txt";
  readonly projectId: string;
  readonly catalogSemanticDigest: `sha256:${string}`;
  readonly selection: DocsContextSelectionV1;
  readonly limits: DocsContextLimitsV1;
  readonly includedDocuments: number;
  readonly omittedDocuments: number;
  readonly truncated: boolean;
  readonly content: string;
}

export interface FoundationDocsFindEvidenceV3 {
  readonly catalogSemanticDigest: `sha256:${string}`;
  readonly catalogStatus: "complete" | "partial";
  readonly diagnostics: readonly {
    readonly message: string;
    readonly ruleId: string;
    readonly severity: "error";
    readonly subject: string;
  }[];
  readonly documents: readonly DocsFindDocument[];
}

export interface FoundationDocsPortV3 extends FoundationDocsPortV2 {
  findWithEvidence(input: Parameters<FoundationDocsPortV2["find"]>[0]): Promise<FoundationDocsFindEvidenceV3>;
}
