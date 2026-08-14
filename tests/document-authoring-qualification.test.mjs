import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  planDocumentationDocument,
  recoverDocumentationTransaction
} from "@agent-teams/engineering-foundation/document-authoring";
import {
  runDocumentAuthoringCrashQualification
} from "@agent-teams/engineering-foundation/document-authoring/qualification";

const fixtureRoot = new URL("fixtures/document-planning/orchestrator/", import.meta.url);
const qualificationUrl = new URL(
  "../packages/engineering-foundation/dist/document-authoring/qualification/index.js",
  import.meta.url
).href;
const checkpointLine = `${JSON.stringify({
  schemaVersion: 1,
  event: "document-authoring-qualification-crash-point",
  crashPoint: "after-publishing-journal-durable"
})}\n`;
const qualified = process.platform === "win32" ? test.skip : test;

async function createPlan(consumerRoot) {
  const profilePath = join(consumerRoot, "document-authoring.yaml");
  const profile = await readFile(profilePath, "utf8");
  await writeFile(profilePath, profile
    .replace("schemaVersion: 1", "schemaVersion: 2")
    .replaceAll(/(    - type: [^\n]+\n)/gu,
      "$1      allowedOwnerIds: [architecture/tooling, example/create-widget]\n")
    .replace("reachability: {kind: not-required}",
      "reachability: {kind: not-required, reason: indexed by bounded-context hierarchy}"));
  await rm(join(consumerRoot, "packages/example/src/features/create-widget"), {
    force: true,
    recursive: true
  });
  const fixture = JSON.parse(await readFile(join(consumerRoot, "cases.json"), "utf8"));
  const vector = fixture.cases.find(({ name }) => name === "feature");
  assert.ok(vector);
  const plan = await planDocumentationDocument({
    consumerRoot,
    profilePath: fixture.profilePath,
    intent: vector.intent,
    parentPolicy: "create-missing-real-directories"
  });
  assert.equal(plan.schemaVersion, 2);
  return plan;
}

async function writeOwnershipMarker(consumerRoot, extra = {}) {
  await writeFile(
    join(consumerRoot, ".agent-teams-document-authoring-qualification-fixture.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "agent-teams-document-authoring-qualification-fixture",
      consumerRoot,
      ...extra
    })}\n`
  );
}

test("qualification subpath is closed and absent from normal authoring", async () => {
  const [normal, qualification] = await Promise.all([
    import("@agent-teams/engineering-foundation/document-authoring"),
    import("@agent-teams/engineering-foundation/document-authoring/qualification")
  ]);
  assert.equal(normal.runDocumentAuthoringCrashQualification, undefined);
  assert.deepEqual(Object.keys(qualification), [
    "runDocumentAuthoringCrashQualification"
  ]);
  const declarations = await readFile(new URL(
    "../packages/engineering-foundation/dist/document-authoring/qualification/index.d.ts",
    import.meta.url
  ), "utf8");
  assert.doesNotMatch(
    declarations,
    /\b(?:callback|faultInjector|hook|adapter|operations|port)\b/iu
  );
  assert.match(declarations, /DocumentPlanV2/u);
  assert.match(declarations, /after-publishing-journal-durable/u);
});

test("qualification rejects a marker with any unowned field before applying", async (t) => {
  const consumerRoot = await realpath(
    await mkdtemp(join(tmpdir(), "foundation-qualification-guard-"))
  );
  t.after(() => rm(consumerRoot, { force: true, recursive: true }));
  await writeOwnershipMarker(consumerRoot, { unowned: true });
  await assert.rejects(
    runDocumentAuthoringCrashQualification({
      consumerRoot,
      plan: {},
      crashPoint: "after-publishing-journal-durable"
    }),
    /exact closed fixture ownership marker/u
  );
});

qualified("qualification signals durable publishing and remains killable for recovery", async (t) => {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), "foundation-qualification-crash-"))
  );
  t.after(() => rm(scratch, { force: true, recursive: true }));
  const consumerRoot = join(scratch, "consumer");
  await cp(fixtureRoot, consumerRoot, { recursive: true });
  const plan = await createPlan(consumerRoot);
  await writeOwnershipMarker(consumerRoot);
  const planPath = join(scratch, "plan.json");
  const workerPath = join(scratch, "worker.mjs");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);
  await writeFile(workerPath, [
    'import { readFile } from "node:fs/promises";',
    `import { runDocumentAuthoringCrashQualification } from ${JSON.stringify(qualificationUrl)};`,
    "const [consumerRoot, planPath] = process.argv.slice(2);",
    'const plan = JSON.parse(await readFile(planPath, "utf8"));',
    'await runDocumentAuthoringCrashQualification({ consumerRoot, plan, crashPoint: "after-publishing-journal-durable" });',
    'process.stderr.write("qualification returned before SIGKILL\\n");',
    "process.exitCode = 2;",
    ""
  ].join("\n"));
  const child = spawn(process.execPath, [workerPath, consumerRoot, planPath], {
    cwd: import.meta.dirname,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`qualification checkpoint timeout: ${stderr}`));
      }, 20_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout === checkpointLine) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (stdout !== checkpointLine) {
          clearTimeout(timeout);
          reject(new Error(
            `qualification exited before checkpoint: ${code}/${signal}: ${stderr}`
          ));
        }
      });
    });
    assert.equal(stdout, checkpointLine);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  const recovered = await recoverDocumentationTransaction({ consumerRoot });
  assert.equal(recovered.schemaVersion, 2);
  assert.equal(recovered.outcome, "applied");
  assert.equal(recovered.planDigest, plan.planDigest);
});
