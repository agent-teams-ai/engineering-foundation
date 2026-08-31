import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  applyKnownFileTransaction,
  compileKnownFileTransactionPlan,
} from "@agent-teams/repository-mutation";
import { assertDocsCommandEnvelopeSchema } from "../dist/adapters/docs-command-envelope-schema-validator.js";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);

async function runJson(arguments_) {
  const result = await execute(process.execPath, [cli.pathname, ...arguments_, "--json"]);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  await assertDocsCommandEnvelopeSchema(envelope);
  return envelope;
}

async function runJsonFailure(arguments_) {
  let failure;
  try {
    await execute(process.execPath, [cli.pathname, ...arguments_, "--json"]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "command must fail");
  assert.equal(failure.stderr, "");
  const envelope = JSON.parse(failure.stdout);
  await assertDocsCommandEnvelopeSchema(envelope);
  return { envelope, exitCode: failure.code };
}

async function snapshotTree(root, relative = "") {
  const directory = join(root, relative);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const snapshot = [];
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const stats = await lstat(join(root, path));
    if (stats.isDirectory()) {
      snapshot.push({ path, type: "directory" });
      snapshot.push(...await snapshotTree(root, path));
    } else if (stats.isFile()) {
      snapshot.push({
        content: (await readFile(join(root, path))).toString("base64"),
        path,
        type: "file",
      });
    } else {
      snapshot.push({ path, type: "unsupported" });
    }
  }
  return snapshot;
}

