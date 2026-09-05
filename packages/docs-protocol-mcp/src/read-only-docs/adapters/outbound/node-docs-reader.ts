import { docsContextV1, docsFindV3, docsInfoV2 } from "@agent-teams/docs-protocol";

import type { DocsReader } from "../../application/ports/docs-reader.js";

export class NodeDocsReader implements DocsReader {
  info(input: Parameters<DocsReader["info"]>[0]) {
    return docsInfoV2(input);
  }

  find(input: Parameters<DocsReader["find"]>[0]) {
    return docsFindV3(input);
  }

  context(input: Parameters<DocsReader["context"]>[0]) {
    return docsContextV1(input);
  }
}
