import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Arguments, CliInputError } from "../packages/docs-protocol/dist/composition/cli-input.js";
import { normalizeDocumentIds } from "../packages/docs-protocol/dist/domain/document-semantics.js";
import {
  renderDocumentCommandJson,
  renderDocumentCommandText,
} from "../packages/document-authoring/dist/document-authoring/adapters/inbound/cli/document-command-renderer.js";
import { assertSchema } from "../packages/document-authoring/dist/document-authoring/adapters/node/schema-catalog.js";
import { assertDocsCommandEnvelopeSchema } from "../packages/docs-protocol/dist/adapters/docs-command-envelope-schema-validator.js";
import { RunDocumentDoctor } from "../packages/document-authoring/dist/document-authoring/application/use-cases/run-document-doctor.js";
import { RunDocumentNew } from "../packages/document-authoring/dist/document-authoring/application/use-cases/run-document-new.js";
import { RunDocumentRecover } from "../packages/document-authoring/dist/document-authoring/application/use-cases/run-document-recover.js";

const cliPath = fileURLToPath(
  new URL("../packages/docs-protocol/dist/cli.js", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("fixtures/document-command-envelope-v2.json", import.meta.url),
);
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const doctorEnvironment = {
  async inspect() {
    return {
      installedFoundationVersion: "0.16.0",
      installedFoundationBuildIdentity: `sha256:${"a".repeat(64)}`,
      filesystem: {
        basis: "platform-contract",
        strictDirectoryDurability: "platform-supported",
      },
    };
  },
};

test("parses the closed docs new surface and preserves repeatable relations", () => {
  const parsed = new Arguments([
    "--type", "adr",
    "--id", "ADR-0083",
    "--title", "Deterministic docs",
    "--owner", "architecture/tooling",
    "--summary", "Defines deterministic authoring.",
    "--slug", "deterministic-docs",
    "--destination", "docs/decisions/0083-deterministic-docs.md",
    "--profile", "architecture/foundation/document-authoring.yaml",
    "--related", "ADR-0001",
    "--related", "ADR-0053",
    "--dry-run",
    "--json",
  ]);
  assert.equal(parsed.flag("--dry-run"), true);
  assert.deepEqual(parsed.many("--related"), ["ADR-0001", "ADR-0053"]);
  assert.equal(parsed.one("--destination"), "docs/decisions/0083-deterministic-docs.md");
  assert.equal(parsed.flag("--json"), true);
  for (const option of ["--type", "--id", "--title", "--owner", "--summary", "--slug", "--profile"]) {
    assert.ok(parsed.one(option));
  }
  assert.deepEqual(parsed.positionals(), []);
});

test("keeps the repeatable related bound aligned with Docs Protocol semantics", () => {
  const atLimit = Array.from({ length: 256 }, (_value, index) => [
    "--related", `ADR-${String(index).padStart(4, "0")}`,
  ]).flat();
  const related = new Arguments(atLimit).many("--related");
  assert.equal(normalizeDocumentIds(related, "related").length, 256);
  assert.throws(
    () => normalizeDocumentIds([...related, "ADR-9999"], "related"),
    /related exceeds 256 items/u,
  );
});

test("rejects duplicate global scalar options", () => {
  for (const args of [
    ["--json", "--json"],
    ["--consumer", "/first", "--consumer", "/second"],
  ]) {
    assert.throws(
      () => args[0] === "--json"
        ? new Arguments(args).flag("--json")
        : new Arguments(args).one("--consumer"),
      (error) => error instanceof CliInputError && /may be supplied only once/u.test(error.message),
    );
  }
});

test("rejects mutation shortcuts, duplicate scalar options, missing values, and positionals", () => {
  for (const option of ["--force", "--clean", "--delete-conflict", "--rollback-output"]) {
    assert.deepEqual(new Arguments([option]).positionals(), [option]);
  }
  assert.deepEqual(new Arguments(["extra"]).positionals(), ["extra"]);
  assert.throws(
    () => new Arguments(["--title", "Title", "--title", "Again"]).one("--title"),
    /may be supplied only once/u,
  );
  assert.throws(
    () => new Arguments(["--related", "--dry-run"]).many("--related"),
    /requires a value/u,
  );
});

test("keeps v1 find parsing compatible", () => {
  const parsed = new Arguments([
    "tenant", "--id", "ADR-0001", "--status", "accepted",
    "--owner", "architecture", "--type", "adr", "--json",
  ]);
  assert.equal(parsed.one("--id"), "ADR-0001");
  assert.equal(parsed.one("--status"), "accepted");
  assert.equal(parsed.one("--owner"), "architecture");
  assert.equal(parsed.one("--type"), "adr");
  assert.equal(parsed.flag("--json"), true);
  assert.deepEqual(parsed.positionals(), ["tenant"]);
});

test("preserves a second option terminator as positional input", () => {
  const parsed = new Arguments(["--", "--"]);
  assert.deepEqual(parsed.positionals(), ["--"]);
});

test("accepts every v2 command fixture and rejects cross-command results", async () => {
  for (const envelope of Object.values(fixtures)) {
    await assertSchema("document-command-envelope/v2", envelope, "document-command-v2");
  }
  const confused = structuredClone(fixtures.preview);
  confused.command = "docs.doctor";
  await assert.rejects(
    assertSchema("document-command-envelope/v2", confused, "confused-command"),
  );
});

test("validates representative real application envelopes against v2", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const plan = {
    destination: "docs/decisions/0083-test.md", planDigest: digest,
    intent: { title: "Test document" },
    authority: { profile: { path: "profile.yaml" } },
  };
  const newCommand = new RunDocumentNew({
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async plan() { return plan; },
    async apply() { return assert.fail("dry-run must not apply"); },
    similar: { async advise() { return { matches: [], query: "test" }; } },
    reachability: { async project() { return { state: "not-required" }; } },
    structure: { async verify() { return { valid: true, diagnostics: [] }; } },
  });
  const preview = await newCommand.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: true,
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await newCommand.execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false,
    signal: controller.signal,
  });
  const committedViolation = await new RunDocumentNew({
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async plan() { return plan; },
    async apply() {
      return { outcome: "applied", receiptDigest: digest, diagnostics: [] };
    },
    similar: { async advise() { return { matches: [], query: "test" }; } },
    reachability: { async project() { return { state: "not-required" }; } },
    structure: { async verify() { throw new Error("verification failed"); } },
  }).execute({
    consumerRoot: "/fixture", profilePath: "profile.yaml", intent: {}, dryRun: false,
  });
  const doctor = await new RunDocumentDoctor({
    environment: doctorEnvironment,
    async inspect() {
      return {
        schemaVersion: 1,
        state: "manual-recovery-required",
        reason: "unknown",
        transactionKind: "unknown",
        diagnostics: [],
      };
    },
  }).execute({ consumerRoot: "/fixture" });
  const recover = await new RunDocumentRecover({
    async inspect() { return { schemaVersion: 1, state: "idle", diagnostics: [] }; },
    async recover() { return assert.fail("idle recovery must not run"); },
  }).execute({ consumerRoot: "/fixture" });
  const recoveryRequired = await new RunDocumentRecover({
    async inspect() {
      return {
        schemaVersion: 1,
        state: "recoverable",
        operationKind: "document-authoring",
        format: "document-authoring-envelope-v3",
        foundationVersion: "0.16.0",
        foundationBuildIdentity: digest,
        recovery: {
          commandId: "docs-recover",
          exactFoundationVersion: "0.16.0",
          exactFoundationBuildIdentity: digest,
        },
        diagnostics: [],
      };
    },
    async recover() {
      return {
        outcome: "recovery-required",
        receiptDigest: digest,
        diagnostics: [{
          ruleId: "document.recovery.pending",
          severity: "error",
          phase: "recovery",
          subject: "document.transaction",
          message: "Recovery remains pending.",
        }],
        commit: { publication: "unknown" },
      };
    },
  }).execute({ consumerRoot: "/fixture" });
  for (const execution of [
    preview,
    cancelled,
    committedViolation,
    doctor,
    recover,
    recoveryRequired,
  ]) {
    await assertSchema(
      "document-command-envelope/v2",
      execution.envelope,
      "real-document-command",
    );
  }
  assert.equal(committedViolation.envelope.result.reachability.state, "not-required");
  assert.equal(
    recoveryRequired.envelope.diagnostics[0].remediation.commandId,
    "docs.doctor",
  );
});