test("portable CLI flow bootstraps, authors, discovers, and projects agent context end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-portable-e2e-"));
  try {
    const initArguments = [
      "init",
      "--consumer", root,
      "--project-id", "portable-e2e",
      "--owner", "docs/platform",
    ];
    const empty = await snapshotTree(root);
    const preview = await runJson([...initArguments, "--dry-run"]);
    assert.equal(preview.schemaVersion, 3);
    assert.equal(preview.command, "docs.init");
    assert.equal(preview.outcome, "success");
    assert.equal(preview.result.writeState, "preview");
    assert.match(preview.result.planDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(await snapshotTree(root), empty, "init --dry-run must not write");

    const applied = await runJson([
      ...initArguments,
      "--apply",
      "--expect", preview.result.planDigest,
    ]);
    assert.equal(applied.result.writeState, "applied");

    const info = await runJson(["info", "--consumer", root]);
    assert.equal(info.result.projectId, "portable-e2e");
    assert.equal(info.result.agentWorkflow.skillPath, ".agents/skills/docs-authoring/SKILL.md");

    const initialCheck = await runJson(["check", "--consumer", root]);
    assert.equal(initialCheck.outcome, "success");
    assert.equal(initialCheck.diagnostics.some(({ severity }) => severity === "error"), false);

    const newArguments = [
      "new",
      "--consumer", root,
      "--type", "tutorial",
      "--id", "docs.tutorial.getting-started",
      "--title", "Getting started",
      "--owner", "docs/platform",
      "--summary", "A short portable documentation tutorial.",
    ];
    const beforeNewPreview = await snapshotTree(root);
    const newPreview = await runJson([...newArguments, "--dry-run"]);
    assert.equal(newPreview.result.writeState, "preview");
    assert.deepEqual(await snapshotTree(root), beforeNewPreview, "new --dry-run must not write");

    const newApplied = await runJson([...newArguments, "--apply"]);
    assert.equal(newApplied.result.writeState, "applied");
    assert.match(
      await readFile(join(root, "docs/tutorials/getting-started.md"), "utf8"),
      /^# Getting started$/mu,
    );

    const found = await runJson([
      "find", "getting strted", "--fuzzy", "--consumer", root,
    ]);
    assert.equal(found.schemaVersion, 3);
    assert.equal(found.result.ranking, "fuzzy-advisory");
    assert.equal(found.result.documents[0].id, "docs.tutorial.getting-started");

    const context = await runJson([
      "context", "getting strted", "--fuzzy", "--max-documents", "1",
      "--max-bytes", "4096", "--consumer", root,
    ]);
    assert.equal(context.schemaVersion, 3);
    assert.equal(context.result.format, "llms.txt");
    assert.deepEqual(context.result.selection, {
      ranking: "fuzzy-advisory",
      query: { text: "getting strted" }
    });
    assert.deepEqual(context.result.limits, { maxBytes: 4096, maxDocuments: 1 });
    assert.equal(Object.hasOwn(context.result, "ranking"), false);
    assert.equal(context.result.includedDocuments, 1);
    assert.ok(Buffer.byteLength(context.result.content, "utf8") <= 4096);
    assert.match(context.result.content, /Getting started/u);

    const finalCheck = await runJson(["check", "--consumer", root]);
    assert.equal(finalCheck.outcome, "success");

    const beforeRerun = await snapshotTree(root);
    const rerun = await runJson([...initArguments, "--dry-run"]);
    assert.equal(rerun.result.writeState, "current");
    assert.deepEqual(await snapshotTree(root), beforeRerun, "idempotent init preview must not write");

    const currentApply = await runJson([
      ...initArguments,
      "--apply",
      "--expect", rerun.result.planDigest,
    ]);
    assert.equal(currentApply.result.writeState, "current");
    assert.equal(currentApply.result.receiptOutcome, "already-satisfied");
    assert.deepEqual(await snapshotTree(root), beforeRerun, "idempotent init apply must preserve the tree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init apply reports an interrupted transaction as recoverable before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-init-recovery-e2e-"));
  try {
    const initArguments = [
      "init",
      "--consumer", root,
      "--project-id", "portable-recovery-e2e",
      "--owner", "docs/platform",
    ];
    const preview = await runJson([...initArguments, "--dry-run"]);
    const interruptedPlan = compileKnownFileTransactionPlan({ operations: [{
      path: "interrupted-bootstrap-fixture.txt",
      precondition: { state: "absent" },
      postimage: { bytes: Buffer.from("must-not-publish\n", "utf8") },
    }] });
    await assert.rejects(
      applyKnownFileTransaction({
        consumerRoot: root,
        plan: interruptedPlan,
        faultInjector(point) {
          if (point.phase === "after-temporary-authorized") {
            throw new Error("injected init recovery fixture crash");
          }
        },
      }),
      /injected init recovery fixture crash/u,
    );

    const beforeApply = await snapshotTree(root);
    const blocked = await runJsonFailure([
      ...initArguments,
      "--apply",
      "--expect", preview.result.planDigest,
    ]);
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.envelope.schemaVersion, 3);
    assert.equal(blocked.envelope.command, "docs.init");
    assert.equal(blocked.envelope.outcome, "recovery-required");
    assert.deepEqual(blocked.envelope.result, {
      kind: "init",
      operation: "recover",
      writeState: "blocked",
    });
    assert.equal(blocked.envelope.diagnostics[0].ruleId, "docs.init.apply-recovery-required");
    assert.match(blocked.envelope.diagnostics[0].message, /docs-protocol init --recover/u);
    assert.deepEqual(await snapshotTree(root), beforeApply, "blocked init apply must not mutate");

    const recovered = await runJson(["init", "--recover", "--consumer", root]);
    assert.equal(recovered.result.writeState, "recovered");
    const applied = await runJson([
      ...initArguments,
      "--apply",
      "--expect", preview.result.planDigest,
    ]);
    assert.equal(applied.result.writeState, "applied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init dry-run reports an oversized AGENTS route as a schema-valid conflict without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-init-oversized-agents-e2e-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "x".repeat(64 * 1024), "utf8");
    const before = await snapshotTree(root);
    const blocked = await runJsonFailure([
      "init",
      "--consumer", root,
      "--project-id", "portable-oversized-agents-e2e",
      "--owner", "docs/platform",
      "--dry-run",
    ]);
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.envelope.command, "docs.init");
    assert.equal(blocked.envelope.outcome, "conflict");
    assert.equal(blocked.envelope.result.writeState, "blocked");
    assert.equal(
      blocked.envelope.result.issues[0].code,
      "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE",
    );
    assert.deepEqual(await snapshotTree(root), before, "oversized AGENTS preview must not write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init apply waits for an active operation instead of prescribing recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "docs-protocol-init-active-lock-e2e-"));
  const barrierAcquired = Promise.withResolvers();
  const releaseBarrier = Promise.withResolvers();
  let activeOperation;
  try {
    const initArguments = [
      "init",
      "--consumer", root,
      "--project-id", "portable-active-lock-e2e",
      "--owner", "docs/platform",
    ];
    const preview = await runJson([...initArguments, "--dry-run"]);
    const activePlan = compileKnownFileTransactionPlan({ operations: [{
      path: "active-operation-fixture.txt",
      precondition: { state: "absent" },
      postimage: { bytes: Buffer.from("active operation\n", "utf8") },
    }] });
    if (process.platform === "win32") {
      await assert.rejects(
        applyKnownFileTransaction({ consumerRoot: root, plan: activePlan }),
        (error) => error?.code === "KNOWN_FILE_APPLY_UNSUPPORTED"
      );
      return;
    }
    activeOperation = applyKnownFileTransaction({
      consumerRoot: root,
      plan: activePlan,
      async faultInjector(point) {
        if (point.phase === "after-barrier-acquired") {
          barrierAcquired.resolve();
          await releaseBarrier.promise;
        }
      },
    });
    await barrierAcquired.promise;
    const beforeApply = await snapshotTree(root);
    const blocked = await runJsonFailure([
      ...initArguments,
      "--apply",
      "--expect", preview.result.planDigest,
    ]);
    assert.equal(blocked.exitCode, 1);
    assert.equal(blocked.envelope.outcome, "conflict");
    assert.deepEqual(blocked.envelope.result, {
      kind: "init",
      operation: "wait",
      reason: "operation-active",
      writeState: "blocked",
    });
    assert.equal(blocked.envelope.diagnostics[0].ruleId, "docs.init.operation-active");
    assert.match(blocked.envelope.diagnostics[0].message, /Wait for it to finish/u);
    assert.match(blocked.envelope.diagnostics[0].message, /retry the init preview or --apply/u);
    assert.doesNotMatch(blocked.envelope.diagnostics[0].message, /restore that build/u);
    assert.deepEqual(await snapshotTree(root), beforeApply, "active-lock preflight must not mutate");

    const recoverBlocked = await runJsonFailure(["init", "--recover", "--consumer", root]);
    assert.equal(recoverBlocked.exitCode, 1);
    assert.equal(recoverBlocked.envelope.outcome, "conflict");
    assert.deepEqual(recoverBlocked.envelope.result, blocked.envelope.result);
    assert.equal(recoverBlocked.envelope.diagnostics[0].ruleId, "docs.init.operation-active");
    assert.doesNotMatch(recoverBlocked.envelope.diagnostics[0].message, /run .*--recover/iu);
    assert.deepEqual(await snapshotTree(root), beforeApply, "active-lock recover must not mutate");
  } finally {
    releaseBarrier.resolve();
    await activeOperation;
    await rm(root, { recursive: true, force: true });
  }
});
