import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJson } from "./pack-test-support.mjs";

export async function writePackedConsumerDocumentAuthoringFixture(consumerRoot) {
  await mkdir(join(consumerRoot, "docs", "catalog"), { recursive: true });
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "document-authoring.yaml"),
    `schemaVersion: 1
projectId: pack-consumer
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs/catalog
  excludedPrefixes: []
authoring:
  mode: create-only
  artifactTypes:
    - type: adr
      initialStatus: proposed
      identity:
        kind: explicit
        format: adr-four-digits
      placement:
        kind: collection
        directory: docs/catalog
        filename: numeric-id-slug
      template:
        kind: fenced-markdown-body
        path: docs/template.md
      heading:
        kind: id-colon-title
      reachability:
        kind: manual-fixed-index
        indexPath: docs/catalog/README.md
`,
    "utf8"
  );
  await writeJson(join(consumerRoot, "docs", "metadata.schema.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["id", "type", "status", "owner", "summary"],
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      status: { type: "string" },
      owner: { type: "string" },
      summary: { type: "string" }
    }
  });
  await writeFile(
    join(consumerRoot, "docs", "owners.yaml"),
    "version: 1\nowners:\n  architecture:\n    kind: architecture\n",
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "docs", "catalog", "guide.md"),
    "---\nid: guide.packaged\ntype: guide\nstatus: active\nowner: architecture\nsummary: Verify the packed document query.\n---\n\n# Packaged Document Query\n\nHermetic search marker.\n",
    "utf8"
  );
}
