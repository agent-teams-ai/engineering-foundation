import { assertDocumentMetadata } from "../domain/document-semantics.js";
import type { DocsCodeAnchor } from "./model.js";
import type { DocsCompiledDocumentV1 } from "./model-v2.js";
import type { CompiledOutput, DecodedCompiledOutput } from "./compiled-output-reader.js";

export function compiledDocument(
  output: CompiledOutput,
  decoded: DecodedCompiledOutput,
  input: {
    readonly anchors: readonly DocsCodeAnchor[];
    readonly blockedBy: readonly string[];
    readonly related: readonly string[];
  }
): DocsCompiledDocumentV1 {
  const { content, frontmatter, metadata } = decoded;
  assertDocumentMetadata(metadata);
  return Object.freeze({
    schemaVersion: 1,
    document: Object.freeze({ content, digest: output.digest, mediaType: output.mediaType, size: output.size }),
    frontmatter,
    metadata: Object.freeze({ ...metadata }),
    relations: Object.freeze({ blockedBy: input.blockedBy, related: input.related }),
    anchors: Object.freeze(input.anchors.map((anchor) => Object.freeze({ ...anchor })))
  });
}
