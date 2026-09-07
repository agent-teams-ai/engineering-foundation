import type { DocumentAuthorityEvidence } from "../model/document-catalog.js";

export interface OwnerMembershipSnapshot {
  readonly evidence: DocumentAuthorityEvidence;
  readonly ids: readonly string[];
}

export interface OwnerMembershipReader {
  read(request: {
    readonly consumerRoot: string;
    readonly contract: "foundation.owner-map/v1";
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<OwnerMembershipSnapshot>;
}
