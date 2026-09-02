import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDocumentLogicalPreimage,
  isDestinationCoveredByCatalog
} from "../packages/document-authoring/dist/application/policies/document-logical-preimage.js";
import { DocumentPlanningPolicyError } from "../packages/document-authoring/dist/application/policies/document-planning-policy-error.js";
import { normalizeDocumentIntent } from "../packages/document-authoring/dist/application/policies/normalize-document-intent.js";
import {
  resolveDocumentAuthoring,
  selectDocumentArtifact
} from "../packages/document-authoring/dist/application/policies/resolve-document-authoring.js";

const evidence = Object.freeze({ digest: `sha256:${"0".repeat(64)}`, path: "authority.json", size: 1 });

function intent(overrides = {}) {
  return {
    schemaVersion: 1,
    type: "adr",
    id: "ADR-0042",
    title: "Cafe\u0301 & Architecture",
    owner: "architecture/tooling",
    summary: "A deterministic decision.",
    ...overrides
  };
}

function artifact(overrides = {}) {
  return {
    type: "adr",
    initialStatus: "proposed",
    identity: { kind: "explicit", format: "adr-four-digits" },
    placement: {
      kind: "collection",
      directory: "docs/decisions",
      filename: "numeric-id-slug"
    },
    template: { kind: "fenced-markdown-body", path: "docs/templates/adr.md" },
    heading: { kind: "id-colon-title" },
    reachability: { kind: "not-required" },
    ...overrides
  };
}

function profile(artifactTypes = [artifact()]) {
  return {
    artifactTypes,
    collections: [{ kind: "markdown-tree", root: "docs/decisions" }],
    evidence,
    excludedPrefixes: [],
    metadataSchemaPath: "docs/schema.json",
    ownerCatalog: { contract: "foundation.owner-map/v1", path: "docs/owners.yaml" },
    projectId: "foundation"
  };
}

function catalog(overrides = {}) {
  return {
    authority: { metadataSchema: evidence, ownerCatalog: evidence, profile: evidence },
    diagnostics: [],
    documents: [],
    identityProjection: [],
    ownerIds: ["architecture/tooling"],
    projectId: "foundation",
    status: "complete",
    ...overrides
  };
}

function policyProblem(problem, operation) {
  assert.throws(operation, (error) =>
    error instanceof DocumentPlanningPolicyError && error.problem === problem
  );
}

test("normalizes Intent recursively while preserving array order and sorting owned sets/maps", () => {
  const normalized = normalizeDocumentIntent(intent({
    related: ["OD-002", "OD-001"],
    additionalMetadata: {
      zeta: { zebra: "e\u0301", alpha: "first" },
      alpha: [{ second: "b", first: "a" }, "last"]
    }
  }));

  assert.equal(normalized.title, "Caf\u00e9 & Architecture");
  assert.deepEqual(normalized.related, ["OD-001", "OD-002"]);
  assert.deepEqual(Object.keys(normalized.additionalMetadata), ["alpha", "zeta"]);
  assert.deepEqual(Object.keys(normalized.additionalMetadata.zeta), ["alpha", "zebra"]);
  assert.deepEqual(normalized.additionalMetadata.alpha, [{ first: "a", second: "b" }, "last"]);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.additionalMetadata.alpha[0]));
});

test("rejects related duplicates after NFC and invalid canonical JSON values", () => {
  policyProblem("duplicate-related", () => normalizeDocumentIntent(intent({
    related: ["caf\u00e9", "cafe\u0301"]
  })));
  policyProblem("invalid-intent-json", () => normalizeDocumentIntent(intent({
    additionalMetadata: { value: -0 }
  })));
  policyProblem("invalid-intent-json", () => normalizeDocumentIntent(intent({
    additionalMetadata: { value: "\ud800" }
  })));
});

test("selects one artifact and resolves exact NFKD slug, filename, and heading operators", () => {
  const selected = selectDocumentArtifact(profile(), "adr");
  assert.deepEqual(resolveDocumentAuthoring({ artifact: selected, intent: intent() }), {
    artifact: selected,
    destination: "docs/decisions/0042-cafe-architecture.md",
    heading: "ADR-0042: Cafe\u0301 & Architecture",
    slug: "cafe-architecture"
  });
  policyProblem("invalid-artifact-type", () => selectDocumentArtifact(profile([]), "adr"));
  policyProblem("invalid-identity", () => resolveDocumentAuthoring({
    artifact: selected,
    intent: intent({ id: "ADR-42" })
  }));
  policyProblem("missing-slug", () => resolveDocumentAuthoring({
    artifact: selected,
    intent: intent({ title: "\u4e2d\u6587" })
  }));
});

