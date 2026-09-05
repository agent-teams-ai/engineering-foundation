import type { ValidatedDocumentAuthoringProfileV2, ValidatedDocumentAuthoringProfileV3 } from "./validated-document-authoring-profile.js";
import type { DocumentAuthorityEvidence } from "./document-catalog.js";
import type { MetadataSchemaSnapshot } from "../ports/metadata-instance-validator.js";
import type { OwnerMembershipSnapshot } from "../ports/owner-membership-reader.js";
export interface DescribeDocumentAuthoringProfileV2Request {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export interface DescribeDocumentAuthoringProfileV3Request {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

export type DescriptionRequest =
  | DescribeDocumentAuthoringProfileV2Request
  | DescribeDocumentAuthoringProfileV3Request;

export type ValidatedDescriptionProfile =
  | ValidatedDocumentAuthoringProfileV2
  | ValidatedDocumentAuthoringProfileV3;

export interface LoadedDescriptionAuthority {
  readonly metadata: MetadataSchemaSnapshot;
  readonly ownerCatalog: OwnerMembershipSnapshot;
  readonly profile: ValidatedDescriptionProfile;
  readonly profileEvidence: DocumentAuthorityEvidence;
  readonly sidecarEvidence?: DocumentAuthorityEvidence;
  readonly templateEvidenceByPath: ReadonlyMap<string, DocumentAuthorityEvidence>;
}

