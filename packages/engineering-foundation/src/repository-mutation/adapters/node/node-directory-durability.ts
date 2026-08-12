import { open } from "node:fs/promises";

export type DirectoryDurability = "durable" | "unsupported";

interface DirectorySyncHandle {
  close(): Promise<void>;
  sync(): Promise<void>;
}

interface DirectoryDurabilityOperations {
  readonly open: (path: string) => Promise<DirectorySyncHandle>;
  readonly platform: NodeJS.Platform;
}

const nodeDirectoryDurabilityOperations: DirectoryDurabilityOperations = {
  async open(path) {
    return open(path, "r");
  },
  platform: process.platform
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export async function syncDirectoryDurably(
  path: string,
  operations: DirectoryDurabilityOperations = nodeDirectoryDurabilityOperations
): Promise<DirectoryDurability> {
  try {
    const handle = await operations.open(path);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return "durable";
  } catch (error) {
    if (
      operations.platform === "win32" &&
      ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")
    ) {
      return "unsupported";
    }
    throw error;
  }
}
