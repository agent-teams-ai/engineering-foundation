import assert from "node:assert/strict";
import filesystem, {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createNodeLocalLinkStateStore } from "../packages/engineering-foundation/dist/local-mode/adapters/node/local-state-store.js";
import { createNodeLocalOperationCustody } from "../packages/engineering-foundation/dist/local-mode/adapters/node/local-operation-custody.js";
import type { FoundationLinkState } from "../packages/engineering-foundation/dist/local-mode/application/model.js";
import { FoundationError } from "../packages/engineering-foundation/dist/features/validation-reporting/api.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foundation-marker-custody-")));
  const directory = join(root, ".agent-teams-local");
  await mkdir(directory);
  const marker = join(directory, "foundation-link.json");
  const state: FoundationLinkState = {
    schemaVersion: 1,
    phase: "ATTACHING",
    consumerRoot: root,
    targetPackageRoot: join(root, "target"),
    registryBackupPath: join(directory, "foundation-registry-backup"),
    registryEntryKind: "directory",
    registryPackageRoot: join(root, "node_modules/@agent-teams/engineering-foundation"),
    packageVersion: "1.3.0",
    gitCommit: "a".repeat(40),
    gitDirty: false,
    attachedAt: "2026-11-05T00:00:00.000Z",
  };
  const hooks: {
    ensure?: () => Promise<void>;
    sync?: () => Promise<void>;
    prune?: () => Promise<void>;
  } = {};
  const store = createNodeLocalLinkStateStore({
    ensure: async () => {
      await hooks.ensure?.();
      return mkdir(directory, { recursive: true });
    },
    sync: async () => {
      await hooks.sync?.();
    },
    prune: async () => {
      await hooks.prune?.();
    },
  });
  return { root, directory, marker, state, store, hooks };
}

