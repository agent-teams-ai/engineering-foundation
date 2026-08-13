import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Bytes } from "../packages/engineering-foundation/dist/canonical-json.js";
import { NodeDocumentFileState } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-file-state.js";
import { NodeDocumentPublisher } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-publisher.js";
import {
  assertDocumentPhysicalIdentity,
  assertNonzeroDocumentPhysicalIdentity
} from "../packages/engineering-foundation/dist/document-authoring/application/model/document-physical-identity.js";
import { documentPlanDigest } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";

const requiresStrictDirectoryDurability = process.platform === "win32"
  ? test.skip
  : test;

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

requiresStrictDirectoryDurability("Node document publisher prepares, resumes, publishes, and cleans exact Plan output", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const state = new NodeDocumentFileState();
    assert.deepEqual(await state.classifyDestination({ consumerRoot: root, plan }), { state: "absent" });
    assert.deepEqual(await state.classifyDerivedTemporary({ consumerRoot: root, plan }), { state: "absent" });
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    assert.equal(temporary.path, documentTemporaryPath(plan.destination, plan.planDigest));
    assert.ok([temporary.identity.dev, temporary.identity.ino, temporary.identity.birthtimeNs]
      .every((value) => typeof value === "string"));
    assert.doesNotThrow(() => JSON.stringify(temporary));
    assert.ok([temporary.identity.dev, temporary.identity.ino, temporary.identity.birthtimeNs].every((value) => value !== "0"));
    const derived = await state.classifyDerivedTemporary({ consumerRoot: root, plan });
    assert.equal(derived.state, "present");
    assert.equal(derived.path, temporary.path);
    assert.deepEqual(derived.identity, temporary.identity);
    assert.equal((await state.classifyTemporary({ consumerRoot: root, temporary })).state, "owned-exact");
    const publication = await publisher.publishPrepared({ consumerRoot: root, plan, temporary });
    assert.equal(publication.outcome, "published");
    assert.equal(publication.identityEvidence, "owned-temporary");
    assert.deepEqual(publication.publicationIdentity, temporary.identity);
    assert.deepEqual(await readFile(join(root, plan.destination)), Buffer.from("# Test\n"));
    const destination = await state.classifyDestination({ consumerRoot: root, plan });
    assert.equal(destination.state, "exact");
    assert.ok([destination.identity.dev, destination.identity.ino, destination.identity.birthtimeNs]
      .every((value) => value !== "0"));
    await publisher.removeOwnedTemporary({ consumerRoot: root, temporary });
    assert.deepEqual(await state.classifyTemporary({ consumerRoot: root, temporary }), { state: "absent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

requiresStrictDirectoryDurability("publication completion verifies bound identity and supports absent temporary", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await publisher.publishPrepared({ consumerRoot: root, plan, temporary });
    const withTemporary = await publisher.completePublication({
      consumerRoot: root,
      plan,
      temporary
    });
    assert.deepEqual(withTemporary.publicationIdentity, temporary.identity);
    await publisher.removeOwnedTemporary({ consumerRoot: root, temporary });
    const withoutTemporary = await publisher.completePublication({
      consumerRoot: root,
      plan,
      temporary
    });
    assert.deepEqual(withoutTemporary.publicationIdentity, temporary.identity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

requiresStrictDirectoryDurability("publication completion rejects same bytes with a different identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await writeFile(join(root, plan.destination), Buffer.from("# Test\n"), { mode: 0o644 });
    await assert.rejects(
      publisher.completePublication({ consumerRoot: root, plan, temporary }),
      /does not match its bound temporary identity/u
    );
    assert.deepEqual(await readFile(join(root, temporary.path)), Buffer.from("# Test\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node document adapters honor cancellation only before mutations may start", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const state = new NodeDocumentFileState();
    const controller = new AbortController();
    controller.abort(new Error("cancel test"));
    await assert.rejects(
      publisher.prepare({ consumerRoot: root, plan, signal: controller.signal }),
      /cancel test/u
    );
    await assert.rejects(
      state.classifyDestination({ consumerRoot: root, plan, signal: controller.signal }),
      /cancel test/u
    );
    await assert.rejects(
      state.classifyDerivedTemporary({ consumerRoot: root, plan, signal: controller.signal }),
      /cancel test/u
    );
    await assert.rejects(
      state.classifyTemporary({
        consumerRoot: root,
        signal: controller.signal,
        temporary: {
          path: documentTemporaryPath(plan.destination, plan.planDigest),
          digest: plan.output.digest,
          identity: {
            adapter: "node-filesystem",
            version: 1,
            dev: "1",
            ino: "1",
            birthtimeNs: "1"
          }
        }
      }),
      /cancel test/u
    );
    await assert.rejects(readFile(join(root, documentTemporaryPath(
      plan.destination,
      plan.planDigest
    ))), /ENOENT/u);
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
    assert.equal((await state.classifyTemporary({ consumerRoot: root, temporary: zero })).state, "unverifiable");
    await rm(join(root, "docs"), { recursive: true });
    await import("node:fs/promises").then(({ symlink }) => symlink(outside, join(root, "docs"), "dir"));
    assert.equal((await state.classifyDestination({ consumerRoot: root, plan })).state, "unverifiable");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("zero identity remains wire evidence but grants no mutation authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const temporary = {
      path: documentTemporaryPath(plan.destination, plan.planDigest),
      digest: plan.output.digest,
      identity: {
        adapter: "node-filesystem",
        version: 1,
        dev: "0",
        ino: "0",
        birthtimeNs: "0"
      }
    };
    assert.doesNotThrow(() => assertDocumentPhysicalIdentity(temporary.identity));
    assert.throws(
      () => assertNonzeroDocumentPhysicalIdentity(temporary.identity),
      /grants no mutation authority/u
    );
    await writeFile(join(root, temporary.path), Buffer.from("# Test\n"), { mode: 0o644 });
    const publisher = new NodeDocumentPublisher();
    await assert.rejects(
      publisher.publishPrepared({ consumerRoot: root, plan, temporary }),
      /grants no mutation authority/u
    );
    await assert.rejects(
      publisher.removeOwnedTemporary({ consumerRoot: root, temporary }),
      /grants no mutation authority/u
    );
    assert.deepEqual(await readFile(join(root, temporary.path)), Buffer.from("# Test\n"));
    await assert.rejects(readFile(join(root, plan.destination)), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

requiresStrictDirectoryDurability("already-satisfied publication reports the destination identity without claiming ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const firstTemporary = await publisher.prepare({ consumerRoot: root, plan });
    const first = await publisher.publishPrepared({
      consumerRoot: root,
      plan,
      temporary: firstTemporary
    });
    assert.equal(first.outcome, "published");
    await publisher.removeOwnedTemporary({ consumerRoot: root, temporary: firstTemporary });

    const secondTemporary = await publisher.prepare({ consumerRoot: root, plan });
    const second = await publisher.publishPrepared({
      consumerRoot: root,
      plan,
      temporary: secondTemporary
    });
    assert.equal(second.outcome, "already-satisfied");
    assert.deepEqual(second.publicationIdentity, first.publicationIdentity);
    assert.notDeepEqual(second.publicationIdentity, secondTemporary.identity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

requiresStrictDirectoryDurability("derived temporary inspection preserves a foreign replacement in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-writer-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Test\n"));
    const publisher = new NodeDocumentPublisher();
    const state = new NodeDocumentFileState();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await rename(join(root, temporary.path), `${join(root, temporary.path)}.owned`);
    await writeFile(join(root, temporary.path), "foreign replacement\n");
    await assert.rejects(
      publisher.removeOwnedTemporary({ consumerRoot: root, temporary }),
      /replaced and was preserved/u
    );
    const derived = await state.classifyDerivedTemporary({ consumerRoot: root, plan });
    assert.equal(derived.state, "present");
    const residue = (await readdir(join(root, "docs"))).find((entry) =>
      entry.includes("foundation-owned-cleanup-"));
    assert.equal(residue, undefined);
    assert.equal(
      await readFile(join(root, temporary.path), "utf8"),
      "foreign replacement\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
