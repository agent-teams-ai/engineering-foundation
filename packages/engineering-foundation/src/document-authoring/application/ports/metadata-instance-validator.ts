import type { DocumentAuthorityEvidence } from "../model/document-catalog.js";

export interface MetadataValidationResult {
  readonly messages: readonly string[];
  readonly valid: boolean;
}

export interface MetadataSchemaSnapshot {
  readonly evidence: DocumentAuthorityEvidence;
  validate(instance: unknown): MetadataValidationResult;
}

export interface MetadataInstanceValidator {
  load(request: {
    readonly consumerRoot: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<MetadataSchemaSnapshot>;
}