test("resolves qualified leaf and validates explicit placement segment counts", () => {
  const qualified = artifact({
    type: "context",
    identity: {
      kind: "explicit",
      format: "qualified",
      grammar: { prefixSegments: ["domain", "contexts"], minSuffixSegments: 1, maxSuffixSegments: 2 }
    },
    placement: { kind: "qualified-leaf-index", root: "docs/domain/contexts", requiredBasename: "README.md" },
    heading: { kind: "title" }
  });
  assert.equal(resolveDocumentAuthoring({
    artifact: qualified,
    intent: intent({ type: "context", id: "domain.contexts.billing.core", title: "Billing" })
  }).destination, "docs/domain/contexts/billing/core/README.md");

  const explicit = artifact({
    type: "feature",
    identity: {
      kind: "explicit",
      format: "qualified",
      grammar: { prefixSegments: ["feature"], minSuffixSegments: 2, maxSuffixSegments: 2 }
    },
    placement: {
      kind: "explicit",
      allowedRoots: ["projects"],
      requiredSegmentsInOrder: ["src", "features"],
      requiredBasename: "README.md",
      minimumSegmentsBeforeRequired: 1,
      minimumSegmentsAfterRequired: 1
    }
  });
  assert.equal(resolveDocumentAuthoring({
    artifact: explicit,
    intent: intent({
      type: "feature",
      id: "feature.billing.invoice",
      destination: "projects/web/src/features/invoice/README.md"
    })
  }).destination, "projects/web/src/features/invoice/README.md");
  policyProblem("invalid-destination", () => resolveDocumentAuthoring({
    artifact: explicit,
    intent: intent({
      type: "feature",
      id: "feature.billing.invoice",
      destination: "projects/src/features/invoice/README.md"
    })
  }));
});

test("checks catalog collection coverage and exclusions on segment boundaries", () => {
  assert.equal(isDestinationCoveredByCatalog(
    "docs/domain/billing/README.md",
    [{ kind: "frontmatter-readme", roots: ["docs/domain"] }],
    []
  ), true);
  assert.equal(isDestinationCoveredByCatalog(
    "docs/domain/generated/README.md",
    [{ kind: "frontmatter-readme", roots: ["docs/domain"] }],
    ["docs/domain/generated"]
  ), false);
  assert.equal(isDestinationCoveredByCatalog(
    "docs/domain/billing/notes.md",
    [{ kind: "frontmatter-readme", roots: ["docs/domain"] }],
    []
  ), false);
});

test("classifies only exact path plus ID plus bytes as logical self", () => {
  const destination = "docs/decisions/0042-example.md";
  const bytes = new TextEncoder().encode("exact\n");
  const snapshot = catalog({
    documents: [{
      id: "ADR-0042", owner: "architecture/tooling", repositoryPath: destination,
      source: "markdown-tree", status: "proposed", summary: "Summary", title: "Example", type: "adr"
    }],
    identityProjection: [
      { id: "ADR-0001", repositoryPath: "docs/decisions/0001-first.md" },
      { id: "ADR-0042", repositoryPath: destination }
    ]
  });
  const result = classifyDocumentLogicalPreimage({
    catalog: snapshot, destination, expectedBytes: bytes, id: "ADR-0042", observedBytes: bytes
  });
  assert.equal(result.isExactSelf, true);
  assert.deepEqual(result.identityProjection, [
    { id: "ADR-0001", repositoryPath: "docs/decisions/0001-first.md" }
  ]);

  policyProblem("destination-conflict", () => classifyDocumentLogicalPreimage({
    catalog: catalog(), destination, expectedBytes: bytes, id: "ADR-0042", observedBytes: bytes
  }));
  policyProblem("destination-conflict", () => classifyDocumentLogicalPreimage({
    catalog: snapshot, destination, expectedBytes: bytes, id: "ADR-0042",
    observedBytes: new TextEncoder().encode("different\n")
  }));
  policyProblem("catalog-incomplete", () => classifyDocumentLogicalPreimage({
    catalog: catalog({ status: "partial" }), destination, expectedBytes: bytes, id: "ADR-0042"
  }));
});
