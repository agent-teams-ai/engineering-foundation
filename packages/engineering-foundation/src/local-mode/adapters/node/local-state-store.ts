import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { FoundationLinkState } from "../../application/model.js";
import { LOCAL_STATE_DIRECTORY, LOCAL_STATE_FILE } from "../../application/model.js";

async function writeLinkState(
  durability: LocalStateDirectory,
  consumerRoot: string,
  state: FoundationLinkState
): Promise<void> {
  const directory = join(consumerRoot, LOCAL_STATE_DIRECTORY);
  const destination = join(directory, LOCAL_STATE_FILE);
  const temporary = `${destination}.${process.pid}.tmp`;
  await durability.ensure(consumerRoot);
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await durability.sync(directory);
}

async function removeLinkState(durability: LocalStateDirectory, consumerRoot: string): Promise<void> {
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
  await durability.sync(directory);
  await durability.prune(consumerRoot);
}

export interface LocalStateDirectory {
  ensure(consumerRoot: string): Promise<unknown>;
  prune(consumerRoot: string): Promise<void>;
  sync(directory: string): Promise<void>;
}

export function createNodeLocalLinkStateStore(durability: LocalStateDirectory) {
  return {
    write: (consumerRoot: string, state: FoundationLinkState) => writeLinkState(durability, consumerRoot, state),
    remove: (consumerRoot: string) => removeLinkState(durability, consumerRoot)
  };
}
