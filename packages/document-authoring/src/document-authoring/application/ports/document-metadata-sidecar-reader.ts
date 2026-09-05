import type {
  DocumentAuthorityEvidence,
  DocumentMetadataObject
} from "../model/document-catalog.js";

export interface DocumentMetadataSidecarSnapshot {
  readonly documents: Readonly<Record<string, DocumentMetadataObject>>;
  readonly evidence: DocumentAuthorityEvidence;
}

export interface DocumentMetadataSidecarReader {
  read(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<DocumentMetadataSidecarSnapshot>;
}
