import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSchema } from "../packages/engineering-foundation/dist/schema-catalog.js";

import {
  planDocumentParentMaterializationV2
} from "../packages/document-authoring/dist/index.js";
import { NodeDocumentParentMaterializerV2 } from "../packages/document-authoring/dist/adapters/node/node-document-parent-materializer.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-parent-v2-"));
  await mkdir(join(root, "docs"));
  return root;
}

function journal(base, createdDirectories = []) {
  return { ...base, createdDirectories };
}

test("v2 schema rejects zero physical identity before runtime recovery", async () => {
  const value = {
    schemaVersion: 2,
    plan: {
      deepestExistingDirectory: ".",
      finalParent: "docs",
      missingDirectories: ["docs"],
      policy: "create-missing-real-directories"
    },
    anchorIdentity: {
      adapter: "node-filesystem",
      version: 1,
      dev: "0",
      ino: "1",
      birthtimeNs: "1"
    },
    createdDirectories: []
  };
  await assert.rejects(
    assertSchema("document-parent-materialization/v2", value, "zero-identity"),
    /must match pattern/u
  );
  value.anchorIdentity.dev = "1".repeat(33);
  await assert.rejects(
    assertSchema("document-parent-materialization/v2", value, "oversized-identity"),
    /must NOT have more than 32 characters/u
  );
});

test("v2 planning projects the exact existing anchor and ordered missing directories", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));
  const plan = await planDocumentParentMaterializationV2({
    consumerRoot: root,
    destination: "docs/architecture/decisions/ADR-0042-example.md"
  });
  assert.deepEqual(plan, {
    deepestExistingDirectory: "docs",
    finalParent: "docs/architecture/decisions",
    missingDirectories: ["docs/architecture", "docs/architecture/decisions"],
    policy: "create-missing-real-directories"
  });
  await assert.rejects(readFile(join(root, "docs/architecture")), { code: "ENOENT" });
});

test("v2 materialization creates one bound real directory per durable journal step", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));
  const plan = await planDocumentParentMaterializationV2({
    consumerRoot: root,
    destination: "docs/architecture/decisions/ADR-0042-example.md"
  });
  const materializer = new NodeDocumentParentMaterializerV2({
    syncDirectory: async () => {}
  });
  const base = await materializer.begin({ consumerRoot: root, plan });
  const first = await materializer.createNext({ consumerRoot: root, journal: base });
  assert.equal(first.path, "docs/architecture");
  const second = await materializer.createNext({
    consumerRoot: root,
    journal: journal(base, [first])
  });
  assert.equal(second.path, "docs/architecture/decisions");
  assert.equal(await materializer.createNext({
    consumerRoot: root,
    journal: journal(base, [first, second])
  }), undefined);
});

test("an existing unbound directory in the mkdir-to-journal crash window is never adopted", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));
  const plan = await planDocumentParentMaterializationV2({
    consumerRoot: root,
    destination: "docs/architecture/ADR-0042-example.md"
  });
  await mkdir(join(root, "docs/architecture"));
  const materializer = new NodeDocumentParentMaterializerV2({ syncDirectory: async () => {} });
  // The durable journal precedes mkdir. Simulate a crash after mkdir but before
  // the created identity could be persisted.
  await rm(join(root, "docs/architecture"), { recursive: true });
  const base = await materializer.begin({ consumerRoot: root, plan });
  await mkdir(join(root, "docs/architecture"));
  assert.deepEqual(await materializer.inspect({ consumerRoot: root, journal: base }), {
    path: "docs/architecture",
    reason: "unbound-directory-exists",
    state: "manual-recovery-required"
  });
  await assert.rejects(
    materializer.createNext({ consumerRoot: root, journal: base }),
    /manual recovery/u
  );
});

test("planning rejects symlink ancestry and portable case aliases", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "docs/link"));
  await assert.rejects(planDocumentParentMaterializationV2({
    consumerRoot: root,
    destination: "docs/link/ADR-0042-example.md"
  }), /real directory/u);
  await mkdir(join(root, "docs/Architecture"));
  await assert.rejects(planDocumentParentMaterializationV2({
    consumerRoot: root,
    destination: "docs/architecture/ADR-0042-example.md"
  }), /portable name collision/u);
});
