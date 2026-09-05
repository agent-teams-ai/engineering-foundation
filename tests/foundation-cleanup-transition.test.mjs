import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeFoundationCleanupTransition } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-cleanup-transition.js";
import {
  syncFoundationStateDirectory,
  syncFoundationStateDirectoryStrictly,
} from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/node-foundation-state-directory.js";
import { createNodeFoundationTransactionCoordinator } from "../packages/engineering-foundation/dist/composition/node-foundation-transaction-coordinator.js";
import { readBoundedRegularFile } from "../packages/repository-mutation/dist/repository-mutation/adapters/node/node-bounded-regular-file.js";
import { scaffoldTransactionEvidenceExists } from "../packages/engineering-foundation/dist/scaffolding/adapters/node/node-scaffold-journal-transaction-evidence.js";

const prefix = "foundation-transaction.cleanup-residue.";
const token = "a".repeat(64);

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "foundation-cleanup-transition-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function portableTransition(root, overrides = {}) {
  return createNodeFoundationCleanupTransition(root, token, {
    async syncStateDirectory() {},
    ...overrides,
  });
}

test("creates and syncs the global marker before begin returns", async () => {
  await withRoot(async (root) => {
    const syncs = [];
    const tokens = ["retirement", "terminal"];
    const port = portableTransition(root, {
      randomToken() {
        return tokens.shift();
      },
      async syncStateDirectory(path) {
        syncs.push(path);
      },
    });
    const active = await port.begin();
    const state = join(root, ".agent-teams-local");
    assert.equal(
      await readFile(join(state, `${prefix}${token}`), "utf8"),
      "foundation cleanup transition\n",
    );
    assert.deepEqual(syncs, [state]);
    await active.complete();
    const terminalRoot = join(state, "foundation-cleanup-retired-evidence");
    assert.deepEqual(await readdir(terminalRoot), ["terminal"]);
  });
});

test("retains discoverable marker evidence when marker retirement fails", async () => {
  await withRoot(async (root) => {
    const port = portableTransition(root, {
      async beforeLogicalRetirement() {
        throw new Error("marker removal failed");
      },
    });
    const active = await port.begin();
    await assert.rejects(active.complete(), /marker removal failed/u);
    const evidence = (await readdir(join(root, ".agent-teams-local")))
      .filter((entry) => entry.startsWith(prefix));
    assert.equal(evidence.length, 1);
    assert.match(evidence[0], new RegExp(`^${prefix}${token}\\.retired\\.`));
  });
});

test("rejects a pre-existing terminal-root link without escaping state", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "foundation-cleanup-outside-"));
    try {
      const active = await portableTransition(root)
        .begin();
      await symlink(
        outside,
        join(
          root,
          ".agent-teams-local",
          "foundation-cleanup-retired-evidence",
        ),
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        active.complete(),
        /real operation-owned directory/u,
      );
      assert.deepEqual(await readdir(outside), []);
      assert.equal(
        (await readdir(join(root, ".agent-teams-local"))).some((entry) =>
          entry.startsWith(`${prefix}${token}.retired.`)),
        true,
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

test("never deletes a marker replacement swapped after the final proof", async () => {
  await withRoot(async (root) => {
    let retiredMarker;
    const active = await portableTransition(root, {
      async beforeLogicalRetirement(path) {
        retiredMarker = path;
        await rename(path, `${path}.owned`);
        await writeFile(path, "foreign marker replacement\n");
      },
    }).begin();
    await assert.rejects(active.complete(), /marker authority changed/u);
    assert.equal(await readFile(retiredMarker, "utf8"), "foreign marker replacement\n");
    assert.equal(
      await readFile(`${retiredMarker}.owned`, "utf8"),
      "foundation cleanup transition\n",
    );
  });
});

test("rejects a swapped marker without deleting foreign evidence", async () => {
  await withRoot(async (root) => {
    let reads = 0;
    const port = portableTransition(root, {
      async readBoundedRegularFile(path, maximumBytes) {
        reads += 1;
        if (reads === 1) {
          await rename(path, `${path}.owned`);
          await writeFile(path, "foundation cleanup transition\n");
        }
        return readBoundedRegularFile(path, maximumBytes);
      },
    });
    const active = await port.begin();
    await assert.rejects(
      active.complete(),
      /marker authority changed/u,
    );
    const marker = join(root, ".agent-teams-local", `${prefix}${token}`);
    assert.equal(await readFile(marker, "utf8"), "foundation cleanup transition\n");
    assert.equal(await readFile(`${marker}.owned`, "utf8"), "foundation cleanup transition\n");
  });
});

test("foreign retirement collision retains the canonical marker", async () => {
  await withRoot(async (root) => {
    const active = await portableTransition(root, {
      randomToken: () => "collision",
    }).begin();
    const state = join(root, ".agent-teams-local");
    const collision = join(state, `${prefix}${token}.retired.collision`);
    await mkdir(collision);
    await assert.rejects(active.complete(), (error) => error?.code === "EEXIST");
    assert.equal(
      await readFile(join(state, `${prefix}${token}`), "utf8"),
      "foundation cleanup transition\n",
    );
  });
});

test("marker without a journal globally blocks a new mutation", async () => {
  await withRoot(async (root) => {
    const active = await portableTransition(root).begin();
    assert.equal(
      await scaffoldTransactionEvidenceExists(
        join(root, ".agent-teams-local", "scaffolding-transaction.json"),
      ),
      true,
    );
    const coordinator = await createNodeFoundationTransactionCoordinator(root);
    const status = await coordinator.inspect();
    assert.equal(status.state, "manual-recovery-required");
    assert.equal(status.reason, "journal-transition-residue");
    await assert.rejects(
      coordinator.acquire({ requestedMutation: "document-authoring" }),
      /incomplete Foundation transaction transition/u,
    );
    await active.complete();
  });
});

test("cleanup marker creation fails closed when strict directory sync is unsupported", async () => {
  await withRoot(async (root) => {
    let opened = false;
    const port = createNodeFoundationCleanupTransition(root, token, {
      async syncStateDirectory() {
        const error = new Error("unsupported marker directory fsync");
        error.code = "EINVAL";
        throw error;
      },
      async open(...args) {
        opened = true;
        return import("node:fs/promises").then(({ open }) => open(...args));
      },
    });
    await assert.rejects(
      port.begin(),
      (error) => error?.code === "EINVAL",
    );
    assert.equal(opened, true);
    const entries = await readdir(join(root, ".agent-teams-local"));
    assert.deepEqual(entries, [`${prefix}${token}`]);
  });
});

test("strict marker sync is a separate fail-closed operation", async () => {
  assert.notEqual(syncFoundationStateDirectoryStrictly, syncFoundationStateDirectory);
});
