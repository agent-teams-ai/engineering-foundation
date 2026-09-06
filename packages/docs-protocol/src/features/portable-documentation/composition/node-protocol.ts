import { DocsProtocol } from "../application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../adapters/outbound/minisearch-adapter.js";
import { NodeDocsAdoptionInspector } from "../adapters/outbound/node-adoption-inspector.js";
import { NodeCodeAnchorMatcher } from "../adapters/outbound/node-code-anchor-matcher.js";
import { NodeDocumentAuthoringPort } from "../adapters/outbound/document-authoring-port.js";
import { NodeDocsProfileReader } from "../adapters/outbound/node-profile-reader.js";

export function createNodeDocsProtocol() {
  return new DocsProtocol({ adoption: new NodeDocsAdoptionInspector(), anchors: new NodeCodeAnchorMatcher(), foundation: new NodeDocumentAuthoringPort(), profiles: new NodeDocsProfileReader(), compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex() });
}
