import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeDocumentContractValidator } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-contract-validator.js";
import { NodeDocumentPlanningProfileReader } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-planning-profile-reader.js";
import { NodeDocumentPlanningStateReader } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-planning-state-reader.js";
import { NodeDocumentTemplateReader } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-template-reader.js";
import { DocumentPlanningError } from "../packages/engineering-foundation/dist/document-authoring/document-planning-error.js";

async function disposableRepository(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function profileSource() {
  return `schemaVersion: 1
projectId: fixture
catalog:
  metadataSchemaPath: docs/metadata.schema.json
  ownerCatalog:
    path: docs/owners.yaml
    contract: foundation.owner-map/v1
  collections:
    - kind: markdown-tree
      root: docs
  excludedPrefixes: [docs/generated]
authoring:
  mode: create-only
  artifactTypes:
    - type: context
      initialStatus: active
      identity:
        kind: explicit
        format: qualified
        grammar:
          prefixSegments: [domain, contexts]
          minSuffixSegments: 1
          maxSuffixSegments: 1
      placement:
        kind: qualified-leaf-index
        root: docs/domain/contexts
        requiredBasename: README.md
      template:
        kind: fenced-markdown-body
        path: docs/templates/context.md
      heading:
        kind: title
`;
}

test("planning profile reader returns a deeply immutable full snapshot", async () => {
  await disposableRepository("document-planning-profile-", async (root) => {
    await writeFile(join(root, "profile.yaml"), profileSource(), "utf8");
    const snapshot = await new NodeDocumentPlanningProfileReader().read({
      consumerRoot: root,
      path: "profile.yaml"
    });
    assert.equal(snapshot.projectId, "fixture");
    assert.equal(snapshot.artifactTypes[0].placement.kind, "qualified-leaf-index");
    assert.deepEqual(snapshot.artifactTypes[0].identity.grammar.prefixSegments, [
      "domain",
      "contexts"
    ]);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.artifactTypes), true);
    assert.equal(Object.isFrozen(snapshot.artifactTypes[0].identity.grammar), true);
    assert.equal(
      Object.isFrozen(snapshot.artifactTypes[0].identity.grammar.prefixSegments),
      true
    );
  });
});

test("planning profile maps schema and semantic failures to stable planning errors", async () => {
  await disposableRepository("document-planning-invalid-profile-", async (root) => {
    await writeFile(
      join(root, "profile.yaml"),
      profileSource().replace("maxSuffixSegments: 1", "maxSuffixSegments: 0"),
      "utf8"
    );
    await assert.rejects(
      new NodeDocumentPlanningProfileReader().read({
        consumerRoot: root,
        path: "profile.yaml"
      }),
      (error) => error instanceof DocumentPlanningError &&
        error.code === "DOCUMENT_PLANNING_INPUT_INVALID" &&
        error.message.length < 1200
    );
  });
});

test("template reader captures bounded exact UTF-8 evidence", async () => {
  await disposableRepository("document-planning-template-", async (root) => {
    await mkdir(join(root, "docs"));
    const source = "```markdown\n---\nid: placeholder\n---\n# Placeholder\n```\n";
    await writeFile(join(root, "docs/template.md"), source, "utf8");
    const snapshot = await new NodeDocumentTemplateReader().read({
      consumerRoot: root,
      path: "docs/template.md"
    });
    assert.equal(snapshot.source, source);
    assert.equal(snapshot.evidence.size, Buffer.byteLength(source));
    assert.match(snapshot.evidence.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(snapshot), true);
  });
});

test("template reader rejects symlinks, malformed UTF-8, BOM, NUL, and oversized input", async () => {
  await disposableRepository("document-planning-template-security-", async (root) => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "outside.md"), "outside", "utf8");
    await symlink(join(root, "outside.md"), join(root, "docs/link.md"));
    const vectors = [
      ["docs/link.md", undefined],
      ["docs/malformed.md", Buffer.from([0xc3, 0x28])],
      ["docs/bom.md", Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
      ["docs/nul.md", Buffer.from([0x61, 0, 0x62])],
      ["docs/large.md", Buffer.alloc(256 * 1024 + 1, 0x61)]
    ];
    for (const [path, bytes] of vectors) {
      if (bytes !== undefined) {
        await writeFile(join(root, path), bytes);
      }
      await assert.rejects(
        new NodeDocumentTemplateReader().read({ consumerRoot: root, path }),
        (error) => error instanceof DocumentPlanningError &&
          [
            "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
            "DOCUMENT_PLANNING_INPUT_INVALID"
          ].includes(error.code),
        path
      );
    }
  });
});

