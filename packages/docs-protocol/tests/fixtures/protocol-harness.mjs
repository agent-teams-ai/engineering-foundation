import { DocsProtocol } from "../../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import { createDocsProtocolApi } from "../../dist/features/docs-command/adapters/inbound/protocol-api.js";
import { parseDocsProtocolProfile } from "../../dist/features/portable-documentation/application/profile-policy.js";

export const profile = parseDocsProtocolProfile({
  schemaVersion: 3,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 3, metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: ["documentation.domain-semantics"]
});

export const taskVocabularyProfile = {
  schemaVersion: 4,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 3, metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  relations: { blockers: { types: ["task"], statuses: ["todo"], subjectIncompatibleStatuses: ["done"] } },
  semanticValidatorIds: []
};

export const types = [{
  type: "adr",
  initialStatus: "proposed",
  allowedOwnerIds: ["architecture/tooling"],
  identity: { format: "adr-four-digits" },
  heading: { kind: "id-colon-title" },
  placement: { kind: "collection" },
  requiredMetadata: ["id", "type", "status", "owner", "summary"],
  reachability: { kind: "manual-fixed-index", indexPath: "docs/decisions/README.md" }
}];

export const PROFILE_SEMANTIC_DIGEST = `sha256:${"6".repeat(64)}`;
export const CATALOG_SEMANTIC_DIGEST = `sha256:${"7".repeat(64)}`;

export function descriptor(overrides = {}) {
  return {
    id: "ADR-0002",
    type: "adr",
    status: "accepted",
    owner: "architecture/tooling",
    summary: "Second decision",
    title: "Second",
    repositoryPath: "docs/decisions/0002-second.md",
    source: "markdown-tree",
    related: ["ADR-0001"],
    blockedBy: ["ADR-0003"],
    ...overrides
  };
}

export function plan(intent) {
  const content = "---\nid: ADR-0083\ntype: adr\nstatus: proposed\nowner: architecture/tooling\nsummary: Defines tenant isolation.\n---\n# ADR-0083: Tenant isolation\n";
  return {
    schemaVersion: 2,
    protocolVersion: 2,
    compiler: { id: "@agent-teams/engineering-foundation", version: "0.17.0-rc.0", buildIdentity: `sha256:${"1".repeat(64)}` },
    projectId: "fixture-project",
    intent,
    intentDigest: `sha256:${"2".repeat(64)}`,
    authority: {
      profileSemanticDigest: PROFILE_SEMANTIC_DIGEST,
      catalogPreimageSemanticDigest: CATALOG_SEMANTIC_DIGEST,
      expectedCatalogPostimageSemanticDigest: CATALOG_SEMANTIC_DIGEST
    },
    selectedOwner: {},
    identityProjection: {},
    referencedDocuments: [],
    destination: "docs/decisions/0083-tenant-isolation.md",
    expectedParent: { path: "docs/decisions", state: "directory", ancestry: "real-directories" },
    parentMaterialization: { policy: "create-missing-real-directories", missingDirectories: [] },
    destinationPrecondition: { state: "absent" },
    output: {
      contentBase64: Buffer.from(content, "utf8").toString("base64"),
      digest: `sha256:${"8".repeat(64)}`,
      mediaType: "text/markdown; charset=utf-8",
      size: Buffer.byteLength(content)
    },
    requiredAdapterCapabilities: ["create-directories-no-replace/v1", "create-file-no-replace/v1"],
    diagnostics: [],
    planDigest: `sha256:${"3".repeat(64)}`
  };
}

export function harness(options = {}) {
  const calls = { apply: 0, buildCatalog: 0, describe: 0, find: 0, profiles: 0, plan: [] };
  const defaultDescription = { authority: { templates: [] }, catalog: { collections: [], excludedPrefixes: [] }, projectId: "fixture-project", profileSchemaVersion: 3, semanticDigest: PROFILE_SEMANTIC_DIGEST, metadataSchemaPath: "docs/metadata.schema.json", metadataSidecar: { kind: "none" }, ownerIds: ["architecture/tooling"], types, authorityPaths: [] };
  const defaultCatalog = { projectId: "fixture-project", status: "complete", diagnostics: [], documents: [
    { ...descriptor({ id: "ADR-0001", repositoryPath: "docs/decisions/0001-first.md" }), metadata: {} },
    { ...descriptor({ id: "OD-001", type: "open-decision", status: "open", repositoryPath: "docs/open-decisions/OD-001.md" }), metadata: {} }
  ], identityProjection: [], ownerIds: ["architecture/tooling"], authority: {}, semanticDigest: CATALOG_SEMANTIC_DIGEST };
  const foundation = {
    async describe() {
      const value = options.descriptions?.[calls.describe] ?? defaultDescription;
      calls.describe += 1;
      return value;
    },
    async buildCatalog() {
      const value = options.catalogs?.[calls.buildCatalog] ?? defaultCatalog;
      calls.buildCatalog += 1;
      return value;
    },
    async find() {
      calls.find += 1;
      return [descriptor(), descriptor({ id: "ADR-0004", repositoryPath: "docs/decisions/0004-fourth.md", related: [] })];
    },
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async plan(input) { calls.plan.push(input); return options.plan ?? plan(input.intent); },
    async apply(input) {
      calls.apply += 1;
      return options.applyReceipt ?? {
        schemaVersion: 1,
        protocolVersion: 1,
        planDigest: input.plan.planDigest,
        adapter: { id: "foundation.filesystem/v1", contractVersion: 1 },
        destination: input.plan.destination,
        outcome: "applied",
        resultDigest: `sha256:${"4".repeat(64)}`,
        commit: { state: "committed", publication: "published", atomicity: "single-file-atomic-create", recoverability: "not-required" },
        diagnostics: [],
        receiptDigest: `sha256:${"5".repeat(64)}`
      };
    },
    async recover() { throw new Error("not used"); }
  };
  return {
    calls,
    protocol: createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(), ...(options.compiledOutput === undefined ? {} : { compiledOutput: options.compiledOutput }), adoption: options.adoption ?? { async inspect() { return []; } }, anchors: options.anchors ?? { async matchedPatterns({ patterns }) { return options.matchedPatterns ?? patterns; } }, foundation, profiles: { async read() { const value = options.profiles?.[calls.profiles] ?? options.profile ?? profile; calls.profiles += 1; return value; } } }))
  };
}
