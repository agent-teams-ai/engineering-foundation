import type { MarkdownAnchorProfile } from "../../../../documentation-observation/application/model/markdown-document.js";

export interface DocumentationLocalReferencesPolicy {
  readonly anchorProfile: MarkdownAnchorProfile;
  readonly markdownRoots: readonly string[];
}
