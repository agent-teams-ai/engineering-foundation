import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDocsTools,
  DOCS_CONTEXT_OUTPUT_SCHEMA_V1,
  DOCS_ERROR_OUTPUT_SCHEMA_V1,
  DOCS_FIND_OUTPUT_SCHEMA_V1,
  DOCS_INFO_OUTPUT_SCHEMA_V1,
  DOCS_PROTOCOL_MCP_PACKAGE_VERSION,
  DOCS_PROTOCOL_MCP_PROJECTION_VERSION
} from "../dist/index.js";

const BINDING = Object.freeze({
  consumerRoot: "/fixed/test-consumer",
  profilePath: "config/docs-profile.yml"
});

test("exports distinct authoritative package and projection versions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(DOCS_PROTOCOL_MCP_PACKAGE_VERSION, manifest.version);
  assert.equal(DOCS_PROTOCOL_MCP_PROJECTION_VERSION, 1);
});

function execution(command, result, diagnostics = []) {
  return Object.freeze({
    envelope: Object.freeze({
      schemaVersion: 2,
      protocol: Object.freeze({ id: "agent-teams.docs-protocol", version: 1 }),
      command,
      outcome: "success",
      diagnostics: Object.freeze(diagnostics),
      result
    }),
    exitCode: 0
  });
}

function parseResult(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function advertisedSchema(tool) {
  return tool.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
}

test("tool surface is deterministic and strictly read-only", () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const tools = createDocsTools(reader, BINDING);

  assert.deepEqual(tools.map(({ name }) => name), ["docs_info", "docs_find", "docs_context"]);
  assert.ok(tools.every(({ annotations }) => annotations.readOnlyHint === true));
  assert.ok(tools.every(({ annotations }) => annotations.destructiveHint === false));
  assert.ok(tools.every(({ annotations }) => annotations.openWorldHint === false));
  assert.ok(tools.every(({ name }) => !/(new|write|recover|upgrade|shell|process)/u.test(name)));
  assert.ok(Object.isFrozen(tools));
});

test("exports closed projection and error schemas for external validation", () => {
  for (const schema of [DOCS_INFO_OUTPUT_SCHEMA_V1, DOCS_FIND_OUTPUT_SCHEMA_V1, DOCS_CONTEXT_OUTPUT_SCHEMA_V1, DOCS_ERROR_OUTPUT_SCHEMA_V1]) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
  }
  for (const schema of [DOCS_INFO_OUTPUT_SCHEMA_V1, DOCS_FIND_OUTPUT_SCHEMA_V1, DOCS_CONTEXT_OUTPUT_SCHEMA_V1]) {
    assert.equal(schema.properties.source.additionalProperties, false);
    assert.equal(schema.properties.result.additionalProperties, false);
    assert.equal(schema.properties.diagnostics.additionalProperties, false);
  }
  const info = DOCS_INFO_OUTPUT_SCHEMA_V1.properties.result.properties;
  assert.equal(info.authorityPaths.properties.items.maxItems, 16);
  assert.equal(info.authorityPaths.properties.returnedCount.maximum, 16);
  assert.equal(info.ownerIds.properties.items.maxItems, 32);
  assert.equal(info.semanticValidatorIds.properties.returnedCount.maximum, 32);
  assert.equal(info.catalog.properties.excludedPrefixes.properties.items.maxItems, 16);
  assert.equal(info.catalog.properties.collections.properties.items.maxItems, 16);
  assert.equal(info.catalog.properties.collections.properties.items.items.properties.roots.properties.items.maxItems, 16);
  const document = DOCS_FIND_OUTPUT_SCHEMA_V1.properties.result.properties.documents.items;
  assert.equal(document.properties.related.properties.items.maxItems, 8);
  assert.equal(document.properties.blockedBy.properties.returnedCount.maximum, 8);
});

