import { createHash } from "node:crypto";

// Markdown observation decodes valid UTF-8 fatally and preserves the BOM.
// Its source is unmodified: UTF-8 encoding preserves the observed raw bytes,
// including CRLF and non-ASCII text. Never reread a file to authorize a
// classification of a different observation.
export function digestMarkdownSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