test("contract validator accepts v1 Intent and bounds validation diagnostics", async () => {
  const validator = new NodeDocumentContractValidator();
  const intent = {
    schemaVersion: 1,
    type: "adr",
    id: "ADR-9001",
    title: "Bounded adapter",
    owner: "architecture/tooling",
    summary: "Proves strict schema validation."
  };
  assert.equal(await validator.validateIntent(intent), intent);
  await assert.rejects(
    validator.validateIntent({ ...intent, unexpected: true }),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_INPUT_INVALID" &&
      error.message.length < 1200
  );
  const accessorIntent = { ...intent };
  Object.defineProperty(accessorIntent, "summary", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    }
  });
  await assert.rejects(
    validator.validateIntent(accessorIntent),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_INPUT_INVALID"
  );
  let proxyTraps = 0;
  const proxyIntent = new Proxy(intent, {
    getOwnPropertyDescriptor() {
      proxyTraps += 1;
      throw new Error("must not execute");
    },
    getPrototypeOf() {
      proxyTraps += 1;
      throw new Error("must not execute");
    },
    ownKeys() {
      proxyTraps += 1;
      throw new Error("must not execute");
    }
  });
  await assert.rejects(
    validator.validateIntent(proxyIntent),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_INPUT_INVALID"
  );
  assert.equal(proxyTraps, 0);
  let deepIntent = {};
  for (let depth = 0; depth < 10_000; depth += 1) {
    deepIntent = { nested: deepIntent };
  }
  await assert.rejects(
    validator.validateIntent(deepIntent),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_INPUT_INVALID"
  );
  const shared = { value: "accepted-twice" };
  const sharedIntent = {
    ...intent,
    additionalMetadata: { first: shared, second: shared }
  };
  assert.equal(await validator.validateIntent(sharedIntent), sharedIntent);
  await assert.rejects(
    validator.validatePlan({ schemaVersion: 1 }),
    (error) => error instanceof DocumentPlanningError &&
      error.code === "DOCUMENT_PLANNING_OUTPUT_INVALID" &&
      error.message.length < 1200
  );
});

test("planning state observes absent and bounded regular-file destinations without writes", async () => {
  await disposableRepository("document-planning-state-", async (root) => {
    await mkdir(join(root, "docs/decisions"), { recursive: true });
    const reader = new NodeDocumentPlanningStateReader();
    const absent = await reader.observe({
      consumerRoot: root,
      destination: "docs/decisions/adr.md"
    });
    assert.deepEqual(absent, {
      destination: { state: "absent" },
      expectedParent: {
        ancestry: "real-directories",
        path: "docs/decisions",
        state: "directory"
      }
    });
    await writeFile(join(root, "docs/decisions/adr.md"), "exact bytes", "utf8");
    const existing = await reader.observe({
      consumerRoot: root,
      destination: "docs/decisions/adr.md"
    });
    assert.equal(existing.destination.state, "regular-file");
    assert.equal(
      Buffer.from(existing.destination.bytes).toString("utf8"),
      "exact bytes"
    );
  });
});

test("planning state requires an existing real contained parent ancestry", async () => {
  await disposableRepository("document-planning-parent-security-", async (root) => {
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "docs/link"), "dir");
    const reader = new NodeDocumentPlanningStateReader();
    for (const destination of [
      "missing/child/document.md",
      "docs/link/document.md"
    ]) {
      await assert.rejects(
        reader.observe({ consumerRoot: root, destination }),
        (error) => error instanceof DocumentPlanningError &&
          error.code === "DOCUMENT_PLANNING_PARENT_UNAVAILABLE",
        destination
      );
    }
  });
});

test("planning state classifies portable collisions, directories, special files, and oversized files", async () => {
  await disposableRepository("document-planning-conflicts-", async (root) => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/Readme.md"), "collision", "utf8");
    await mkdir(join(root, "docs/directory.md"));
    await writeFile(join(root, "docs/large.md"), Buffer.alloc(1024 * 1024 + 1));
    await symlink(join(root, "docs/Readme.md"), join(root, "docs/link.md"));
    const reader = new NodeDocumentPlanningStateReader();
    const vectors = [
      ["docs/README.md", "portable-name-collision"],
      ["docs/directory.md", "directory"],
      ["docs/link.md", "special-file"],
      ["docs/large.md", "special-file"]
    ];
    for (const [destination, kind] of vectors) {
      const snapshot = await reader.observe({ consumerRoot: root, destination });
      assert.deepEqual(snapshot.destination, { kind, state: "conflict" });
    }
  });
});

test("planning state rejects non-portable paths and checks root-level destinations", async () => {
  await disposableRepository("document-planning-root-state-", async (root) => {
    const reader = new NodeDocumentPlanningStateReader();
    await assert.rejects(
      reader.observe({ consumerRoot: root, destination: "../escape.md" }),
      (error) => error instanceof DocumentPlanningError &&
        error.code === "DOCUMENT_PLANNING_INPUT_INVALID"
    );
    assert.deepEqual(
      await reader.observe({ consumerRoot: root, destination: "README.md" }),
      {
        destination: { state: "absent" },
        expectedParent: {
          ancestry: "real-directories",
          path: ".",
          state: "directory"
        }
      }
    );
  });
});
