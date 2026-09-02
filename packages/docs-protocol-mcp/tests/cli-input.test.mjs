import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
