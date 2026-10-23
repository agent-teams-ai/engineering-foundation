import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

function parseSchema(source: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export const schema = parseSchema(
  await readFile(
    new URL(
      "../../schemas/docs-protocol-portable-command-envelope/v1.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const validate: ValidateFunction = new Ajv2020({ allErrors: true, strict: true }).compile(
  schema,
);
export const schemaV2 = parseSchema(
  await readFile(
    new URL(
      "../../schemas/docs-protocol-portable-command-envelope/v2.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const schemaV3 = parseSchema(
  await readFile(
    new URL(
      "../../schemas/docs-protocol-portable-command-envelope/v3.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajvV2 = new Ajv2020({ allErrors: true, strict: true });
export const validateV2: ValidateFunction = ajvV2.compile(schemaV2);
export const validateV3: ValidateFunction = ajvV2.compile(schemaV3);

export function assertValidEnvelope(value: unknown): void {
  assert.ok(typeof value === "object" && value !== null);
  const version = "schemaVersion" in value ? value.schemaVersion : undefined;
  const selected = version === 3 ? validateV3 : version === 2 ? validateV2 : validate;
  assert.equal(selected(value), true, JSON.stringify(selected.errors, null, 2));
}

void test("schema rejects impossible command outcome and result combinations", () => {
  const base = {
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    diagnostics: [],
  };
  for (const envelope of [
    { ...base, command: "docs.info", outcome: "success", result: {} },
    {
      ...base,
      command: "docs.find",
      outcome: "execution-failure",
      result: { kind: "find", matches: 0, documents: [] },
    },
    {
      ...base,
      command: "docs.new",
      outcome: "success",
      result: {
        kind: "new",
        reservation: "none",
        writeState: "applied",
        documentPath: "docs/a.md",
        planDigest: `sha256:${"1".repeat(64)}`,
        reachability: { state: "not-required", reason: "none" },
      },
    },
    {
      ...base,
      command: "docs.recover",
      outcome: "success",
      result: { kind: "recover", transactionState: "recovered", writeState: "committed" },
    },
  ]) {
    assert.equal(validate(envelope), false, JSON.stringify(envelope));
  }
});

void test("schema closes new and recover outcomes and excludes retired directory rollback evidence", () => {
  const base = {
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    diagnostics: [],
  };
  const receipt = {
    outcome: "recovery-required",
    commit: {
      state: "recovery-required",
      publication: "published",
      recoverability: "preserved-for-recovery",
    },
    directoryMaterialization: {
      state: "rolled-back",
      plannedDirectories: [],
      observedCreatedDirectories: [],
    },
  };
  for (const envelope of [
    {
      ...base,
      command: "docs.new",
      outcome: "violation",
      result: {
        kind: "new",
        reservation: "none",
        writeState: "blocked",
        reason: "authority-stale",
      },
    },
    {
      ...base,
      command: "docs.new",
      outcome: "success",
      result: {
        kind: "new",
        reservation: "none",
        writeState: "blocked",
        reason: "authority-stale",
      },
    },
    {
      ...base,
      command: "docs.recover",
      outcome: "success",
      result: {
        kind: "recover",
        transactionState: "manual-required",
        writeState: "unknown",
        transaction: { state: "manual-recovery-required" },
      },
    },
    {
      ...base,
      command: "docs.new",
      outcome: "recovery-required",
      result: {
        kind: "new",
        reservation: "none",
        writeState: "published-recovery-required",
        documentPath: "docs/a.md",
        planDigest: `sha256:${"1".repeat(64)}`,
        receiptDigest: `sha256:${"2".repeat(64)}`,
        receiptOutcome: "recovery-required",
        receipt,
      },
    },
  ]) {
    assert.equal(validate(envelope), false, JSON.stringify(envelope));
  }
});

void test("init envelope binds receipts and conflicts to their exact write states", () => {
  const base = {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.init",
    outcome: "success",
    diagnostics: [],
  };
  const plan = {
    kind: "init",
    operation: "plan",
    writeState: "preview",
    planDigest: `sha256:${"1".repeat(64)}`,
    files: [{ ownership: "create-only", path: "docs.config.yaml", writeState: "create" }],
    issues: [],
  };
  const currentPlan = {
    ...plan,
    writeState: "current",
    files: [{ ownership: "create-only", path: "docs.config.yaml", writeState: "current" }],
  };
  assertValidEnvelope({ ...base, result: plan });
  assertValidEnvelope({
    ...base,
    outcome: "conflict",
    result: {
      ...plan,
      writeState: "blocked",
      files: [{ ownership: "managed-block", path: "AGENTS.md", writeState: "blocked" }],
      issues: [
        {
          code: "PORTABLE_BOOTSTRAP_AGENTS_TOO_LARGE",
          message: "The managed AGENTS.md postimage exceeds the routing limit.",
          path: "AGENTS.md",
        },
      ],
    },
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
      receiptOutcome: "applied",
    },
  });
  assertValidEnvelope({
    ...base,
    result: {
      ...currentPlan,
      receiptDigest: `sha256:${"2".repeat(64)}`,
      receiptOutcome: "already-satisfied",
    },
  });
  for (const result of [
    { ...plan, receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "applied" },
    { ...plan, writeState: "applied" },
    { ...plan, writeState: "blocked", issues: [] },
    { ...plan, writeState: "current" },
    { ...currentPlan, receiptDigest: `sha256:${"2".repeat(64)}` },
    { ...currentPlan, receiptDigest: `sha256:${"2".repeat(64)}`, receiptOutcome: "applied" },
    {
      ...plan,
      writeState: "applied",
      receiptDigest: `sha256:${"2".repeat(64)}`,
      receiptOutcome: "rolled-back",
    },
    { kind: "init", operation: "recover", writeState: "recovered" },
    {
      kind: "init",
      operation: "recover",
      writeState: "unchanged",
      receiptDigest: `sha256:${"3".repeat(64)}`,
      receiptOutcome: "rolled-back",
    },
  ]) {
    assert.equal(validateV3({ ...base, result }), false, JSON.stringify(result));
  }
  assert.equal(validateV3({ ...base, outcome: "recovery-required", result: wait }), false);
  assert.equal(
    validateV3({
      ...base,
      outcome: "conflict",
      result: { kind: "init", operation: "recover", writeState: "blocked" },
    }),
    false,
  );
});

void test("context envelope binds truncation to omitted documents", () => {
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
      content: "# Context\n",
    },
  };
  assertValidEnvelope(base);
  assertValidEnvelope({
    ...base,
    result: { ...base.result, omittedDocuments: 1, truncated: true },
  });
  assertValidEnvelope({
    ...base,
    result: {
      ...base.result,
      selection: { ranking: "fuzzy-advisory", query: { text: "context" } },
    },
  });
  for (const result of [
    { ...base.result, omittedDocuments: 1, truncated: false },
    { ...base.result, omittedDocuments: 0, truncated: true },
    { ...base.result, ranking: "binary-default" },
    { ...base.result, selection: { ...base.result.selection, rawInput: {} } },
    { ...base.result, selection: { ranking: "binary-default", query: { fuzzy: false } } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: {} } },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: "" } } },
    {
      ...base.result,
      selection: { ranking: "fuzzy-advisory", query: { text: "unsafe\u0000query" } },
    },
    { ...base.result, selection: { ranking: "fuzzy-advisory", query: { text: " untrimmed" } } },
    { ...base.result, limits: { ...base.result.limits, extra: 1 } },
    { ...base.result, limits: { maxBytes: 262144 } },
    { ...base.result, limits: { maxBytes: 1023, maxDocuments: 64 } },
  ]) {
    assert.equal(validateV3({ ...base, result }), false, JSON.stringify(result));
  }
});

void test("v3 search envelopes withhold document content for fail-closed outcomes", () => {
  const common = {
    schemaVersion: 3,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    diagnostics: [],
  };
  const findViolation = {
    ...common,
    command: "docs.find",
    outcome: "violation",
    result: { kind: "find", matches: 0, documents: [] },
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
    blockedBy: [],
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
    content: "",
  };
  assertValidEnvelope(findViolation);
  for (const outcome of ["violation", "authority-stale"]) {
    assertValidEnvelope({ ...common, command: "docs.context", outcome, result: contextResult });
  }
  for (const envelope of [
    { ...findViolation, result: { ...findViolation.result, matches: 1 } },
    { ...findViolation, result: { ...findViolation.result, documents: [document] } },
    {
      ...common,
      command: "docs.context",
      outcome: "violation",
      result: { ...contextResult, includedDocuments: 1 },
    },
    {
      ...common,
      command: "docs.context",
      outcome: "authority-stale",
      result: { ...contextResult, content: "# Leaked context\n" },
    },
  ]) {
    assert.equal(validateV3(envelope), false, JSON.stringify(envelope));
  }
});

void test("schema accepts the meaningful adoption-invalid blocked new result", () => {
  assertValidEnvelope({
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.new",
    outcome: "violation",
    diagnostics: [
      {
        ruleId: "docs.adoption.foundation-runtime-identity",
        severity: "error",
        phase: "authority",
        subject: "foundation",
        message: "Runtime identity mismatch.",
      },
    ],
    result: { kind: "new", reservation: "none", writeState: "blocked", reason: "adoption-invalid" },
  });
});