test("failed acquisition and repeated release cannot retain or erase another operation's custody", async () => {
  const f = await fixture();
  try {
    const custody = createNodeLocalOperationCustody(
      { ensure: async () => {}, sync: async () => {}, prune: async () => {} },
      {
        run: async () => {
          throw new Error("unexpected process execution");
        },
      },
    );
    const acquireFailure = Object.freeze(new Error("acquisition failed"));
    await assert.rejects(
      custody.acquire(f.root, async () => {
        throw acquireFailure;
      }),
      (error: unknown) => error === acquireFailure,
    );
    assert.throws(() => custody.current(f.root), /active operation lease/u);
    const releaseFailure = Object.freeze(new Error("release failed"));
    let releases = 0;
    const first = await custody.acquire(f.root, async () => ({
      status: { state: "idle", diagnostics: [] },
      release: async () => {
        releases++;
        throw releaseFailure;
      },
    }));
    const firstResources = custody.current(f.root);
    await assert.rejects(first.release(), (error: unknown) => error === releaseFailure);
    assert.throws(() => custody.current(f.root), /active operation lease/u);
    const second = await custody.acquire(f.root, async () => ({
      status: { state: "idle", diagnostics: [] },
      release: async () => {},
    }));
    const secondResources = custody.current(f.root);
    assert.notEqual(firstResources, secondResources);
    await first.release();
    assert.equal(releases, 1);
    assert.equal(custody.current(f.root), secondResources);
    await second.release();
    assert.throws(() => custody.current(f.root), /active operation lease/u);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("duplicate acquisition preserves ownership failure and release failure without disturbing the owner", async () => {
  const f = await fixture();
  try {
    const custody = createNodeLocalOperationCustody(
      { ensure: async () => {}, sync: async () => {}, prune: async () => {} },
      {
        run: async () => {
          throw new Error("unexpected process execution");
        },
      },
    );
    let ownerReleases = 0;
    const owner = await custody.acquire(f.root, async () => ({
      status: { state: "idle", diagnostics: [] },
      release: async () => {
        ownerReleases++;
      },
    }));
    const resources = custody.current(f.root);
    try {
      for (const releaseFailure of [
        Object.freeze(new Error("duplicate lease release failed")),
        undefined,
      ]) {
        let releases = 0;
        await assert.rejects(
          custody.acquire(f.root, async () => ({
            status: { state: "idle", diagnostics: [] },
            release: async (options) => {
              releases++;
              assert.deepEqual(options, { retainTransactionBarrier: true });
              throw releaseFailure;
            },
          })),
          (failure: unknown) => {
            assert.ok(failure instanceof FoundationError);
            assert.equal(failure.code, "LOCAL_STATE_INVALID");
            assert.ok(failure.cause instanceof AggregateError);
            assert.equal(failure.cause.errors.length, 2);
            const ownershipFailure: unknown = failure.cause.errors[0];
            const finalizationFailure: unknown = failure.cause.errors[1];
            assert.ok(ownershipFailure instanceof FoundationError);
            assert.equal(ownershipFailure.code, "LOCAL_STATE_INVALID");
            assert.match(ownershipFailure.message, /did not exclude an existing owner/u);
            assert.equal(finalizationFailure, releaseFailure);
            return true;
          },
        );
        assert.equal(releases, 1);
        assert.equal(ownerReleases, 0);
        assert.equal(custody.current(f.root), resources);
      }
      let releases = 0;
      await assert.rejects(
        custody.acquire(f.root, async () => ({
          status: { state: "idle", diagnostics: [] },
          release: async (options) => {
            releases++;
            assert.deepEqual(options, { retainTransactionBarrier: true });
          },
        })),
        (failure: unknown) => {
          assert.ok(failure instanceof FoundationError);
          assert.equal(failure.code, "LOCAL_STATE_INVALID");
          assert.match(failure.message, /did not exclude an existing owner/u);
          assert.equal(failure.cause, undefined);
          return true;
        },
      );
      assert.equal(releases, 1);
      assert.equal(ownerReleases, 0);
      assert.equal(custody.current(f.root), resources);
    } finally {
      await owner.release();
    }
    assert.equal(ownerReleases, 1);
    assert.throws(() => custody.current(f.root), /active operation lease/u);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("initial marker publication refuses a preexisting foreign marker", async () => {
  const f = await fixture();
  try {
    await writeFile(f.marker, "foreign evidence\n");
    await assert.rejects(f.store.write(f.root, f.state));
    assert.equal(await readFile(f.marker, "utf8"), "foreign evidence\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("phase publication refuses a marker substituted while ensuring its directory", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const bytes = await readFile(f.marker);
    f.hooks.ensure = async () => {
      await rename(f.marker, join(f.directory, "original"));
      await writeFile(f.marker, bytes);
    };
    await assert.rejects(f.store.write(f.root, { ...f.state, phase: "LOCAL" }));
    assert.deepEqual(await readFile(f.marker), bytes);
    assert.deepEqual(await readFile(join(f.directory, "original")), bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("phase publication preserves retained marker custody across directory observations", async (context) => {
  const f = await fixture();
  const originalRealpath = filesystem.realpath;
  let substituted = false;
  try {
    await f.store.write(f.root, f.state);
    const bytes = await readFile(f.marker);
    const originalMarker = join(f.directory, "retained-marker");
    context.mock.method(
      filesystem,
      "realpath",
      async (...args: Parameters<typeof originalRealpath>) => {
        const result = await originalRealpath(...args);
        if (!substituted && String(args[0]) === f.directory) {
          substituted = true;
          await rename(f.marker, originalMarker);
          await writeFile(f.marker, bytes);
        }
        return result;
      },
    );
    syncBuiltinESMExports();
    await assert.rejects(f.store.write(f.root, { ...f.state, phase: "LOCAL" }));
    assert.equal(substituted, true);
    await assert.rejects(f.store.remove(f.root));
    assert.deepEqual(await readFile(f.marker), bytes);
    assert.deepEqual(await readFile(originalMarker), bytes);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("phase publication refuses a replaced parent and preserves both marker trees", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const bytes = await readFile(f.marker);
    const oldDirectory = join(f.root, "retained-parent");
    f.hooks.ensure = async () => {
      await rename(f.directory, oldDirectory);
      await mkdir(f.directory);
      await writeFile(f.marker, "foreign parent marker\n");
    };
    await assert.rejects(f.store.write(f.root, { ...f.state, phase: "LOCAL" }));
    assert.equal(await readFile(f.marker, "utf8"), "foreign parent marker\n");
    assert.deepEqual(await readFile(join(oldDirectory, "foundation-link.json")), bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a fresh operation admits its on-disk predecessor before DETACHING", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    await f.store.write(f.root, { ...f.state, phase: "LOCAL" });
    const restarted = createNodeLocalLinkStateStore({
      ensure: async () => {},
      sync: async () => {},
      prune: async () => {},
    });
    await assert.rejects(restarted.remove(f.root));
    await restarted.write(f.root, { ...f.state, phase: "DETACHING" });
    assert.equal(JSON.parse(await readFile(f.marker, "utf8")).phase, "DETACHING");
    await restarted.remove(f.root);
    await restarted.remove(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("post-publication synchronization failure retains the published marker and failure", async () => {
  const f = await fixture();
  try {
    const failure = Object.freeze(new Error("directory synchronization failed"));
    f.hooks.sync = async () => {
      throw failure;
    };
    await assert.rejects(f.store.write(f.root, f.state), (error: unknown) => error === failure);
    assert.deepEqual(JSON.parse(await readFile(f.marker, "utf8")), f.state);
    delete f.hooks.sync;
    await f.store.remove(f.root);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("marker retirement remains idempotent after its empty directory is pruned", async () => {
  const f = await fixture();
  try {
    f.hooks.prune = async () => {
      await filesystem.rmdir(f.directory);
    };
    await f.store.write(f.root, f.state);
    await f.store.remove(f.root);
    await f.store.remove(f.root);
    await assert.rejects(filesystem.lstat(f.directory), { code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("marker absence does not conceal a replaced retained parent", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const retainedDirectory = join(f.root, "retained-parent");
    await rename(f.directory, retainedDirectory);
    await assert.rejects(f.store.remove(f.root));
    assert.deepEqual(
      JSON.parse(await readFile(join(retainedDirectory, "foundation-link.json"), "utf8")),
      f.state,
    );
    await mkdir(f.directory);
    await writeFile(join(f.directory, "foreign.txt"), "keep replacement directory\n");
    await assert.rejects(f.store.remove(f.root));
    assert.equal(
      await readFile(join(f.directory, "foreign.txt"), "utf8"),
      "keep replacement directory\n",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed marker-removal synchronization retains parent custody for its retry", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const failure = new Error("removal synchronization failed");
    f.hooks.sync = async () => {
      throw failure;
    };
    await assert.rejects(f.store.remove(f.root), (error: unknown) => error === failure);
    delete f.hooks.sync;
    await rename(f.directory, join(f.root, "retained-parent"));
    await mkdir(f.directory);
    await writeFile(join(f.directory, "foreign.txt"), "preserve retry replacement\n");
    await assert.rejects(f.store.remove(f.root));
    assert.equal(
      await readFile(join(f.directory, "foreign.txt"), "utf8"),
      "preserve retry replacement\n",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("post-publication marker substitution is refused and never cleaned as owned", async () => {
  const f = await fixture();
  try {
    f.hooks.sync = async () => {
      await rename(f.marker, join(f.directory, "published-original"));
      await writeFile(f.marker, "foreign published marker\n");
    };
    await assert.rejects(f.store.write(f.root, f.state));
    delete f.hooks.sync;
    await assert.rejects(f.store.remove(f.root));
    assert.equal(await readFile(f.marker, "utf8"), "foreign published marker\n");
    assert.deepEqual(
      JSON.parse(await readFile(join(f.directory, "published-original"), "utf8")),
      f.state,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const publication of ["initial", "phase"] as const) {
  test(`${publication} publication refuses an in-place marker edit before retaining its observation`, async (context) => {
    const f = await fixture();
    const method = publication === "initial" ? "link" : "rename";
    const originalPublish = filesystem[method];
    const state = publication === "initial" ? f.state : { ...f.state, phase: "LOCAL" as const };
    const expectedBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    const foreignBytes = Buffer.from(
      `${JSON.stringify({ ...state, packageVersion: "9.9.9" }, null, 2)}\n`,
      "utf8",
    );
    let edited = false;
    try {
      if (publication === "phase") {
        await f.store.write(f.root, f.state);
      }
      context.mock.method(
        filesystem,
        method,
        async (...args: Parameters<typeof originalPublish>) => {
          await originalPublish(args[0], args[1]);
          if (String(args[1]) === f.marker) {
            assert.deepEqual(await readFile(f.marker), expectedBytes);
            assert.equal(foreignBytes.length, expectedBytes.length);
            assert.notDeepEqual(foreignBytes, expectedBytes);
            edited = true;
            await writeFile(f.marker, foreignBytes);
          }
        },
      );
      syncBuiltinESMExports();
      await assert.rejects(f.store.write(f.root, state));
      assert.equal(edited, true);
      await assert.rejects(f.store.remove(f.root));
      assert.deepEqual(await readFile(f.marker), foreignBytes);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("marker removal preserves a replaced destination even when its bytes match", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const bytes = await readFile(f.marker);
    await rename(f.marker, join(f.directory, "owned-retained"));
    await writeFile(f.marker, bytes);
    await assert.rejects(f.store.remove(f.root));
    assert.deepEqual(await readFile(f.marker), bytes);
    assert.deepEqual(await readFile(join(f.directory, "owned-retained")), bytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("marker retirement never deletes historical unowned temporaries", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.root, f.state);
    const temporary = join(f.directory, "foundation-link.json.historical.tmp");
    await writeFile(temporary, "unproven prior write\n");
    await f.store.remove(f.root);
    assert.equal(await readFile(temporary, "utf8"), "unproven prior write\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("temporary substitution preserves the foreign entry and unpublishable owned bytes", async (context) => {
  const f = await fixture();
  const originalOpen = filesystem.open;
  let substituted: string | undefined;
  try {
    context.mock.method(filesystem, "open", async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const path = String(args[0]);
      if (path.startsWith(`${f.marker}.`) && path.endsWith(".tmp")) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          await rename(path, join(f.directory, "original-temporary"));
          await writeFile(path, "foreign temporary\n");
          substituted = path;
        };
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.store.write(f.root, f.state));
    assert.ok(substituted);
    assert.equal(await readFile(substituted, "utf8"), "foreign temporary\n");
    assert.deepEqual(
      JSON.parse(await readFile(join(f.directory, "original-temporary"), "utf8")),
      f.state,
    );
    await assert.rejects(readFile(f.marker), { code: "ENOENT" });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("initial publication cannot replace a competing marker at its physical effect", async (context) => {
  const f = await fixture();
  const originalLink = filesystem.link;
  try {
    context.mock.method(filesystem, "link", async (...args: Parameters<typeof originalLink>) => {
      if (String(args[1]) === f.marker) {
        await writeFile(f.marker, "competing marker\n", { flag: "wx" });
      }
      return originalLink(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.store.write(f.root, f.state));
    assert.equal(await readFile(f.marker, "utf8"), "competing marker\n");
    assert.deepEqual(await filesystem.readdir(f.directory), ["foundation-link.json"]);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(f.root, { recursive: true, force: true });
  }
});
