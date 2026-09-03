import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeDocumentAuthoringPort } from "../adapters/document-authoring-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { discoverDocsProfilePath } from "../adapters/node-profile-discovery.js";
import { assertDocsCommandEnvelopeSchema } from "../adapters/docs-command-envelope-schema-validator.js";
import type { DocsFindQuery, DocsNewRequest } from "../domain/model.js";
import type {
  DocsExecutionV2,
  DocsNewResultV2
} from "../domain/model-v2.js";
import type {
  DocsContextRequestV1,
  DocsContextResultV1,
  DocsExecutionV3,
  DocsFindQueryV3,
  DocsFindResultV3
} from "../domain/model-v3.js";

function nodeProtocol(): DocsProtocol {
  return new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeDocumentAuthoringPort(),
    profiles: new NodeDocsProfileReader()
  });
}

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

export function docsInfoV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().infoV2(input));
}

export function docsFindV2(input: DocsConsumerRequest & {
  readonly query: DocsFindQuery;
  readonly signal?: AbortSignal;
}) {
  return verified(nodeProtocol().findV2(input));
}

export function docsFindV3(input: DocsConsumerRequest & {
  readonly query: DocsFindQueryV3;
  readonly signal?: AbortSignal;
}): Promise<DocsExecutionV3<DocsFindResultV3>> {
  return verified(nodeProtocol().findV3(input));
}

export function docsContextV1(input: DocsContextRequestV1): Promise<DocsExecutionV3<DocsContextResultV1>> {
  return verified(nodeProtocol().contextV1(input));
}

export function docsNewV2(input: DocsNewRequest): Promise<DocsExecutionV2<DocsNewResultV2>> {
  return verified(nodeProtocol().newDocumentV2(input));
}

export function docsDoctorV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().doctorV2(input));
}

export function docsRecoverV2(input: DocsConsumerRequest & { readonly signal?: AbortSignal }) {
  return verified(nodeProtocol().recoverV2(input));
}

export function docsCheckV2(input: DocsConsumerRequest) {
  return verified(nodeProtocol().checkV2(input));
}
