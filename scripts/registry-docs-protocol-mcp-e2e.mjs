import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/server";

import { runCommand } from "./pack-test-support.mjs";

const COMMAND_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const FIXTURE_FILE_LIMIT = 32;
const FIXTURE_FILE_BYTES_LIMIT = 8 * 1024 * 1024;
const FIXTURE_TOTAL_BYTES_LIMIT = 16 * 1024 * 1024;

async function runJson(cliPath, consumerRoot, arguments_) {
  const result = await runCommand(
    process.execPath,
    [cliPath, ...arguments_, "--json"],
    consumerRoot,
    { timeoutMs: COMMAND_TIMEOUT_MS },
  );
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

async function snapshotTree(root, relative = "") {
  const entries = (await readdir(join(root, relative), { withFileTypes: true }))
    .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const snapshot = [];
  for (const entry of entries) {
    const repositoryPath = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const state = await lstat(join(root, repositoryPath));
    if (state.isDirectory() && !state.isSymbolicLink()) {
      snapshot.push({ path: repositoryPath, type: "directory" });
      snapshot.push(...await snapshotTree(root, repositoryPath));
    } else if (state.isFile() && !state.isSymbolicLink()) {
      snapshot.push({
        content: (await readFile(join(root, repositoryPath))).toString("base64"),
        mode: state.mode & 0o777,
        path: repositoryPath,
        type: "file",
      });
    } else {
      throw new Error(`Registry MCP fixture contains unsupported entry ${repositoryPath}.`);
    }
  }
  return snapshot;
}

async function waitBounded(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function openJsonRpcClient(cliPath, consumerRoot) {
  const child = spawn(
    process.execPath,
    [cliPath, "--consumer-root", consumerRoot],
    { cwd: consumerRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const readBuffer = new ReadBuffer({ maxBufferSize: OUTPUT_LIMIT_BYTES });
  const pending = new Map();
  const stderr = [];
  let stderrBytes = 0;
  let nextId = 1;
  let closing = false;
  let failure;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function fail(error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    for (const pendingRequest of pending.values()) {
      // oxlint-disable-next-line promise/no-multiple-resolved -- every pending entry is rejected once before the map is cleared.
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(failure);
    }
    pending.clear();
  }

  child.once("error", fail);
  child.once("exit", (code, signal) => {
    resolveExit({ code, signal });
    if (!closing || code !== 0 || signal !== null) {
      fail(new Error(`Installed MCP process exited unexpectedly: code=${code} signal=${signal}.`));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > OUTPUT_LIMIT_BYTES) {
      fail(new Error("Installed MCP stderr exceeded its bounded output limit."));
      child.kill("SIGKILL");
      return;
    }
    stderr.push(chunk);
  });
  child.stdout.on("data", (chunk) => {
    try {
      readBuffer.append(chunk);
      for (let message = readBuffer.readMessage(); message !== null; message = readBuffer.readMessage()) {
        if (!("id" in message) || (!("result" in message) && !("error" in message))) {
          continue;
        }
        const pendingRequest = pending.get(message.id);
        if (pendingRequest !== undefined) {
          clearTimeout(pendingRequest.timeout);
          pending.delete(message.id);
          pendingRequest.resolve(message);
        }
      }
    } catch (error) {
      fail(error);
      child.kill("SIGKILL");
    }
  });

  async function send(message) {
    if (failure !== undefined || child.stdin.destroyed) {
      throw failure ?? new Error("Installed MCP stdin is closed.");
    }
    if (!child.stdin.write(serializeMessage(message))) {
      await new Promise((resolve, reject) => {
        child.stdin.once("drain", resolve);
        child.stdin.once("error", reject);
      });
    }
  }

  async function request(method, params) {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Installed MCP request ${method} exceeded ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { reject, resolve, timeout });
    });
    try {
      await send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pendingRequest = pending.get(id);
      if (pendingRequest !== undefined) {
        clearTimeout(pendingRequest.timeout);
        pending.delete(id);
        pendingRequest.reject(error);
      }
    }
    return response;
  }

  async function close() {
    closing = true;
    child.stdin.end();
    let exit;
    try {
      exit = await waitBounded(exited, 5_000, "Installed MCP did not exit after stdin closed.");
    } catch {
      child.kill("SIGTERM");
      exit = await waitBounded(exited, 2_000, "Installed MCP did not stop after SIGTERM.")
        .catch(async () => {
          child.kill("SIGKILL");
          await exited;
          throw new Error("Installed MCP required forced termination.");
        });
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Installed MCP shutdown was not clean: code=${exit.code} signal=${exit.signal}.`);
    }
    if (failure !== undefined) {
      throw failure;
    }
    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
  }

  return Object.freeze({ close, notify: send, request });
}

function toolPayload(response) {
  assert.ok("result" in response, JSON.stringify(response));
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, "text");
  const projection = JSON.parse(response.result.content[0].text);
  assert.deepEqual(response.result.structuredContent, projection);
  return projection;
}

async function bootstrapFixture(cliPath, consumerRoot, executeJson = runJson) {
  const init = [
    "init", "--consumer", consumerRoot,
    "--project-id", "registry-mcp-e2e",
    "--owner", "docs/platform",
  ];
  const preview = await executeJson(cliPath, consumerRoot, [...init, "--dry-run"]);
  assert.equal(preview.result.writeState, "preview");
  const applied = await executeJson(cliPath, consumerRoot, [
    ...init, "--apply", "--expect", preview.result.planDigest,
  ]);
  assert.equal(applied.result.writeState, "applied");
  const authored = await executeJson(cliPath, consumerRoot, [
    "new", "--consumer", consumerRoot,
    "--type", "tutorial",
    "--id", "docs.tutorial.registry-mcp",
    "--title", "Registry MCP workflow",
    "--owner", "docs/platform",
    "--summary", "Proves the packed read-only MCP workflow.",
    "--apply",
  ]);
  assert.equal(authored.result.writeState, "applied");
}

function assertPortableFixturePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512 ||
      path.startsWith("/") || path.includes("\\") || path.split("/").some(
        (segment) => segment.length === 0 || segment === "." || segment === "..",
      )) {
    throw new Error("Installed portable bootstrap renderer returned an unsafe path.");
  }
}

async function materializeInstalledPortableFixture(installedDocsRoot, consumerRoot) {
  const assetModulePath = join(
    installedDocsRoot,
    "dist", "features", "portable-bootstrap", "application", "portable-bootstrap-assets.js",
  );
  const assets = await import(pathToFileURL(assetModulePath).href);
  if (typeof assets.portableBootstrapDesiredFiles !== "function" ||
      typeof assets.portableBootstrapManagedBlock !== "function") {
    throw new Error("Installed Docs Protocol does not expose its internal bootstrap asset renderer.");
  }
  const files = assets.portableBootstrapDesiredFiles("registry-mcp-e2e", "docs/platform");
  if (!Array.isArray(files) || files.length === 0 || files.length + 1 > FIXTURE_FILE_LIMIT) {
    throw new Error("Installed portable bootstrap renderer returned an invalid file inventory.");
  }
  let totalBytes = 0;
  for (const file of files) {
    assertPortableFixturePath(file?.path);
    if (file.ownership !== "create-only" || !(file.bytes instanceof Uint8Array) ||
        file.bytes.byteLength > FIXTURE_FILE_BYTES_LIMIT) {
      throw new Error("Installed portable bootstrap renderer returned an invalid file asset.");
    }
    totalBytes += file.bytes.byteLength;
    if (totalBytes > FIXTURE_TOTAL_BYTES_LIMIT) {
      throw new Error("Installed portable bootstrap assets exceed the bounded fixture budget.");
    }
    const destination = join(consumerRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: "wx", mode: 0o644 });
  }
  const agentsSource = `${assets.portableBootstrapManagedBlock("\n")}\n`;
  const agentsBytes = Buffer.from(agentsSource, "utf8");
  totalBytes += agentsBytes.byteLength;
  if (agentsBytes.byteLength > FIXTURE_FILE_BYTES_LIMIT || totalBytes > FIXTURE_TOTAL_BYTES_LIMIT) {
    throw new Error("Installed portable bootstrap AGENTS.md exceeds the bounded fixture budget.");
  }
  await writeFile(join(consumerRoot, "AGENTS.md"), agentsBytes, { flag: "wx", mode: 0o644 });
}

export async function prepareRegistryDocsProtocolMcpFixture(input, dependencies = {}) {
  const executeJson = dependencies.executeJson ?? runJson;
  if ((dependencies.platform ?? process.platform) === "win32") {
    const materialize = dependencies.materializePortableFixture ?? materializeInstalledPortableFixture;
    await materialize(input.installedDocsRoot, input.consumerRoot);
  } else {
    await bootstrapFixture(input.docsCli, input.consumerRoot, executeJson);
  }
  const checked = await executeJson(input.docsCli, input.consumerRoot, [
    "check", "--consumer", input.consumerRoot,
  ]);
  assert.equal(checked.outcome, "success");
  assert.equal(checked.diagnostics.some(({ severity }) => severity === "error"), false);
  return (dependencies.platform ?? process.platform) === "win32"
    ? Object.freeze({ documentId: "docs.tutorials.index", query: "Tutorials", title: "Tutorials" })
    : Object.freeze({
      documentId: "docs.tutorial.registry-mcp",
      query: "Registry MCP",
      title: "Registry MCP workflow",
    });
}

export async function verifyRegistryDocsProtocolCli(input) {
  const consumerRoot = input.consumerRoot;
  await mkdir(consumerRoot, { recursive: true });
  const docsCli = join(input.installedDocsRoot, "dist", "cli.js");
  const expectedDocument = await prepareRegistryDocsProtocolMcpFixture({
    consumerRoot,
    docsCli,
    installedDocsRoot: input.installedDocsRoot,
  });
  const before = await snapshotTree(consumerRoot);
  const info = await runJson(docsCli, consumerRoot, ["info", "--consumer", consumerRoot]);
  assert.equal(info.schemaVersion, 2);
  assert.equal(info.command, "docs.info");
  assert.equal(info.outcome, "success");
  assert.equal(info.result.projectId, "registry-mcp-e2e");

  const found = await runJson(docsCli, consumerRoot, [
    "find", expectedDocument.query, "--fuzzy", "--consumer", consumerRoot,
  ]);
  assert.equal(found.schemaVersion, 3);
  assert.equal(found.command, "docs.find");
  assert.equal(found.result.documents[0].id, expectedDocument.documentId);

  const context = await runJson(docsCli, consumerRoot, [
    "context", expectedDocument.query, "--fuzzy", "--max-documents", "1",
    "--max-bytes", "4096", "--consumer", consumerRoot,
  ]);
  assert.equal(context.schemaVersion, 3);
  assert.equal(context.command, "docs.context");
  assert.equal(context.result.format, "llms.txt");
  assert.ok(context.result.content.includes(expectedDocument.title));

  const checked = await runJson(docsCli, consumerRoot, [
    "check", "--consumer", consumerRoot,
  ]);
  assert.equal(checked.schemaVersion, 2);
  assert.equal(checked.command, "docs.check");
  assert.equal(checked.outcome, "success");
  assert.deepEqual(
    await snapshotTree(consumerRoot),
    before,
    "installed Docs Protocol read-only CLI commands must not write",
  );
  return expectedDocument;
}

export async function verifyRegistryDocsProtocolMcp(input) {
  const consumerRoot = join(input.consumerRoot, "docs-protocol-mcp-consumer");
  const mcpCli = join(input.installedMcpRoot, "dist", "cli.js");
  const expectedDocument = await verifyRegistryDocsProtocolCli({
    consumerRoot,
    installedDocsRoot: input.installedDocsRoot,
  });
  const before = await snapshotTree(consumerRoot);
  const client = openJsonRpcClient(mcpCli, consumerRoot);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "registry-docs-protocol-mcp-e2e", version: "1.0.0" },
    });
    assert.ok("result" in initialized, JSON.stringify(initialized));
    assert.equal(initialized.result.serverInfo.name, "@agent-teams/docs-protocol-mcp");
    assert.equal(initialized.result.serverInfo.version, input.mcpVersion);
    await client.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await client.request("tools/list", {});
    assert.ok("result" in listed, JSON.stringify(listed));
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      "docs_info", "docs_find", "docs_context",
    ]);
    assert.ok(listed.result.tools.every(({ annotations }) => annotations.readOnlyHint === true));
    assert.ok(listed.result.tools.every(({ outputSchema }) =>
      outputSchema.type === "object" && outputSchema.additionalProperties === false &&
      outputSchema.properties.result.additionalProperties === false));

    const info = toolPayload(await client.request("tools/call", {
      name: "docs_info", arguments: {},
    }));
    assert.equal(info.result.projectId, "registry-mcp-e2e");
    const found = toolPayload(await client.request("tools/call", {
      name: "docs_find", arguments: { text: expectedDocument.query, fuzzy: true },
    }));
    assert.equal(found.result.documents[0].id, expectedDocument.documentId);
    const context = toolPayload(await client.request("tools/call", {
      name: "docs_context",
      arguments: { text: expectedDocument.query, fuzzy: true, maxDocuments: 1, maxBytes: 4096 },
    }));
    assert.equal(context.result.format, "llms.txt");
    assert.ok(context.result.content.includes(expectedDocument.title));
  } finally {
    await client.close();
  }
  assert.deepEqual(await snapshotTree(consumerRoot), before, "installed MCP tools must be read-only");
}
