import { DocsProtocol } from "../application/docs-protocol.js";
import { NodeDocsAdoptionInspector } from "../adapters/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/node-code-anchor-matcher.js";
import { NodeFoundationDocsPort } from "../adapters/foundation-docs-port.js";
import { NodeDocsProfileReader } from "../adapters/node-profile-reader.js";
import { assertDocsCommandEnvelopeSchema } from "../adapters/docs-command-envelope-schema-validator.js";
import type { DocsExecution, DocsFindQuery, DocsNewRequest, DocsNewResult } from "../domain/model.js";

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
