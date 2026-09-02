import type { Dirent } from "node:fs";
import {
  lstat as nodeLstat,
  opendir as nodeOpendir,
  realpath as nodeRealpath,
  stat as nodeStat
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { readContainedRegularFile } from "../../../../../filesystem-path-safety.js";
import { assertNotCancelled } from "../../../../../strict-yaml.js";
import {
  portableRepositoryPathProblem
} from "../../../application/model/repository-path.js";

interface SourceFilesystemMetadata {
  readonly ctimeMs: bigint | number;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: bigint | number;
  readonly mtimeMs: bigint | number;
  readonly size: bigint | number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface SourceDirectory extends AsyncIterable<Dirent> {}

export interface SourceWorkspaceFileSystem {
  lstat(path: string): Promise<SourceFilesystemMetadata>;
  opendir(path: string, signal?: AbortSignal): Promise<SourceDirectory>;
  realpath(path: string): Promise<string>;
  readContainedFile(input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }): Promise<Buffer>;
  stat(path: string): Promise<SourceFilesystemMetadata>;
}

export interface StableRepositoryPath {
  readonly absolutePath: string;
  readonly canonicalMetadata: SourceFilesystemMetadata;
  readonly lexicalMetadata: SourceFilesystemMetadata;
  readonly repositoryPath: string;
  readonly traversesSymbolicLink: boolean;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "source-workspace-topology",
    retryable: false
  });
}

export function createSourceWorkspaceFileSystem(
  overrides: Partial<SourceWorkspaceFileSystem> | undefined = {}
): SourceWorkspaceFileSystem {
  const defaults: SourceWorkspaceFileSystem = {
    lstat: (path) => nodeLstat(path, { bigint: true }),
    opendir: (path) => nodeOpendir(path),
    realpath: (path) => nodeRealpath(path),
    readContainedFile: readContainedRegularFile,
    stat: (path) => nodeStat(path, { bigint: true })
  };
  return { ...defaults, ...overrides };
}

function pathIsContained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

export function assertSafeRepositoryPath(repositoryPath: string): void {
  if (portableRepositoryPathProblem(repositoryPath) !== undefined) {
    inputError(
      "SOURCE_DISCOVERY_PATH_INVALID",
      "Source workspace discovery produced a non-contained repository path."
    );
  }
}

function sameValue(left: bigint | number, right: bigint | number): boolean {
  return String(left) === String(right);
}

function sameFilesystemIdentity(
  left: SourceFilesystemMetadata,
  right: SourceFilesystemMetadata
): boolean {
  return sameValue(left.dev, right.dev) && sameValue(left.ino, right.ino);
}

function sameFilesystemSnapshot(
  left: SourceFilesystemMetadata,
  right: SourceFilesystemMetadata
): boolean {
  return (
    sameFilesystemIdentity(left, right) &&
    sameValue(left.mode, right.mode) &&
    sameValue(left.size, right.size) &&
    sameValue(left.mtimeMs, right.mtimeMs) &&
    sameValue(left.ctimeMs, right.ctimeMs)
  );
}

