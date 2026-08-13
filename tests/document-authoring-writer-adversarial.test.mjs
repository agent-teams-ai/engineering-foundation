import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sha256Bytes } from "../packages/engineering-foundation/dist/canonical-json.js";
import { NodeDocumentFileState } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-file-state.js";
import { NodeDocumentJournalStore } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-journal-store-private.js";
import { NodeDocumentPublisher } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-publisher-private.js";
import { documentPlanDigest } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";
import {
  applyNodeDocumentationPlanPrivately
} from "../packages/engineering-foundation/dist/document-authoring/composition/node-document-writing-private.js";
import {
  planDocumentationDocument
} from "../packages/engineering-foundation/dist/document-authoring/index.js";

const planningFixture = fileURLToPath(new URL(
  "fixtures/document-planning/orchestrator/",
  import.meta.url
));

function planFor(bytes = Buffer.from("# Adversarial fixture\n")) {
  const plan = {
    schemaVersion: 1,
    protocolVersion: 1,
    compiler: {
      id: "adversarial-test",
      version: "1.0.0",
      buildIdentity: `sha256:${"1".repeat(64)}`
    },
    projectId: "disposable-adversarial-fixture",
    intent: {
      schemaVersion: 1,
      type: "adr",
      id: "adr.adversarial",
      title: "Adversarial fixture",
      owner: "test",
      summary: "Disposable writer qualification"
    },
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
    destination: "docs/adversarial.md",
    expectedParent: { path: "docs", state: "directory", ancestry: "real-directories" },
    destinationPrecondition: { state: "absent" },
    output: {
      contentBase64: bytes.toString("base64"),
      digest: sha256Bytes(bytes),
      mediaType: "text/markdown; charset=utf-8",
      mode: "0644",
      size: bytes.length
    },
    requiredAdapterCapabilities: ["create-file-no-replace/v1"],
    diagnostics: [],
    planDigest: `sha256:${"0".repeat(64)}`
  };
  plan.planDigest = documentPlanDigest(plan);
  return plan;
}

async function withRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "foundation-doc-adversarial-"));
  try {
    await mkdir(join(root, "docs"));
    await mkdir(join(root, ".agent-teams-local"));
    await run(root, planFor());
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withPlanningRepository(run) {
  const root = await mkdtemp(join(tmpdir(), "foundation-doc-adversarial-e2e-"));
  try {
    await cp(planningFixture, root, { recursive: true });
    const { cases, profilePath } = JSON.parse(
      await readFile(join(root, "cases.json"), "utf8")
    );
    const vector = cases.find(({ name }) => name === "adr");
    assert.ok(vector);
    const plan = await planDocumentationDocument({
      consumerRoot: root,
      intent: vector.intent,
      profilePath
    });
    await run(root, plan);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function temporaryAbsolute(root, plan) {
  return join(root, documentTemporaryPath(plan.destination, plan.planDigest));
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

function systemError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("zero temporary identity grants no publication or cleanup authority", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    const zero = {
      ...temporary,
      identity: { ...temporary.identity, ino: "0" }
    };
    await assert.rejects(
      publisher.publishPrepared({ consumerRoot: root, plan, temporary: zero }),
      /grants no mutation authority/u
    );
    await assert.rejects(
      publisher.removeOwnedTemporary({ consumerRoot: root, temporary: zero }),
      /grants no mutation authority/u
    );
    assert.deepEqual(await readFile(temporaryAbsolute(root, plan)),
      Buffer.from(plan.output.contentBase64, "base64"));
    await assertAbsent(join(root, plan.destination));
  });
});

test("a replaced temporary is preserved and never published", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    const path = temporaryAbsolute(root, plan);
    await rename(path, `${path}.original`);
    await writeFile(path, "foreign replacement\n", { mode: 0o644 });
    await assert.rejects(
      publisher.publishPrepared({ consumerRoot: root, plan, temporary }),
      /identity|changed|temporary/iu
    );
    assert.equal(await readFile(path, "utf8"), "foreign replacement\n");
    await assertAbsent(join(root, plan.destination));
  });
});

