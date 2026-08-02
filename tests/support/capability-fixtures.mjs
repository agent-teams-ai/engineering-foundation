import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const cliPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "cli.js"
);
export const reportSchemaPath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "schemas",
  "foundation-check-report",
  "v1.schema.json"
);

const fixtureRoots = Object.freeze({
  workspace: join(repositoryRoot, "tests", "fixtures", "workspace-dependency-declarations", "valid"),
  source: join(repositoryRoot, "tests", "fixtures", "source-dependencies", "valid"),
  suppression: join(repositoryRoot, "tests", "fixtures", "suppression-governance", "valid"),
  publicApi: join(repositoryRoot, "tests", "fixtures", "public-api-compatibility", "valid"),
  repositorySecurity: join(repositoryRoot, "tests", "fixtures", "repository-security-baseline", "valid")
});

async function withCopiedFixture(prefix, source, callback) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
  try {
    await cp(source, temporaryRoot, { recursive: true });
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function withFixture(callback) {
  return await withCopiedFixture("foundation-capability-", fixtureRoots.workspace, callback);
}

export async function withSourceFixture(callback) {
  return await withCopiedFixture("foundation-source-capability-", fixtureRoots.source, callback);
}

export async function withSuppressionFixture(callback) {
  return await withCopiedFixture("foundation-suppression-", fixtureRoots.suppression, callback);
}

export async function withPublicApiFixture(callback) {
  return await withCopiedFixture("foundation-public-api-", fixtureRoots.publicApi, callback);
}

export async function withRepositorySecurityFixture(callback) {
  return await withCopiedFixture("foundation-repository-security-", fixtureRoots.repositorySecurity, callback);
}

export function utcDateAfter(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function check(consumerRoot, ...args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", ...args, "--consumer", consumerRoot, "--format", "json"],
    { encoding: "utf8" }
  );
  assert.equal(result.stderr, "");
  return { result, report: JSON.parse(result.stdout) };
}
