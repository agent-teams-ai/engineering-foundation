export {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION
} from "./domain/documentation-model.js";
export type {
  DocsCommandOutcome,
  DocsDiagnostic,
  DocsCodeAnchor,
  DocsFindDocument,
  DocsFindQuery,
  DocsNewResult,
  DocsReceiptOutcome,
  DocsNewRequest,
  DocsTypeProfile,
  ReachabilityAction
} from "./application/model.js";
export type {
  DocsCommandV2,
  DocsCompiledDocumentV1,
  DocsJsonValueV2,
  DocsNewResultV2,
  DocsProtocolProfileV3,
  DocsProtocolProfileV4,
  DocsBlockerPolicy
} from "./application/model-v2.js";
export type {
  DocsCommandV3,
  DocsFindQueryV3,
  DocsContextLimitsV1,
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsContextSelectionV1,
  DocsFindResultV3
} from "./application/model-v3.js";

export {
  validatePortableRepositoryPath,
  validatePortableRepositoryPathV2
} from "./application/profile-policy.js";
export {
  CommunityContextError,
  projectCommunityLlmsText,
  rankCommunityDocuments
} from "./application/context.js";
export type {
  CommunityContextCatalog,
  CommunityContextLimits,
  CommunityLlmsTextInput,
  CommunityLlmsTextProjection,
  CommunityRankedDocument,
  CommunitySearchHit,
  CommunitySearchIndex,
  CommunitySearchRecord,
  EffectiveCommunityContextLimits,
  RankCommunityDocumentsInput
} from "./application/context.js";
export {
  CommunityMiniSearchIndex,
  createCommunityMiniSearchIndex
} from "./adapters/outbound/minisearch-adapter.js";
