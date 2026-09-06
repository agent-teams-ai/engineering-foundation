import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  ScaffoldReadAssertionV1
} from "../../application/model/scaffold-compilation.js";
import { sha256Bytes } from "../../kernel/canonical-json.js";
import { ScaffoldError } from "../../scaffold-error.js";
import type { ScaffoldAuthorityObservation } from "../../application/ports/authority-observation.js";
import { assertScaffoldAuthorityPath } from "../../application/policies/authority-path.js";
import { readBoundedRegularFile } from "./filesystem-file-identity.js";

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

function decodeUtf8(bytes: Uint8Array, repositoryPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new ScaffoldError(
      "SCAFFOLD_INPUT_INVALID",
      `Scaffolding input must contain valid UTF-8: ${repositoryPath}.`,
      [],
      { cause: error }
    );
  }
}

export async function readContainedRepositoryFile(
  consumerRoot: string,
  repositoryPath: string,
  phase: string,
  observation: ScaffoldAuthorityObservation,
  maxBytes = MAX_INPUT_BYTES
): Promise<LoadedRepositoryFile> {
  try {
    assertScaffoldAuthorityPath(repositoryPath, phase);
    const canonicalRoot = await realpath(consumerRoot);
    const candidate = resolve(canonicalRoot, repositoryPath);
    if (await observation.pathTraversesSymbolicLink(canonicalRoot, candidate)) {
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
    const result = await readBoundedRegularFile(canonicalCandidate, maxBytes);
    if (result.outcome === "invalid") {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input must be a regular file no larger than ${maxBytes} bytes: ${repositoryPath}.`
      );
    }
    if (
      result.outcome === "changed" ||
      (await realpath(candidate)) !== canonicalCandidate ||
      (await observation.pathTraversesSymbolicLink(canonicalRoot, candidate))
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_INPUT_INVALID",
        `Scaffolding input changed while it was being read: ${repositoryPath}.`
      );
    }
    return {
      path: repositoryPath,
      bytes: result.bytes,
      source: decodeUtf8(result.bytes, repositoryPath)
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
