import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeFoundationDocsPort } from "../adapters/foundation-docs-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { assertDocsCommandEnvelopeSchema } from "../adapters/docs-command-envelope-schema-validator.js";
import type { DocsExecution, DocsFindQuery, DocsNewRequest, DocsNewResult } from "../domain/model.js";
import type { DocsExecutionV2, DocsNewResultV2 } from "../domain/model-v2.js";

function nodeProtocol(): DocsProtocol {
  return new DocsProtocol({
    adoption: new NodeDocsAdoptionInspector(),
    anchors: new NodeCodeAnchorMatcher(),
    foundation: new NodeFoundationDocsPort(),
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

export function docsInfo(input: DocsConsumerRequest) {
  return verified(nodeProtocol().info(input));
}

export function docsFind(input: DocsConsumerRequest & {
  readonly query: DocsFindQuery;
  readonly signal?: AbortSignal;
}) {
  return verified(nodeProtocol().find(input));
}

export function docsNew(input: DocsNewRequest): Promise<DocsExecution<DocsNewResult>> {
  return verified(nodeProtocol().newDocument(input));
}

export function docsDoctor(input: DocsConsumerRequest) {
  return verified(nodeProtocol().doctor(input));
}

export function docsRecover(input: DocsConsumerRequest & { readonly signal?: AbortSignal }) {
  return verified(nodeProtocol().recover(input));
}

export function docsCheck(input: DocsConsumerRequest) {
  return verified(nodeProtocol().check(input));
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
