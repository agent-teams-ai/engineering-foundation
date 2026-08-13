import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sha256Bytes } from "../packages/engineering-foundation/dist/canonical-json.js";
import { NodeDocumentPublisher } from "../packages/engineering-foundation/dist/document-authoring/adapters/node/node-document-publisher.js";
import { documentPlanDigest } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../packages/engineering-foundation/dist/document-authoring/application/policies/document-temporary-path.js";
import {
  applyDocumentationPlan,
  inspectDocumentTransactionV1,
  planDocumentationDocument
} from "../packages/engineering-foundation/dist/document-authoring/index.js";
import { StrictDirectoryDurabilityError } from "../packages/engineering-foundation/dist/repository-mutation/adapters/node/node-directory-durability.js";
import { createNodeFoundationCleanupTransition } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";

const fixtures = fileURLToPath(
  new URL("fixtures/document-planning/orchestrator/", import.meta.url)
);
const windowsTest = process.platform === "win32" ? test : test.skip;

function planFor(bytes) {
  const plan = {
    schemaVersion: 1,
    protocolVersion: 1,
    compiler: {
      id: "windows-qualification",
      version: "1.0.0",
      buildIdentity: `sha256:${"1".repeat(64)}`
    },
    projectId: "windows-qualification",
    intent: {
      schemaVersion: 1,
      type: "test",
      id: "test.windows-qualification",
      title: "Windows qualification",
      owner: "test",
      summary: "Proves unsupported strict directory durability fails closed."
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
    destination: "docs/windows-qualification.md",
    expectedParent: { path: "docs", state: "directory", ancestry: "real-directories" },
    destinationPrecondition: { state: "absent" },
    output: {
      digest: sha256Bytes(bytes),
      size: bytes.length,
      mode: "0644",
      mediaType: "text/markdown; charset=utf-8",
      contentBase64: bytes.toString("base64")
    },
    requiredAdapterCapabilities: ["create-file-no-replace/v1"],
    diagnostics: [],
    planDigest: `sha256:${"0".repeat(64)}`
  };
  plan.planDigest = documentPlanDigest(plan);
  return plan;
}

async function missing(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

windowsTest("Windows refuses publication when strict directory durability is unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-windows-"));
  try {
    await mkdir(join(root, "docs"));
    const plan = planFor(Buffer.from("# Windows fail-closed qualification\n"));
    const publisher = new NodeDocumentPublisher();

    await assert.rejects(
      publisher.prepare({ consumerRoot: root, plan }),
      (error) => error?.name === StrictDirectoryDurabilityError.name &&
        error.message.includes(join(root, "docs"))
    );
    await missing(join(root, documentTemporaryPath(plan.destination, plan.planDigest)));
    await missing(join(root, plan.destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest("Windows public writer fails closed and preserves recovery evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-document-windows-public-"));
  try {
    await cp(fixtures, root, { recursive: true });
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
    const receipt = await applyDocumentationPlan({ consumerRoot: root, plan });

    assert.equal(receipt.outcome, "manual-recovery-required");
    assert.deepEqual(receipt.commit, {
      atomicity: "not-applicable",
      publication: "none",
      recoverability: "preserved-for-recovery",
      state: "manual-recovery-required"
    });
    assert.match(
      receipt.diagnostics.map(({ message }) => message).join("\n"),
      /Journal creation reported failure and durable state is unverifiable/u
    );
    await missing(join(root, plan.destination));

    const stateDirectory = join(root, ".agent-teams-local");
    assert.deepEqual((await readdir(stateDirectory)).toSorted(), [
      "foundation-operation.lock",
      "scaffolding-transaction.json.document-transition"
    ]);
    assert.ok((await lstat(join(
      stateDirectory,
      "scaffolding-transaction.json.document-transition"
    ))).isFile());
    const inspection = await inspectDocumentTransactionV1(root);
    assert.equal(inspection.state, "manual-recovery-required");
    assert.equal(inspection.reason, "journal-transition-residue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest("Windows cleanup marker authority fails closed on unsupported directory fsync", async () => {
  const root = await mkdtemp(join(tmpdir(), "foundation-cleanup-marker-windows-"));
  try {
    const token = "d".repeat(64);
    await assert.rejects(
      createNodeFoundationCleanupTransition(root, token).begin(),
      (error) => error instanceof Error &&
        "code" in error &&
        ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(error.code)
    );
    assert.deepEqual(
      await readdir(join(root, ".agent-teams-local")),
      [`foundation-transaction.cleanup-residue.${token}`]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
