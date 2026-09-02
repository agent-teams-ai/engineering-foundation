import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_AUTHORITY_BYTES = 8 * 1024 * 1024;

class AdoptionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptionInputError";
  }
}

function stable(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs;
}

async function readRealRegularText(path: string, maximumBytes: number): Promise<string> {
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) {throw new AdoptionInputError("Input must not traverse symbolic links.");}
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
      throw new AdoptionInputError(`Input must be one non-hardlinked regular file of at most ${maximumBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    const [after, pathState, finalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(absolute, { bigint: true }),
      realpath(absolute)
    ]);
    if (after.nlink !== 1n || pathState.nlink !== 1n || !stable(before, after) ||
      pathState.dev !== after.dev || pathState.ino !== after.ino || finalPath !== absolute ||
      bytes.byteLength !== Number(after.size)) {
      throw new AdoptionInputError("Input path or contents changed while it was read.");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new AdoptionInputError("Input must be strict UTF-8 text.");
    }
    if (source.startsWith("\uFEFF") || source.includes("\u0000")) {
      throw new AdoptionInputError("Input must not contain a UTF-8 BOM or NUL bytes.");
    }
    return source;
  } finally {
    await handle.close();
  }
}

export async function readContainedText(root: string, repositoryPath: string, maximumBytes: number): Promise<string> {
  const absolute = resolve(root, repositoryPath);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {throw new AdoptionInputError("Input escapes the consumer root.");}
  return readRealRegularText(absolute, maximumBytes);
}

export async function assertContainedAuthority(root: string, repositoryPath: string): Promise<void> {
  await readContainedText(root, repositoryPath, MAX_AUTHORITY_BYTES);
}