test("same bytes with a replaced destination inode cannot finalize publication", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await publisher.publishPrepared({ consumerRoot: root, plan, temporary });
    const destination = join(root, plan.destination);
    await rename(destination, `${destination}.owned-inode`);
    await writeFile(destination, Buffer.from(plan.output.contentBase64, "base64"), {
      mode: 0o644
    });
    await assert.rejects(
      publisher.completePublication({ consumerRoot: root, plan, temporary }),
      /does not match its bound temporary identity/u
    );
    assert.deepEqual(await readFile(destination),
      Buffer.from(plan.output.contentBase64, "base64"));
    assert.deepEqual(await readFile(temporaryAbsolute(root, plan)),
      Buffer.from(plan.output.contentBase64, "base64"));
  });
});

test("ENOSPC during temporary creation leaves no destination or temporary", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher({
      async open() { throw systemError("ENOSPC", "injected ENOSPC"); }
    });
    await assert.rejects(
      publisher.prepare({ consumerRoot: root, plan }),
      (error) => error?.code === "ENOSPC"
    );
    await assertAbsent(temporaryAbsolute(root, plan));
    await assertAbsent(join(root, plan.destination));
  });
});

test("unsupported hard links preserve the exact temporary and no destination", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher({
      async link() { throw systemError("ENOTSUP", "hard links unsupported"); }
    });
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await assert.rejects(
      publisher.publishPrepared({ consumerRoot: root, plan, temporary }),
      (error) => error?.code === "ENOTSUP" || /unsupported/u.test(error?.message)
    );
    assert.deepEqual(await readFile(temporaryAbsolute(root, plan)),
      Buffer.from(plan.output.contentBase64, "base64"));
    await assertAbsent(join(root, plan.destination));
  });
});

test("directory sync failure before temporary creation is mutation-free", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher({
      async syncDirectoryStrictly() {
        throw systemError("EINVAL", "directory sync unsupported");
      }
    });
    await assert.rejects(
      publisher.prepare({ consumerRoot: root, plan }),
      /directory sync unsupported/u
    );
    await assertAbsent(temporaryAbsolute(root, plan));
    await assertAbsent(join(root, plan.destination));
  });
});

test("directory sync failure after hard-link preserves both publication evidence paths", async () => {
  await withRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher({
      async syncDirectoryDurably() {
        throw systemError("EIO", "post-link directory sync failed");
      }
    });
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    await assert.rejects(
      publisher.publishPrepared({ consumerRoot: root, plan, temporary }),
      /post-link directory sync failed/u
    );
    assert.deepEqual(await readFile(join(root, plan.destination)),
      Buffer.from(plan.output.contentBase64, "base64"));
    assert.deepEqual(await readFile(temporaryAbsolute(root, plan)),
      Buffer.from(plan.output.contentBase64, "base64"));
  });
});

test("corrupt, unknown, and duplicate journal evidence is preserved fail-closed", async () => {
  for (const scenario of ["corrupt", "unknown", "duplicate"]) {
    await withRepository(async (root) => {
      const state = join(root, ".agent-teams-local");
      const journal = join(state, "scaffolding-transaction.json");
      const transition = `${journal}.document-transition`;
      const bytes = scenario === "corrupt"
        ? "{not-json\n"
        : `${JSON.stringify({ schemaVersion: 99, payloadKind: "unknown/v99" })}\n`;
      await writeFile(journal, bytes, { mode: 0o600 });
      if (scenario === "duplicate") {
        await writeFile(transition, "duplicate evidence\n", { mode: 0o600 });
      }
      const store = new NodeDocumentJournalStore(journal);
      await assert.rejects(
        store.read(),
        scenario === "duplicate"
          ? /transition evidence was preserved/u
          : /invalid strict canonical JSON/u
      );
      assert.equal(await readFile(journal, "utf8"), bytes);
      if (scenario === "duplicate") {
        assert.equal(await readFile(transition, "utf8"), "duplicate evidence\n");
      }
      assert.ok((await readdir(state)).includes("scaffolding-transaction.json"));
    });
  }
});

