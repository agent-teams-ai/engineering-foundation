import { parseDocument } from "yaml";
import type { CompiledOutput, CompiledOutputReader, DecodedCompiledOutput } from "../../application/compiled-output-reader.js";
import { DocsProfileError } from "../../application/profile-policy.js";

export class YamlCompiledOutputReader implements CompiledOutputReader {
  read(output: CompiledOutput): DecodedCompiledOutput {
    if (typeof output.contentBase64 !== "string" || typeof output.digest !== "string" ||
      typeof output.mediaType !== "string" || typeof output.size !== "number") {
      throw new DocsProfileError("Document Plan does not contain one complete compiled output.");
    }
    const content = Buffer.from(output.contentBase64, "base64").toString("utf8");
    const frontmatterEnd = content.startsWith("---\n") ? content.indexOf("\n---\n", 4) : -1;
    if (frontmatterEnd < 0) {throw new DocsProfileError("Compiled document does not contain canonical frontmatter.");}
    const frontmatter = content.slice(4, frontmatterEnd);
    const parsed = parseDocument(frontmatter, { uniqueKeys: true });
    if (parsed.errors.length > 0) {throw new DocsProfileError("Compiled document frontmatter is not valid duplicate-free YAML.");}
    const metadata: unknown = parsed.toJS({ maxAliasCount: 0 });
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      throw new DocsProfileError("Compiled document frontmatter must be one metadata mapping.");
    }
    return Object.freeze({ content, frontmatter, metadata });
  }
}
