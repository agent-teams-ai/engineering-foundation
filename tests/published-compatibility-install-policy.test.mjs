import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main as runPublishedCompatibility } from "../scripts/published-compatibility-e2e.mjs";

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

test("published compatibility bounds one retry per independent install", async () => {
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
  assert.equal(attempts, 4);
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
  assert.match(entrypoint, /verifyTransactions\(\{ currentCliPath, installPackage \}\)/u);
  assert.match(entrypoint, /verifyAuthoring\(\{[\s\S]*installPackage,/u);
  assert.match(entrypoint, /verifyScaffolding\(\{[\s\S]*installPackage,/u);
  assert.match(
    entrypoint,
    /currentRuntimePackageRoot: resolve\("packages", "repository-mutation"\)/u,
  );
  assert.match(
    entrypoint,
    /currentAuthoringPackageRoot: resolve\("packages", "document-authoring"\)/u,
  );
  assert.match(
    scaffolding,
    /\[authoringPackageName\]: `file:\$\{authoring\.archivePath\.replaceAll/u,
  );
  assert.match(
    scaffolding,
    /installedAuthoring\.manifest\.dependencies\?\.\[runtimePackageName\]/u,
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

function compatibilityChecks(calls) {
  return {
    args: [],
    qualifyPublicDocs: async () => { throw new Error("current public completion ran in preflight"); },
    verifyAuthoring: async ({ installPackage, temporaryRoot }) => {
      assert.equal(typeof installPackage, "function");
      assert.equal((await lstat(temporaryRoot)).isDirectory(), true);
      calls.push("authoring");
    },
    verifyBootstrap: async () => { calls.push("bootstrap"); return ["bootstrap@0.0.0"]; },
    verifyScaffolding: async ({ installPackage }) => {
      assert.equal(typeof installPackage, "function");
      calls.push("scaffolding");
    },
    verifyTransactions: async ({ currentCliPath, installPackage }) => {
      assert.equal(currentCliPath, join(repositoryRoot, "packages/engineering-foundation/dist/cli.js"));
      assert.equal(typeof installPackage, "function");
      calls.push("transactions");
    },
    write: (line) => calls.push(line),
  };
}

test("ordinary compatibility defers public completion and retains all historical checks", async () => {
  const calls = [];
  const result = await runPublishedCompatibility(compatibilityChecks(calls));
  assert.deepEqual(calls.slice(0, 4), ["bootstrap", "transactions", "authoring", "scaffolding"]);
  assert.equal(calls.length, 5);
  assert.match(calls[4], /deferred to required post-reconciliation public-docs-release:e2e/u);
  assert.deepEqual(result, {
    bootstrapBaselines: ["bootstrap@0.0.0"],
    publicDocs: { status: "deferred" },
  });
});

test("historical check failures still stop compatibility before reconciliation", async () => {
  for (const check of ["verifyBootstrap", "verifyTransactions", "verifyAuthoring", "verifyScaffolding"]) {
    const calls = [];
    const failure = new Error(`${check} failed`);
    let reconciled = false;
    await assert.rejects(async () => {
      await runPublishedCompatibility({
        ...compatibilityChecks(calls),
        [check]: async () => { throw failure; },
      });
      reconciled = true;
    }, (error) => error === failure);
    assert.equal(reconciled, false);
    assert.equal(calls.some((line) => line.includes("PASS")), false);
  }
});
