import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveInstalledPublicKernel } from "../ef70-managed-campaign/installed-public-kernel.ts";
import { controllerText } from "../ef70-managed-campaign/controller-authentication.ts";
import { preflightSteps, validatePreflight } from "./admission.ts";
import { assertRepairedWorkflow, repairedReceiptBlob } from "./authority.ts";
import { assertAuthorityResponse, resultEnvelope } from "./evidence.ts";
import { assertTerminalSuccess, type TerminalObservation } from "./public-command.ts";

const revision = "1234567890abcdef1234567890abcdef12345678";
const requiredSteps = [
  "Install the ordinary producer profile",
  "Build current producer source with its admitted compiler",
  "Run explicit Stack cleanup and require unchanged source",
  "Provision the unchanged frozen managed test tools",
  "Check the complete actual committed delta",
  "Run the unchanged required fast route",
  "Qualify workflow security",
  "Check canonical adoption admission and failure contracts",
] as const;
function preflightFixture() {
  return {
    selection: { runId: "12345", harnessRevision: revision },
    run: {
      id: 12345,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_sha: revision,
      head_branch: "test/ef70-canonical-adoption",
      path: ".github/workflows/ef70-canonical-adoption.yml",
      repository: { id: 1316243988 },
      head_repository: { id: 1316243988 },
    },
    response: {
      total_count: 1,
      jobs: [
        {
          id: 67890,
          name: "ef70-adoption-preflight",
          status: "completed",
          conclusion: "success",
          head_sha: revision,
          steps: requiredSteps.map((name) => ({
            name,
            status: "completed",
            conclusion: "success",
          })),
        },
      ],
    },
  };
}
test("shared text boundary preserves normal package/version characters and refuses actual control bytes", () => {
  for (const value of ["@agent-teams/repository-mutation", "0.8.0"]) {
    assert.equal(controllerText(value, "normal text"), value);
  }
  for (const value of ["with\0nul", "with\rcarriage", "with\nnewline", ""]) {
    assert.throws(() => controllerText(value, "invalid text"));
  }
});
test("preflight requires a complete exact-source successful job and all eight actual steps", () => {
  const { run, response, selection } = preflightFixture();
  assert.deepEqual(preflightSteps, requiredSteps, "Independent literal workflow gate contract");
  assert.equal(validatePreflight(run, response, selection)["head"], revision);
  const missing = structuredClone(response);
  missing.jobs[0]!.steps.pop();
  assert.throws(() => validatePreflight(run, missing, selection));
  const skipped = structuredClone(response);
  skipped.jobs[0]!.steps[0]!.conclusion = "skipped";
  assert.throws(() => validatePreflight(run, skipped, selection));
  const duplicate = structuredClone(response);
  duplicate.jobs[0]!.steps.push({ ...duplicate.jobs[0]!.steps[0]! });
  assert.throws(() => validatePreflight(run, duplicate, selection));
  const partialCensus = { ...response, total_count: 2 };
  assert.throws(() => validatePreflight(run, partialCensus, selection));
  const duplicateJob = structuredClone(response);
  duplicateJob.jobs.push(structuredClone(duplicateJob.jobs[0]!));
  duplicateJob.total_count = 2;
  assert.throws(() => validatePreflight(run, duplicateJob, selection));
});
test("successful feedback for a different producer head, attempt or repository is not reusable", () => {
  const { run, response, selection } = preflightFixture();
  for (const different of [
    { head_sha: "abcdef1234567890abcdef1234567890abcdef12" },
    { run_attempt: 2 },
    { event: "pull_request" },
    { repository: { id: 1333298097 } },
    { head_repository: { id: 1333298097 } },
    { path: ".github/workflows/ef70-managed-campaign.yml" },
    { head_branch: "test/ef70-other-source" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ]) {
    assert.throws(() => validatePreflight({ ...run, ...different }, response, selection));
  }
  const mismatchedJob = structuredClone(response);
  mismatchedJob.jobs[0]!.head_sha = "abcdef1234567890abcdef1234567890abcdef12";
  assert.throws(() => validatePreflight(run, mismatchedJob, selection));
});
test("new cohort admission requires exact reviewed receipt bytes at both implementation and authority", () => {
  const binding = {
    repository: "agent-teams-ai/.github",
    repository_id: 1316243981,
    path: ".github/workflows/docs-protocol-check.yml",
    revision,
    blob_sha: "abcdef1234567890abcdef1234567890abcdef12",
  };
  const observed = {
    workflowBlob: binding.blob_sha,
    atWorkflow: repairedReceiptBlob,
    atAuthority: repairedReceiptBlob,
  };
  assert.equal(assertRepairedWorkflow(binding, observed), revision);
  assert.throws(() => assertRepairedWorkflow(binding, { ...observed, atWorkflow: revision }));
  assert.throws(() => assertRepairedWorkflow(binding, { ...observed, atAuthority: revision }));
  assert.throws(() => assertRepairedWorkflow(binding, { ...observed, workflowBlob: revision }));
  assert.throws(() => assertRepairedWorkflow({ ...binding, repository_id: 1333298097 }, observed));
  assert.throws(() => assertRepairedWorkflow({ ...binding, path: "scripts/other.mjs" }, observed));
});
test("authority drift or missing protection is a refusal even with a qualified immutable record", () => {
  assertAuthorityResponse({ protected: true, commit: { sha: revision } }, revision);
  assert.throws(() =>
    assertAuthorityResponse({ protected: false, commit: { sha: revision } }, revision),
  );
  assert.throws(() =>
    assertAuthorityResponse({ protected: true, commit: { sha: "other" } }, revision),
  );
});
function successfulTerminal(): TerminalObservation {
  return {
    status: 0,
    signal: null,
    error: null,
    timedOut: false,
    streamsClosed: true,
    identity: { pid: 123, ppid: 122, state: "S", start: "4567" },
    stdoutOverflow: false,
    stderrOverflow: false,
    captureErrors: [],
  };
}
test("zero exit never converts timeout, stream uncertainty or observation errors to success", () => {
  const valid = successfulTerminal();
  assertTerminalSuccess(valid);
  const changes: Partial<TerminalObservation>[] = [
    { status: 1 },
    { signal: "SIGKILL" },
    { timedOut: true },
    { streamsClosed: false },
    {
      error: {
        name: "CommandObservationErrors",
        errors: [{ source: "stdout", message: "read failed" }],
      },
    },
    { identity: null },
    { identity: { pid: 123, ppid: 122, state: "S", start: "" } },
    { stdoutOverflow: true },
    { stderrOverflow: true },
    { captureErrors: [{ message: "write failed" }] },
  ];
  for (const change of changes) {
    assert.throws(() => assertTerminalSuccess({ ...valid, ...change }));
  }
});
test("only the expected successful public envelope is accepted", () => {
  const valid = { schemaVersion: 1, command: "consumer.check", outcome: "current", issues: [] };
  assert.deepEqual(
    resultEnvelope(Buffer.from(JSON.stringify(valid)), "consumer.check", "current"),
    valid,
  );
  for (const change of [
    { outcome: "blocked" },
    { command: "consumer.finalize" },
    { issues: [{ code: "ACTUAL_REFUSAL" }] },
    { schemaVersion: 2 },
  ]) {
    assert.throws(() =>
      resultEnvelope(
        Buffer.from(JSON.stringify({ ...valid, ...change })),
        "consumer.check",
        "current",
      ),
    );
  }
  assert.throws(() => resultEnvelope(Buffer.from("not json"), "consumer.check", "current"));
});

function installedKernelFixture() {
  const installation = realpathSync(mkdtempSync(join(tmpdir(), "ef70-public-kernel-")));
  const kernelRoot = join(installation, "node_modules/@agent-teams/repository-mutation");
  const entry = join(kernelRoot, "public/runtime.js");
  mkdirSync(join(kernelRoot, "public"), { recursive: true });
  writeFileSync(join(installation, "package.json"), '{"private":true,"type":"module"}\n');
  writeFileSync(entry, 'export const fixtureIdentity = "selected-public-kernel";\n');
  writeFileSync(join(kernelRoot, "private.cjs"), 'throw new Error("Private fallback executed");\n');
  const manifest = (publicRoot: unknown) => {
    writeFileSync(
      join(kernelRoot, "package.json"),
      JSON.stringify({
        name: "@agent-teams/repository-mutation",
        version: "0.5.2",
        type: "module",
        main: "./private.cjs",
        exports: { ".": publicRoot, "./package.json": "./package.json" },
      }) + "\n",
    );
  };
  manifest({ types: "./public/runtime.d.ts", import: "./public/runtime.js" });
  return { installation, kernelRoot, entry, manifest };
}

test("EF70 loads the declared import-only kernel public entry when CommonJS resolution refuses", async (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const legacy = createRequire(join(fixture.installation, "package.json"));
  assert.throws(() => legacy.resolve("@agent-teams/repository-mutation"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
  const selected = resolveInstalledPublicKernel(fixture.installation);
  assert.equal(selected.kernelRoot, fixture.kernelRoot);
  assert.equal(selected.entrypointURL, pathToFileURL(fixture.entry).href);
  const module: unknown = await import(selected.entrypointURL);
  assert(module !== null && typeof module === "object");
  assert.equal(Reflect.get(module, "fixtureIdentity"), "selected-public-kernel");
});

test("EF70 refuses unsupported public conditions instead of bypassing their resolution order", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  for (const condition of ["node", "default", "require"]) {
    fixture.manifest({
      [condition]: "./private.cjs",
      types: "./public/runtime.d.ts",
      import: "./public/runtime.js",
    });
    assert.throws(
      () => resolveInstalledPublicKernel(fixture.installation),
      /Unsupported installed kernel public export conditions/u,
    );
  }
});

test("EF70 refuses nonliteral and escaping declared public import targets", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const forbidden = join(fixture.kernelRoot, "NODE_MODULES/other");
  mkdirSync(forbidden, { recursive: true });
  writeFileSync(join(forbidden, "index.js"), 'throw new Error("Forbidden target executed");\n');
  for (const target of [
    "../private.cjs",
    "./../private.cjs",
    "/private.cjs",
    "file:///private.cjs",
    "./public//runtime.js",
    "./public/./runtime.js",
    "./node_modules/other/index.js",
    "./NODE_MODULES/other/index.js",
    "./Node_Modules/other/index.js",
    "./public/%2e%2e/private.cjs",
    "./public/runtime.js?selection=other",
    "./public/runtime.js#other",
  ]) {
    fixture.manifest({ types: "./public/runtime.d.ts", import: target });
    assert.throws(() => resolveInstalledPublicKernel(fixture.installation), /Public ESM target/u);
  }
});

test("EF70 refuses a public entry that escapes its physical kernel through a directory link", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const outside = join(fixture.installation, "outside-kernel");
  mkdirSync(outside);
  writeFileSync(join(outside, "runtime.js"), 'throw new Error("Escaped entry executed");\n');
  symlinkSync(outside, join(fixture.kernelRoot, "bridge"), "junction");
  fixture.manifest({ types: "./public/runtime.d.ts", import: "./bridge/runtime.js" });
  assert.throws(
    () => resolveInstalledPublicKernel(fixture.installation),
    /Public ESM entry must remain inside the selected physical kernel/u,
  );
});

test("EF70 refuses an ancestor kernel when the selected installation has no kernel", (t) => {
  const fixture = installedKernelFixture();
  t.after(() => rmSync(fixture.installation, { recursive: true, force: true }));
  const child = join(fixture.installation, "different-installation");
  mkdirSync(child);
  writeFileSync(join(child, "package.json"), '{"private":true,"type":"module"}\n');
  assert.equal(
    createRequire(join(child, "package.json")).resolve(
      "@agent-teams/repository-mutation/package.json",
    ),
    join(fixture.kernelRoot, "package.json"),
  );
  assert.throws(() => resolveInstalledPublicKernel(child), { code: "ENOENT" });
});
