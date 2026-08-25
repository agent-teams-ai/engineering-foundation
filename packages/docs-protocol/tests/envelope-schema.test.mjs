import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import { DocsProtocol } from "../dist/application/docs-protocol.js";
import { parseDocsProtocolProfile } from "../dist/domain/profile-policy.js";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const fixture = new URL("./fixtures/qualification", import.meta.url).pathname;
const schema = JSON.parse(await readFile(new URL("../schemas/docs-protocol-command-envelope/v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function assertValidEnvelope(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

const profile = parseDocsProtocolProfile({
  schemaVersion: 1,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: {
    path: "architecture/foundation/document-authoring.yaml",
    schemaVersion: 2,
    metadataSidecarPolicy: "foundation-profile-v2-strict-merge"
  },
  agentWorkflow: { skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: []
});

test("schema accepts emitted success and stable zero-match envelopes", async () => {
  const info = await execute(process.execPath, [cli.pathname, "info", "--consumer", fixture, "--json"]);
  assertValidEnvelope(JSON.parse(info.stdout));

  const empty = await execute(process.execPath, [cli.pathname, "find", "--consumer", fixture, "--id", "ADR-9999", "--json"]);
  const envelope = JSON.parse(empty.stdout);
  assert.equal(envelope.result.matches, 0);
  assertValidEnvelope(envelope);
});

test("schema accepts the emitted invalid-input envelope", async () => {
  await assert.rejects(
    execute(process.execPath, [cli.pathname, "unknown", "--json"]),
    (error) => {
      assert.equal(error.code, 2);
      const envelope = JSON.parse(error.stdout);
      assert.equal(envelope.outcome, "invalid-input");
      assertValidEnvelope(envelope);
      return true;
    }
  );
});

test("CLI classifies invalid Foundation authority as input and missing runtime roots as execution failures", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-errors-"));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixture, consumer, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await writeFile(join(consumer, "architecture/foundation/document-authoring.yaml"), "schemaVersion: 1\nprojectId: legacy\n", "utf8");
    await assert.rejects(execute(process.execPath, [cli.pathname, "info", "--consumer", consumer, "--json"]), (error) => {
      const envelope = JSON.parse(error.stdout);
      assert.equal(error.code, 2);
      assert.equal(envelope.outcome, "invalid-input");
      assert.equal(envelope.diagnostics[0].phase, "authority");
      assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.invalid-input.authority");
      assertValidEnvelope(envelope);
      return true;
    });
    await assert.rejects(execute(process.execPath, [cli.pathname, "info", "--consumer", join(temporary, "missing"), "--json"]), (error) => {
      const envelope = JSON.parse(error.stdout);
      assert.equal(error.code, 3);
      assert.equal(envelope.outcome, "execution-failure");
      assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.execution-failure.filesystem");
      assertValidEnvelope(envelope);
      return true;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const requiresSignals = process.platform === "win32" ? test.skip : test;

requiresSignals("SIGTERM cancellation emits one valid JSON envelope with exit 130", async () => {
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `import { runDocsCli } from ${JSON.stringify(moduleUrl)}; const pending = runDocsCli(["info", "--consumer", ${JSON.stringify(fixture)}, "--json"]); queueMicrotask(() => process.kill(process.pid, "SIGTERM")); process.exitCode = await pending;`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 130, stderr);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const envelope = JSON.parse(lines[0]);
    assert.equal(envelope.outcome, "cancelled");
    assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.cancelled.cancelled");
    assertValidEnvelope(envelope);
  } finally {
    if (child.exitCode === null) {child.kill("SIGKILL");}
  }
});

test("schema accepts an emitted recovery-required doctor envelope", async () => {
  const foundation = {
    async describe() {
      return {
        authority: {},
        projectId: "fixture-project",
        profileSchemaVersion: 2,
        metadataSchemaPath: "docs/metadata.schema.json",
        metadataSidecar: { kind: "none" },
        ownerIds: ["architecture/tooling"],
        types: [],
        authorityPaths: []
      };
    },
    async inspectEnvironment() {
      return {
        installedFoundationVersion: "0.17.0-rc.0",
        installedFoundationBuildIdentity: `sha256:${"1".repeat(64)}`,
        filesystem: { basis: "platform-contract", strictDirectoryDurability: "platform-supported" }
      };
    },
    async inspect() {
      return {
        schemaVersion: 1,
        state: "recoverable",
        recovery: {
          exactFoundationBuildIdentity: `sha256:${"2".repeat(64)}`,
          exactFoundationVersion: "0.17.0-rc.0"
        },
        diagnostics: []
      };
    }
  };
  const protocol = new DocsProtocol({
    adoption: { async inspect() { return []; } },
    anchors: { async matchedPatterns() { return []; } },
    foundation,
    profiles: { async read() { return profile; } }
  });
  const execution = await protocol.doctor({ consumerRoot: ".", profilePath: "architecture/foundation/docs-protocol.yaml" });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.envelope.outcome, "recovery-required");
  assertValidEnvelope(execution.envelope);
});

test("schema is closed against accidental result expansion", () => {
  const envelope = {
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.find",
    outcome: "success",
    diagnostics: [],
    result: { kind: "find", matches: 0, documents: [], accidental: true }
  };
  assert.equal(validate(envelope), false);
});

test("find envelope capacity matches the Foundation 10k catalog hard cap", () => {
  assert.equal(schema.$defs.findResult.properties.matches.maximum, 10_000);
  assert.equal(schema.$defs.findResult.properties.documents.maxItems, 10_000);
});

test("find envelope accepts Foundation-projected metadata beyond old 256/key-length caps", () => {
  const metadata = Object.fromEntries(Array.from({ length: 257 }, (_value, index) => [`${"k".repeat(160)}-${index}`, index]));
  const envelope = {
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.find",
    outcome: "success",
    diagnostics: [],
    result: {
      kind: "find",
      matches: 1,
      documents: [{ id: "ADR-0001", type: "adr", status: "proposed", owner: "architecture/tooling", summary: "Large metadata", title: "Large metadata", repositoryPath: "docs/decisions/0001-large.md", source: "markdown-tree", metadata, related: [], blockedBy: [] }]
    }
  };
  assertValidEnvelope(envelope);
});

test("schema rejects impossible command outcome and result combinations", () => {
  const base = { schemaVersion: 1, protocol: { id: "agent-teams.docs-protocol", version: 1 }, diagnostics: [] };
  for (const envelope of [
    { ...base, command: "docs.info", outcome: "success", result: {} },
    { ...base, command: "docs.find", outcome: "execution-failure", result: { kind: "find", matches: 0, documents: [] } },
    { ...base, command: "docs.new", outcome: "success", result: { kind: "new", reservation: "none", writeState: "applied", documentPath: "docs/a.md", planDigest: `sha256:${"1".repeat(64)}`, reachability: { state: "not-required", reason: "none" } } },
    { ...base, command: "docs.recover", outcome: "success", result: { kind: "recover", transactionState: "recovered", writeState: "committed" } }
  ]) {
    assert.equal(validate(envelope), false, JSON.stringify(envelope));
  }
});

test("schema closes new and recover outcomes and excludes retired directory rollback evidence", () => {
  const base = { schemaVersion: 1, protocol: { id: "agent-teams.docs-protocol", version: 1 }, diagnostics: [] };
  const receipt = {
    outcome: "recovery-required",
    commit: { state: "recovery-required", publication: "published", recoverability: "preserved-for-recovery" },
    directoryMaterialization: { state: "rolled-back", plannedDirectories: [], observedCreatedDirectories: [] }
  };
  for (const envelope of [
    { ...base, command: "docs.new", outcome: "violation", result: { kind: "new", reservation: "none", writeState: "blocked", reason: "authority-stale" } },
    { ...base, command: "docs.new", outcome: "success", result: { kind: "new", reservation: "none", writeState: "blocked", reason: "authority-stale" } },
    { ...base, command: "docs.recover", outcome: "success", result: { kind: "recover", transactionState: "manual-required", writeState: "unknown", transaction: { state: "manual-recovery-required" } } },
    { ...base, command: "docs.new", outcome: "recovery-required", result: { kind: "new", reservation: "none", writeState: "published-recovery-required", documentPath: "docs/a.md", planDigest: `sha256:${"1".repeat(64)}`, receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "recovery-required", receipt } }
  ]) {
    assert.equal(validate(envelope), false, JSON.stringify(envelope));
  }
});

test("schema accepts the meaningful adoption-invalid blocked new result", () => {
  assertValidEnvelope({
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.new",
    outcome: "violation",
    diagnostics: [{ ruleId: "docs.adoption.foundation-runtime-identity", severity: "error", phase: "authority", subject: "foundation", message: "Runtime identity mismatch." }],
    result: { kind: "new", reservation: "none", writeState: "blocked", reason: "adoption-invalid" }
  });
});
