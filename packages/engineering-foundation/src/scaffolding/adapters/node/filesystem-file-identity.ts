import { lstat, type FileHandle } from "node:fs/promises";

export interface PortableFileIdentity {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

function identityFromStat(metadata: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): PortableFileIdentity {
  return {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function captureFileHandleIdentity(
  handle: FileHandle
): Promise<PortableFileIdentity> {
  return identityFromStat(await handle.stat({ bigint: true }));
}

export async function pathMatchesFileIdentity(
  path: string,
  expected: PortableFileIdentity
): Promise<"different" | "match" | "missing"> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return "different";
    }
    const observed = identityFromStat(metadata);
    return observed.dev === expected.dev &&
      observed.ino === expected.ino &&
      observed.birthtimeNs === expected.birthtimeNs
      ? "match"
      : "different";
  } catch (error) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
}
