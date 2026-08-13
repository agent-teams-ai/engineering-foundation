import type { DocumentOwnedTemporary } from "../model/document-transaction.js";
import type { DocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import type { DocumentPlan } from "../model/document-planning.js";

export type DocumentPublicationResult =
  | {
      readonly outcome: "published";
      readonly publicationIdentity: DocumentPhysicalIdentity;
      readonly identityEvidence: "owned-temporary";
    }
  | {
      readonly outcome: "already-satisfied";
      readonly publicationIdentity: DocumentPhysicalIdentity;
    };

export interface DocumentPublisher {
  prepare(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
  }): Promise<DocumentOwnedTemporary>;
  publishPrepared(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<DocumentPublicationResult>;
  completePublication(request: {
    readonly consumerRoot: string;
    readonly plan: DocumentPlan;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<{
    readonly publicationIdentity: DocumentPhysicalIdentity;
  }>;
  removeOwnedTemporary(request: {
    readonly consumerRoot: string;
    readonly signal?: AbortSignal;
    readonly temporary: DocumentOwnedTemporary;
  }): Promise<void>;
}
