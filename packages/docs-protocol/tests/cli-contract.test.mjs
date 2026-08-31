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
const fixture = new URL("./fixtures/portable-qualification", import.meta.url).pathname;

test("help succeeds through one pnpm-style separator", async () => {
  const result = await execute(process.execPath, [cli.pathname, "--", "--help"]);
  assert.match(result.stdout, /^Usage: agent-teams-docs/u);
  assert.doesNotMatch(result.stdout, /consumer|qualify/u);
  assert.match(result.stdout, /agent-teams-docs-managed/u);
  assert.equal(result.stderr, "");
});

test("help covers every public command and find documents all common options", async () => {
  const commands = new Map([
    ["info", "Usage: agent-teams-docs info "],
    ["find", "Usage: docs-protocol find "],
    ["context", "Usage: docs-protocol context "],
    ["new", "Usage: agent-teams-docs new "],
    ["doctor", "Usage: agent-teams-docs doctor "],
    ["recover", "Usage: agent-teams-docs recover "],
    ["check", "Usage: agent-teams-docs check "],
    ["init", "Usage: docs-protocol init "],
  ]);
  const general = await execute(process.execPath, [cli.pathname, "--help"]);
  assert.equal(
    general.stdout.split("\n", 1)[0],
    "Usage: agent-teams-docs <info|find|context|new|doctor|recover|check|init> [options]",
  );
  for (const [command, prefix] of commands) {
    const result = await execute(process.execPath, [cli.pathname, command, "--help"]);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.startsWith(prefix), `${command} help must start with its public usage`);
  }

  const find = await execute(process.execPath, [cli.pathname, "find", "--help"]);
  assert.equal(
    find.stdout,
    "Usage: docs-protocol find [TEXT|--text TEXT] [--fuzzy] [--id ID] [--type TYPE] [--status STATUS] [--owner OWNER] [--related ID] [--blocked-by ID] [--consumer PATH] [--profile PATH] [--json]\n",
  );
});

test("invalid command guidance names the complete public command surface", async () => {
  await assert.rejects(
    execute(process.execPath, [cli.pathname, "unknown-command"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(
        error.stdout,
        /Expected one command: info, find, context, new, doctor, recover, check, or init\./u,
      );
      return true;
    },
  );
});

test("portable CLI rejects every former managed route", async () => {
  for (const command of ["consumer", "qualify"]) {
    await assert.rejects(
      execute(process.execPath, [cli.pathname, command, "--json"]),
      (error) => {
        assert.equal(error.code, 2);
        const envelope = JSON.parse(error.stdout);
        assert.equal(envelope.outcome, "invalid-input");
        assert.match(envelope.diagnostics[0].message, /Expected one command/u);
        return true;
      }
    );
  }
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

test("ranked find and bounded context are deterministic opt-in agent projections", async () => {
  const ranked = await execute(process.execPath, [
    cli.pathname, "find", "qualification", "--fuzzy", "--consumer", fixture, "--json"
  ]);
  const findEnvelope = JSON.parse(ranked.stdout);
  assert.equal(findEnvelope.schemaVersion, 3);
  assert.equal(findEnvelope.result.ranking, "fuzzy-advisory");
  assert.equal(findEnvelope.diagnostics[0].ruleId, "docs.find.fuzzy-advisory");
  await assertDocsCommandEnvelopeSchema(findEnvelope);

  const context = await execute(process.execPath, [
    cli.pathname, "context", "  QUALIFICATION  ", "--consumer", fixture, "--max-documents", "1", "--json"
  ]);
  const contextEnvelope = JSON.parse(context.stdout);
  assert.equal(contextEnvelope.schemaVersion, 3);
  assert.equal(contextEnvelope.command, "docs.context");
  assert.equal(contextEnvelope.result.format, "llms.txt");
  assert.deepEqual(contextEnvelope.result.selection, { ranking: "binary-default", query: { text: "qualification" } });
  assert.deepEqual(contextEnvelope.result.limits, { maxBytes: 262144, maxDocuments: 1 });
  assert.equal(Object.hasOwn(contextEnvelope.result, "ranking"), false);
  assert.match(contextEnvelope.result.catalogSemanticDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(contextEnvelope.result.content, /^# docs-protocol-qualification documentation/u);
  await assertDocsCommandEnvelopeSchema(contextEnvelope);

  const human = await execute(process.execPath, [cli.pathname, "context", "--consumer", fixture]);
  assert.match(human.stdout, /^# docs-protocol-qualification documentation/u);
  assert.doesNotMatch(human.stdout, /^docs\.context:/u);
});

test("context CLI rejects limits and noncanonical filters as schema-valid invalid input", async () => {
  for (const invalidArguments of [
    ["--max-bytes", "1023"],
    ["--max-bytes", "1048577"],
    ["--max-documents", "10001"],
    ["--owner", "bad:id"],
    ["--type", "Tutorial"],
  ]) {
    let failure;
    try {
      await execute(process.execPath, [cli.pathname, "context", "--consumer", fixture, ...invalidArguments, "--json"]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${invalidArguments.join(" ")} must fail`);
    assert.equal(failure.code, 2);
    assert.equal(failure.stderr, "");
    const envelope = JSON.parse(failure.stdout);
    assert.equal(envelope.schemaVersion, 3);
    assert.equal(envelope.command, "docs.context");
    assert.equal(envelope.outcome, "invalid-input");
    assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.invalid-input.validation");
    await assertDocsCommandEnvelopeSchema(envelope);
  }
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
