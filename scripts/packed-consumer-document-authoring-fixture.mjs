import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJson } from "./pack-test-support.mjs";

export async function writePackedConsumerDocumentAuthoringFixture(consumerRoot) {
  const manifestPath = join(consumerRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts = {
    ...manifest.scripts,
    "docs:find": "agent-teams-docs find",
    "docs:new": "agent-teams-docs new",
    "docs:doctor": "agent-teams-docs doctor",
    check: "agent-teams-foundation repo check"
  };
  await writeJson(manifestPath, manifest);
  await mkdir(join(consumerRoot, "architecture", "foundation"), { recursive: true });
  await mkdir(join(consumerRoot, ".agents", "skills", "portable-docs"), { recursive: true });
  await mkdir(join(consumerRoot, "docs", "catalog"), { recursive: true });
  await writeFile(
    join(consumerRoot, "docs.config.yaml"),
    `schemaVersion: 3
protocol: {id: agent-teams.docs-protocol, version: 1}
foundationProfile:
  path: architecture/foundation/document-authoring.yaml
  schemaVersion: 3
  metadataSidecarPolicy: foundation-profile-v3-strict-merge
agentWorkflow:
  adoption: portable-v1
  skillPath: .agents/skills/portable-docs/SKILL.md
semanticValidatorIds: []
`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "foundation", "document-authoring.yaml"),
    `schemaVersion: 3
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
      allowedOwnerIds:
        - architecture
`,
    "utf8"
  );
  await writeFile(
    join(consumerRoot, ".agents", "skills", "portable-docs", "SKILL.md"),
    "# Documentation authoring\n\nUse the repository Docs Protocol profile.\n",
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
    join(consumerRoot, "docs", "template.md"),
    "````markdown\n---\nplaceholder: true\n---\n\n# ADR-NNNN: Decision Title\n\n## Context\n\nDescribe the forces.\n\n## Decision\n\nDescribe the decision.\n````\n",
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "docs", "catalog", "guide.md"),
    "---\nid: guide.packaged\ntype: guide\nstatus: active\nowner: architecture\nsummary: Verify the packed document query.\n---\n\n# Packaged Document Query\n\nHermetic search marker.\n",
    "utf8"
  );
}
