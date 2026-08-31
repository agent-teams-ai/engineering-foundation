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
const fixture = new URL("./fixtures/portable-qualification", import.meta.url).pathname;
const schema = JSON.parse(await readFile(new URL("../schemas/docs-protocol-portable-command-envelope/v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const schemaV2 = JSON.parse(await readFile(new URL("../schemas/docs-protocol-portable-command-envelope/v2.schema.json", import.meta.url), "utf8"));
const schemaV3 = JSON.parse(await readFile(new URL("../schemas/docs-protocol-portable-command-envelope/v3.schema.json", import.meta.url), "utf8"));
const ajvV2 = new Ajv2020({ allErrors: true, strict: true });
const validateV2 = ajvV2.compile(schemaV2);
const validateV3 = ajvV2.compile(schemaV3);

function assertValidEnvelope(value) {
  const selected = value.schemaVersion === 3 ? validateV3
    : value.schemaVersion === 2 ? validateV2
      : validate;
  assert.equal(selected(value), true, JSON.stringify(selected.errors, null, 2));
}

test("published v1 info envelope remains backward compatible", () => {
  assertValidEnvelope({
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.info",
    outcome: "success",
    diagnostics: [],
    result: {
      kind: "info",
      projectId: "legacy",
      protocol: { id: "agent-teams.docs-protocol", version: 1 },
      foundationProfile: { path: "architecture/foundation/document-authoring.yaml", schemaVersion: 2, metadataSidecarPolicy: "foundation-profile-v2-strict-merge" },
      agentWorkflow: { skillPath: ".agents/skills/docs-authoring/SKILL.md" },
      metadataSchemaPath: "docs/metadata.schema.json",
      metadataSidecar: { kind: "none" },
      ownerIds: [],
      types: [{
        type: "adr",
        initialStatus: "proposed",
        allowedOwnerIds: ["architecture/tooling"],
        identity: { kind: "explicit", format: "adr-four-digits" },
        heading: { kind: "id-colon-title" },
        placement: { kind: "collection", directory: "docs/decisions", filename: "numeric-id-slug" },
        template: { kind: "fenced-markdown-body", path: "docs/templates/adr.md" },
        requiredMetadata: ["id", "type", "status", "owner", "summary"],
        reachability: { kind: "manual-fixed-index", indexPath: "docs/decisions/README.md" }
      }],
      semanticValidatorIds: []
    }
  });
});

const profile = parseDocsProtocolProfile({
  schemaVersion: 3,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: {
    path: ".docs-protocol/document-authoring.yaml",
    schemaVersion: 3,
    metadataSidecarPolicy: "foundation-profile-v3-strict-merge"
  },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: []
});

test("schema accepts emitted success and stable zero-match envelopes", async () => {
  const info = await execute(process.execPath, [cli.pathname, "info", "--consumer", fixture, "--json"]);
  assertValidEnvelope(JSON.parse(info.stdout));

  const empty = await execute(process.execPath, [cli.pathname, "find", "--consumer", fixture, "--id", "ADR-9999", "--json"]);
  const envelope = JSON.parse(empty.stdout);
  assert.equal(envelope.result.matches, 0);
  assertValidEnvelope(envelope);

  const context = await execute(process.execPath, [cli.pathname, "context", "--consumer", fixture, "--max-documents", "1", "--json"]);
  assertValidEnvelope(JSON.parse(context.stdout));
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
    await writeFile(join(consumer, ".docs-protocol/document-authoring.yaml"), "schemaVersion: 1\nprojectId: legacy\n", "utf8");
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
        profileSchemaVersion: 3,
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
  const execution = await protocol.doctorV2({ consumerRoot: ".", profilePath: "docs.config.yaml" });
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

test("published v2 envelope stays closed while community commands use v3", () => {
  assert.equal(schemaV2.properties.command.enum.includes("docs.context"), false);
  assert.equal(schemaV2.properties.command.enum.includes("docs.init"), false);
  assert.equal(schemaV3.properties.command.enum.includes("docs.context"), true);
  assert.equal(schemaV3.properties.command.enum.includes("docs.init"), true);
});

test("v2 authority evidence capacity covers 32 types without becoming unbounded", async () => {
  const emitted = await execute(process.execPath, [cli.pathname, "info", "--consumer", fixture, "--json"]);
  const envelope = JSON.parse(emitted.stdout);
  envelope.result.authorityPaths = Array.from({ length: 68 }, (_value, index) => `docs/authority/path-${index}.md`);
  assert.equal(schemaV2.$defs.infoResult.properties.authorityPaths.maxItems, 96);
  assertValidEnvelope(envelope);
  envelope.result.authorityPaths = Array.from({ length: 97 }, (_value, index) => `docs/authority/path-${index}.md`);
  assert.equal(validateV2(envelope), false);
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

test("init envelope binds receipts and conflicts to their exact write states", () => {
  const base = {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.init",
    outcome: "success",
    diagnostics: []
  };
  const plan = {
    kind: "init",
    operation: "plan",
    writeState: "preview",
    planDigest: `sha256:${"1".repeat(64)}`,
    files: [{ ownership: "create-only", path: "docs.config.yaml", writeState: "create" }],
    issues: []
  };
  const currentPlan = {
    ...plan,
    writeState: "current",
    files: [{ ownership: "create-only", path: "docs.config.yaml", writeState: "current" }]
  };
  assertValidEnvelope({ ...base, result: plan });
  assertValidEnvelope({
    ...base,
    outcome: "conflict",
    result: {
      ...plan,
      writeState: "blocked",
      files: [{ ownership: "managed-block", path: "AGENTS.md", writeState: "blocked" }],
      issues: [{
        code: "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE",
        message: "The managed AGENTS.md postimage exceeds the routing limit.",
        path: "AGENTS.md"
      }]
    }
  });
  assertValidEnvelope({ ...base, result: currentPlan });
  const wait = {
    kind: "init",
    operation: "wait",
    writeState: "blocked",
    reason: "operation-active",
  };
  assertValidEnvelope({ ...base, outcome: "conflict", result: wait });
  assertValidEnvelope({
    ...base,
    result: {
      ...plan,
      writeState: "applied",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      receiptOutcome: "applied"
    }
  });
  assertValidEnvelope({
    ...base,
    result: {
      ...currentPlan,
      receiptDigest: `sha256:${"2".repeat(64)}`,
      receiptOutcome: "already-satisfied"
    }
  });
  for (const result of [
    { ...plan, receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "applied" },
    { ...plan, writeState: "applied" },
    { ...plan, writeState: "blocked", issues: [] },
    { ...plan, writeState: "current" },
    { ...currentPlan, receiptDigest: `sha256:${"2".repeat(64)}` },
    { ...currentPlan, receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "applied" },
    { ...plan, writeState: "applied", receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "rolled-back" },
    { kind: "init", operation: "recover", writeState: "recovered" },
    { kind: "init", operation: "recover", writeState: "unchanged", receiptDigest: `sha256:${"3".repeat(64)}`, receiptOutcome: "rolled-back" }
  ]) {
    assert.equal(validateV3({ ...base, result }), false, JSON.stringify(result));
  }
  assert.equal(validateV3({ ...base, outcome: "recovery-required", result: wait }), false);
  assert.equal(validateV3({
    ...base,
    outcome: "conflict",
    result: { kind: "init", operation: "recover", writeState: "blocked" },
  }), false);
});

test("context envelope binds truncation to omitted documents", () => {
  const base = {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.context",
    outcome: "success",
    diagnostics: [],
    result: {
      kind: "context",
      format: "llms.txt",
      projectId: "portable-e2e",
      catalogSemanticDigest: `sha256:${"1".repeat(64)}`,
      selection: { ranking: "binary-default", query: {} },
      limits: { maxBytes: 262144, maxDocuments: 64 },
      includedDocuments: 1,
      omittedDocuments: 0,
      truncated: false,
      content: "# Context\n"
    }
  };
  assertValidEnvelope(base);
  assertValidEnvelope({
    ...base,
    result: { ...base.result, omittedDocuments: 1, truncated: true }
  });
  assertValidEnvelope({
    ...base,
    result: { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: "context" } } }
  });
  for (const result of [
    { ...base.result, omittedDocuments: 1, truncated: false },
    { ...base.result, omittedDocuments: 0, truncated: true },
    { ...base.result, ranking: "binary-default" },
    { ...base.result, selection: { ...base.result.selection, rawInput: {} } },
    { ...base.result, selection: { ranking: "binary-default", query: { fuzzy: false } } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: {} } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: "" } } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: "unsafe\u0000query" } } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: " untrimmed" } } },
    { ...base.result, limits: { ...base.result.limits, extra: 1 } },
    { ...base.result, limits: { maxBytes: 262144 } },
    { ...base.result, limits: { maxBytes: 1023, maxDocuments: 64 } }
  ]) {
    assert.equal(validateV3({ ...base, result }), false, JSON.stringify(result));
  }
});

