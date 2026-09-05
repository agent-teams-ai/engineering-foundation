import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CliInputError, parseStartupArguments } from "../dist/index.js";

const execute = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);

test("standalone help succeeds without opening a consumer", async () => {
  const result = await execute(process.execPath, [cli.pathname, "--help"]);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "usage: docs-protocol-mcp --consumer-root PATH [--profile REPOSITORY_RELATIVE_PATH]\n");
});

test("startup binding canonicalizes the consumer root and keeps a repository-relative profile", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-protocol-mcp-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "consumer", "config"), { recursive: true });
  await writeFile(join(sandbox, "consumer", "config", "docs.yml"), "test: true\n", "utf8");

  const binding = await parseStartupArguments([
    "--consumer-root", "consumer",
    "--profile", "config/docs.yml"
  ], sandbox);

  assert.equal(binding.consumerRoot, await realpath(join(sandbox, "consumer")));
  assert.equal(binding.profilePath, "config/docs.yml");
  assert.ok(Object.isFrozen(binding));
});

test("startup binding rejects a profile path escaping the consumer root", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-protocol-mcp-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "consumer"));
  await writeFile(join(sandbox, "outside.yml"), "test: true\n", "utf8");

  await assert.rejects(
    parseStartupArguments([
      "--consumer-root", join(sandbox, "consumer"),
      "--profile", "../outside.yml"
    ], sandbox),
    (error) => error instanceof CliInputError && error.message === "--profile must be a portable repository-relative path."
  );
});

test("startup discovers the portable profile and ignores the retired Foundation profile path", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-protocol-mcp-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const consumer = join(sandbox, "consumer");
  await mkdir(join(consumer, "architecture", "foundation"), { recursive: true });
  await writeFile(join(consumer, "docs.config.yaml"), "test: true\n", "utf8");

  const discovered = await parseStartupArguments(["--consumer-root", consumer], sandbox);
  assert.equal(discovered.profilePath, "docs.config.yaml");

  await writeFile(join(consumer, "architecture", "foundation", "docs-protocol.yaml"), "test: true\n", "utf8");
  const rebound = await parseStartupArguments(["--consumer-root", consumer], sandbox);
  assert.equal(rebound.profilePath, "docs.config.yaml");
});

test("startup discovery fails closed when no profile exists", async (context) => {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-protocol-mcp-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const consumer = join(sandbox, "consumer");
  await mkdir(consumer);
  await assert.rejects(
    parseStartupArguments(["--consumer-root", consumer], sandbox),
    (error) => error instanceof CliInputError && error.message.includes("No documentation profile")
  );
});

test("startup parser rejects unknown, duplicate, and absolute profile arguments", async () => {
  await assert.rejects(parseStartupArguments(["--unknown", "value"], process.cwd()), CliInputError);
  await assert.rejects(parseStartupArguments([
    "--consumer-root", process.cwd(),
    "--consumer-root", process.cwd(),
    "--profile", "profile.yml"
  ], process.cwd()), CliInputError);
  await assert.rejects(parseStartupArguments([
    "--consumer-root", process.cwd(),
    "--profile", "/tmp/profile.yml"
  ], process.cwd()), CliInputError);
  for (const profilePath of [
    "a/../profile.yml",
    "docs\\profile.yml",
    "e\u0301/profile.yml",
    `${"a".repeat(256)}/profile.yml`,
    "a".repeat(513)
  ]) {
    await assert.rejects(parseStartupArguments([
      "--consumer-root", process.cwd(),
      "--profile", profilePath
    ], process.cwd()), (error) =>
      error instanceof CliInputError && error.message === "--profile must be a portable repository-relative path."
    );
  }
});

