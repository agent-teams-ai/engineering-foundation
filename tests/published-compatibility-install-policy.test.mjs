import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { commandDefaultTimeoutMs } from "../scripts/pack-test-support.mjs";
import { createPublishedCompatibilityInstallPolicy } from "../scripts/published-compatibility-install-policy.mjs";

const timeout = () =>
  Object.assign(new Error("timeout"), {
    killed: true,
    terminationConfirmed: true,
    timedOut: true,
  });
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("published compatibility cleans up and retries one timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "published-install-policy-"));
  const calls = [];
  try {
    const install = createPublishedCompatibilityInstallPolicy({
      delay: async (milliseconds) => calls.push(["delay", milliseconds]),
      runInstall: async (_args, installRoot, options) => {
        calls.push(["install", installRoot, options.timeoutMs]);
        if (calls.length === 1) {
          await mkdir(join(root, "node_modules", "partial"), { recursive: true });
          await writeFile(join(root, "package-lock.json"), "partial", "utf8");
          await mkdir(join(root, ".npm-cache"));
          throw timeout();
        }
        await assert.rejects(readFile(join(root, "package-lock.json")));
        await assert.rejects(readFile(join(root, "node_modules", "partial")));
        assert.equal((await lstat(join(root, ".npm-cache"))).isDirectory(), true);
        return "installed";
      },
    });
    assert.equal(await install(["install"], root), "installed");
    assert.deepEqual(calls, [
      ["install", root, 120_000],
      ["delay", 1_000],
      ["install", root, 240_000],
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("published compatibility persistent timeout makes exactly two attempts", async () => {
  const calls = [];
  const install = createPublishedCompatibilityInstallPolicy({
    cleanup: async () => calls.push("cleanup"),
    delay: async () => {},
    runInstall: async () => {
      calls.push("install");
      throw timeout();
    },
  });
  await assert.rejects(install([], "/first"), (error) => error?.timedOut === true);
  assert.deepEqual(calls, ["install", "cleanup", "install"]);
});

test("published compatibility shares its single retry across installs", async () => {
  let attempts = 0;
  const install = createPublishedCompatibilityInstallPolicy({
    cleanup: async () => {},
    delay: async () => {},
    runInstall: async () => {
      attempts += 1;
      throw timeout();
    },
  });
  await assert.rejects(install([], "/first"));
  await assert.rejects(install([], "/second"));
  assert.equal(attempts, 3);
});

test("published compatibility callsites share one install policy", async () => {
  const [entrypoint, publishedInstall, scaffolding, documentTransactions] = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "published-compatibility-e2e.mjs"), "utf8"),
    readFile(join(repositoryRoot, "scripts", "published-foundation-install.mjs"), "utf8"),
    readFile(
      join(repositoryRoot, "scripts", "published-scaffolding-compatibility-e2e.mjs"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, "scripts", "published-document-transaction-compatibility-e2e.mjs"),
      "utf8",
    ),
  ]);
  assert.equal(entrypoint.match(/createPublishedCompatibilityInstallPolicy\(\)/gu)?.length, 1);
  assert.match(entrypoint, /verifyOldFoundationTransactionBarrier\(\{ currentCliPath, installPackage \}\)/u);
  assert.match(entrypoint, /verifyPublishedDocumentTransactionCompatibility\(\{[\s\S]*installPackage,/u);
  assert.match(entrypoint, /verifyPublishedScaffoldingCompatibility\(\{[\s\S]*installPackage,/u);
  assert.match(
    entrypoint,
    /currentRuntimePackageRoot: resolve\("packages", "repository-mutation"\)/u,
  );
  assert.doesNotMatch(publishedInstall, /runNpmCommand/u);
  assert.match(publishedInstall, /await installPackage\(/u);
  assert.doesNotMatch(scaffolding, /runNpmCommand/u);
  assert.match(scaffolding, /await installPackage\(/u);
  assert.doesNotMatch(documentTransactions, /runNpmCommand/u);
  assert.match(documentTransactions, /await installPublishedFoundation\(/u);
});

test("generic command default remains 120 seconds", () => {
  assert.equal(commandDefaultTimeoutMs, 120_000);
});

test("published compatibility does not retry non-timeout failure classes", async () => {
  for (const failure of [
    { killed: false, timedOut: true },
    { killed: true, terminationConfirmed: false, timedOut: true },
    { killed: true, timedOut: false },
    { code: 1, killed: false, timedOut: false },
    { killed: true, timedOut: false, cause: new Error("output limit") },
  ]) {
    let calls = 0;
    const install = createPublishedCompatibilityInstallPolicy({
      runInstall: async () => {
        calls += 1;
        throw Object.assign(new Error("failure"), failure);
      },
    });
    await assert.rejects(install([], "/fixture"));
    assert.equal(calls, 1);
  }
});

test("published compatibility fails closed when cleanup fails", async () => {
  let installs = 0;
  const cleanupFailure = new Error("cleanup failed");
  const install = createPublishedCompatibilityInstallPolicy({
    cleanup: async () => { throw cleanupFailure; },
    runInstall: async () => {
      installs += 1;
      throw timeout();
    },
  });
  await assert.rejects(install([], "/fixture"), cleanupFailure);
  assert.equal(installs, 1);
});