test("v3 search envelopes withhold document content for fail-closed outcomes", () => {
  const common = {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    diagnostics: []
  };
  const findViolation = {
    ...common,
    command: "docs.find",
    outcome: "violation",
    result: { kind: "find", matches: 0, documents: [] }
  };
  const document = {
    id: "ADR-0001",
    type: "adr",
    status: "proposed",
    owner: "architecture/tooling",
    summary: "Withheld document",
    title: "Withheld document",
    repositoryPath: "docs/decisions/0001-withheld.md",
    source: "markdown-tree",
    metadata: {},
    related: [],
    blockedBy: []
  };
  const contextResult = {
    kind: "context",
    format: "llms.txt",
    projectId: "portable-e2e",
    catalogSemanticDigest: `sha256:${"1".repeat(64)}`,
    selection: { ranking: "binary-default", query: {} },
    limits: { maxBytes: 262144, maxDocuments: 64 },
    includedDocuments: 0,
    omittedDocuments: 1,
    truncated: true,
    content: ""
  };
  assertValidEnvelope(findViolation);
  for (const outcome of ["violation", "authority-stale"]) {
    assertValidEnvelope({ ...common, command: "docs.context", outcome, result: contextResult });
  }
  for (const envelope of [
    { ...findViolation, result: { ...findViolation.result, matches: 1 } },
    { ...findViolation, result: { ...findViolation.result, documents: [document] } },
    { ...common, command: "docs.context", outcome: "violation", result: { ...contextResult, includedDocuments: 1 } },
    { ...common, command: "docs.context", outcome: "authority-stale", result: { ...contextResult, content: "# Leaked context\n" } }
  ]) {
    assert.equal(validateV3(envelope), false, JSON.stringify(envelope));
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
