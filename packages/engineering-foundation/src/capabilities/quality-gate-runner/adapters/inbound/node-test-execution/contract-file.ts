import { constants, lstat, open, realpath } from "node:fs/promises";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(`Node test execution contract: ${message}`);
}
function fileSnapshot(stat: {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
export async function readContractFile(path: string): Promise<string> {
  // Keep the verified inode open while reading. NOFOLLOW blocks a final
  // symlink on POSIX; NONBLOCK prevents a FIFO from hanging before fstat.
  const flags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | flags).catch((error: unknown) => {
    if (record(error) && error.code === "ELOOP") {
      fail("contract must be a real regular file");
    }
    throw error;
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      (await realpath(path)) !== path ||
      fileSnapshot(await lstat(path, { bigint: true })) !== fileSnapshot(opened)
    ) {
      fail("contract must be a real regular file");
    }
    const content = await handle.readFile("utf8");
    if (
      fileSnapshot(await handle.stat({ bigint: true })) !== fileSnapshot(opened) ||
      (await realpath(path)) !== path ||
      fileSnapshot(await lstat(path, { bigint: true })) !== fileSnapshot(opened)
    ) {
      fail("contract changed while reading");
    }
    return content;
  } finally {
    await handle.close();
  }
}
