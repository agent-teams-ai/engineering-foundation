import assert from "node:assert/strict";
import test from "node:test";

import { NodeDocumentReachabilityProjector } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-reachability-projector.js";
import { NodeDocumentStructureVerifier } from "../packages/document-authoring/dist/document-authoring/adapters/node/node-document-structure-verifier.js";
import { DocumentPlanningError } from "../packages/document-authoring/dist/document-authoring/application/model/document-planning-error.js";

const profileEvidence = Object.freeze({
  digest: `sha256:${"a".repeat(64)}`,
  path: ".agent-teams/document-authoring.json",
  size: 123,
});
const metadataEvidence = Object.freeze({
  digest: `sha256:${"b".repeat(64)}`,
  path: ".agent-teams/document-metadata.schema.json",
  size: 456,
});
const ownerEvidence = Object.freeze({
  digest: `sha256:${"c".repeat(64)}`,
  path: ".agent-teams/owners.yaml",
  size: 78,
});
const artifact = Object.freeze({
  type: "adr",
  initialStatus: "proposed",
  identity: { kind: "explicit", format: "adr-four-digits" },
  placement: {
    kind: "collection",
    directory: "docs/adr",
    filename: "numeric-id-slug",
  },
  template: { kind: "fenced-markdown-body", path: "docs/templates/adr.md" },
  heading: { kind: "id-colon-title" },
  reachability: { kind: "manual-fixed-index", indexPath: "docs/README.md" },
});
const profile = Object.freeze({
  artifactTypes: Object.freeze([artifact]),
  collections: Object.freeze([{ kind: "markdown-tree", root: "docs" }]),
  evidence: profileEvidence,
  excludedPrefixes: Object.freeze([]),
  metadataSchemaPath: metadataEvidence.path,
  ownerCatalog: Object.freeze({ contract: "foundation.owner-map/v1", path: ownerEvidence.path }),
  projectId: "fixture",
});
const plan = Object.freeze({
  projectId: "fixture",
  intent: Object.freeze({
    schemaVersion: 1,
    type: "adr",
    id: "ADR-0001",
    title: "Exact authority",
    owner: "platform",
    summary: "Proves the exact post-apply descriptor.",
  }),
  authority: Object.freeze({
    profile: profileEvidence,
    metadataSchema: metadataEvidence,
    ownerCatalog: ownerEvidence,
  }),
  destination: "docs/adr/0001-exact-authority.md",
});

test("reachability rereads the exact profile path and projects its declared strategy", async () => {
  const reads = [];
  const projector = new NodeDocumentReachabilityProjector({
    async read(request) {
      reads.push(request);
      return profile;
    },
  });

  assert.deepEqual(await projector.project({ consumerRoot: "/fixture", plan }), {
    state: "manual-required",
    indexPath: "docs/README.md",
    markdownLink: "[ADR-0001: Exact authority](adr/0001-exact-authority.md)",
  });
  assert.deepEqual(reads, [{
    consumerRoot: "/fixture",
    path: profileEvidence.path,
  }]);
});

test("reachability fails closed when reread profile evidence differs", async () => {
  const projector = new NodeDocumentReachabilityProjector({
    async read() {
      return {
        ...profile,
        evidence: { ...profileEvidence, digest: `sha256:${"d".repeat(64)}` },
      };
    },
  });

  await assert.rejects(
    projector.project({ consumerRoot: "/fixture", plan }),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_AUTHORITY_CHANGED",
  );
});

test("structure verification proves exact authority and descriptor", async () => {
  const descriptor = Object.freeze({
    id: plan.intent.id,
    repositoryPath: plan.destination,
    type: plan.intent.type,
    title: `${plan.intent.id}: ${plan.intent.title}`,
    owner: plan.intent.owner,
    summary: plan.intent.summary,
    status: artifact.initialStatus,
    source: "markdown-tree",
  });
  const verifier = new NodeDocumentStructureVerifier({
    catalog: {
      async execute(request) {
        assert.equal(request.profilePath, profileEvidence.path);
        return {
          authority: {
            profile: profileEvidence,
            metadataSchema: metadataEvidence,
            ownerCatalog: ownerEvidence,
          },
          diagnostics: [],
          documents: [descriptor],
          identityProjection: [{ id: descriptor.id, repositoryPath: descriptor.repositoryPath }],
          ownerIds: [descriptor.owner],
          projectId: plan.projectId,
          status: "complete",
        };
      },
    },
    profiles: { async read() { return profile; } },
  });

  assert.deepEqual(await verifier.verify({ consumerRoot: "/fixture", plan }), {
    diagnostics: [],
    valid: true,
  });
});

test("structure verification rejects a descriptor with the right id but wrong metadata", async () => {
  const verifier = new NodeDocumentStructureVerifier({
    catalog: {
      async execute() {
        return {
          authority: {
            profile: profileEvidence,
            metadataSchema: metadataEvidence,
            ownerCatalog: ownerEvidence,
          },
          diagnostics: [],
          documents: [{
            id: plan.intent.id,
            repositoryPath: plan.destination,
            type: plan.intent.type,
            title: `${plan.intent.id}: ${plan.intent.title}`,
            owner: plan.intent.owner,
            summary: "wrong summary",
            status: artifact.initialStatus,
            source: "markdown-tree",
          }],
          identityProjection: [],
          ownerIds: [plan.intent.owner],
          projectId: plan.projectId,
          status: "complete",
        };
      },
    },
    profiles: { async read() { return profile; } },
  });

  const result = await verifier.verify({ consumerRoot: "/fixture", plan });
  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map(({ ruleId }) => ruleId), [
    "document.new.descriptor-mismatch",
  ]);
});
