import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import filesystem, {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  FOUNDATION_PACKAGE_NAME,
  inspectFoundationMode,
} from "../packages/engineering-foundation/dist/local-mode/index.js";
import { createFixture, writeJson } from "./helpers/local-mode-fixture.ts";

const HOLDER_PATH = fileURLToPath(new URL("./fixtures/operation-lock-holder.mjs", import.meta.url));
const SERVICE_MODULE_PATH = fileURLToPath(
  new URL(
    "../packages/engineering-foundation/dist/local-mode/composition/operation-lock.js",
    import.meta.url,
  ),
);
const CHILD_WAIT_TIMEOUT_MS = 5_000;

function interceptDirectorySync(
  context: TestContext,
  directory: string,
  effect: () => Promise<void>,
): void {
  const originalOpen = filesystem.open;
  context.mock.method(filesystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    const target = String(args[0]) === directory && args[1] === "r";
    let handle;
    try {
      handle = await originalOpen(...args);
    } catch (error) {
      // The production sync port tolerates unsupported Windows directory opens.
      // Inject at that same awaited boundary without inventing a successful fsync.
      if (target) {
        await effect();
      }
      throw error;
    }
    if (target) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        try {
          await sync();
        } finally {
          await effect();
        }
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
}

async function startOperationLockHolder(consumerRoot: string) {
  const child = spawn(process.execPath, [HOLDER_PATH, SERVICE_MODULE_PATH, consumerRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Lock holder did not become ready before its deadline."));
      }, CHILD_WAIT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.off("exit", onExit);
      };
      const onStdout = (chunk: string) => {
        if (chunk.includes("READY")) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Lock holder exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`,
          ),
        );
      };
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onStdout);
      child.once("exit", onExit);
    });
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child);
    throw error;
  }
  return child;
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Lock holder did not exit before its deadline."));
    }, CHILD_WAIT_TIMEOUT_MS);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

test("rejects a target whose real CLI self-check does not run", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.targetPackageRoot, "dist", "cli.js"), "", "utf8");
    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /self-check did not return a valid result/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a target with broken runtime exports", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.targetPackageRoot, "dist", "index.js"), "", "utf8");
    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /runtime export is unavailable/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects incompatible target protocol metadata", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.targetPackageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.agentTeamsFoundation.compatibleLocalModeProtocolVersions = [2];
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /does not support local-mode protocol 1/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects unresolved target runtime dependencies", async () => {
  const fixture = await createFixture();
  try {
    const manifestPath = join(fixture.targetPackageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies = {
      "@agent-teams/definitely-missing": "1.0.0",
    };
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /runtime dependency cannot be resolved/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("restores registry mode when final attach verification fails", async () => {
  const fixture = await createFixture({ failAttachedStatus: true });
  try {
    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /registry installation was restored/u,
    );

    const status = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(status.mode, "REGISTRY");
    assert.equal(status.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("finishes detach after a crash restored the registry entry", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    const statePath = join(fixture.consumerRoot, ".agent-teams-local", "foundation-link.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.phase = "DETACHING";
    await writeJson(statePath, state);

    const installedPackagePath = join(
      fixture.consumerRoot,
      "node_modules",
      "@agent-teams",
      "engineering-foundation",
    );
    await rm(installedPackagePath, { force: true, recursive: true });
    await rename(
      join(fixture.consumerRoot, ".agent-teams-local", "foundation-registry-backup"),
      installedPackagePath,
    );

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
    assert.equal(restored.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("detach accepts semantically unchanged v1 marker JSON formatting", async (context) => {
  for (const format of ["compact", "reordered"] as const) {
    await context.test(format, async () => {
      const fixture = await createFixture();
      try {
        await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
        const directory = join(fixture.consumerRoot, ".agent-teams-local");
        const marker = join(directory, "foundation-link.json");
        const state = JSON.parse(await readFile(marker, "utf8"));
        const encoded =
          format === "compact"
            ? JSON.stringify(state)
            : JSON.stringify(Object.fromEntries(Object.entries(state).toReversed()), null, 4);
        await writeFile(marker, encoded);
        const registryBytes = await readFile(
          join(directory, "foundation-registry-backup", "package.json"),
        );
        assert.equal((await fixture.service.status(fixture.consumerRoot)).mode, "LOCAL");
        assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
        assert.deepEqual(
          await readFile(
            join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME, "package.json"),
          ),
          registryBytes,
        );
        await assert.rejects(lstat(marker), { code: "ENOENT" });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("reclaims an operation lock after its owner process is killed", async () => {
  const fixture = await createFixture();
  let holder;
  try {
    holder = await startOperationLockHolder(fixture.consumerRoot);
    holder.kill("SIGKILL");
    await waitForExit(holder);
    const lockRoot = join(fixture.consumerRoot, ".agent-teams-local", "foundation-operation.lock");
    await utimes(lockRoot, new Date(0), new Date(0));

    const attached = await fixture.service.attach(
      fixture.consumerRoot,
      fixture.targetRepositoryRoot,
    );
    assert.equal(attached.status.mode, "LOCAL");
  } finally {
    if (holder !== undefined && holder.exitCode === null) {
      holder.kill("SIGKILL");
      await waitForExit(holder);
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a concurrent operation owned by a live process", async () => {
  const fixture = await createFixture();
  let holder;
  try {
    holder = await startOperationLockHolder(fixture.consumerRoot);

    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /operation is active or its lock is not safely recoverable/u,
    );
    assert.equal(await readFile(join(fixture.consumerRoot, ".git", "info", "exclude"), "utf8"), "");
    assert.equal(fixture.runner.requests.length, 0);
    assert.equal((await inspectFoundationMode(fixture.consumerRoot)).mode, "INVALID");
  } finally {
    if (holder !== undefined && holder.exitCode === null) {
      holder.kill("SIGTERM");
      await waitForExit(holder);
    }
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a local state directory redirected outside the consumer", async () => {
  const fixture = await createFixture();
  try {
    const externalStateRoot = join(fixture.root, "external-state");
    await mkdir(externalStateRoot, { recursive: true });
    await symlink(
      externalStateRoot,
      join(fixture.consumerRoot, ".agent-teams-local"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /real consumer-owned directory/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("restores from backup when the local checkout disappears", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    await rm(fixture.targetRepositoryRoot, { force: true, recursive: true });

    const restored = await fixture.service.detach(fixture.consumerRoot);
    assert.equal(restored.mode, "REGISTRY");
    assert.equal(restored.installedVersion, "1.2.3");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("detach preserves a foreign installed directory and the registry backup", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
    const backup = join(fixture.consumerRoot, ".agent-teams-local", "foundation-registry-backup");
    const backupBytes = await readFile(join(backup, "package.json"));
    await rm(installed, { force: true });
    await mkdir(installed);
    await writeFile(join(installed, "foreign.txt"), "keep this replacement\n");
    await assert.rejects(fixture.service.detach(fixture.consumerRoot));
    assert.equal(await readFile(join(installed, "foreign.txt"), "utf8"), "keep this replacement\n");
    assert.deepEqual(await readFile(join(backup, "package.json")), backupBytes);
    assert.equal(
      JSON.parse(
        await readFile(
          join(fixture.consumerRoot, ".agent-teams-local", "foundation-link.json"),
          "utf8",
        ),
      ).phase,
      "DETACHING",
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("detach preserves its marker when synchronized restoration is replaced", async (context) => {
  for (const completion of ["renamed-backup", "existing-registry-link"] as const) {
    await context.test(completion, async (subtest) => {
      const fixture = await createFixture();
      try {
        const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
        const directory = join(fixture.consumerRoot, ".agent-teams-local");
        const backup = join(directory, "foundation-registry-backup");
        const registry = join(
          fixture.consumerRoot,
          "node_modules/.pnpm/foundation/node_modules",
          FOUNDATION_PACKAGE_NAME,
        );
        if (completion === "existing-registry-link") {
          await mkdir(dirname(registry), { recursive: true });
          await rename(installed, registry);
          await symlink(registry, installed, process.platform === "win32" ? "junction" : "dir");
        }
        await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
        const originalBytes = await readFile(join(backup, "package.json"));
        if (completion === "existing-registry-link") {
          await rm(installed);
          await symlink(registry, installed, process.platform === "win32" ? "junction" : "dir");
        }
        const parked = join(fixture.root, "retained-restored-registry");
        let substituted = false;
        interceptDirectorySync(
          subtest,
          completion === "renamed-backup" ? dirname(installed) : directory,
          async () => {
            if (substituted || (await lstat(backup).catch(() => {})) !== undefined) {
              return;
            }
            substituted = true;
            await rename(installed, parked);
            await mkdir(installed);
            await writeJson(join(installed, "package.json"), {
              name: FOUNDATION_PACKAGE_NAME,
              version: "1.2.3",
              type: "module",
            });
            await writeFile(join(installed, "foreign.txt"), "keep synchronized replacement\n");
          },
        );
        await assert.rejects(fixture.service.detach(fixture.consumerRoot));
        assert.equal(substituted, true);
        assert.equal(
          await readFile(join(installed, "foreign.txt"), "utf8"),
          "keep synchronized replacement\n",
        );
        assert.deepEqual(await readFile(join(parked, "package.json")), originalBytes);
        assert.equal(
          JSON.parse(await readFile(join(directory, "foundation-link.json"), "utf8")).phase,
          "DETACHING",
        );
      } finally {
        subtest.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("attach preserves a backup replaced during its publication synchronization", async (context) => {
  for (const kind of ["directory", "symbolic-link"] as const) {
    await context.test(kind, async (subtest) => {
      const fixture = await createFixture();
      try {
        const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
        const directory = join(fixture.consumerRoot, ".agent-teams-local");
        const backup = join(directory, "foundation-registry-backup");
        if (kind === "symbolic-link") {
          const registry = join(
            fixture.consumerRoot,
            "node_modules/.pnpm/foundation/node_modules",
            FOUNDATION_PACKAGE_NAME,
          );
          await mkdir(dirname(registry), { recursive: true });
          await rename(installed, registry);
          await symlink(registry, installed, process.platform === "win32" ? "junction" : "dir");
        }
        const originalBytes = await readFile(join(installed, "package.json"));
        const parked = join(fixture.root, "retained-published-backup");
        let substituted = false;
        interceptDirectorySync(subtest, directory, async () => {
          if (substituted || (await lstat(backup).catch(() => {})) === undefined) {
            return;
          }
          substituted = true;
          await rename(backup, parked);
          await mkdir(backup);
          await writeJson(join(backup, "package.json"), {
            name: FOUNDATION_PACKAGE_NAME,
            version: "1.2.3",
            type: "module",
          });
          await writeFile(join(backup, "foreign.txt"), "keep substituted backup\n");
        });
        await assert.rejects(
          fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
        );
        assert.equal(substituted, true);
        assert.equal(
          await readFile(join(backup, "foreign.txt"), "utf8"),
          "keep substituted backup\n",
        );
        assert.deepEqual(await readFile(join(parked, "package.json")), originalBytes);
      } finally {
        subtest.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("failed attach does not readmit foreign matching-target links during rollback", async (context) => {
  for (const substitution of ["installed-parent", "local-link"] as const) {
    await context.test(substitution, async (subtest) => {
      const fixture = await createFixture();
      try {
        const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
        const parent = dirname(installed);
        const directory = join(fixture.consumerRoot, ".agent-teams-local");
        const backup = join(directory, "foundation-registry-backup");
        const originalBytes = await readFile(join(installed, "package.json"));
        const parked = join(fixture.root, "retained-original-entry");
        let foreignIdentity:
          | { readonly dev: bigint; readonly ino: bigint; readonly link: string }
          | undefined;
        interceptDirectorySync(
          subtest,
          substitution === "installed-parent" ? directory : parent,
          async () => {
            if (foreignIdentity !== undefined) {
              return;
            }
            if (substitution === "installed-parent") {
              if ((await lstat(backup).catch(() => {})) === undefined) {
                return;
              }
              await rename(parent, parked);
              await mkdir(parent);
            } else {
              if ((await readlink(installed).catch(() => {})) === undefined) {
                return;
              }
              await rename(installed, parked);
            }
            await symlink(
              fixture.targetPackageRoot,
              installed,
              process.platform === "win32" ? "junction" : "dir",
            );
            const metadata = await lstat(installed, { bigint: true });
            foreignIdentity = {
              dev: metadata.dev,
              ino: metadata.ino,
              link: await readlink(installed),
            };
          },
        );
        await assert.rejects(
          fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
        );
        assert.ok(foreignIdentity);
        const after = await lstat(installed, { bigint: true });
        assert.equal(after.isSymbolicLink(), true);
        assert.equal(after.dev, foreignIdentity.dev);
        assert.equal(after.ino, foreignIdentity.ino);
        assert.equal(await readlink(installed), foreignIdentity.link);
        assert.deepEqual(await readFile(join(backup, "package.json")), originalBytes);
        const original = await lstat(parked);
        assert.equal(
          substitution === "installed-parent" ? original.isDirectory() : original.isSymbolicLink(),
          true,
        );
      } finally {
        subtest.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("refuses an orphan backup with an unbound installed local link", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    await rm(join(fixture.consumerRoot, ".agent-teams-local", "foundation-link.json"), {
      force: true,
    });

    const interrupted = await inspectFoundationMode(fixture.consumerRoot);
    assert.equal(interrupted.mode, "INVALID");
    assert.ok(interrupted.issues.includes("An orphan registry backup requires detach recovery."));

    const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
    const target = await readlink(installed);
    const backup = join(fixture.consumerRoot, ".agent-teams-local", "foundation-registry-backup");
    const backupBytes = await readFile(join(backup, "package.json"));
    await assert.rejects(
      fixture.service.detach(fixture.consumerRoot),
      /not an admitted local link/u,
    );
    assert.equal(await readlink(installed), target);
    assert.deepEqual(await readFile(join(backup, "package.json")), backupBytes);
    // Removing only this test-owned unbound link makes the retained backup safe
    // for the separately admitted absent-entry recovery route.
    await rm(installed);
    assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("an orphan backup completes proven registry links without replacing the installed entry", async () => {
  const fixture = await createFixture();
  try {
    const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
    const registry = join(
      fixture.consumerRoot,
      "node_modules/.pnpm/foundation/node_modules",
      FOUNDATION_PACKAGE_NAME,
    );
    await mkdir(dirname(registry), { recursive: true });
    await rename(installed, registry);
    await symlink(registry, installed, process.platform === "win32" ? "junction" : "dir");
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    const directory = join(fixture.consumerRoot, ".agent-teams-local");
    const backup = join(directory, "foundation-registry-backup");
    await rm(join(directory, "foundation-link.json"));
    await rm(installed);
    await symlink(registry, installed, process.platform === "win32" ? "junction" : "dir");
    const before = await lstat(installed, { bigint: true });
    const target = await readlink(installed);
    const bytes = await readFile(join(registry, "package.json"));
    assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
    const after = await lstat(installed, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.birthtimeNs, before.birthtimeNs);
    assert.equal(await readlink(installed), target);
    assert.deepEqual(await readFile(join(registry, "package.json")), bytes);
    await assert.rejects(lstat(backup), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects recovery paths outside the consumer boundary", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
    const statePath = join(fixture.consumerRoot, ".agent-teams-local", "foundation-link.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.registryPackageRoot = fixture.targetPackageRoot;
    await writeJson(statePath, state);

    await assert.rejects(
      fixture.service.detach(fixture.consumerRoot),
      /paths outside its consumer-owned boundary/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("preserves manifest runtime dependency failure order before metadata normalization", async () => {
  const fixture = await createFixture();
  try {
    const path = join(fixture.targetPackageRoot, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.dependencies = {
      "z-first-missing-ef3-dependency": "1.0.0",
      "a-second-missing-ef3-dependency": "1.0.0",
    };
    await writeJson(path, manifest);
    await assert.rejects(
      fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot),
      /runtime dependency cannot be resolved: z-first-missing-ef3-dependency/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("detach preserves foreign files and symlink targets", async (context) => {
  for (const kind of ["file", "symbolic-link"] as const) {
    await context.test(kind, async () => {
      const fixture = await createFixture();
      try {
        await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot);
        const installed = join(fixture.consumerRoot, "node_modules", FOUNDATION_PACKAGE_NAME);
        const backup = join(
          fixture.consumerRoot,
          ".agent-teams-local",
          "foundation-registry-backup",
        );
        const backupBytes = await readFile(join(backup, "package.json"));
        await rm(installed);
        const foreign = join(fixture.root, "foreign-replacement");
        await mkdir(foreign);
        await writeFile(join(foreign, "keep.txt"), "foreign target bytes\n");
        if (kind === "file") {
          await writeFile(installed, "foreign installed bytes\n");
        } else {
          await symlink(foreign, installed, process.platform === "win32" ? "junction" : "dir");
        }
        const before =
          kind === "file" ? await readFile(installed, "utf8") : await readlink(installed);
        await assert.rejects(
          fixture.service.detach(fixture.consumerRoot),
          /not an admitted local link/u,
        );
        assert.equal(
          kind === "file" ? await readFile(installed, "utf8") : await readlink(installed),
          before,
        );
        assert.equal(await readFile(join(foreign, "keep.txt"), "utf8"), "foreign target bytes\n");
        assert.deepEqual(await readFile(join(backup, "package.json")), backupBytes);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("reattach and detach admit fresh operation custody each time", async () => {
  const fixture = await createFixture();
  try {
    for (let round = 0; round < 2; round++) {
      assert.equal(
        (await fixture.service.attach(fixture.consumerRoot, fixture.targetRepositoryRoot)).status
          .mode,
        "LOCAL",
      );
      assert.equal((await fixture.service.detach(fixture.consumerRoot)).mode, "REGISTRY");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
