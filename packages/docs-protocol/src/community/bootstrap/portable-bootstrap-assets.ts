const MAXIMUM_BOOTSTRAP_FILES = 32;
const SKILL_PATH = ".agents/skills/docs-authoring/SKILL.md";

export const PORTABLE_BOOTSTRAP_BEGIN_MARKER = "<!-- agent-teams:portable-docs:start -->";
export const PORTABLE_BOOTSTRAP_END_MARKER = "<!-- agent-teams:portable-docs:end -->";

export interface PortableBootstrapDesiredFile {
  readonly bytes: Uint8Array;
  readonly ownership: "create-only" | "managed-block";
  readonly path: string;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function docsConfig(): string {
  return `schemaVersion: 3
protocol: {id: agent-teams.docs-protocol, version: 1}
foundationProfile:
  path: .docs-protocol/document-authoring.yaml
  schemaVersion: 3
  metadataSidecarPolicy: foundation-profile-v3-strict-merge
agentWorkflow:
  skillPath: ${SKILL_PATH}
  adoption: portable-v1
semanticValidatorIds: []
`;
}

function artifactType(input: {
  readonly directory: string;
  readonly identity: string;
  readonly template: string;
  readonly type: string;
}): string {
  const reachability = input.type === "adr"
    ? "{kind: manual-fixed-index, indexPath: docs/decisions/README.md}"
    : "{kind: not-required, reason: Deterministic catalog and context projection provide reachability without duplicating manual indexes.}";
  const heading = input.type === "adr" ? "id-colon-title" : "title";
  return `    - type: ${input.type}
      initialStatus: proposed
      identity: ${input.identity}
      placement: {kind: collection, directory: ${input.directory}, filename: ${input.type === "adr" ? "numeric-id-slug" : "slug"}}
      template: {kind: fenced-markdown-body, path: .docs-protocol/templates/${input.template}.md}
      heading: {kind: ${heading}}
      reachability: ${reachability}
      ownerSetId: documentation
`;
}

function documentAuthoringProfile(projectId: string, ownerId: string): string {
  return `schemaVersion: 3
projectId: ${yamlScalar(projectId)}
catalog:
  metadataSchemaPath: .docs-protocol/metadata.schema.json
  ownerCatalog: {path: .docs-protocol/owners.yaml, contract: foundation.owner-map/v1}
  collections:
    - {kind: markdown-tree, root: docs}
  excludedPrefixes: [.docs-protocol]
authoring:
  mode: create-only
  ownerSets:
    schemaVersion: 1
    sets:
      documentation: [${yamlScalar(ownerId)}]
  artifactTypes:
${artifactType({ type: "adr", directory: "docs/decisions", template: "adr", identity: "{kind: explicit, format: adr-four-digits}" })}${artifactType({ type: "tutorial", directory: "docs/tutorials", template: "tutorial", identity: "{kind: explicit, format: qualified, grammar: {prefixSegments: [docs, tutorial], minSuffixSegments: 1, maxSuffixSegments: 16}}" })}${artifactType({ type: "how-to", directory: "docs/how-to", template: "how-to", identity: "{kind: explicit, format: qualified, grammar: {prefixSegments: [docs, how-to], minSuffixSegments: 1, maxSuffixSegments: 16}}" })}${artifactType({ type: "reference", directory: "docs/reference", template: "reference", identity: "{kind: explicit, format: qualified, grammar: {prefixSegments: [docs, reference], minSuffixSegments: 1, maxSuffixSegments: 16}}" })}${artifactType({ type: "explanation", directory: "docs/explanation", template: "explanation", identity: "{kind: explicit, format: qualified, grammar: {prefixSegments: [docs, explanation], minSuffixSegments: 1, maxSuffixSegments: 16}}" })}`;
}

function metadataSchema(ownerId: string): string {
  const commonStatuses = ["proposed", "active", "deprecated", "superseded"];
  const nonAdrTypes = ["tutorial", "how-to", "reference", "explanation", "index"];
  return `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["id", "type", "status", "owner", "summary"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 214 },
      type: { enum: ["adr", "tutorial", "how-to", "reference", "explanation", "index"] },
      status: { type: "string" },
      owner: { const: ownerId },
      summary: { type: "string", minLength: 1, maxLength: 500 },
      related: { type: "array", uniqueItems: true, items: { type: "string" } },
      blocked_by: { type: "array", uniqueItems: true, items: { type: "string" } },
      code_anchors: { type: "array", uniqueItems: true, items: { type: "object" } }
    },
    oneOf: [{
      type: "object",
      required: ["type", "status"],
      properties: {
        type: { const: "adr" },
        status: { enum: [...commonStatuses, "accepted"] }
      }
    }, {
      type: "object",
      required: ["type", "status"],
      properties: {
        type: { enum: nonAdrTypes },
        status: { enum: commonStatuses }
      }
    }]
  }, undefined, 2)}\n`;
}

function template(type: string, title: string, sections: readonly string[]): string {
  return `\`\`\`\`markdown
---
id: REPLACE_ME
type: ${type}
status: proposed
owner: REPLACE_ME
summary: REPLACE_ME
---

# ${title}

${sections.map((section) => `## ${section}\n\nREPLACE_ME`).join("\n\n")}
\`\`\`\`
`;
}

function indexReadme(input: {
  readonly description: string;
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
}): string {
  return `---
id: ${input.id}
type: index
status: active
owner: ${yamlScalar(input.ownerId)}
summary: ${input.description}
---

# ${input.title}

${input.description}

This index describes the category. The deterministic documentation catalog is the source for document discovery, so this file does not duplicate a hand-maintained document list.
`;
}

function skill(): string {
  return `---
name: docs-authoring
description: Create and maintain repository documentation using the portable Docs Protocol layout.
---

# Documentation authoring

Protocol declaration: agent-teams.docs-protocol/v1.

Read \`docs.config.yaml\` and the local authority files before changing documentation.
Choose the Diataxis category matching the reader's need, or use an ADR for a durable decision.

1. Discover existing material with \`docs-protocol find --consumer . --profile docs.config.yaml --text QUERY\`.
2. Preview creation with \`docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --dry-run\`.
3. Apply the reviewed intent with \`docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --apply\`.
4. If the result is \`manual-required\`, add its exact \`markdownLink\` to its exact \`indexPath\` before verification.
5. Refresh bounded agent context with \`docs-protocol context --consumer . --profile docs.config.yaml\`.
6. Verify authorities and documents with \`docs-protocol check --consumer . --profile docs.config.yaml\`.

Start from the matching template in \`.docs-protocol/templates\` and replace every placeholder.
Keep metadata valid against \`.docs-protocol/metadata.schema.json\` and select a declared owner.
Create files only and never overwrite an existing document for a new-document request.
Do not assume a package manager, hosting provider, or repository forge.
`;
}

export function portableBootstrapManagedBlock(eol: string): string {
  return [
    PORTABLE_BOOTSTRAP_BEGIN_MARKER,
    `Use [${SKILL_PATH}](${SKILL_PATH}) for documentation.`,
    PORTABLE_BOOTSTRAP_END_MARKER
  ].join(eol);
}

export function portableBootstrapDesiredFiles(
  projectId: string,
  ownerId: string
): readonly PortableBootstrapDesiredFile[] {
  const textFiles: readonly [string, string][] = [
    ["docs.config.yaml", docsConfig()],
    [".docs-protocol/document-authoring.yaml", documentAuthoringProfile(projectId, ownerId)],
    [".docs-protocol/metadata.schema.json", metadataSchema(ownerId)],
    [".docs-protocol/owners.yaml", `version: 1\nowners:\n  ${yamlScalar(ownerId)}:\n    kind: documentation\n`],
    [".docs-protocol/templates/adr.md", template("adr", "ADR-NNNN: Decision title", ["Context", "Decision", "Consequences"])],
    [".docs-protocol/templates/tutorial.md", template("tutorial", "Tutorial title", ["Goal", "Prerequisites", "Steps", "Next steps"])],
    [".docs-protocol/templates/how-to.md", template("how-to", "How to achieve a goal", ["Before you begin", "Procedure", "Verification"])],
    [".docs-protocol/templates/reference.md", template("reference", "Reference title", ["Overview", "Contract", "Examples"])],
    [".docs-protocol/templates/explanation.md", template("explanation", "Explanation title", ["Context", "Concept", "Trade-offs"])],
    ["docs/README.md", indexReadme({ id: "docs.index", ownerId, title: "Documentation", description: "Use tutorials to learn, how-to guides to complete tasks, reference for exact facts, explanations for understanding, and decision records for architectural choices." })],
    ["docs/decisions/README.md", indexReadme({ id: "docs.decisions.index", ownerId, title: "Architecture decisions", description: "MADR-compatible decision records capture durable architectural choices, their context, and their consequences." })],
    ["docs/tutorials/README.md", indexReadme({ id: "docs.tutorials.index", ownerId, title: "Tutorials", description: "Tutorials are learning-oriented lessons that guide a reader to a successful first result." })],
    ["docs/how-to/README.md", indexReadme({ id: "docs.how-to.index", ownerId, title: "How-to guides", description: "How-to guides are goal-oriented procedures for readers who already understand the basics." })],
    ["docs/reference/README.md", indexReadme({ id: "docs.reference.index", ownerId, title: "Reference", description: "Reference documentation is precise, complete, and organized for lookup." })],
    ["docs/explanation/README.md", indexReadme({ id: "docs.explanation.index", ownerId, title: "Explanation", description: "Explanations build understanding by describing concepts, context, and trade-offs." })],
    [SKILL_PATH, skill()]
  ];
  const files = textFiles.map(([path, source]) => Object.freeze({
    path,
    ownership: "create-only" as const,
    bytes: Buffer.from(source, "utf8")
  }));
  if (files.length + 1 > MAXIMUM_BOOTSTRAP_FILES) {
    throw new TypeError(`Portable bootstrap exceeds ${MAXIMUM_BOOTSTRAP_FILES} files.`);
  }
  return Object.freeze(files);
}
