import assert from "node:assert/strict";
import test from "node:test";

import { projectDocumentReachability } from "../packages/document-authoring/dist/application/policies/project-document-reachability.js";

function artifact(reachability, placement = {
  kind: "collection",
  directory: "docs/decisions",
  filename: "numeric-id-slug"
}) {
  return {
    type: "adr",
    initialStatus: "proposed",
    identity: { kind: "explicit", format: "adr-four-digits" },
    placement,
    template: { kind: "fenced-markdown-body", path: "docs/templates/adr.md" },
    heading: { kind: "id-colon-title" },
    reachability
  };
}

test("fixed reachability projects an exact portable relative Markdown link", () => {
  assert.deepEqual(projectDocumentReachability({
    artifact: artifact({
      kind: "manual-fixed-index",
      indexPath: "docs/decisions/README.md"
    }),
    destination: "docs/decisions/0083-deterministic-docs.md",
    heading: "ADR-0083: Deterministic [docs]"
  }), {
    state: "manual-required",
    indexPath: "docs/decisions/README.md",
    markdownLink: "[ADR-0083: Deterministic \\[docs\\]](0083-deterministic-docs.md)"
  });
});

test("fixed reachability traverses repository parents using slash separators", () => {
  assert.equal(projectDocumentReachability({
    artifact: artifact({
      kind: "manual-fixed-index",
      indexPath: "docs/README.md"
    }),
    destination: "packages/foundation/docs/README.md",
    heading: "Foundation"
  }).markdownLink, "[Foundation](../packages/foundation/docs/README.md)");
});

test("colocated reachability projects the explicit prefix before required segments", () => {
  const projection = projectDocumentReachability({
    artifact: artifact({
      kind: "manual-colocated-index",
      pathPrefix: "before-required-segments",
      indexBasename: "README.md"
    }, {
      kind: "explicit",
      allowedRoots: ["apps", "packages"],
      requiredSegmentsInOrder: ["src", "features"],
      requiredBasename: "README.md",
      minimumSegmentsBeforeRequired: 1,
      minimumSegmentsAfterRequired: 1
    }),
    destination: "packages/payments/src/features/refunds/README.md",
    heading: "Refunds"
  });
  assert.deepEqual(projection, {
    state: "manual-required",
    indexPath: "packages/payments/README.md",
    markdownLink: "[Refunds](src/features/refunds/README.md)"
  });
});

test("not-required projects no guessed index", () => {
  assert.deepEqual(projectDocumentReachability({
    artifact: artifact({ kind: "not-required" }),
    destination: "docs/decisions/0083-docs.md",
    heading: "Ignored"
  }), { state: "not-required" });
});

test("colocated reachability rejects incompatible or ambiguous placement", () => {
  const reachability = {
    kind: "manual-colocated-index",
    pathPrefix: "before-required-segments",
    indexBasename: "README.md"
  };
  assert.throws(() => projectDocumentReachability({
    artifact: artifact(reachability),
    destination: "docs/decisions/0083-docs.md",
    heading: "ADR"
  }), /requires explicit placement authority/u);

  assert.throws(() => projectDocumentReachability({
    artifact: artifact(reachability, {
      kind: "explicit",
      allowedRoots: ["packages"],
      requiredSegmentsInOrder: ["src", "src"],
      requiredBasename: "README.md",
      minimumSegmentsBeforeRequired: 1,
      minimumSegmentsAfterRequired: 1
    }),
    destination: "packages/a/src/src/src/README.md",
    heading: "Ambiguous"
  }), /cannot project a unique index prefix/u);

  assert.throws(() => projectDocumentReachability({
    artifact: artifact(reachability, {
      kind: "explicit",
      allowedRoots: ["packages"],
      requiredSegmentsInOrder: ["src", "features"],
      requiredBasename: "README.md",
      minimumSegmentsBeforeRequired: 1,
      minimumSegmentsAfterRequired: 1
    }),
    destination: "apps/a/src/features/f/README.md",
    heading: "Outside"
  }), /outside explicit placement authority/u);
});

test("Windows separators and self-links fail closed", () => {
  const fixed = artifact({
    kind: "manual-fixed-index",
    indexPath: "docs/README.md"
  });
  assert.throws(() => projectDocumentReachability({
    artifact: fixed,
    destination: "docs\\feature\\README.md",
    heading: "Feature"
  }), /projection is invalid/u);
  assert.throws(() => projectDocumentReachability({
    artifact: fixed,
    destination: "docs/README.md",
    heading: "Index"
  }), /projection is invalid/u);
});
