import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createDocsProtocolMcpServer } from "../dist/index.js";

function execution(command, result) {
  return {
    envelope: {
      schemaVersion: 2,
      protocol: { id: "agent-teams.docs-protocol", version: 1 },
      command,
      outcome: "success",
      diagnostics: [],
      result
    },
    exitCode: 0
  };
}

async function snapshot(root) {
  const names = (await readdir(root)).toSorted();
  return Promise.all(names.map(async (name) => [name, await readFile(join(root, name), "utf8")]));
}

test("MCP transport exposes and calls only the fixed read-only surface", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "docs-protocol-mcp-e2e-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, "docs.config.yaml"), "schemaVersion: 1\n", "utf8");
  await writeFile(join(fixture, "ADR-0001.md"), "# ADR-0001: Sandbox\n", "utf8");
  const before = await snapshot(fixture);
  const calls = [];
  const reader = {
    async info(input) {
      calls.push(["info", input]);
      return execution("docs.info", { projectId: "sandbox" });
    },
    async find(input) {
      calls.push(["find", input]);
      return execution("docs.find", { kind: "find", matches: 1, documents: [{ id: "ADR-0001" }] });
    },
    async context(input) {
      calls.push(["context", input]);
      return execution("docs.context", {
        kind: "context",
        format: "llms.txt",
        projectId: "sandbox",
        selection: { ranking: "fuzzy-advisory", query: { text: "sandbox" } },
        limits: { maxBytes: 4096, maxDocuments: 2 },
        includedDocuments: 1,
        omittedDocuments: 0,
        truncated: false,
        content: "# Sandbox documentation\n\n- ADR-0001: Sandbox\n"
      });
    }
  };
  const binding = { consumerRoot: fixture, profilePath: "docs.config.yaml" };
  const server = createDocsProtocolMcpServer(reader, binding);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport exposes an onmessage callback property, not EventTarget.
  clientTransport.onmessage = (message) => {
    if ("id" in message && ("result" in message || "error" in message)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  context.after(async () => {
    await clientTransport.close();
    await server.close();
  });
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve) => {
      pending.set(id, resolve);
    });
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    return response;
  };

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "docs-protocol-mcp-e2e", version: "1.0.0" }
  });
  assert.ok("result" in initialized);
  assert.equal(initialized.result.serverInfo.name, "@agent-teams/docs-protocol-mcp");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(initialized.result.serverInfo.version, manifest.version);
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listed = await request("tools/list", {});
  assert.deepEqual(listed.result.tools.map(({ name }) => name), ["docs_info", "docs_find", "docs_context"]);
  assert.ok(listed.result.tools.every(({ annotations }) => annotations.readOnlyHint === true));
  assert.ok(listed.result.tools.every(({ outputSchema }) =>
    outputSchema.type === "object" && outputSchema.additionalProperties === false && outputSchema.properties.result.additionalProperties === false
  ));

  const called = await request("tools/call", {
    name: "docs_context",
    arguments: { text: "sandbox", fuzzy: true, maxDocuments: 2, maxBytes: 4096 }
  });
  const payload = JSON.parse(called.result.content[0].text);
  assert.deepEqual(called.result.structuredContent, payload);
  assert.equal(payload.result.format, "llms.txt");
  assert.deepEqual(payload.result.selection, { ranking: "fuzzy-advisory", query: { text: "sandbox" } });
  assert.deepEqual(payload.result.limits, { maxBytes: 4096, maxDocuments: 2 });
  assert.equal(Object.hasOwn(payload.result, "ranking"), false);
  assert.match(payload.result.content, /ADR-0001/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].consumerRoot, fixture);
  assert.equal(calls[0][1].profilePath, "docs.config.yaml");

  for (const [name, arguments_, kind] of [
    ["docs_info", {}, "info"],
    ["docs_find", { id: "ADR-0001", maxResults: 1 }, "find"]
  ]) {
    const response = await request("tools/call", { name, arguments: arguments_ });
    assert.notEqual(response.result.isError, true);
    assert.deepEqual(response.result.structuredContent, JSON.parse(response.result.content[0].text));
    assert.equal(response.result.structuredContent.result.kind, kind);
    assert.equal(response.result.structuredContent.source.command, `docs.${kind}`);
  }
  assert.equal(calls.length, 3);
  for (const [name, arguments_] of [
    ["docs_info", { profilePath: "escape.yaml" }],
    ["docs_find", { maxResults: 1 }],
    ["docs_find", { owner: "docs/team", fuzzy: true }],
    ["docs_context", { maxBytes: 1023 }],
    ["docs_context", { fuzzy: true }]
  ]) {
    const invalid = await request("tools/call", { name, arguments: arguments_ });
    assert.ok("error" in invalid || invalid.result?.isError === true);
    assert.equal(calls.length, 3);
  }

  const rootOverride = await request("tools/call", {
    name: "docs_context",
    arguments: { text: "sandbox", consumerRoot: "/escape" }
  });
  assert.ok("error" in rootOverride || rootOverride.result?.isError === true);
  assert.equal(calls.length, 3);

  const forbidden = await request("tools/call", { name: "docs_new", arguments: {} });
  assert.ok("error" in forbidden || forbidden.result?.isError === true);
  assert.equal(calls.length, 3);
  assert.deepEqual(await snapshot(fixture), before);
});