async function installedPackage(context) {
  const sandbox = await mkdtemp(join(tmpdir(), "docs-mcp-installed-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("..", import.meta.url));
  const installed = join(sandbox, "node_modules", "@agent-teams", "docs-protocol-mcp");
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  for (const entry of ["dist", "package.json"]) {
    await cp(join(source, entry), join(installed, entry), { recursive: true });
  }
  // Only dependency links are reused; the package under test is an independent installed tree.
  for (const dependency of Object.keys(manifest.dependencies)) {
    const link = join(installed, "node_modules", dependency);
    await mkdir(dirname(link), { recursive: true });
    await symlink(await realpath(join(source, "node_modules", dependency)), link,
      process.platform === "win32" ? "junction" : "dir");
  }
  await writeFile(join(sandbox, "package.json"), JSON.stringify({ private: true, version: "88.77.66" }));
  return { sandbox, installed, manifest, binary: join(installed, manifest.bin["docs-protocol-mcp"]) };
}

test("installed help and version use the relocated package identity without a consumer profile", async (context) => {
  const { sandbox, installed, manifest, binary } = await installedPackage(context);
  for (const version of [manifest.version, "7.8.9-rc.4+installed-proof"]) {
    await writeFile(join(installed, "package.json"), JSON.stringify({ ...manifest, version }));
    const options = { cwd: sandbox, timeout: 10_000 };
    const printed = await execute(process.execPath, [binary, "--version"], options);
    assert.equal(printed.stdout, `${version}\n`);
    assert.equal(printed.stderr, "");
    const imported = await execute(process.execPath, ["--input-type=module", "--eval",
      'import { DOCS_PROTOCOL_MCP_PACKAGE_VERSION } from "@agent-teams/docs-protocol-mcp"; console.log(DOCS_PROTOCOL_MCP_PACKAGE_VERSION);'
    ], options);
    assert.equal(imported.stdout, `${version}\n`);
    assert.equal(imported.stderr, "");
    const help = await execute(process.execPath, [binary, "--help"], options);
    assert.equal(help.stdout, "usage: docs-protocol-mcp --consumer-root PATH [--profile REPOSITORY_RELATIVE_PATH]\n");
    assert.equal(help.stderr, "");
  }
});

test("installed package identity fails closed on missing or invalid version fields", async (context) => {
  const { sandbox, installed, manifest, binary } = await installedPackage(context);
  for (const value of [null, { ...manifest, version: 12 }, { ...manifest, version: "latest" }, { ...manifest, version: undefined }]) {
    // Retain ESM package metadata while varying the version field.
    await writeFile(join(installed, "package.json"), JSON.stringify(value === null ? { type: "module" } : value));
    await assert.rejects(execute(process.execPath, [binary, "--version"], { cwd: sandbox, timeout: 10_000 }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /package.json must contain a semantic version/u);
      return true;
    });
  }
});

async function sourcePolicyFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "docs-mcp-source-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("..", import.meta.url));
  const mcpRoot = join(root, "packages/docs-protocol-mcp");
  await cp(join(source, "src"), join(mcpRoot, "src"), { recursive: true });
  await cp(join(source, "package.json"), join(mcpRoot, "package.json"));
  const protocolRoot = join(root, "packages/docs-protocol");
  await mkdir(join(protocolRoot, "src"), { recursive: true });
  await writeFile(join(protocolRoot, "package.json"), JSON.stringify({
    name: "@agent-teams/docs-protocol", version: "1.0.0", type: "module", exports: { ".": "./src/index.ts" }
  }));
  await writeFile(join(protocolRoot, "src/index.ts"), "export const fixture = true;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mcp-source-policy-fixture", private: true }));
  await cp(new URL("../../../pnpm-workspace.yaml", import.meta.url), join(root, "pnpm-workspace.yaml"));
  const policy = await readFile(new URL("../../../architecture/foundation/source-dependencies.yaml", import.meta.url), "utf8");
  const owned = policy.slice(policy.indexOf("  - id: docs-protocol-mcp.application\n"), policy.indexOf("  - id: docs-protocol-mcp.tests\n"));
  assert.ok(owned.includes("docs-protocol-mcp.transport"));
  await writeFile(join(root, "source.yaml"), [
    "schemaVersion: 2", "workspace: { kind: pnpm, manifest: pnpm-workspace.yaml }", "packageRoots: [packages]",
    "governedRoots: [packages/docs-protocol-mcp/src, packages/docs-protocol/src]", "boundaries:", owned,
    "  - id: fixture.protocol", "    roots: [packages/docs-protocol/src]",
    "    entrypoints: [packages/docs-protocol/src/index.ts]", "    packageExports: ['.']",
    "    allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] }", ""
  ].join("\n"));
  await writeFile(join(root, "foundation.config.yaml"), JSON.stringify({
    schemaVersion: 1, project: { id: "mcp-source-boundary-regression" },
    capabilities: { "architecture.source-dependencies": { configPath: "source.yaml" } }
  }));
  return { root, mcpRoot };
}

test("MCP source policy confines infrastructure and rejects stray source and JSON loaders", async (context) => {
  const { root, mcpRoot } = await sourcePolicyFixture(context);
  const foundation = fileURLToPath(new URL("../../engineering-foundation/dist/cli.js", import.meta.url));
  const command = [foundation, "check", "architecture.source-dependencies", "--consumer", root, "--json"];
  const valid = await execute(process.execPath, command, { timeout: 30_000 });
  assert.equal(JSON.parse(valid.stdout).outcome, "passed");
  const port = join(mcpRoot, "src/read-only-docs/application/ports/docs-reader.ts");
  const original = await readFile(port, "utf8");
  const stray = join(mcpRoot, "src/stray.ts");
  await writeFile(port, `${original}\nimport "node:fs";\nimport "@modelcontextprotocol/server";\n`);
  await writeFile(stray, "export const unowned = true;\n");
  const loader = join(mcpRoot, "src/read-only-docs/adapters/inbound/json-loader.ts");
  await writeFile(loader, 'import data from "../../../../package.json" with { type: "json" };\n');
  await assert.rejects(execute(process.execPath, command, { timeout: 30_000 }), (error) => {
    assert.equal(error.code, 1);
    const diagnostics = JSON.parse(error.stdout).capabilities[0].diagnostics;
    for (const rule of ["forbidden-builtin-dependency", "forbidden-package-dependency", "unclassified-source-file", "unresolved-local-import"]) {
      assert.ok(diagnostics.some(({ ruleId }) => ruleId === `architecture.source-dependencies.${rule}`),
        JSON.stringify(diagnostics));
    }
    return true;
  });
});