test("tool inputs cannot replace the startup consumer root or profile", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const [info, find, context] = createDocsTools(reader, BINDING);

  const infoValidation = await info.inputSchema["~standard"].validate({ consumerRoot: "/escape" });
  const findValidation = await find.inputSchema["~standard"].validate({ text: "ADR", profilePath: "../escape.yml" });
  const contextValidation = await context.inputSchema["~standard"].validate({ consumerRoot: "/escape" });

  assert.ok("issues" in infoValidation);
  assert.ok("issues" in findValidation);
  assert.ok("issues" in contextValidation);
  assert.doesNotMatch(JSON.stringify(info.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })), /consumerRoot|profilePath/u);
  assert.doesNotMatch(JSON.stringify(find.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" })), /consumerRoot|profilePath/u);
});

test("tools always pass the fixed binding and request AbortSignal to the reader", async () => {
  const calls = [];
  const reader = {
    async info(input) {
      calls.push(input);
      return execution("docs.info", { projectId: "sandbox" });
    },
    async find(input) {
      calls.push(input);
      return execution("docs.find", { documents: [] });
    },
    async context(input) {
      calls.push(input);
      return execution("docs.context", { format: "llms.txt", content: "# docs" });
    }
  };
  const [info, find, context] = createDocsTools(reader, BINDING);
  const signal = new AbortController().signal;

  await info.run({}, signal);
  await find.run({ text: "ADR", maxResults: 7 }, signal);
  await context.run({ text: "architecture", fuzzy: true, maxDocuments: 4, maxBytes: 4096 }, signal);

  assert.deepEqual(calls[0], { ...BINDING, signal });
  assert.deepEqual(calls[1], { ...BINDING, query: { text: "ADR" }, signal });
  assert.equal("maxResults" in calls[1].query, false);
  assert.deepEqual(calls[2], {
    ...BINDING,
    query: { text: "architecture", ranking: "fuzzy-advisory" },
    limits: { maxBytes: 4096, maxDocuments: 4 },
    signal
  });
});

test("docs_find bounds the returned documents and reports truncation", async () => {
  const documents = Array.from({ length: 8 }, (_, index) => Object.freeze({ id: `ADR-${index}` }));
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", Object.freeze({ kind: "find", matches: 8, documents })); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const find = createDocsTools(reader, BINDING)[1];

  const result = parseResult(await find.run({ text: "ADR", maxResults: 3 }, new AbortController().signal));

  assert.equal(result.schemaVersion, DOCS_PROTOCOL_MCP_PROJECTION_VERSION);
  assert.equal("envelope" in result, false);
  assert.equal(result.result.originalCount, 8);
  assert.equal(result.result.returnedCount, 3);
  assert.equal(result.result.truncated, true);
  assert.deepEqual(result.result.documents.map(({ id }) => id), ["ADR-0", "ADR-1", "ADR-2"]);
});

