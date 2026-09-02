import type { DocumentJsonValue } from "@agent-teams/document-authoring";
import { parseDocument } from "yaml";

import type { DocsCodeAnchor } from "../domain/model.js";
import type { DocsCompiledDocumentV1, DocumentAuthoringPortV2 } from "../domain/model-v2.js";
import { DocsProfileError } from "../domain/profile-policy.js";

export function compiledDocument(
  plan: Awaited<ReturnType<DocumentAuthoringPortV2["plan"]>>,
  input: {
    readonly anchors: readonly DocsCodeAnchor[];
    readonly blockedBy: readonly string[];
    readonly initialStatus: string;
    readonly metadata?: Readonly<Record<string, DocumentJsonValue>>;
    readonly related: readonly string[];
  }
): DocsCompiledDocumentV1 {
  if (typeof plan.output.contentBase64 !== "string" || typeof plan.output.digest !== "string" ||
    typeof plan.output.mediaType !== "string" || typeof plan.output.size !== "number") {
    throw new DocsProfileError("Document Plan does not contain one complete compiled output.");
  }
  const content = Buffer.from(plan.output.contentBase64, "base64").toString("utf8");
  const frontmatterEnd = content.startsWith("---\n") ? content.indexOf("\n---\n", 4) : -1;
  if (frontmatterEnd < 0) {throw new DocsProfileError("Compiled document does not contain canonical frontmatter.");}
  const frontmatter = content.slice(4, frontmatterEnd);
  const parsed = parseDocument(frontmatter, { uniqueKeys: true });
  if (parsed.errors.length > 0) {throw new DocsProfileError("Compiled document frontmatter is not valid duplicate-free YAML.");}
  const metadata = parsed.toJS({ maxAliasCount: 0 });
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new DocsProfileError("Compiled document frontmatter must be one metadata mapping.");
  }
  return Object.freeze({
    schemaVersion: 1,
    document: Object.freeze({ content, digest: plan.output.digest, mediaType: plan.output.mediaType, size: plan.output.size }),
    frontmatter,
    metadata: Object.freeze({ ...(metadata as Record<string, DocumentJsonValue>) }),
    relations: Object.freeze({ blockedBy: input.blockedBy, related: input.related }),
    anchors: Object.freeze(input.anchors.map((anchor) => Object.freeze({ ...anchor })))
  });
}
