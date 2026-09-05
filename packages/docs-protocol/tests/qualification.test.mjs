import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import assert from "node:assert/strict";
import { access, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planDocumentationDocument } from "@agent-teams/document-authoring";
import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";
import { NodeCodeAnchorMatcher } from "../dist/features/portable-documentation/adapters/outbound/node-code-anchor-matcher.js";
import { NodeDocsAdoptionInspector } from "../dist/features/portable-documentation/adapters/outbound/node-adoption-inspector.js";
import { NodeDocsProfileReader } from "../dist/features/portable-documentation/adapters/outbound/node-profile-reader.js";
import { NodeDocumentAuthoringPort } from "../dist/features/portable-documentation/adapters/outbound/document-authoring-port.js";
import { runDocsProtocolQualification } from "../dist/features/qualification/adapters/run-qualification.js";
import {
  crashAfterDurablePublication,
  crashAtDurablePublishing
} from "../dist/features/qualification/adapters/crash-driver.js";
import {
  fileSnapshot,
  isQualificationEvidenceExcludedPath,
  isQualificationMutationObservationExcludedPath,
  isQualificationSourceCopyExcludedPath,
  qualificationEvidencePolicy,
  snapshot,
} from "../dist/features/qualification/adapters/filesystem-evidence.js";

const fixtureRoot = new URL("./fixtures/portable-qualification", import.meta.url).pathname;

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

