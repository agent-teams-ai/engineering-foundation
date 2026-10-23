import {
  schema,
  schemaV2,
  schemaV3,
  validate,
  validateV2,
  assertValidEnvelope,
} from "./support/envelope-schema-cases.ts";
import { DocsProtocol } from "../dist/features/portable-documentation/application/docs-protocol.js";
import { YamlCompiledOutputReader } from "../dist/features/portable-documentation/adapters/outbound/yaml-compiled-output-reader.js";
import { createCommunityMiniSearchIndex } from "../dist/features/portable-documentation/adapters/outbound/minisearch-adapter.js";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createDocsProtocolApi } from "../dist/features/docs-command/adapters/inbound/protocol-api.js";
import { parseDocsProtocolProfile } from "../dist/features/portable-documentation/application/profile-policy.js";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const fixture = new URL("./fixtures/portable-qualification", import.meta.url).pathname;
test("operation presentation preserves generic payloads, wire vocabulary and every exit outcome", async () => {
  const outcomes = {
    "authority-stale": 1,
    cancelled: 130,
    conflict: 1,
    "execution-failure": 3,
    "invalid-input": 2,
    "recovery-required": 1,
    success: 0,
    violation: 1,
  };
  const commands = [
    ["checkV2", "docs.check", 2],
    ["doctorV2", "docs.doctor", 2],
    ["findV2", "docs.find", 2],
    ["infoV2", "docs.info", 2],
    ["newDocumentV2", "docs.new", 2],
    ["recoverV2", "docs.recover", 2],
    ["findV3", "docs.find", 3],
    ["contextV1", "docs.context", 3],
  ];
  for (const [outcome, exitCode] of Object.entries(outcomes)) {
    const diagnostics = Object.freeze([
      {
        message: "Fixture diagnostic",
        phase: "input",
        ruleId: "docs.fixture",
        severity: "info",
        subject: "fixture",
      },
    ]);
    const result = Object.freeze({});
    const operations = Object.fromEntries(
      commands.map(([method, command]) => [
        method,
        async () => ({ command, outcome, diagnostics, result }),
      ]),
    );
    const api = createDocsProtocolApi(operations);
    for (const [method, command, schemaVersion] of commands) {
      const execution = await api[method]({});
      assert.deepEqual(execution, {
        exitCode,
        envelope: {
          schemaVersion,
          protocol: { id: "agent-teams.docs-protocol", version: 1 },
          command,
          outcome,
          diagnostics,
          result,
        },
      });
      assert.equal(execution.envelope.result, result);
      assert.equal(execution.envelope.diagnostics, diagnostics);
      assert.equal(Object.isFrozen(execution.envelope), true);
      // Empty invalid-input results are valid for every operation. Other
      // command/result combinations retain their existing schema-specific tests.
      if (outcome === "invalid-input") {
        assertValidEnvelope(execution.envelope);
      }
    }
  }
});

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
      foundationProfile: {
        path: "architecture/foundation/document-authoring.yaml",
        schemaVersion: 2,
        metadataSidecarPolicy: "foundation-profile-v2-strict-merge",
      },
      agentWorkflow: { skillPath: ".agents/skills/docs-authoring/SKILL.md" },
      metadataSchemaPath: "docs/metadata.schema.json",
      metadataSidecar: { kind: "none" },
      ownerIds: [],
      types: [
        {
          type: "adr",
          initialStatus: "proposed",
          allowedOwnerIds: ["architecture/tooling"],
          identity: { kind: "explicit", format: "adr-four-digits" },
          heading: { kind: "id-colon-title" },
          placement: {
            kind: "collection",
            directory: "docs/decisions",
            filename: "numeric-id-slug",
          },
          template: { kind: "fenced-markdown-body", path: "docs/templates/adr.md" },
          requiredMetadata: ["id", "type", "status", "owner", "summary"],
          reachability: { kind: "manual-fixed-index", indexPath: "docs/decisions/README.md" },
        },
      ],
      semanticValidatorIds: [],
    },
  });
});

const profile = parseDocsProtocolProfile({
  schemaVersion: 3,
  protocol: { id: "agent-teams.docs-protocol", version: 1 },
  foundationProfile: {
    path: ".docs-protocol/document-authoring.yaml",
    schemaVersion: 3,
    metadataSidecarPolicy: "foundation-profile-v3-strict-merge",
  },
  agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
  semanticValidatorIds: [],
});

test("schema accepts emitted success and stable zero-match envelopes", async () => {
  const info = await execute(process.execPath, [
    cli.pathname,
    "info",
    "--consumer",
    fixture,
    "--json",
  ]);
  assertValidEnvelope(JSON.parse(info.stdout));

  const empty = await execute(process.execPath, [
    cli.pathname,
    "find",
    "--consumer",
    fixture,
    "--id",
    "ADR-9999",
    "--json",
  ]);
  const envelope = JSON.parse(empty.stdout);
  assert.equal(envelope.result.matches, 0);
  assertValidEnvelope(envelope);

  const context = await execute(process.execPath, [
    cli.pathname,
    "context",
    "--consumer",
    fixture,
    "--max-documents",
    "1",
    "--json",
  ]);
  assertValidEnvelope(JSON.parse(context.stdout));
});

