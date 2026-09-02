import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
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
import {
  removeExpectedAuthorityScaffoldJournal,
  writeAuthorityScaffoldJournal
} from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal.js";
import { freshAuthorityScaffoldJournal } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-journal-state.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/filesystem-authority-workspace.js";
import { assessScaffoldPlanAuthority } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-plan-authority.js";
import { ownedTemporaryCleanupResiduePrefix } from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-cleanup-owned-temporary.js";

test("legacy journal retirement rejects a pre-existing link without escaping state", async () => {
  const root = await createConsumer();
  const outside = await mkdtemp(join(tmpdir(), "legacy-scaffold-journal-outside-"));
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    await mkdir(dirname(path), { recursive: true });
    await symlink(
      outside,
      `${path}.completed-scaffold-evidence`,
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(
      writeAuthorityScaffoldJournal(
        path,
        freshAuthorityScaffoldJournal(scaffoldPlan)
      ),
      /real operation-owned directory/u
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal(
      (await readdir(dirname(path))).some((entry) =>
        entry.startsWith("scaffolding-transaction.json.document-quarantine.")),
      true
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legacy journal removal rejects a replacement terminal-root link", async () => {
  const root = await createConsumer();
  const outside = await mkdtemp(join(tmpdir(), "legacy-scaffold-remove-outside-"));
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    const authority = await writeAuthorityScaffoldJournal(
      path,
      freshAuthorityScaffoldJournal(scaffoldPlan)
    );
    const terminalRoot = `${path}.completed-scaffold-evidence`;
    await rm(terminalRoot, { force: true, recursive: true });
    await symlink(
      outside,
      terminalRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(
      removeExpectedAuthorityScaffoldJournal(path, authority),
      /real operation-owned directory/u
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

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

test("normalizes unsnapshotable and unfreezable Plans to a typed Plan error", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    for (const unsupportedRuntimeValue of [() => 1, new Uint8Array([1])]) {
      await assert.rejects(
        applyAuthorityFilesystemScaffoldWithFaultInjection(root, {
          ...scaffoldPlan,
          unsupportedRuntimeValue
        }),
        (error) => {
          assert.equal(error?.code, "SCAFFOLD_PLAN_INVALID");
          assert.match(error?.message ?? "", /cannot be snapshotted/u);
          return true;
        }
      );
    }
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
    const envelope = JSON.parse(await readFile(journalPath(root), "utf8"));
    assert.equal(envelope.schemaVersion, 6);
    assert.equal(envelope.payload.schemaVersion, 1);
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
    const envelope = JSON.parse(await readFile(journalPath(root), "utf8"));
    assert.equal(envelope.schemaVersion, 6);
    assert.equal(envelope.payload.schemaVersion, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a same-inode journal mutation after final verification", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const foreign = "foreign same-inode journal bytes\n";
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase === "after-final-verification") {
            await writeFile(journalPath(root), foreign, "utf8");
          }
        }
      ),
      /journal changed before it could be removed/u
    );
    assert.equal(await readFile(journalPath(root), "utf8"), foreign);
    assert.equal(
      JSON.parse(await readFile(join(root, ".agent-teams-local", "foundation-operation.lock"), "utf8")).kind,
      "transaction-barrier"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a pathname replacement between proof and journal quarantine", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const foreign = "foreign pathname replacement\n";
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, async (point) => {
        if (point.phase === "before-journal-quarantine") {
          const journal = journalPath(root);
          await rename(journal, `${journal}.foundation-original`);
          await writeFile(journal, foreign, "utf8");
        }
      }),
      /journal changed before it could be removed/u
    );
    const entries = await readdir(dirname(journalPath(root)));
    // Fixed-slot CAS never relocates a pathname that changed before quarantine.
    assert.ok(!entries.some((entry) =>
      entry.startsWith("scaffolding-transaction.json.scaffold-quarantine.")
    ));
    assert.equal(await readFile(journalPath(root), "utf8"), foreign);
    await stat(`${journalPath(root)}.foundation-original`);
    assert.equal(
      JSON.parse(await readFile(join(root, ".agent-teams-local", "foundation-operation.lock"), "utf8")).kind,
      "transaction-barrier"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a same-bytes different-inode journal substitution before replace", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    let substituted;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(root, scaffoldPlan, async (point) => {
        if (point.phase === "after-journal-temporary-synced" && substituted === undefined) {
          const journal = journalPath(root);
          try {
            const bytes = await readFile(journal);
            await rename(journal, `${journal}.owned-original`);
            await writeFile(journal, bytes);
            substituted = bytes;
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          }
        }
      }),
      /journal changed before it could be removed|Quarantined scaffolding journal changed concurrently/u
    );
    assert.ok(substituted);
    const entries = await readdir(dirname(journalPath(root)));
    // A late CAS failure preserves both identities plus its already-durable candidate.
    assert.ok(!entries.some((entry) =>
      entry.startsWith("scaffolding-transaction.json.scaffold-quarantine.")
    ));
    assert.ok(entries.includes("scaffolding-transaction.json.tmp"));
    assert.deepEqual(await readFile(journalPath(root)), substituted);
    assert.deepEqual(await readFile(`${journalPath(root)}.owned-original`), substituted);
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

test("preserves an exact replacement before cleanup transition authority", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    let evidence;
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
          const originalPath = `${temporary}.original`;
          await rename(temporary, originalPath);
          const original = await open(originalPath, "r");
          let bytes;
          let ownedIdentity;
          try {
            [bytes, ownedIdentity] = await Promise.all([
              original.readFile(), original.stat({ bigint: true }),
            ]);
          } finally {
            await original.close();
          }
          const replacement = await open(temporary, "wx", 0o644);
          try {
            await replacement.writeFile(bytes);
          } finally {
            await replacement.close();
          }
          if (process.platform !== "win32") {
            await chmod(temporary, 0o644);
          }
          const replacementIdentity = await stat(temporary, { bigint: true });
          evidence = {
            bytes,
            originalPath,
            ownedIdentity,
            parent,
            replacementIdentity,
            residuePrefix: ownedTemporaryCleanupResiduePrefix(temporary),
            temporary,
          };
        }
      ),
      /temporary path was replaced concurrently/u
    );
    assert.ok(evidence);
    const residueEntries = (await readdir(evidence.parent)).filter((entry) =>
      entry.startsWith(evidence.residuePrefix)
    );
    assert.deepEqual(residueEntries, []);
    assert.deepEqual(await readFile(evidence.temporary), evidence.bytes);
    assert.deepEqual(await readFile(evidence.originalPath), evidence.bytes);
    const replacementIdentity = await stat(evidence.temporary, { bigint: true });
    const originalIdentity = await stat(evidence.originalPath, { bigint: true });
    assert.equal(replacementIdentity.ino, evidence.replacementIdentity.ino);
    assert.equal(originalIdentity.ino, evidence.ownedIdentity.ino);
    assert.notEqual(replacementIdentity.ino, originalIdentity.ino);
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
        { faultInjector: async () => {
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o600);
          }
        } }
      ),
      /journal temporary path was replaced concurrently/u
    );
    assert.ok((await stat(temporary)).isFile());
    await assertMissing(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not promote or delete a same-inode mutated journal temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    const temporary = `${path}.tmp`;
    const foreign = "mutated journal temporary\n";
    await assert.rejects(
      writeAuthorityScaffoldJournal(
        path,
        freshAuthorityScaffoldJournal(scaffoldPlan),
        { faultInjector: async () => {
          await writeFile(temporary, foreign, "utf8");
        } }
      ),
      /journal temporary path was replaced concurrently/u
    );
    assert.equal(await readFile(temporary, "utf8"), foreign);
    await assertMissing(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains the downgrade barrier for a replaced journal temporary", async () => {
  const root = await createConsumer();
  try {
    const scaffoldPlan = await plan(root);
    const path = journalPath(root);
    const temporary = `${path}.tmp`;
    await assert.rejects(
      applyAuthorityFilesystemScaffoldWithFaultInjection(
        root,
        scaffoldPlan,
        async (point) => {
          if (point.phase !== "after-journal-temporary-synced") {
            return;
          }
          const bytes = await readFile(temporary);
          await rename(temporary, `${temporary}.original`);
          await writeFile(temporary, bytes);
          if (process.platform !== "win32") {
            await chmod(temporary, 0o600);
          }
        },
      ),
      /journal temporary path was replaced concurrently/u,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          join(root, ".agent-teams-local", "foundation-operation.lock"),
          "utf8",
        ),
      ).kind,
      "transaction-barrier",
    );
    await assertMissing(path);
    assert.ok((await stat(temporary)).isFile());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "rejects a FIFO journal without blocking and releases the operation lock",
  { skip: process.platform === "win32", timeout: 15_000 },
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
        { timeout: 8_000 }
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
    const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "fs-socket-"));
    await cp(fixtureRoot, root, { recursive: true });
    const path = journalPath(root);
    const server = createServer();
    try {
      await mkdir(dirname(path), { recursive: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          resolve();
        });
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
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await rm(root, { recursive: true, force: true });
    }
  }
);
