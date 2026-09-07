import type { DocsProtocol } from "../../portable-documentation/application.js";

export type DocumentationOperations = Pick<DocsProtocol, "infoV2" | "findV2" | "findV3" | "contextV1" | "newDocumentV2" | "doctorV2" | "recoverV2" | "checkV2">;
export type { DocsOperationResult } from "../../portable-documentation/application.js";
export type { DocsCommandV2, DocsCommandV3, DocsCommandOutcome, DocsDiagnostic, DocsFindQuery, DocsFindQueryV3, DocsNewRequest, DocsNewResultV2, DocsContextRequestV1, DocsContextResultV1, DocsFindResultV3 } from "../../portable-documentation/application.js";
export type { DocsInitApi } from "../../portable-bootstrap/application.js";
export { DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION, DocsProfileError } from "../../portable-documentation/domain.js";
export { MINIMUM_COMMUNITY_CONTEXT_BYTES, MAXIMUM_COMMUNITY_CONTEXT_BYTES, MAXIMUM_COMMUNITY_CONTEXT_DOCUMENTS } from "../../portable-documentation/application.js";
