import assert from "node:assert/strict";
import test from "node:test";

import {
  documentationCatalogSemanticDigest,
  projectDocumentationCatalogSemanticTransitionV2,
} from "../packages/document-authoring/dist/application/policies/document-authoring-semantic-digests.js";

const evidence = Object.freeze({
  digest: `sha256:${"1".repeat(64)}`,
  path: "authority.yaml",
  size: 1,
});

const profile = Object.freeze({
  artifactTypes: Object.freeze([
    Object.freeze({
      heading: Object.freeze({ kind: "title" }),
      identity: Object.freeze({ kind: "explicit", format: "adr-four-digits" }),
      initialStatus: "active",
      placement: Object.freeze({
        directory: "docs/content",
        filename: "numeric-id-slug",
        kind: "collection",
      }),
      reachability: Object.freeze({ kind: "not-required" }),
      template: Object.freeze({ kind: "fenced-markdown-body", path: "template.md" }),
      type: "guide",
    }),
  ]),
  collections: Object.freeze([
    Object.freeze({ kind: "markdown-tree", root: "docs/content" }),
  ]),
  evidence,
  excludedPrefixes: Object.freeze([]),
  metadataSchemaPath: "metadata.schema.json",
  ownerCatalog: Object.freeze({ contract: "foundation.owner-map/v1", path: "owners.yaml" }),
  projectId: "semantic-transition",
  schemaVersion: 2,
});

const intent = Object.freeze({
  additionalMetadata: Object.freeze({ blocked_by: Object.freeze(["guide.blocker"]) }),
  id: "ADR-0001",
  owner: "architecture",
  schemaVersion: 1,
  summary: "Transition guide.",
  title: "Transition guide",
  type: "guide",
});

function catalog(documents = [], identities = []) {
  const withoutDigest = Object.freeze({
    authority: Object.freeze({
      metadataSchema: evidence,
      ownerCatalog: evidence,
      profile: evidence,
    }),
    diagnostics: Object.freeze([]),
    documents: Object.freeze(documents),
    identityProjection: Object.freeze(identities),
    ownerIds: Object.freeze(["architecture"]),
    projectId: "semantic-transition",
    status: "complete",
  });
  return Object.freeze({
    ...withoutDigest,
    semanticDigest: documentationCatalogSemanticDigest(withoutDigest),
  });
}

const plannedDocument = Object.freeze({
  id: intent.id,
  metadata: Object.freeze({
    blocked_by: Object.freeze(["guide.blocker"]),
    id: intent.id,
    owner: intent.owner,
    status: "active",
    summary: intent.summary,
    type: intent.type,
  }),
  owner: intent.owner,
  repositoryPath: "docs/content/0001-transition-guide.md",
  source: "markdown-tree",
  status: "active",
  summary: intent.summary,
  title: intent.title,
  type: intent.type,
});
const plannedIdentity = Object.freeze({
  id: plannedDocument.id,
  repositoryPath: plannedDocument.repositoryPath,
});

function transition(snapshot) {
  return projectDocumentationCatalogSemanticTransitionV2({
    catalog: snapshot,
    destination: plannedDocument.repositoryPath,
    intent,
    profile,
  });
}

test("catalog transition has stable preimage and expected postimage across publication", () => {
  const before = catalog();
  const planned = transition(before);
  const after = catalog([plannedDocument], [plannedIdentity]);
  const replayed = transition(after);

  assert.equal(planned.catalogPreimageSemanticDigest, before.semanticDigest);
  assert.equal(planned.expectedCatalogPostimageSemanticDigest, after.semanticDigest);
  assert.deepEqual(replayed, planned);
});

test("catalog transition preserves unrelated full-corpus drift", () => {
  const before = catalog();
  const baseline = transition(before);
  const unrelated = Object.freeze({
    ...plannedDocument,
    id: "guide.unrelated",
    metadata: Object.freeze({
      ...plannedDocument.metadata,
      id: "guide.unrelated",
      status: "blocked",
    }),
    repositoryPath: "docs/content/unrelated.md",
    status: "blocked",
    summary: "Unrelated.",
    title: "Unrelated",
  });
  const drifted = transition(catalog(
    [unrelated],
    [{ id: unrelated.id, repositoryPath: unrelated.repositoryPath }],
  ));

  assert.notEqual(
    drifted.catalogPreimageSemanticDigest,
    baseline.catalogPreimageSemanticDigest,
  );
  assert.notEqual(
    drifted.expectedCatalogPostimageSemanticDigest,
    baseline.expectedCatalogPostimageSemanticDigest,
  );
});
