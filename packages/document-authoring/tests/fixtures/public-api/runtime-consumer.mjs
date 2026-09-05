import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDocumentationPlan,
  applyDocumentationPlanV2,
  inspectDocumentTransactionV2,
  planDocumentationDocument,
  planDocumentationDocumentV2,
  recoverDocumentationTransaction,
  recoverDocumentationTransactionV2
} from "@agent-teams/document-authoring";

const [consumerRoot, generationText, entrypoint, operation, checkpoint] = process.argv.slice(2);
const generation = Number(generationText);
assert.ok([1, 2].includes(generation));
assert.ok(["generic", "V2"].includes(entrypoint));
assert.ok(["plan", "apply", "recover"].includes(operation));
const installedRoot = fileURLToPath(new URL("..", import.meta.resolve("@agent-teams/document-authoring")));
assert.equal(installedRoot, join(dirname(consumerRoot), "node_modules/@agent-teams/document-authoring/"));

async function snapshot(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64");
  }
  return result;
}

async function prepareRequest() {
  const { cases, profilePath } = JSON.parse(await readFile(join(consumerRoot, "cases.json"), "utf8"));
  const vector = cases.find(({ name }) => name === (generation === 1 ? "adr" : "feature"));
  assert.ok(vector);
  if (generation === 2) {
    const path = join(consumerRoot, profilePath);
    const profile = await readFile(path, "utf8");
    await writeFile(path, profile.replace("schemaVersion: 1", "schemaVersion: 2")
      .replaceAll(/(    - type: [^\n]+\n)/gu,
        "$1      allowedOwnerIds: [architecture/tooling, example/create-widget]\n")
      .replace("reachability: {kind: not-required}",
        "reachability: {kind: not-required, reason: indexed by bounded-context hierarchy}"));
    await rm(join(consumerRoot, "packages/example/src/features/create-widget"), { recursive: true });
  }
  return {
    vector,
    request: { consumerRoot, profilePath, intent: vector.intent,
      ...(generation === 2 ? { parentPolicy: "create-missing-real-directories" } : {}) }
  };
}

async function assertPlan(request, vector) {
  const before = await snapshot(consumerRoot);
  const plan = await planDocumentationDocument(request);
  assert.equal(plan.schemaVersion, generation);
  assert.equal(plan.protocolVersion, generation);
  assert.equal(plan.compiler.id, "@agent-teams/document-authoring");
  assert.equal(plan.destination, vector.destination);
  // Frozen fixture bytes provide an oracle independent of the planner output.
  const expected = await readFile(join(consumerRoot, vector.expected));
  assert.deepEqual(Buffer.from(plan.output.contentBase64, "base64"), expected);
  assert.equal(plan.output.digest, `sha256:${createHash("sha256").update(expected).digest("hex")}`);
  if (generation === 1) {
    assert.equal(Object.hasOwn(plan, "parentMaterialization"), false);
    assert.deepEqual(plan.requiredAdapterCapabilities, ["create-file-no-replace/v1"]);
    await assert.rejects(planDocumentationDocumentV2({ ...request,
      parentPolicy: "create-missing-real-directories" }), { code: "DOCUMENT_PLANNING_INPUT_INVALID" });
  } else {
    assert.equal(plan.parentMaterialization.policy, "create-missing-real-directories");
    assert.deepEqual(plan.parentMaterialization.missingDirectories, ["packages/example/src/features/create-widget"]);
    assert.deepEqual(await planDocumentationDocumentV2(request), plan);
    const { parentPolicy, ...withoutPolicy } = request;
    assert.equal(parentPolicy, "create-missing-real-directories");
    await assert.rejects(planDocumentationDocument(withoutPolicy), { code: "DOCUMENT_PLANNING_INPUT_INVALID" });
  }
  await assert.rejects(applyDocumentationPlan({ consumerRoot, plan: {} }));
  assert.deepEqual(await snapshot(consumerRoot), before);
  return plan;
}

