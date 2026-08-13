import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Bytes } from "../packages/engineering-foundation/dist/canonical-json.js";
import { NodeDocumentFileState } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-file-state.js";
import { NodeDocumentPublisher } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-publisher.js";
import { documentPlanDigest } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";

function planFor(bytes) {
  const plan = {
    schemaVersion: 1,
    protocolVersion: 1,
    compiler: { id: "test", version: "1.0.0", buildIdentity: `sha256:${"1".repeat(64)}` },
    projectId: "test",
    intent: { schemaVersion: 1, type: "test", id: "test.one", title: "Test", owner: "test", summary: "Test" },
    intentDigest: `sha256:${"2".repeat(64)}`,
    authority: {
      profile: { path: "profile.json", digest: `sha256:${"3".repeat(64)}`, size: 1 },
      metadataSchema: { path: "schema.json", digest: `sha256:${"4".repeat(64)}`, size: 1 },
      ownerCatalog: { path: "owners.json", digest: `sha256:${"5".repeat(64)}`, size: 1 },
      template: { path: "template.md", digest: `sha256:${"6".repeat(64)}`, size: 1 }
    },
    selectedOwner: { id: "test", membershipDigest: `sha256:${"7".repeat(64)}` },
    identityProjection: { entryCount: 0, digest: `sha256:${"8".repeat(64)}` },
    referencedDocuments: [],
    destination: "docs/test.md",
    expectedParent: { path: "docs", state: "directory", ancestry: "real-directories" },
    destinationPrecondition: { state: "absent" },
    output: {
      digest: sha256Bytes(bytes), size: bytes.length, mode: "0644",
      mediaType: "text/markdown; charset=utf-8", contentBase64: bytes.toString("base64")
    },
    requiredAdapterCapabilities: ["create-file-no-replace/v1"], diagnostics: [],
    planDigest: `sha256:${"0".repeat(64)}`
  };
  plan.planDigest = documentPlanDigest(plan);
  return plan;
}

test("Node document publisher prepares, resumes, publishes, and cleans exact Plan output", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const state = new NodeDocumentFileState();
    assert.deepEqual(await state.classifyDestination({ consumerRoot: root, plan }), { state: "absent" });
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    assert.equal(temporary.path, documentTemporaryPath(plan.destination, plan.planDigest));
    assert.ok([temporary.identity.dev, temporary.identity.ino, temporary.identity.birthtimeNs].every((value) => value !== "0"));
    assert.equal((await state.classifyTemporary({ consumerRoot: root, temporary })).state, "owned-exact");
    assert.equal(await publisher.publishPrepared({ consumerRoot: root, plan, temporary }), "published");
    assert.deepEqual(await readFile(join(root, plan.destination)), Buffer.from("# Test\n"));
    assert.deepEqual(await state.classifyDestination({ consumerRoot: root, plan }), { state: "exact" });
    await publisher.removeOwnedTemporary({ consumerRoot: root, temporary });
    assert.deepEqual(await state.classifyTemporary({ consumerRoot: root, temporary }), { state: "absent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node document adapters reject conflicts, zero identity, and linked ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  const outside = await mkdtemp(join(tmpdir(), "foundation-document-outside-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const state = new NodeDocumentFileState();
    await writeFile(join(root, plan.destination), "different\n");
    assert.equal((await state.classifyDestination({ consumerRoot: root, plan })).state, "conflict");
    const zero = {
      path: documentTemporaryPath(plan.destination, plan.planDigest),
      digest: plan.output.digest,
      identity: { adapter: "node-filesystem", version: 1, dev: "0", ino: "1", birthtimeNs: "1" }
    };
    assert.equal((await state.classifyTemporary({ consumerRoot: root, temporary: zero })).state, "conflict");
    await rm(join(root, "docs"), { recursive: true });
    await import("node:fs/promises").then(({ symlink }) => symlink(outside, join(root, "docs"), "dir"));
    assert.equal((await state.classifyDestination({ consumerRoot: root, plan })).state, "conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
