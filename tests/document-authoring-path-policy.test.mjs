import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeAuthoringProfileReader } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-authoring-profile-reader.js";
import {
  assertAuthoringProfileSemantics,
  AuthoringProfileSemanticError,
  hasContiguousRequiredSegments,
  isRepositoryPathAllowedByPlacement,
  matchingPlacementRoot
} from "../packages/engineering-foundation/dist/document-authoring/application/policies/authoring-profile-semantics.js";
import { isDocumentRepositoryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-repository-path.js";
import { DocumentCatalogError } from "../packages/engineering-foundation/dist/document-authoring/document-catalog-error.js";

const pathVectors = JSON.parse(readFileSync(
  new URL("./fixtures/repository-path-conformance-v1.json", import.meta.url),
  "utf8"
)).vectors;

function vectorPath(vector) {
  return vector.path ?? vector.segments
    .map(({ count, repeat }) => repeat.repeat(count))
    .join("/");
}

function profile(...artifactTypes) {
  return { authoring: { artifactTypes } };
}

function artifact(type, placement, identity) {
  return { ...(identity === undefined ? {} : { identity }), placement, type };
}

test("implements the document subset of the shared repository path vectors", () => {
  for (const vector of pathVectors) {
    assert.equal(isDocumentRepositoryPath(vectorPath(vector)), vector.documentValid, vector.name);
  }
});

test("rejects duplicate and portable-colliding artifact types", () => {
  assert.throws(
    () => assertAuthoringProfileSemantics(profile(
      artifact("guide", { kind: "collection" }),
      artifact("guide", { kind: "collection" })
    )),
    (error) => error instanceof AuthoringProfileSemanticError &&
      error.problem === "duplicate-artifact-type"
  );
});

test("rejects inverted qualified identity suffix bounds", () => {
  assert.throws(
    () => assertAuthoringProfileSemantics(profile(artifact("guide", {
      kind: "collection"
    }, {
      grammar: {
        maxSuffixSegments: 1,
        minSuffixSegments: 2,
        prefixSegments: ["guide"]
      }
    }))),
    (error) => error instanceof AuthoringProfileSemanticError &&
      error.problem === "invalid-qualified-grammar-range"
  );
});

test("rejects incompatible identity and placement strategy pairs", () => {
  for (const candidate of [
    artifact("adr", {
      kind: "qualified-leaf-index",
      root: "docs/contexts"
    }, { format: "adr-four-digits" }),
    artifact("guide", {
      directory: "docs/guides",
      filename: "numeric-id-slug",
      kind: "collection"
    }, { format: "qualified" })
  ]) {
    assert.throws(
      () => assertAuthoringProfileSemantics(profile(candidate)),
      (error) => error instanceof AuthoringProfileSemanticError &&
        error.problem === "incompatible-identity-placement"
    );
  }
  assert.doesNotThrow(() => assertAuthoringProfileSemantics(profile(
    artifact("context", {
      kind: "qualified-leaf-index",
      root: "docs/contexts"
    }, { format: "qualified" }),
    artifact("adr", {
      directory: "docs/decisions",
      filename: "numeric-id-slug",
      kind: "collection"
    }, { format: "adr-four-digits" })
  )));
});

test("rejects case-colliding and segment-overlapping explicit roots", () => {
  for (const allowedRoots of [
    ["docs/Guides", "DOCS/guides"],
    ["docs", "docs/guides"]
  ]) {
    assert.throws(
      () => assertAuthoringProfileSemantics(profile(artifact("guide", {
        allowedRoots,
        kind: "explicit",
        requiredSegmentsInOrder: ["guides"]
      }))),
      AuthoringProfileSemanticError
    );
  }
});

test("treats roots on segment boundaries and required segments as contiguous", () => {
  assert.equal(matchingPlacementRoot("docs/guides/README.md", ["doc", "docs"]), "docs");
  assert.equal(matchingPlacementRoot("docs-other/README.md", ["docs"]), undefined);
  assert.equal(matchingPlacementRoot("docs/guides/README.md", ["docs", "docs/guides"]), undefined);
  assert.equal(
    hasContiguousRequiredSegments("packages/a/docs/guides/README.md", ["docs", "guides"]),
    true
  );
  assert.equal(
    hasContiguousRequiredSegments("packages/docs/a/guides/README.md", ["docs", "guides"]),
    false
  );
  assert.equal(
    hasContiguousRequiredSegments(
      "packages/docs/guides/README.md",
      ["docs", "guides"],
      "packages"
    ),
    true
  );
  assert.equal(
    hasContiguousRequiredSegments(
      "packages/docs/a/guides/README.md",
      ["docs", "guides"],
      "packages"
    ),
    false
  );
});

test("matches policy paths literally while collision checks remain ASCII-case-folded", () => {
  assert.equal(matchingPlacementRoot("docs/guides/README.md", ["DOCS"]), undefined);
  assert.equal(
    hasContiguousRequiredSegments("packages/src/features/README.md", ["SRC", "features"], "packages"),
    false
  );
});

test("enforces explicit placement relative to one root, basename, and both margins", () => {
  const placement = {
    allowedRoots: ["apps", "packages", "tooling"],
    kind: "explicit",
    minimumSegmentsAfterRequired: 1,
    minimumSegmentsBeforeRequired: 1,
    requiredBasename: "README.md",
    requiredSegmentsInOrder: ["src", "features"]
  };
  assert.equal(
    isRepositoryPathAllowedByPlacement("apps/web/src/features/login/README.md", placement),
    true
  );
  for (const repositoryPath of [
    "apps/src/features/login/README.md",
    "apps/web/src/features/README.md",
    "apps/web/SRC/features/login/README.md",
    "apps/web/src/features/login/readme.md",
    "applications/web/src/features/login/README.md"
  ]) {
    assert.equal(isRepositoryPathAllowedByPlacement(repositoryPath, placement), false, repositoryPath);
  }
});

test("accepts one qualified root and independent explicit roots", () => {
  assert.doesNotThrow(() => assertAuthoringProfileSemantics(profile(
    artifact("package", { kind: "qualified-leaf-index", root: "packages" }, {
      format: "qualified"
    }),
    artifact("guide", {
      allowedRoots: ["docs/guides", "handbook/guides"],
      kind: "explicit",
      requiredSegmentsInOrder: ["guides"]
    })
  )));
});

test("profile reader fails closed on semantics that JSON Schema cannot express", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-profile-semantics-"));
  try {
    await writeFile(join(root, "profile.yaml"), `schemaVersion: 1
projectId: fixture
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs
authoring:
  mode: create-only
  artifactTypes:
    - type: guide
      initialStatus: proposed
      identity:
        kind: explicit
        format: qualified
        grammar:
          prefixSegments: [guide]
          minSuffixSegments: 2
          maxSuffixSegments: 1
      placement:
        kind: qualified-leaf-index
        root: docs/guides
        requiredBasename: README.md
      template:
        kind: fenced-markdown-body
        path: docs/template.md
      heading:
        kind: title
`, "utf8");
    await assert.rejects(
      new NodeAuthoringProfileReader().read({ consumerRoot: root, path: "profile.yaml" }),
      (error) => error instanceof DocumentCatalogError &&
        error.code === "DOCUMENT_CATALOG_INPUT_INVALID" &&
        /invalid-qualified-grammar-range/u.test(error.message)
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("profile reader rejects an incompatible identity and placement pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-profile-compatibility-"));
  try {
    await writeFile(join(root, "profile.yaml"), `schemaVersion: 1
projectId: fixture
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs
authoring:
  mode: create-only
  artifactTypes:
    - type: guide
      initialStatus: proposed
      identity:
        kind: explicit
        format: qualified
        grammar:
          prefixSegments: [guide]
          minSuffixSegments: 1
          maxSuffixSegments: 2
      placement:
        kind: collection
        directory: docs/guides
        filename: numeric-id-slug
      template:
        kind: fenced-markdown-body
        path: docs/template.md
      heading:
        kind: title
`, "utf8");
    await assert.rejects(
      new NodeAuthoringProfileReader().read({ consumerRoot: root, path: "profile.yaml" }),
      (error) => error instanceof DocumentCatalogError &&
        error.code === "DOCUMENT_CATALOG_INPUT_INVALID" &&
        /incompatible-identity-placement/u.test(error.message)
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("authority readers use the same repository path segment bound", async () => {
  await assert.rejects(
    new NodeAuthoringProfileReader().read({
      consumerRoot: tmpdir(),
      path: "a".repeat(256)
    }),
    (error) => error instanceof DocumentCatalogError &&
      error.code === "DOCUMENT_CATALOG_INPUT_INVALID" &&
      /portable repository-relative path grammar/u.test(error.message)
  );
});
