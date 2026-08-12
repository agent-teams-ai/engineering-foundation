import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { NodeFoundationOperationLock } from "../transaction-coordination/adapters/node/node-foundation-operation-lock.js";
import {
  ensureFoundationStateDirectory,
  pruneFoundationStateDirectory,
  syncFoundationStateDirectory
} from "../transaction-coordination/adapters/node/node-foundation-state-directory.js";
import type { FoundationLinkState } from "./types.js";
import { LOCAL_STATE_DIRECTORY, LOCAL_STATE_FILE } from "./types.js";

export async function syncDirectory(path: string): Promise<void> {
  await syncFoundationStateDirectory(path);
}

export async function writeLinkState(
  consumerRoot: string,
  state: FoundationLinkState
): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await ensureFoundationStateDirectory(consumerRoot);
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(directory);
}

export async function removeLinkState(consumerRoot: string): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  await rm(destination, { force: true });
  const temporaryEntries = await readdir(directory).catch(() => []);
  await Promise.all(
    temporaryEntries
      .filter((entry) => entry.startsWith(`${LOCAL_STATE_FILE}.`) && entry.endsWith(".tmp"))
      .map(async (entry) => {
        await rm(join(directory, entry), { force: true });
      })
  );
  await syncDirectory(directory);
  await pruneFoundationStateDirectory(consumerRoot);
}

export async function acquireFoundationOperationLock(
  consumerRoot: string
): Promise<() => Promise<void>> {
  return new NodeFoundationOperationLock(consumerRoot).acquire();
}