test("qualification separates immutable source exclusions from mutation observation", async () => {
  assert.equal(isQualificationSourceCopyExcludedPath(".agent-teams-local/journal.json", "directory"), true);
  assert.equal(isQualificationMutationObservationExcludedPath(".agent-teams-local/journal.json", "directory"), false);
  assert.equal(isQualificationSourceCopyExcludedPath("node_modules/package/index.js", "directory"), true);
  assert.equal(isQualificationMutationObservationExcludedPath("packages/example/node_modules/package/index.js", "directory"), true);
  assert.equal(isQualificationSourceCopyExcludedPath(".git", "file"), true);
  assert.equal(isQualificationMutationObservationExcludedPath("packages/example/node_modules", "file"), true);
  assert.equal(isQualificationSourceCopyExcludedPath("target/output", "directory"), true);
  assert.equal(isQualificationSourceCopyExcludedPath("docs/target/governed.md", "directory"), false);
  assert.equal(isQualificationMutationObservationExcludedPath("docs/.cache/preview-side-effect.md", "directory"), false);

  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-mutation-evidence-"));
  try {
    const root = await realpath(temporary);
    const policy = qualificationEvidencePolicy(["docs"]);
    await mkdir(join(temporary, ".agent-teams-local"), { recursive: true });
    await mkdir(join(temporary, ".cache"), { recursive: true });
    await mkdir(join(temporary, "docs", "target"), { recursive: true });
    await mkdir(join(temporary, "agent-runtime", "experiments", "rust-system-boundaries", "target"), { recursive: true });
    await writeFile(join(temporary, ".agent-teams-local", "preview-side-effect.json"), "{}\n");
    await writeFile(join(temporary, ".cache", "ignored-build-output"), "cache\n");
    await writeFile(join(temporary, "docs", "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    await writeFile(join(temporary, "docs", "target", "governed.md"), "# Governed\n");
    const nestedTarget = "agent-runtime/experiments/rust-system-boundaries/target";
    await writeFile(join(temporary, nestedTarget, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# Cargo build cache\n");
    await writeFile(join(temporary, nestedTarget, "2.1gb-equivalent-artifact"), "generated\n");
    assert.equal(await isQualificationEvidenceExcludedPath(root, nestedTarget, policy, "source", "directory"), true);
    assert.equal(await isQualificationEvidenceExcludedPath(root, nestedTarget, policy, "mutation", "directory"), true);
    assert.equal(await isQualificationEvidenceExcludedPath(root, "docs/target", policy, "source", "directory"), false);
    const sourceBefore = await snapshot(root, policy);
    await writeFile(join(temporary, nestedTarget, "2.1gb-equivalent-artifact"), "changed generated\n");
    assert.equal(await snapshot(root, policy), sourceBefore);
    await writeFile(join(temporary, "docs", "target", "governed.md"), "# Governed changed\n");
    assert.notEqual(await snapshot(root, policy), sourceBefore);
    const observation = await fileSnapshot(root, policy);
    assert.equal(observation.has("file:.agent-teams-local/preview-side-effect.json"), true);
    assert.equal(observation.has("file:.cache/ignored-build-output"), false);
    assert.equal(observation.has(`file:${nestedTarget}/2.1gb-equivalent-artifact`), false);
    assert.equal(observation.has("file:docs/target/governed.md"), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification retains regular files named target and .cache without probing children", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "agent-teams-docs-cache-name-files-")));
  const policy = qualificationEvidencePolicy([]);
  const paths = ["target", ".cache", "packages/example/target", "packages/example/.cache"];
  try {
    await mkdir(join(temporary, "packages", "example"), { recursive: true });
    for (const path of paths) {await writeFile(join(temporary, path), `${path}\n`);}
    for (const path of paths) {
      assert.equal(await isQualificationEvidenceExcludedPath(temporary, path, policy, "source", "file"), false);
      assert.equal(await isQualificationEvidenceExcludedPath(temporary, path, policy, "mutation", "file"), false);
    }
    const sourceBefore = await snapshot(temporary, policy);
    const mutationBefore = await fileSnapshot(temporary, policy);
    for (const path of paths) {assert.equal(mutationBefore.has(`file:${path}`), true);}
    await writeFile(join(temporary, "packages", "example", "target"), "changed\n");
    assert.notEqual(await snapshot(temporary, policy), sourceBefore);
    assert.notEqual((await fileSnapshot(temporary, policy)).get("file:packages/example/target"), mutationBefore.get("file:packages/example/target"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
      new URL("../../document-authoring", import.meta.url).pathname,
      join(scope, "document-authoring"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(crashAtDurablePublishing(temporary, {}), /exited before checkpoint/u);
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("qualification cleans its inputs after a crash-child spawn error", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-crash-spawn-error-"));
  const originalExecPath = process.execPath;
  try {
    process.execPath = join(temporary, "missing-node-executable");
    await assert.rejects(
      crashAtDurablePublishing(temporary, {}),
      (error) => error?.code === "ENOENT",
    );
    await assert.rejects(access(join(temporary, ".qualification-crash-plan.json")), (error) => error?.code === "ENOENT");
    await assert.rejects(access(join(temporary, ".qualification-crash-worker.mjs")), (error) => error?.code === "ENOENT");
  } finally {
    process.execPath = originalExecPath;
    await rm(temporary, { recursive: true, force: true });
  }
});

const requiresStrictDirectoryDurability = process.platform === "win32" ? test.skip : test;

async function withCorruptedProfileCrash(crash, callback) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "agent-teams-docs-corrupt-profile-")),
  );
  const consumerRoot = join(temporary, "consumer");
  try {
    await cp(fixtureRoot, consumerRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const plan = await planDocumentationDocument({
      consumerRoot,
      profilePath: ".docs-protocol/document-authoring.yaml",
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
    const packageScope = join(consumerRoot, "node_modules", "@agent-teams");
    await mkdir(packageScope, { recursive: true });
    await symlink(
      new URL("../../document-authoring", import.meta.url).pathname,
      join(packageScope, "document-authoring"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await writeFile(
      join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "agent-teams-document-authoring-qualification-fixture",
        consumerRoot: await realpath(consumerRoot)
      })}\n`,
      "utf8"
    );
    await crash(consumerRoot, plan);
    await writeFile(join(consumerRoot, "docs.config.yaml"), "not: [valid\n", "utf8");
    await writeFile(join(consumerRoot, ".docs-protocol/document-authoring.yaml"), "not: [valid\n", "utf8");
    await callback({ consumerRoot, plan, protocol: createDocsProtocolApi(new DocsProtocol({ compiledOutput: new YamlCompiledOutputReader(), searchIndex: createCommunityMiniSearchIndex(),
      adoption: new NodeDocsAdoptionInspector(),
      anchors: new NodeCodeAnchorMatcher(),
      foundation: new NodeDocumentAuthoringPort(),
      profiles: new NodeDocsProfileReader()
    })) });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

requiresStrictDirectoryDurability("before durable publication, corrupted mutable profiles require recovery and preserve evidence", async () => {
  await withCorruptedProfileCrash(crashAtDurablePublishing, async ({ consumerRoot, plan, protocol }) => {
    const journalPath = join(consumerRoot, ".agent-teams-local", "scaffolding-transaction.json");
    const evidenceBefore = await readFile(journalPath);
    await assert.rejects(access(join(consumerRoot, plan.destination)), (error) => error?.code === "ENOENT");
    const recovered = await protocol.recoverV2({
      consumerRoot,
      profilePath: "docs.config.yaml"
    });
    assert.equal(recovered.exitCode, 1, JSON.stringify(recovered.envelope));
    assert.equal(recovered.envelope.outcome, "recovery-required");
    assert.equal(recovered.envelope.result.transactionState, "recovery-required");
    assert.equal(recovered.envelope.result.writeState, "unchanged");
    assert.equal(recovered.envelope.diagnostics[0].ruleId, "document.transaction.recovery-authority");
    assert.deepEqual(await readFile(journalPath), evidenceBefore);
    await assert.rejects(access(join(consumerRoot, plan.destination)), (error) => error?.code === "ENOENT");
  });
});

requiresStrictDirectoryDurability("after durable publication, recovery uses persisted authority when both mutable profiles are corrupted", async () => {
  await withCorruptedProfileCrash(crashAfterDurablePublication, async ({ consumerRoot, plan, protocol }) => {
    assert.equal(
      await readFile(join(consumerRoot, plan.destination), "utf8"),
      Buffer.from(plan.output.contentBase64, "base64").toString("utf8")
    );
    const recovered = await protocol.recoverV2({
      consumerRoot,
      profilePath: "docs.config.yaml"
    });
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.envelope));
    assert.equal(recovered.envelope.result.transactionState, "recovered");
    await lstat(join(consumerRoot, plan.destination));
  });
});
