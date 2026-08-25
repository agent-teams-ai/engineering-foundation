import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import {
  docsCliErrorExecution,
  validatedMachineExecution,
} from "../dist/composition/cli.js";
import { assertDocsCommandEnvelopeSchema } from "../dist/adapters/docs-command-envelope-schema-validator.js";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const fixture = new URL("./fixtures/qualification", import.meta.url).pathname;

test("help succeeds through one pnpm-style separator", async () => {
  const result = await execute(process.execPath, [cli.pathname, "--", "--help"]);
  assert.match(result.stdout, /^Usage: agent-teams-docs/u);
  assert.match(result.stdout, /\|consumer>/u);
  assert.match(result.stdout, /consumer --help/u);
  assert.equal(result.stderr, "");
});

test("new subcommand help documents the explicit mutation boundary", async () => {
  const result = await execute(process.execPath, [cli.pathname, "new", "--help"]);
  assert.match(result.stdout, /\(--dry-run\|--apply\)/u);
  assert.match(result.stdout, /--blocked-by/u);
});

test("human info and zero-match find expose useful authoring context", async () => {
  const info = await execute(process.execPath, [cli.pathname, "info", "--consumer", fixture]);
  assert.match(info.stdout, /Project: docs-protocol-qualification/u);
  assert.match(info.stdout, /Type adr \| initial proposed \| owners architecture\/tooling/u);
  assert.match(info.stdout, /identity adr-four-digits \| placement collection/u);

  const empty = await execute(process.execPath, [cli.pathname, "find", "--consumer", fixture, "--id", "ADR-9999"]);
  assert.match(empty.stdout, /docs\.find: success/u);
  assert.match(empty.stdout, /Matches: 0/u);
});

test("machine failures expose only stable allowlisted classification", async () => {
  const secret = "/private/consumer/token-super-secret";
  const hostile = Object.assign(new Error(`${secret}\n${"x".repeat(4_000)}`), {
    code: "SECRET_VALUE_MUST_NOT_ESCAPE",
    repositoryBytes: secret,
  });
  const execution = docsCliErrorExecution("docs.check", hostile, true);
  await assertDocsCommandEnvelopeSchema(execution.envelope);
  assert.deepEqual(execution.envelope.diagnostics, [{
    message: "Documentation command failed.",
    phase: "apply",
    ruleId: "docs.cli.execution-failure.internal",
    severity: "error",
    subject: "docs.check",
  }]);
  assert.doesNotMatch(JSON.stringify(execution.envelope), /token-super-secret|SECRET_VALUE|repositoryBytes/u);
});

test("invalid hostile output falls back to a schema-valid redacted envelope", async () => {
  const hostile = {
    exitCode: 0,
    envelope: {
      schemaVersion: 1,
      protocol: { id: "agent-teams.docs-protocol", version: 1 },
      command: "docs.check",
      outcome: "success",
      diagnostics: [],
      result: { kind: "check", projectId: "/private/token", unexpected: "secret" },
    },
  };
  const fallback = await validatedMachineExecution("docs.check", hostile);
  await assertDocsCommandEnvelopeSchema(fallback.envelope);
  assert.equal(fallback.exitCode, 3);
  assert.deepEqual(fallback.envelope.diagnostics, [{
    message: "Documentation command produced invalid output.",
    phase: "apply",
    ruleId: "docs.cli.invalid-output.internal",
    severity: "error",
    subject: "docs.check",
  }]);
  assert.doesNotMatch(JSON.stringify(fallback.envelope), /private|token|secret|unexpected/u);
});

test("SIGTERM cancels the Docs Protocol CLI through its AbortSignal", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async () => {
  const child = fork(new URL("./fixtures/cli-cancellation-child.mjs", import.meta.url), [], {
    execArgv: [],
    silent: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", resolve);
  });
  assert.equal(child.kill("SIGTERM"), true);
  const closed = await new Promise((resolve) => {
    child.once("close", (code, signal) => { resolve({ code, signal }); });
  });
  assert.deepEqual(closed, { code: 130, signal: null });
  assert.equal(stderr, "");
  const envelope = JSON.parse(stdout);
  assert.equal(`${JSON.stringify(envelope)}\n`, stdout);
  assert.equal(envelope.outcome, "cancelled");
  assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.cancelled.cancelled");
  await assertDocsCommandEnvelopeSchema(envelope);
});
