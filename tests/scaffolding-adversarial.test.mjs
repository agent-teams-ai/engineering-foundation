import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyFilesystemScaffold,
  planScaffoldFromFile
} from "../packages/engineering-foundation/dist/scaffolding/index.js";
import { writeAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal.js";
import { freshAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";
import { assessScaffoldPlanAuthority } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-plan-authority.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "scaffolding-authority-consumer"
);

async function createConsumer() {
  const root = await mkdtemp(join(tmpdir(), "foundation-scaffolding-adversarial-"));
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function plan(root) {
  return planScaffoldFromFile({
    consumerRoot: root,
    intentPath: "intents/create-fixture.yaml"
  });
}

function journalPath(root) {
  return join(root, ".agent-teams-local", "scaffolding-transaction.json");
}

async function assertMissing(path) {
  await assert.rejects(stat(path), /ENOENT/u);
}

async function setOwnerStatus(root, status) {
  const path = join(root, "docs", "decisions", "adr-0060.md");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(/^status: .+$/mu, `status: ${status}`),
    "utf8"
  );
}

test("detects authority mutation between initial and stability source reads", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const assessment = await assessScaffoldPlanAuthority(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-authority-source-stability-check") {
          await setOwnerStatus(root, "proposed");
        }
      }
    );
    assert.deepEqual(assessment, { state: "stale" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies only the synchronous Plan snapshot when the caller mutates during Apply", async () => {
  const root = await createConsumer();
  try {
    const callerPlan = structuredClone(await plan(root));
    const original = structuredClone(callerPlan.operations[0]);
    assert.ok(original);
    const mutatedPath = original.path.replace(/[^/]+$/u, "caller-mutated.ts");
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      callerPlan,
      (point) => {
        if (
          point.phase === "before-operation-authority-recheck" &&
          point.operationIndex === 0
        ) {
          callerPlan.operations[0].path = mutatedPath;
          callerPlan.operations[0].after.contentBase64 = Buffer.from(
            "caller mutation\n"
          ).toString("base64");
        }
      }
    );

    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.operations[0]?.path, original.path);
    assert.deepEqual(
      await readFile(join(root, ...original.path.split("/"))),
      Buffer.from(original.after.contentBase64, "base64")
    );
    await assertMissing(join(root, ...mutatedPath.split("/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes an unsnapshotable runtime Plan to a typed Plan error", async () => {
  const root = await createConsumer();
  try {
    const callerPlan = {
      ...(await plan(root)),
      unsupportedRuntimeValue: () => undefined
    };
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, callerPlan),
      (error) => {
        assert.equal(error?.code, "SCAFFOLD_PLAN_INVALID");
        assert.match(error?.message ?? "", /cannot be snapshotted/u);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not commit when an output changes before final authority verification", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const destination = join(root, ...first.path.split("/"));
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-final-authority-recheck") {
          await writeFile(destination, "third-party final state\n", "utf8");
        }
      }
    );

    assert.equal(receipt.outcome, "recovery-required");
    assert.equal(await readFile(destination, "utf8"), "third-party final state\n");
    assert.match(await readFile(journalPath(root), "utf8"), /"schemaVersion": 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a journal replaced after final verification", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase !== "after-final-verification") {
            return;
          }
          const journal = journalPath(root);
          const bytes = await readFile(journal);
          await rename(journal, `${journal}.foundation-original`);
          await writeFile(journal, bytes);
        }
      ),
      /journal changed before it could be removed/u
    );
    assert.match(await readFile(journalPath(root), "utf8"), /"schemaVersion": 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rechecks outputs before an already-applied Receipt", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    await applyFilesystemScaffold(root, scaffoldPlan);
    const first = scaffoldPlan.operations[0];
    assert.ok(first);
    const destination = join(root, ...first.path.split("/"));
    const receipt = await applyAuthorityFilesystemScaffoldWithFaultInjection(
      root,
      scaffoldPlan,
      async (point) => {
        if (point.phase === "before-final-authority-recheck") {
          await writeFile(destination, "changed after initial classification\n", "utf8");
        }
      }
    );

    assert.equal(receipt.outcome, "rejected");
    assert.equal(
      await readFile(destination, "utf8"),
      "changed after initial classification\n"
    );
    await assertMissing(journalPath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an exact replacement of a transaction temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    let replacementPath;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase !== "after-hard-link" || point.operationIndex !== 0) {
            return;
          }
          const first = scaffoldPlan.operations[0];
          assert.ok(first);
          const parent = dirname(join(root, ...first.path.split("/")));
          const temporaryName = (await readdir(parent)).find((entry) =>
            entry.startsWith(".foundation-")
          );
          assert.ok(temporaryName);
          const temporary = join(parent, temporaryName);
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o644);
          }
          replacementPath = temporary;
        }
      ),
      /temporary path was replaced concurrently/u
    );
    assert.ok(replacementPath);
    assert.ok((await stat(replacementPath)).isFile());
    assert.match(await readFile(journalPath(root), "utf8"), /"publishing"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an exact replacement of the journal temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    const temporary = `${path}.tmp`;
    await assert.rejects(
      writeAuthorityScaffoldJournal(
        path,
        freshAuthorityScaffoldJournal(scaffoldPlan),
        async () => {
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o600);
          }
        }
      ),
      /journal temporary path was replaced concurrently/u
    );
    assert.ok((await stat(temporary)).isFile());
    await assertMissing(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "rejects a FIFO journal without blocking and releases the operation lock",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = await createConsumer();
    try {
      const path = journalPath(root);
      await mkdir(dirname(path), { recursive: true });
      await execFileAsync("mkfifo", [path]);
      const scaffoldingUrl = new URL(
        "../packages/engineering-foundation/dist/scaffolding/index.js",
        import.meta.url
      ).href;
      const identityUrl = new URL(
        "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-file-identity.js",
        import.meta.url
      ).href;
      const probe = `
        const [scaffoldingUrl, identityUrl, root, path] = process.argv.slice(1);
        const { recoverFilesystemScaffold } = await import(scaffoldingUrl);
        const { readBoundedRegularFile } = await import(identityUrl);
        const direct = await readBoundedRegularFile(path, 1024);
        if (direct.outcome !== "invalid") throw new Error("FIFO was not rejected");
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let rejected = false;
          try {
            await recoverFilesystemScaffold(root);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("bounded regular file")) throw error;
            rejected = true;
          }
          if (!rejected) throw new Error("FIFO journal recovery was not rejected");
        }
        process.stdout.write("completed\\n");
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          probe,
          scaffoldingUrl,
          identityUrl,
          root,
          path
        ],
        { timeout: 5_000 }
      );

      assert.equal(stdout, "completed\n");
      assert.equal((await stat(path)).isFIFO(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "rejects a Unix socket journal through the typed recovery path",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = await mkdtemp("/tmp/foundation-socket-");
    await cp(fixtureRoot, root, { recursive: true });
    const path = journalPath(root);
    const server = createServer();
    try {
      await mkdir(dirname(path), { recursive: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, resolve);
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          applyFilesystemScaffold(root, await plan(root)),
          (error) => {
            assert.equal(error?.code, "SCAFFOLD_RECOVERY_REQUIRED");
            assert.match(error?.message ?? "", /bounded regular file/u);
            return true;
          }
        );
      }
      assert.equal((await stat(path)).isSocket(), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
);
