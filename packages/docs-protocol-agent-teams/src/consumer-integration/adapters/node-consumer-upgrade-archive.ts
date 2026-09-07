import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ConsumerIntegrationNodeError } from "./consumer-integration-node-error.js";
import { readStableConsumerFile } from "./node-consumer-repository-files.js";

type Execute = (
  executable: string,
  args: readonly string[],
  cwd: string
) => Promise<unknown>;

export const MAXIMUM_INVENTORY_FILES = 100_000;
export const MAXIMUM_INVENTORY_BYTES = 1024 * 1024 * 1024;
export const MAXIMUM_INVENTORY_FILE_BYTES = 64 * 1024 * 1024;

async function restoreFileMode(root: string, target: string, path: string): Promise<number> {
  const source = await readStableConsumerFile(root, path, MAXIMUM_INVENTORY_FILE_BYTES, true);
  const extracted = await readStableConsumerFile(target, path, MAXIMUM_INVENTORY_FILE_BYTES, true);
  if (source.state !== "file" || extracted.state !== "file") {throw new Error("unreachable");}
  if (!Buffer.from(source.bytes).equals(Buffer.from(extracted.bytes))) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED",
      `Committed source differs from the worktree bytes: ${path}.`
    );
  }
  const absolute = join(target, path);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const pathState = await lstat(absolute);
    if (!metadata.isFile() || metadata.nlink !== 1 ||
      metadata.dev !== pathState.dev || metadata.ino !== pathState.ino ||
      await realpath(absolute) !== absolute || metadata.size > MAXIMUM_INVENTORY_FILE_BYTES ||
      !Buffer.from(extracted.bytes).equals(await handle.readFile())) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_INPUT_UNSTABLE",
        `Archive file changed before restoring its source mode: ${path}.`
      );
    }
    // Git records only the owner executable bit. The byte-proved worktree is
    // authority for the remaining admitted permission bits, including 0600/0750.
    await handle.chmod(source.mode);
  } finally {
    await handle.close();
  }
  return source.bytes.byteLength;
}

async function restoreSourceModes(root: string, target: string): Promise<void> {
  let entries = 0;
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    const directory = join(target, path);
    if (await realpath(directory) !== directory) {
      throw new ConsumerIntegrationNodeError(
        "DOCS_CONSUMER_PATH_ESCAPE", "Archive directory must remain inside its real sandbox."
      );
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAXIMUM_INVENTORY_FILES || bytes > MAXIMUM_INVENTORY_BYTES) {
        throw new ConsumerIntegrationNodeError(
          "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE", "Archive exceeds the bounded inventory."
        );
      }
      const relativePath = path === "" ? entry.name : `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) {continue;}
      if (entry.isDirectory()) {await visit(relativePath);}
      else {bytes += await restoreFileMode(root, target, relativePath);}
    }
  }
  await visit("");
  if (bytes > MAXIMUM_INVENTORY_BYTES) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_UPGRADE_REPOSITORY_TOO_LARGE", "Archive exceeds the bounded byte count."
    );
  }
}

export async function extractHead(
  input: { readonly root: string; readonly head: string; readonly target: string },
  execute: Execute
): Promise<void> {
  const { root, head, target } = input;
  if (await realpath(dirname(target)) !== dirname(target)) {
    throw new ConsumerIntegrationNodeError(
      "DOCS_CONSUMER_PATH_ESCAPE", "Archive destination must have a real sandbox parent."
    );
  }
  // The caller owns a private mkdtemp parent; never extract over an existing tree.
  await mkdir(target);
  const archive = `${target}.tar`;
  try {
    // Explicit archive AND extraction permissions avoid root defaults, caller
    // umasks and local tar.umask configuration selecting staging permissions.
    await execute("git", ["-c", "tar.umask=022", "archive", "--format=tar", `--output=${archive}`, head], root);
    await execute("tar", ["-xpf", archive, "--no-same-owner", "-C", target], root);
    await restoreSourceModes(root, target);
  } finally {
    await rm(archive, { force: true });
  }
}
