import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
interface CliEnvelope {
  outcome: string;
  issues: [{ code: string; message: string }, ...{ code: string; message: string }[]];
}
const envelope = (bytes: string) => JSON.parse(bytes) as CliEnvelope;
export function assertConsumerCliBoundaries(root: string, repositoryName: string): void {
  const cli = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "dist", "cli.js"), "check", "--consumer", root, "--json"],
    { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(envelope(cli.stdout).outcome, "current");

  const wrongRepository = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "dist", "cli.js"), "check", "--consumer", root, "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repositoryName,
        GITHUB_REPOSITORY_ID: "123",
        NO_PROXY: "*",
      },
    },
  );
  assert.equal(wrongRepository.status, 1, wrongRepository.stderr);
  assert.equal(
    envelope(wrongRepository.stdout).issues[0].code,
    "DOCS_CONSUMER_REPOSITORY_ID_MISMATCH",
  );

  const duplicateJson = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "cli.js"),
      "check",
      "--consumer",
      root,
      "--json",
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } },
  );
  assert.equal(duplicateJson.status, 2, duplicateJson.stderr);
  assert.equal(envelope(duplicateJson.stdout).issues[0].code, "DOCS_CONSUMER_CLI_INVALID");

  const invalidFlag = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "cli.js"),
      "check",
      "--consumer",
      root,
      "--unknown",
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } },
  );
  assert.equal(invalidFlag.status, 2, invalidFlag.stderr);
  assert.equal(envelope(invalidFlag.stdout).issues[0].code, "DOCS_CONSUMER_CLI_INVALID");

  const missingRoot = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "cli.js"),
      "check",
      "--consumer",
      join(root, "missing"),
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, NO_PROXY: "*" } },
  );
  assert.equal(missingRoot.status, 3, missingRoot.stderr);
  const missingRootIssue = envelope(missingRoot.stdout).issues[0];
  assert.equal(missingRootIssue.code, "DOCS_CONSUMER_EXECUTION_FAILURE");
  assert.doesNotMatch(missingRootIssue.message, new RegExp(root.replaceAll("/", "\\/"), "u"));
}
