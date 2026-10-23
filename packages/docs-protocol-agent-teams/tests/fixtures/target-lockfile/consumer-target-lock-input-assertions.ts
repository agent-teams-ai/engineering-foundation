import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  link,
  open,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeConsumerTargetLockfileReader } from "../../../dist/consumer-integration/adapters/node-consumer-target-lockfile.js";
import { candidate, digest } from "./consumer-target-lockfile-fixture.mjs";
const readConsumerTargetLockfile: typeof nodeConsumerTargetLockfileReader.read = (...args) =>
  nodeConsumerTargetLockfileReader.read(...args);
export async function assertRetainedTargetLockInput(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-target-lock-input-")));
  const consumer = join(root, "consumer"),
    path = join(root, "target.yaml");
  await mkdir(consumer);
  const selected = { path, sha256: digest(candidate) };
  try {
    await writeFile(path, candidate);
    const retained = await readConsumerTargetLockfile(selected, consumer);
    await rename(path, `${path}.old`);
    await writeFile(path, "replacement");
    assert.deepEqual(retained, candidate);
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /SHA256/u);
    await assert.rejects(
      readConsumerTargetLockfile({ ...selected, sha256: "sha256:BAD" }, consumer),
      /SHA256/u,
    );
    await rm(path);
    await symlink(`${path}.old`, path);
    await assert.rejects(
      readConsumerTargetLockfile(selected, consumer),
      /symlink|changed during observation/u,
    );
    await rm(path);
    await link(`${path}.old`, path);
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /hardlinked/u);
    await rm(path);
    await writeFile(path, "");
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /bounded/u);
    const handle = await open(path, "w");
    await handle.truncate(32 * 1024 * 1024 + 1);
    await handle.close();
    await assert.rejects(readConsumerTargetLockfile(selected, consumer), /bounded/u);
    await writeFile(join(consumer, "lock.yaml"), candidate);
    for (const forbidden of [
      join(consumer, "lock.yaml"),
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
      fileURLToPath(new URL("../../../../repository-mutation/package.json", import.meta.url)),
    ]) {
      await assert.rejects(
        readConsumerTargetLockfile({ ...selected, path: forbidden }, consumer),
        /outside/u,
      );
    }
    await symlink(root, join(root, "alias"));
    await assert.rejects(
      readConsumerTargetLockfile({ ...selected, path: join(root, "alias/target.yaml") }, consumer),
      /canonical/u,
    );
    await assert.rejects(
      readConsumerTargetLockfile({ ...selected, path: "relative.yaml" }, consumer),
      /absolute/u,
    );
    await assert.rejects(
      readConsumerTargetLockfile({ ...selected, path: root }, consumer),
      /regular/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function assertFrozenTargetLockInstall(args: readonly string[] | undefined): void {
  assert.deepEqual(args, [
    "pnpm",
    "install",
    "--prefer-offline",
    "--frozen-lockfile",
    "--package-import-method=copy",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--verify-store-integrity",
  ]);
}

export async function assertTargetLockReadRaces(t: TestContext): Promise<void> {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-target-lock-race-")));
  const consumer = join(root, "consumer"),
    path = join(root, "lock.yaml");
  await mkdir(consumer);
  const originalOpen = fs.open;
  try {
    for (const mutate of [
      async () => {
        await rename(path, `${path}.old`);
        await writeFile(path, candidate);
      },
      async () => {
        await fs.appendFile(path, "growth");
      },
    ]) {
      await writeFile(path, candidate);
      let reads = 0;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === path) {
          const read = handle.read.bind(handle);
          handle.read = new Proxy(read, {
            async apply(target, receiver: unknown, readArguments: unknown[]) {
              const result = await (Reflect.apply(target, receiver, readArguments) as ReturnType<
                typeof read
              >);
              if (reads++ === 0) {
                await mutate();
              }
              return result;
            },
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      await assert.rejects(
        readConsumerTargetLockfile({ path, sha256: digest(candidate) }, consumer),
        /changed during observation/u,
      );
      assert.ok(reads <= 2, "reader never follows unbounded file growth");
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
}
