import assert from "node:assert/strict";
import { access, cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planDocumentationDocument } from "../../engineering-foundation/dist/document-authoring/index.js";
import { applyNodeDocumentationPlanPrivately } from "../../engineering-foundation/dist/document-authoring/composition/node-document-writing-private.js";
import { DocsProtocol } from "../dist/application/docs-protocol.js";
import { NodeCodeAnchorMatcher } from "../dist/adapters/node-code-anchor-matcher.js";
import { NodeDocsAdoptionInspector } from "../dist/adapters/node-adoption-inspector.js";
import { NodeDocsProfileReader } from "../dist/adapters/node-profile-reader.js";
import { NodeFoundationDocsPort } from "../dist/adapters/foundation-docs-port.js";
import { runDocsProtocolQualification } from "../dist/qualification/index.js";
import { crashAtDurablePublishing } from "../dist/qualification/crash-driver.js";

const fixtureRoot = new URL("./fixtures/qualification", import.meta.url).pathname;

test("shared qualification runner mutates only its owned disposable copy", async () => {
  const receipt = await runDocsProtocolQualification({
    fixtureRoot,
    scenario: {
      find: { query: { type: "adr" }, expectedIds: [] },
      newDocument: {
        intent: {
          type: "adr",
          id: "ADR-0001",
          title: "Qualification decision",
          owner: "architecture/tooling",
          summary: "Proves the shared disposable qualification workflow."
        }
      }
    }
  });
  assert.equal(receipt.projectId, "docs-protocol-qualification");
  assert.equal(receipt.appliedDocumentPath, "docs/decisions/generated/0001-qualification-decision.md");
  assert.deepEqual(receipt.checks, ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"]);
});

test("qualification crash child honors pre-cancellation without materializing inputs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-cancelled-crash-"));
  try {
    await assert.rejects(
      crashAtDurablePublishing(temporary, {}, AbortSignal.abort()),
      (error) => error?.name === "AbortError",
    );
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification awaits an early crash-child exit before cleaning its inputs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-early-crash-exit-"));
  const scope = join(temporary, "node_modules", "@agent-teams");
  try {
    await mkdir(scope, { recursive: true });
    await symlink(
      new URL("../../engineering-foundation", import.meta.url).pathname,
      join(scope, "engineering-foundation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(crashAtDurablePublishing(temporary, {}), /exited before checkpoint/u);
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const requiresStrictDirectoryDurability = process.platform === "win32" ? test.skip : test;

requiresStrictDirectoryDurability("recovery uses persisted transaction authority after both mutable profiles are corrupted", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-corrupt-profile-"));
  const consumerRoot = join(temporary, "consumer");
  try {
    await cp(fixtureRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const plan = await planDocumentationDocument({
      consumerRoot,
      profilePath: "architecture/foundation/document-authoring.yaml",
      parentPolicy: "create-missing-real-directories",
      intent: {
        schemaVersion: 1,
        type: "adr",
        id: "ADR-0002",
        title: "Crash recovery",
        owner: "architecture/tooling",
        summary: "Proves recovery is independent of mutable profiles."
      }
    });
    assert.equal(plan.schemaVersion, 2);
    assert.deepEqual(plan.parentMaterialization.missingDirectories, ["docs/decisions/generated"]);
    const interrupted = await applyNodeDocumentationPlanPrivately(
      { consumerRoot, plan },
      {
        faultInjector(point) {
          if (point.phase === "after-published-journal-durable") {
            throw new Error("simulated process crash after durable publication state");
          }
        }
      }
    );
    assert.equal(interrupted.outcome, "recovery-required");
    await writeFile(join(consumerRoot, "architecture/foundation/docs-protocol.yaml"), "not: [valid\n", "utf8");
    await writeFile(join(consumerRoot, "architecture/foundation/document-authoring.yaml"), "not: [valid\n", "utf8");

    const protocol = new DocsProtocol({
      adoption: new NodeDocsAdoptionInspector(),
      anchors: new NodeCodeAnchorMatcher(),
      foundation: new NodeFoundationDocsPort(),
      profiles: new NodeDocsProfileReader()
    });
    const recovered = await protocol.recover({
      consumerRoot,
      profilePath: "architecture/foundation/docs-protocol.yaml"
    });
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.envelope));
    assert.equal(recovered.envelope.result.transactionState, "recovered");
    await lstat(join(consumerRoot, plan.destination));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
