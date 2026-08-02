import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/index.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-consumer"
);
const operationLockHolderPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "operation-lock-holder.mjs"
);
const localModeServiceModulePath = join(
  repositoryRoot,
  "packages",
  "engineering-foundation",
  "dist",
  "local-mode",
  "service.js"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: "intents/create-fixture.yaml"
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function startOperationLockHolder(root) {
  const child = spawn(
    process.execPath,
    [operationLockHolderPath, localModeServiceModulePath, root],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("READY")) {
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Lock holder exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`
        )
      );
    });
  });
  return child;
}

test("rejects a platform-reserved output path before journaling", async () => {
  for (const unsafeTarget of [
    "CON/generated",
    ".GIT/config-copy",
    "packages/testing/node_modules/generated",
    "packages./testing/generated"
  ]) {
    const root = await createConsumer();
    try {
      const catalogPath = join(root, "architecture", "package-catalog.yaml");
      await writeFile(
        catalogPath,
        (await readFile(catalogPath, "utf8")).replace(
          "packages/testing/generated",
          unsafeTarget
        )
      );
      const scaffoldPlan = await plan(root);
      await assert.rejects(
        applyFilesystemScaffold(root, scaffoldPlan),
        /operation path is unsafe/u,
        unsafeTarget
      );
      await assert.rejects(
        readFile(
          join(root, ".agent-teams-local", "scaffolding-transaction.json"),
          "utf8"
        ),
        /ENOENT/u
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects apply while another foundation operation owns the lock", async () => {
  const root = await createConsumer();
  let holder;
  try {
    const scaffoldPlan = await plan(root);
    holder = await startOperationLockHolder(root);
    await assert.rejects(
      applyFilesystemScaffold(root, scaffoldPlan),
      /Another foundation operation/u
    );
  } finally {
    if (holder !== undefined && holder.exitCode === null) {
      holder.kill("SIGTERM");
      await waitForExit(holder);
    }
    await rm(root, { recursive: true, force: true });
  }
});
