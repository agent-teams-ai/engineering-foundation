import { readBoundedRegularFile } from "@agent-teams/repository-mutation/node";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_AUTHORITY_BYTES = 8 * 1024 * 1024;

class AdoptionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptionInputError";
  }
}

async function readRealRegularText(path: string, maximumBytes: number): Promise<string> {
  const absolute = resolve(path);
  if ((await realpath(absolute)) !== absolute) {
    throw new AdoptionInputError("Input must not traverse symbolic links.");
  }
  const observed = await readBoundedRegularFile(absolute, maximumBytes);
  if (
    observed.outcome === "invalid" ||
    (observed.outcome === "read" && observed.linkCount !== 1n)
  ) {
    throw new AdoptionInputError(
      `Input must be one non-hardlinked regular file of at most ${maximumBytes} bytes.`,
    );
  }
  if (observed.outcome === "changed") {
    throw new AdoptionInputError("Input path or contents changed while it was read.");
  }
  try {
    const [pathState, finalPath] = await Promise.all([
      lstat(absolute, { bigint: true }),
      realpath(absolute),
    ]);
    if (
      pathState.isSymbolicLink() ||
      !pathState.isFile() ||
      pathState.nlink !== 1n ||
      pathState.dev !== observed.identity.dev ||
      pathState.ino !== observed.identity.ino ||
      pathState.birthtimeNs !== observed.identity.birthtimeNs ||
      finalPath !== absolute ||
      pathState.size !== BigInt(observed.bytes.byteLength)
    ) {
      throw new AdoptionInputError("Input path or contents changed while it was read.");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(observed.bytes);
    } catch {
      throw new AdoptionInputError("Input must be strict UTF-8 text.");
    }
    if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
      throw new AdoptionInputError("Input must not contain a UTF-8 BOM or NUL bytes.");
    }
    return source;
  } catch (error) {
    if (error instanceof AdoptionInputError) {
      throw error;
    }
    throw new AdoptionInputError(
      "Input path or contents changed or became unavailable after reading.",
    );
  }
}

export async function readContainedText(
  root: string,
  repositoryPath: string,
  maximumBytes: number,
): Promise<string> {
  const absolute = resolve(root, repositoryPath);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new AdoptionInputError("Input escapes the consumer root.");
  }
  return readRealRegularText(absolute, maximumBytes);
}

export async function assertContainedAuthority(
  root: string,
  repositoryPath: string,
): Promise<void> {
  await readContainedText(root, repositoryPath, MAX_AUTHORITY_BYTES);
}