async function pathTraversesSymbolicLink(
  canonicalConsumerRoot: string,
  absolutePath: string,
  operations: SourceWorkspaceFileSystem,
  signal?: AbortSignal
): Promise<boolean> {
  const relation = relative(canonicalConsumerRoot, absolutePath);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    return false;
  }
  let current = canonicalConsumerRoot;
  for (const segment of relation.split(sep).filter((value) => value.length > 0)) {
    assertNotCancelled(signal);
    current = join(current, segment);
    const metadata = await operations.lstat(current).catch(() => {
      assertNotCancelled(signal);
      return inputError(
        "SOURCE_DIRECTORY_UNAVAILABLE",
        "A required schema v2 source path is unavailable."
      );
    });
    assertNotCancelled(signal);
    if (metadata.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export async function captureStableRepositoryPath(
  canonicalConsumerRoot: string,
  repositoryPath: string,
  expectedKind: "directory" | "source",
  operations: SourceWorkspaceFileSystem,
  signal?: AbortSignal
): Promise<StableRepositoryPath> {
  assertNotCancelled(signal);
  assertSafeRepositoryPath(repositoryPath);
  const absolutePath =
    repositoryPath === "."
      ? canonicalConsumerRoot
      : resolve(canonicalConsumerRoot, repositoryPath);
  if (!pathIsContained(canonicalConsumerRoot, absolutePath)) {
    inputError(
      "SOURCE_DIRECTORY_ESCAPE",
      `Schema v2 source path escapes the consumer repository: ${repositoryPath}.`
    );
  }
  const lexicalMetadata = await operations.lstat(absolutePath).catch(() => {
    assertNotCancelled(signal);
    return inputError(
      "SOURCE_DIRECTORY_UNAVAILABLE",
      `Required schema v2 source path is unavailable: ${repositoryPath}.`
    );
  });
  assertNotCancelled(signal);
  const traversesSymbolicLink = await pathTraversesSymbolicLink(
    canonicalConsumerRoot,
    absolutePath,
    operations,
    signal
  );
  const canonicalPath = await operations.realpath(absolutePath).catch(() => {
    assertNotCancelled(signal);
    return inputError(
      "SOURCE_DIRECTORY_UNAVAILABLE",
      `Required schema v2 source path is unavailable: ${repositoryPath}.`
    );
  });
  assertNotCancelled(signal);
  if (!pathIsContained(canonicalConsumerRoot, canonicalPath)) {
    inputError(
      "SOURCE_DIRECTORY_ESCAPE",
      `Schema v2 source path escapes the consumer repository: ${repositoryPath}.`
    );
  }
  const canonicalMetadata = await operations.stat(canonicalPath).catch(() => {
    assertNotCancelled(signal);
    return inputError(
      "SOURCE_DIRECTORY_UNAVAILABLE",
      `Required schema v2 source path is unavailable: ${repositoryPath}.`
    );
  });
  assertNotCancelled(signal);
  if (
    (expectedKind === "directory" && !canonicalMetadata.isDirectory()) ||
    (expectedKind === "source" &&
      !canonicalMetadata.isDirectory() &&
      !canonicalMetadata.isFile())
  ) {
    inputError(
      "SOURCE_DIRECTORY_INVALID",
      `Schema v2 source path has an invalid filesystem kind: ${repositoryPath}.`
    );
  }
  if (
    !traversesSymbolicLink &&
    !sameFilesystemIdentity(lexicalMetadata, canonicalMetadata)
  ) {
    inputError(
      "SOURCE_FILESYSTEM_CHANGED",
      `Schema v2 source path changed while it was inspected: ${repositoryPath}.`
    );
  }
  return Object.freeze({
    absolutePath,
    canonicalMetadata,
    lexicalMetadata,
    repositoryPath,
    traversesSymbolicLink
  });
}

export async function revalidateStableRepositoryPath(
  canonicalConsumerRoot: string,
  captured: StableRepositoryPath,
  operations: SourceWorkspaceFileSystem,
  signal?: AbortSignal
): Promise<void> {
  assertNotCancelled(signal);
  try {
    const lexicalMetadata = await operations.lstat(captured.absolutePath);
    const traversesSymbolicLink = await pathTraversesSymbolicLink(
      canonicalConsumerRoot,
      captured.absolutePath,
      operations,
      signal
    );
    const canonicalPath = await operations.realpath(captured.absolutePath);
    if (!pathIsContained(canonicalConsumerRoot, canonicalPath)) {
      throw new Error("escape");
    }
    const canonicalMetadata = await operations.stat(canonicalPath);
    if (
      traversesSymbolicLink !== captured.traversesSymbolicLink ||
      !sameFilesystemSnapshot(lexicalMetadata, captured.lexicalMetadata) ||
      !sameFilesystemSnapshot(canonicalMetadata, captured.canonicalMetadata)
    ) {
      throw new Error("changed");
    }
    assertNotCancelled(signal);
  } catch (error) {
    if (
      error instanceof CapabilityInputError &&
      error.problem.code === "EXECUTION_CANCELLED"
    ) {
      throw error;
    }
    inputError(
      "SOURCE_FILESYSTEM_CHANGED",
      `Schema v2 source path changed while it was inspected: ${captured.repositoryPath}.`
    );
  }
}
