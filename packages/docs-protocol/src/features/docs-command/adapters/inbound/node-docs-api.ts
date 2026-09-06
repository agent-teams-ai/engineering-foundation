import { type DocsExecutionV2, type DocsExecutionV3 } from "../../contracts/command.js";
import { type DocsProtocolApi } from "./protocol-api.js";
import { discoverDocsProfilePath } from "../outbound/node-profile-discovery.js";
import { assertDocsCommandEnvelopeSchema } from "../outbound/docs-command-envelope-schema-validator.js";
import { type DocsFindQuery, type DocsNewRequest, type DocsNewResultV2, type DocsContextRequestV1, type DocsContextResultV1, type DocsFindQueryV3, type DocsFindResultV3 } from "../../application/command-operations.js";
async function verified<Result extends { readonly envelope: unknown }>(execution: Promise<Result>): Promise<Result> {
  const resolved = await execution;
  await assertDocsCommandEnvelopeSchema(resolved.envelope);
  return resolved;
}

export interface DocsConsumerRequest {
  readonly consumerRoot: string;
  readonly profilePath: string;
  readonly signal?: AbortSignal;
}

/** Resolves explicit, portable, or legacy profile authority with fail-closed ambiguity. */
export function docsProfilePath(input: {
  readonly consumerRoot: string;
  readonly explicitProfilePath?: string;
}): Promise<string> {
  return discoverDocsProfilePath(input);
}


export function createNodeDocsApi(nodeProtocol: () => DocsProtocolApi) {
function docsInfoV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().infoV2(input));
}

function docsFindV2(input: DocsConsumerRequest & {
  readonly query: DocsFindQuery;
  readonly signal?: AbortSignal;
}) {
  return verified(nodeProtocol().findV2(input));
}

function docsFindV3(input: DocsConsumerRequest & {
  readonly query: DocsFindQueryV3;
  readonly signal?: AbortSignal;
}): Promise<DocsExecutionV3<DocsFindResultV3>> {
  return verified(nodeProtocol().findV3(input));
}

function docsContextV1(input: DocsContextRequestV1): Promise<DocsExecutionV3<DocsContextResultV1>> {
  return verified(nodeProtocol().contextV1(input));
}

function docsNewV2(input: DocsNewRequest): Promise<DocsExecutionV2<DocsNewResultV2>> {
  return verified(nodeProtocol().newDocumentV2(input));
}

function docsDoctorV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().doctorV2(input));
}

function docsRecoverV2(input: DocsConsumerRequest & { readonly signal?: AbortSignal }) {
  return verified(nodeProtocol().recoverV2(input));
}

function docsCheckV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().checkV2(input));
}

return { docsProfilePath, docsInfoV2, docsFindV2, docsFindV3, docsContextV1, docsNewV2, docsDoctorV2, docsRecoverV2, docsCheckV2 };
}