test("schema accepts the emitted invalid-input envelope", async () => {
  await assert.rejects(execute(process.execPath, [cli.pathname, "unknown", "--json"]), (error) => {
    assert.equal(error.code, 2);
    const envelope = JSON.parse(error.stdout);
    assert.equal(envelope.outcome, "invalid-input");
    assertValidEnvelope(envelope);
    return true;
  });
});

test("CLI classifies invalid Foundation authority as input and missing runtime roots as execution failures", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-teams-docs-errors-"));
  const consumer = join(temporary, "consumer");
  try {
    await cp(fixture, consumer, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    await writeFile(
      join(consumer, ".docs-protocol/document-authoring.yaml"),
      "schemaVersion: 1\nprojectId: legacy\n",
      "utf8",
    );
    await assert.rejects(
      execute(process.execPath, [cli.pathname, "info", "--consumer", consumer, "--json"]),
      (error) => {
        const envelope = JSON.parse(error.stdout);
        assert.equal(error.code, 2);
        assert.equal(envelope.outcome, "invalid-input");
        assert.equal(envelope.diagnostics[0].phase, "authority");
        assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.invalid-input.authority");
        assertValidEnvelope(envelope);
        return true;
      },
    );
    await assert.rejects(
      execute(process.execPath, [
        cli.pathname,
        "info",
        "--consumer",
        join(temporary, "missing"),
        "--json",
      ]),
      (error) => {
        const envelope = JSON.parse(error.stdout);
        assert.equal(error.code, 3);
        assert.equal(envelope.outcome, "execution-failure");
        assert.equal(envelope.diagnostics[0].ruleId, "docs.cli.execution-failure.filesystem");
        assertValidEnvelope(envelope);
        return true;
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

const requiresSignals = process.platform === "win32" ? test.skip : test;

requiresSignals("SIGTERM cancellation emits one valid JSON envelope with exit 130", async () => {
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `import { runDocsCli } from ${JSON.stringify(moduleUrl)}; const pending = runDocsCli(["info", "--consumer", ${JSON.stringify(fixture)}, "--json"]); queueMicrotask(() => process.kill(process.pid, "SIGTERM")); process.exitCode = await pending;`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
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
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
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
        authorityPaths: [],
      };
    },
    async inspectEnvironment() {
      return {
        installedFoundationVersion: "0.17.0-rc.0",
        installedFoundationBuildIdentity: `sha256:${"1".repeat(64)}`,
        filesystem: { basis: "platform-contract", strictDirectoryDurability: "platform-supported" },
      };
    },
    async inspect() {
      return {
        schemaVersion: 1,
        state: "recoverable",
        recovery: {
          exactFoundationBuildIdentity: `sha256:${"2".repeat(64)}`,
          exactFoundationVersion: "0.17.0-rc.0",
        },
        diagnostics: [],
      };
    },
  };
  const protocol = createDocsProtocolApi(
    new DocsProtocol({
      compiledOutput: new YamlCompiledOutputReader(),
      searchIndex: createCommunityMiniSearchIndex(),
      adoption: {
        async inspect() {
          return [];
        },
      },
      anchors: {
        async matchedPatterns() {
          return [];
        },
      },
      foundation,
      profiles: {
        async read() {
          return profile;
        },
      },
    }),
  );
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
    result: { kind: "find", matches: 0, documents: [], accidental: true },
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
  const emitted = await execute(process.execPath, [
    cli.pathname,
    "info",
    "--consumer",
    fixture,
    "--json",
  ]);
  const envelope = JSON.parse(emitted.stdout);
  envelope.result.authorityPaths = Array.from(
    { length: 68 },
    (_value, index) => `docs/authority/path-${index}.md`,
  );
  assert.equal(schemaV2.$defs.infoResult.properties.authorityPaths.maxItems, 96);
  assertValidEnvelope(envelope);
  envelope.result.authorityPaths = Array.from(
    { length: 97 },
    (_value, index) => `docs/authority/path-${index}.md`,
  );
  assert.equal(validateV2(envelope), false);
});

test("find envelope accepts Foundation-projected metadata beyond old 256/key-length caps", () => {
  const metadata = Object.fromEntries(
    Array.from({ length: 257 }, (_value, index) => [`${"k".repeat(160)}-${index}`, index]),
  );
  const envelope = {
    schemaVersion: 1,
    protocol: { id: "agent-teams.docs-protocol", version: 1 },
    command: "docs.find",
    outcome: "success",
    diagnostics: [],
    result: {
      kind: "find",
      matches: 1,
      documents: [
        {
          id: "ADR-0001",
          type: "adr",
          status: "proposed",
          owner: "architecture/tooling",
          summary: "Large metadata",
          title: "Large metadata",
          repositoryPath: "docs/decisions/0001-large.md",
          source: "markdown-tree",
          metadata,
          related: [],
          blockedBy: [],
        },
      ],
    },
  };
  assertValidEnvelope(envelope);
});