test("pure renderers emit one JSON object and a human recovery command", () => {
  const execution = { envelope: fixtures.preview, exitCode: 0 };
  assert.equal(renderDocumentCommandJson(execution), `${JSON.stringify(fixtures.preview)}\n`);
  const human = renderDocumentCommandText({ envelope: fixtures.doctor, exitCode: 1 });
  assert.match(human, /Run: agent-teams-docs recover/u);
});

test("human renderer preserves exact Document Authoring recovery coordinates", () => {
  const doctor = structuredClone(fixtures.doctor);
  doctor.result.recoveryCommand.args = {
    exactFoundationVersion: "0.14.3",
    exactFoundationBuildIdentity: `sha256:${"a".repeat(64)}`,
  };
  const human = renderDocumentCommandText({ envelope: doctor, exitCode: 1 });
  assert.match(
    human,
    /Run: agent-teams-docs recover/u,
  );
  assert.match(human, /Required build: sha256:a{64}/u);
});

test("JSON parse failures use one object and no stderr", async () => {
  const invalid = spawnSync(process.execPath, [
    cliPath, "new", "--force", "--json",
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(invalid.stderr, "");
  const invalidEnvelope = JSON.parse(invalid.stdout);
  assert.equal(`${JSON.stringify(invalidEnvelope)}\n`, invalid.stdout);
  await assertDocsCommandEnvelopeSchema(invalidEnvelope);

});

test("doctor JSON parse failures remain valid without runtime environment evidence", async () => {
  const invalid = spawnSync(process.execPath, [
    cliPath, "doctor", "--bogus", "--json",
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(invalid.stderr, "");
  const invalidEnvelope = JSON.parse(invalid.stdout);
  assert.equal(`${JSON.stringify(invalidEnvelope)}\n`, invalid.stdout);
  assert.equal(invalidEnvelope.command, "docs.doctor");
  assert.equal(invalidEnvelope.outcome, "invalid-input");
  await assertDocsCommandEnvelopeSchema(invalidEnvelope);
});

test("doctor JSON preserves machine output when consumer value is missing", async () => {
  const invalid = spawnSync(process.execPath, [
    cliPath, "doctor", "--consumer", "--json",
  ], { encoding: "utf8" });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(invalid.stderr, "");
  const invalidEnvelope = JSON.parse(invalid.stdout);
  assert.equal(`${JSON.stringify(invalidEnvelope)}\n`, invalid.stdout);
  assert.equal(invalidEnvelope.command, "docs.doctor");
  assert.equal(invalidEnvelope.outcome, "invalid-input");
  await assertDocsCommandEnvelopeSchema(invalidEnvelope);
});
