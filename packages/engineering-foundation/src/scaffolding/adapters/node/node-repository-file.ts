import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ScaffoldReadAssertionV1 } from "../../contract/types.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { pathTraversesSymbolicLink } from "../../../filesystem-path-safety.js";
import { assertRepositoryRelativePath } from "../../../strict-yaml.js";

const MAX_INPUT_BYTES = 1024 * 1024;

export interface LoadedRepositoryFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly source: string;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

export async function readContainedRepositoryFile(
  consumerRoot: string,
  repositoryPath: string,
  phase: string,
  maxBytes = MAX_INPUT_BYTES
): Promise<LoadedRepositoryFile> {
  try {
    assertRepositoryRelativePath(repositoryPath, phase);
    const canonicalRoot = await realpath(consumerRoot);
    const candidate = resolve(canonicalRoot, repositoryPath);
    if (await pathTraversesSymbolicLink(canonicalRoot, candidate)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input cannot traverse a symbolic link: ${repositoryPath}.`
      );
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isContained(canonicalRoot, canonicalCandidate)) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input escapes the consumer repository: ${repositoryPath}.`
      );
    }
    const metadata = await lstat(canonicalCandidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > maxBytes
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input must be a regular file no larger than ${maxBytes} bytes: ${repositoryPath}.`
      );
    }
    const bytes = await readFile(canonicalCandidate);
    return {
      path: repositoryPath,
      bytes,
      source: bytes.toString("utf8")
    };
  } catch (error) {
    if (error instanceof ScaffoldError) {
      throw error;
    }
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Cannot read scaffolding input: ${repositoryPath}.`,
      [],
      { cause: error }
    );
  }
}

export function assertion(file: LoadedRepositoryFile): ScaffoldReadAssertionV1 {
  const canonicalBytes = Buffer.from(
    file.source.replace(/\r\n?/gu, "\n"),
    "utf8"
  );
  return Object.freeze({
    path: file.path,
    state: "file" as const,
    digest: sha256Bytes(canonicalBytes),
    size: canonicalBytes.byteLength
  });
}