test("unexpected reader errors are sanitized", async () => {
  const reader = {
    async info() { throw new Error("secret /private/user/project/config.yml"); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const info = createDocsTools(reader, BINDING)[0];

  const result = await info.run({}, new AbortController().signal);
  const payload = parseResult(result);

  assert.equal(result.isError, true);
  assert.equal(payload.error.code, "DOCS_READ_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /secret|private|config\.yml/u);
});

test("schema-shaped large info is summarized instead of failing the transport limit", async () => {
  const requiredMetadata = Array.from({ length: 64 }, (_, index) => `field-${index}`);
  const allowedOwnerIds = Array.from({ length: 64 }, (_, index) => `Owner-${index}`);
  const reader = {
    async info() {
      return execution("docs.info", {
        kind: "info",
        projectId: "sandbox",
        protocol: { id: "agent-teams.docs-protocol", version: 1 },
        foundationProfile: { schemaVersion: 3, path: ".docs-protocol/document-authoring.yaml", metadataSidecarPolicy: "foundation-profile-v3-strict-merge" },
        agentWorkflow: { adoption: "portable-v1", skillPath: ".agents/skills/docs-authoring/SKILL.md" },
        catalog: {
          collections: Array.from({ length: 48 }, (_, index) => ({ kind: "markdown-tree", root: `docs/collection-${index}`, roots: [`docs/root-${index}`] })),
          excludedPrefixes: Array.from({ length: 48 }, (_, index) => `vendor/excluded-${index}`)
        },
        semanticDigest: `sha256:${"a".repeat(64)}`,
        metadataSchemaPath: "docs/metadata.schema.json",
        authorityPaths: Array.from({ length: 96 }, (_, index) => `architecture/authority-${index}.yaml`),
        ownerIds: Array.from({ length: 256 }, (_, index) => `Owner-${index}`),
        types: Array.from({ length: 128 }, (_, index) => ({
          type: `type-${index}`,
          initialStatus: "proposed",
          allowedOwnerIds,
          requiredMetadata
        })),
        semanticValidatorIds: Array.from({ length: 128 }, (_, index) => `validator-${index}`)
      });
    },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const info = createDocsTools(reader, BINDING)[0];
  const response = await info.run({}, new AbortController().signal);
  assert.notEqual(response.isError, true);
  const payload = parseResult(response);
  assert.equal(payload.result.authorityPaths.originalCount, 96);
  assert.equal(payload.result.authorityPaths.returnedCount, 16);
  assert.equal(payload.result.ownerIds.returnedCount, 32);
  assert.equal(payload.result.catalog.collections.originalCount, 48);
  assert.equal(payload.result.catalog.collections.returnedCount, 16);
  assert.equal(payload.result.catalog.excludedPrefixes.returnedCount, 16);
  assert.equal(payload.result.types.originalCount, 128);
  assert.equal(payload.result.types.returnedCount, 24);
  assert.equal(payload.result.types.truncated, true);
});

test("diagnostic projection reports deterministic scale evidence", async () => {
  const diagnostics = Array.from({ length: 20 }, (_, index) => ({
    ruleId: `rule-${index}`,
    severity: "warning",
    phase: "query",
    subject: `subject-${index}`,
    message: `Message ${index}`
  }));
  const reader = {
    async info() { return execution("docs.info", { kind: "info", catalog: { collections: [], excludedPrefixes: [] } }, diagnostics); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const response = await createDocsTools(reader, BINDING)[0].run({}, new AbortController().signal);
  const evidence = parseResult(response).diagnostics;
  assert.deepEqual({ originalCount: evidence.originalCount, returnedCount: evidence.returnedCount, truncated: evidence.truncated }, {
    originalCount: 20,
    returnedCount: 8,
    truncated: true
  });
  assert.deepEqual(evidence.items.map(({ ruleId }) => ruleId), diagnostics.slice(0, 8).map(({ ruleId }) => ruleId));
});

test("cancellation returns a bounded sanitized error", async () => {
  const reader = {
    async info() { return execution("docs.info", { kind: "info" }); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const info = createDocsTools(reader, BINDING)[0];

  const controller = new AbortController();
  controller.abort();
  const cancelled = await info.run({}, controller.signal);
  assert.equal(parseResult(cancelled).error.code, "CANCELLED");
});

test("docs_find drops large metadata while preserving the deterministic document whitelist", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() {
      return execution("docs.find", {
        kind: "find",
        matches: 1,
        documents: [{
          id: "ADR-0001",
          type: "adr",
          status: "accepted",
          owner: "Platform",
          title: "Bounded transport projection",
          summary: "Metadata stays behind the transport boundary.",
          repositoryPath: "docs/decisions/ADR-0001.md",
          source: "markdown-tree",
          related: ["ADR-0002"],
          blockedBy: [],
          metadata: { evidence: "x".repeat(900_000) }
        }]
      });
    },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const response = await createDocsTools(reader, BINDING)[1].run({ id: "ADR-0001" }, new AbortController().signal);
  assert.notEqual(response.isError, true);
  const projection = parseResult(response);
  assert.deepEqual(response.structuredContent, projection);
  const document = projection.result.documents[0];
  assert.equal(document.id, "ADR-0001");
  assert.equal("metadata" in document, false);
  assert.deepEqual(document.related.items, ["ADR-0002"]);
  assert.ok(Buffer.byteLength(JSON.stringify(document), "utf8") < 16_384);
});

test("docs_find requires a bounded valid query", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const find = createDocsTools(reader, BINDING)[1];
  const validate = find.inputSchema["~standard"].validate;

  assert.ok("issues" in await validate({ maxResults: 5 }));
  assert.ok("issues" in await validate({ fuzzy: false }));
  assert.ok("issues" in await validate({ owner: "platform", fuzzy: true }));
  assert.ok("issues" in await validate({ text: "ADR", maxResults: 101 }));
  assert.ok("value" in await validate({ text: "ADR", maxResults: 100 }));
});

test("advertised schemas require find queries and fuzzy text without requiring context filters", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const [, find, context] = createDocsTools(reader, BINDING);
  const expectedQueryFields = ["blockedBy", "id", "owner", "related", "status", "text", "type"];

  const advertisedFind = advertisedSchema(find);
  const advertisedContext = advertisedSchema(context);
  assert.deepEqual(advertisedFind.anyOf.map(({ required }) => required[0]), expectedQueryFields);
  assert.equal("anyOf" in advertisedContext, false);
  for (const advertised of [advertisedFind, advertisedContext]) {
    assert.deepEqual(advertised.allOf[0].if, { properties: { fuzzy: { const: true } }, required: ["fuzzy"] });
    assert.deepEqual(advertised.allOf[0]["then"], { required: ["text"] });
    assert.equal(await Promise.resolve(advertised.allOf[0]), advertised.allOf[0]);
    assert.ok(Object.isFrozen(advertised.allOf[0]));
    assert.ok(Object.isFrozen(advertised.allOf[0]["then"].required));
    for (const field of ["id", "owner", "related", "blockedBy"]) {
      assert.deepEqual(advertised.properties[field], {
        type: "string",
        minLength: 1,
        maxLength: 214,
        pattern: "^[A-Za-z0-9@][A-Za-z0-9@._/-]*$"
      });
    }
    for (const field of ["type", "status"]) {
      assert.deepEqual(advertised.properties[field], {
        type: "string",
        minLength: 1,
        maxLength: 160,
        pattern: "^[a-z0-9][a-z0-9._/-]*$"
      });
    }
    assert.equal(advertised.properties.text.maxLength, 512);
    assert.equal(advertised.properties.text.pattern, "^[^\\u0000-\\u001F\\u007F-\\u009F\\uD800-\\uDFFF]+$");
  }
});

test("query validators enforce exact canonical identifier and control boundaries", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() { return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const [, find, context] = createDocsTools(reader, BINDING);
  for (const validate of [find.inputSchema["~standard"].validate, context.inputSchema["~standard"].validate]) {
    assert.ok("value" in await validate({ id: `A${"a".repeat(213)}` }));
    assert.ok("issues" in await validate({ id: `A${"a".repeat(214)}` }));
    assert.ok("issues" in await validate({ owner: "owner:id" }));
    assert.ok("value" in await validate({ type: "a".repeat(160) }));
    assert.ok("issues" in await validate({ type: "a".repeat(161) }));
    assert.ok("issues" in await validate({ status: "In-Review" }));
    assert.ok("issues" in await validate({ text: "docs\u0007query" }));
    assert.ok("issues" in await validate({ text: "docs\u0085query" }));
    assert.ok("issues" in await validate({ text: "docs\uD800query" }));
  }
});

test("docs_context returns llms.txt through the package projection and validates bounds", async () => {
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find() { return execution("docs.find", { documents: [] }); },
    async context() {
      return execution("docs.context", {
        kind: "context",
        format: "llms.txt",
        includedDocuments: 1,
        omittedDocuments: 0,
        truncated: false,
        content: "# Sandbox docs\n"
      });
    }
  };
  const context = createDocsTools(reader, BINDING)[2];
  const payload = parseResult(await context.run({}, new AbortController().signal));

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.source.command, "docs.context");
  assert.equal(payload.result.format, "llms.txt");
  assert.equal(payload.result.content, "# Sandbox docs\n");
  assert.ok("issues" in await context.inputSchema["~standard"].validate({ fuzzy: true }));
  assert.ok("issues" in await context.inputSchema["~standard"].validate({ maxBytes: 512 }));
  assert.ok("issues" in await context.inputSchema["~standard"].validate({ owner: "platform", fuzzy: true }));
  assert.ok("value" in await context.inputSchema["~standard"].validate({}));
  assert.ok("value" in await context.inputSchema["~standard"].validate({ fuzzy: false }));
  assert.ok("value" in await context.inputSchema["~standard"].validate({ maxBytes: 4096, maxDocuments: 2 }));
  assert.ok("value" in await context.inputSchema["~standard"].validate({ text: "docs", maxBytes: 4096, maxDocuments: 2 }));
});

// Captured before the loader/topology fix from candidate 9c5199db73547f39b8959aba123887f89f51ce60.
// These published V1 JSON bytes must survive internal schema assembly changes.
test("published MCP schemas retain their exact V1 serialization", () => {
  const schemas = [DOCS_INFO_OUTPUT_SCHEMA_V1, DOCS_FIND_OUTPUT_SCHEMA_V1,
    DOCS_CONTEXT_OUTPUT_SCHEMA_V1, DOCS_ERROR_OUTPUT_SCHEMA_V1,
    ...createDocsTools({}, BINDING).map(advertisedSchema)];
  assert.deepEqual(schemas.map((schema) => createHash("sha256").update(JSON.stringify(schema)).digest("hex")),
    [
    "a23b0c457a497e29127287a231d685781c5fd556a0d50284dde2e52428004839",
    "b6851e7950b2e5b09db6a9bb1211d5d4cb7b48ea16a79120028e39bf86cc7107",
    "9bcbc756edec6e5fd690e51f726f9da7d612d202abe8166720377302a69c6a57",
    "970a1c355bb8d9413174dbf4cb772f5f574e4facb8bab28f074b409b227a4184",
    "b151588b27a9a7b6d0808c5c25073aa15d449cea66fba5bf47357ce04962f141",
    "185327799c27783dfabe5d95b27dd9c18ba5b4a8ddd918b9777ed46a709681c1",
    "4010d2323d67a096e8bf827edd1fdba8bbf32186abb0381f746daaf960ff214a"
]);
});

test("validated transport arguments preserve fields and map only explicit query authority", async () => {
  const calls = [];
  const reader = {
    async info() { return execution("docs.info", {}); },
    async find(input) { calls.push(input); return execution("docs.find", { documents: [] }); },
    async context(input) { calls.push(input); return execution("docs.context", { format: "llms.txt", content: "" }); }
  };
  const [, find, context] = createDocsTools(reader, BINDING);
  const query = { blockedBy: "TASK-1", id: "ADR-1", owner: "@docs/team", related: "ADR-2", status: "active", text: "docs", type: "adr" };
  const signal = new AbortController().signal;
  for (const [tool, limits] of [[find, { maxResults: 3 }], [context, { maxBytes: 4096, maxDocuments: 2 }]]) {
    const input = { ...query, ...limits, fuzzy: true };
    const parsed = await tool.inputSchema["~standard"].validate(input);
    assert.deepEqual(parsed, { value: input });
    assert.ok(Object.isFrozen(parsed.value));
    const result = await tool.run(parsed.value, signal);
    assert.deepEqual(result.structuredContent, parseResult(result));
  }
  for (const call of calls) {
    assert.deepEqual(call.query, { ...query, ranking: "fuzzy-advisory" });
    assert.equal(call.consumerRoot, BINDING.consumerRoot);
    assert.equal(call.profilePath, BINDING.profilePath);
    assert.equal(call.signal, signal);
  }
  assert.deepEqual(calls[1].limits, { maxBytes: 4096, maxDocuments: 2 });
});