test("file-state refuses cleanup after a temporary inode replacement", async () => {
  await withPlanningRepository(async (root, plan) => {
    const publisher = new NodeDocumentPublisher();
    const state = new NodeDocumentFileState();
    const temporary = await publisher.prepare({ consumerRoot: root, plan });
    const path = temporaryAbsolute(root, plan);
    await rename(path, `${path}.owned`);
    await writeFile(path, Buffer.from(plan.output.contentBase64, "base64"), {
      mode: 0o644
    });
    assert.equal(
      (await state.classifyTemporary({ consumerRoot: root, temporary })).state,
      "conflict"
    );
    await assert.rejects(
      publisher.removeOwnedTemporary({ consumerRoot: root, temporary }),
      /replaced and was preserved/u
    );
    const derived = await state.classifyDerivedTemporary({ consumerRoot: root, plan });
    assert.equal(derived.state, "unverifiable");
    assert.match(derived.reason, /cleanup residue/u);
    const temporaryParent = dirname(path);
    const residue = (await readdir(temporaryParent)).find((entry) =>
      entry.includes("foundation-owned-cleanup-"));
    assert.ok(residue);
    assert.deepEqual(
      await readFile(join(temporaryParent, residue, "owned-temporary")),
      Buffer.from(plan.output.contentBase64, "base64")
    );
    const before = await readFile(join(temporaryParent, residue, "owned-temporary"));
    const receipt = await applyNodeDocumentationPlanPrivately({ consumerRoot: root, plan });
    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.match(
      receipt.diagnostics.map(({ message }) => message).join("\n"),
      /cleanup residue|evidence was preserved/u
    );
    assert.deepEqual(
      await readFile(join(temporaryParent, residue, "owned-temporary")),
      before
    );
    await assert.rejects(lstat(join(root, plan.destination)),
      (error) => error?.code === "ENOENT");
  });
});

test("post-publication authority drift retains the destination and durable recovery journal", async () => {
  await withPlanningRepository(async (root, plan) => {
    let drifted = false;
    const receipt = await applyNodeDocumentationPlanPrivately(
      { consumerRoot: root, plan },
      {
        async faultInjector(point) {
          if (!drifted && point.phase === "after-published-journal-durable") {
            await writeFile(
              join(root, plan.authority.ownerCatalog.path),
              "changed-authority\n",
              "utf8"
            );
            drifted = true;
          }
        }
      }
    );
    assert.equal(drifted, true);
    assert.equal(receipt.outcome, "recovery-required");
    assert.deepEqual(await readFile(join(root, plan.destination)),
      Buffer.from(plan.output.contentBase64, "base64"));
    await lstat(join(root, ".agent-teams-local", "scaffolding-transaction.json"));
  });
});

test("cancellation before publication is reported only after journal and temp cleanup", async () => {
  await withPlanningRepository(async (root, plan) => {
    const controller = new AbortController();
    const receipt = await applyNodeDocumentationPlanPrivately(
      { consumerRoot: root, plan, signal: controller.signal },
      {
        faultInjector(point) {
          if (point.phase === "after-prepared-journal-durable") {
            controller.abort(new Error("cancel after durable PREPARED"));
          }
        }
      }
    );
    assert.equal(receipt.outcome, "cancelled");
    await assertAbsent(join(root, plan.destination));
    await assertAbsent(temporaryAbsolute(root, plan));
    await assertAbsent(join(root, ".agent-teams-local", "scaffolding-transaction.json"));
  });
});

test("cancellation after hard-link is masked until a truthful committed receipt", async () => {
  await withPlanningRepository(async (root, plan) => {
    const controller = new AbortController();
    let linked = false;
    const receipt = await applyNodeDocumentationPlanPrivately(
      { consumerRoot: root, plan, signal: controller.signal },
      {
        faultInjector(point) {
          if (point.phase === "after-hard-link") {
            linked = true;
            controller.abort(new Error("cancel after hard-link"));
          }
        }
      }
    );
    assert.equal(linked, true);
    assert.equal(receipt.outcome, "applied");
    assert.deepEqual(await readFile(join(root, plan.destination)),
      Buffer.from(plan.output.contentBase64, "base64"));
    await assertAbsent(temporaryAbsolute(root, plan));
    await assertAbsent(join(root, ".agent-teams-local", "scaffolding-transaction.json"));
  });
});
