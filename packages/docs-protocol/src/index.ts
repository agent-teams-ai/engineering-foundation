export { renderDocsHumanV2, renderDocsHumanV3, runDocsCli } from "./composition/cli.js";
export {
  docsContextV1,
  docsCheckV2,
  docsDoctorV2,
  docsFindV2,
  docsFindV3,
  docsInfoV2,
  docsNewV2,
  docsProfilePath,
  docsRecoverV2
} from "./composition/node-docs-api.js";
export type { DocsConsumerRequest } from "./composition/node-docs-api.js";
export {
  docsInitApply,
  docsInitPlan,
  docsInitRecover
} from "./composition/node-docs-bootstrap-api.js";
export type {
  DocsInitApplyResult,
  DocsInitApplyRequest,
  DocsInitBarrier,
  DocsInitExecution,
  DocsInitFilePlan,
  DocsInitIssue,
  DocsInitOperationActive,
  DocsInitPlan,
  DocsInitRecovery,
  DocsInitRecoveryRequired,
  DocsInitRequest
} from "./composition/node-docs-bootstrap-api.js";
export {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION
} from "./domain/model.js";
export { validatePortableRepositoryPath } from "./domain/profile-policy.js";
export type {
  DocsCommandOutcome,
  DocsCodeAnchor,
  DocsDiagnostic,
  DocsFindDocument,
  DocsFindQuery,
  DocsNewResult,
  DocsNewRequest,
  DocsTypeProfile,
  ReachabilityAction
} from "./domain/model.js";
export type {
  DocsCommandEnvelopeV2,
  DocsCommandV2,
  DocsCompiledDocumentV1,
  DocsExecutionV2,
  DocsJsonValueV2,
  DocsNewResultV2,
  DocsProtocolProfileV3
} from "./domain/model-v2.js";
export type {
  DocsCommandEnvelopeV3,
  DocsCommandV3,
  DocsContextLimitsV1,
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsContextSelectionV1,
  DocsExecutionV3,
  DocsFindQueryV3,
  DocsFindResultV3
} from "./domain/model-v3.js";
export {
  CommunityContextError,
  CommunityMiniSearchIndex,
  createCommunityMiniSearchIndex,
  projectCommunityLlmsText,
  rankCommunityDocuments
} from "./community/context/index.js";
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
} from "./community/context/index.js";