function assertReceipt(receipt, plan, outcome) {
  assert.equal(receipt.schemaVersion, generation);
  assert.equal(receipt.protocolVersion, generation);
  assert.equal(receipt.outcome, outcome);
  assert.equal(receipt.planDigest, plan.planDigest);
  assert.equal(receipt.destination, plan.destination);
  assert.equal(receipt.resultDigest, plan.output.digest);
  assert.match(receipt.receiptDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(receipt.commit, {
    state: "committed", publication: outcome === "applied" ? "published" : "preexisting-exact",
    [generation === 1 ? "atomicity" : "fileAtomicity"]:
      outcome === "applied" ? "single-file-atomic-create" : "not-applicable",
    recoverability: "not-required"
  });
  if (generation === 1) {
    assert.equal(Object.hasOwn(receipt, "directoryMaterialization"), false);
  } else {
    assert.deepEqual(receipt.directoryMaterialization, {
      state: outcome === "applied" ? "created-and-retained" : "none-created",
      plannedDirectories: plan.parentMaterialization.missingDirectories,
      observedCreatedDirectories: outcome === "applied" ? plan.parentMaterialization.missingDirectories : []
    });
  }
}

async function crashAndRecover(plan) {
  const planPath = `${consumerRoot}.plan.json`;
  await writeFile(planPath, JSON.stringify(plan));
  const crashed = spawnSync(process.execPath, [fileURLToPath(new URL("./crash-worker.mjs", import.meta.url)),
    consumerRoot, planPath, checkpoint], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(crashed.error, undefined, crashed.error?.message);
  assert.equal(crashed.status, null, `${crashed.stdout}${crashed.stderr}`);
  assert.equal(crashed.signal, "SIGKILL");
  const journalPath = join(consumerRoot, ".agent-teams-local/scaffolding-transaction.json");
  const journalBytes = await readFile(journalPath);
  const inspection = await inspectDocumentTransactionV2(consumerRoot);
  assert.equal(inspection.state, "recoverable");
  assert.equal(inspection.format, `document-authoring-envelope-v${generation + 2}`);
  assert.equal(inspection.recovery.exactFoundationBuildIdentity, plan.compiler.buildIdentity);
  assert.deepEqual(await readFile(journalPath), journalBytes);
  if (checkpoint === "after-publishing-journal-durable") {
    await assert.rejects(lstat(join(consumerRoot, plan.destination)), { code: "ENOENT" });
  } else {
    assert.deepEqual(await readFile(join(consumerRoot, plan.destination)), Buffer.from(plan.output.contentBase64, "base64"));
  }
  const recover = entrypoint === "V2" ? recoverDocumentationTransactionV2 : recoverDocumentationTransaction;
  const receipt = await recover({ consumerRoot });
  await assert.rejects(lstat(journalPath), { code: "ENOENT" });
  return receipt;
}

async function assertApplyReplay(plan) {
  const apply = generation === 2 && entrypoint === "V2" ? applyDocumentationPlanV2 : applyDocumentationPlan;
  const receipt = operation === "recover" ? await crashAndRecover(plan)
    : await apply({ consumerRoot, plan: JSON.parse(JSON.stringify(plan)) });
  assertReceipt(receipt, plan, "applied");
  const path = join(consumerRoot, plan.destination);
  const bytes = await readFile(path);
  assert.deepEqual(bytes, Buffer.from(plan.output.contentBase64, "base64"));
  const before = await lstat(path, { bigint: true });
  const replay = await apply({ consumerRoot, plan });
  assertReceipt(replay, plan, "already-applied");
  assert.deepEqual(await readFile(path), bytes);
  const after = await lstat(path, { bigint: true });
  assert.deepEqual([after.dev, after.ino, after.birthtimeNs], [before.dev, before.ino, before.birthtimeNs]);
  assert.equal((await inspectDocumentTransactionV2(consumerRoot)).state, "idle");
  // No fabricated receipt when there is no supported persisted transaction.
  for (const recover of [recoverDocumentationTransaction, recoverDocumentationTransactionV2]) {
    await assert.rejects(recover({ consumerRoot }), /requires a coordinator-qualified recoverable transaction/u);
  }
}

const { request, vector } = await prepareRequest();
const plan = await assertPlan(request, vector);
if (operation !== "plan") { await assertApplyReplay(plan); }
process.stdout.write(JSON.stringify({ generation, entrypoint, operation, outcome: "passed" }));
