import { opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import {
  assertSourceReadActive,
  sourceRootSymlink,
  sourceRootUnavailable,
  sourceRootEscape,
  sourceRootNotDirectory,
  sourcePathCollision,
  sourceEntrySymlink,
  sourceFileCountExceeded,
  unstableSourceFile,
  nulSourceFile,
  sourceByteBudgetExceeded,
  sourceConsumerUnavailable
} from "../../../application/policies/source-input-failures.js";
import { ContainedFileReadError, assertRepositoryRelativePath } from "../../../api.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "./contained-file-reader.js";

import type { SourceFileSnapshot } from "../../../application/model/source-file-snapshot.js";
import type { SourceTreeReader } from "../../../application/ports/source-tree-reader.js";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
]);
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_FILES = 100_000;
const MAX_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024;
const READ_CONCURRENCY = 32;

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function portablePathIdentity(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function isContained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

async function containedDirectory(
  canonicalRoot: string,
  repositoryPath: string
): Promise<string> {
  assertRepositoryRelativePath(repositoryPath, "source-discovery");
  const candidate = resolve(canonicalRoot, repositoryPath);
  if (await pathTraversesSymbolicLink(canonicalRoot, candidate)) {
    sourceRootSymlink(repositoryPath);
  }
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    sourceRootUnavailable(repositoryPath);
  }
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    sourceRootEscape(repositoryPath);
  }
  if (!(await stat(canonicalCandidate)).isDirectory()) {
    sourceRootNotDirectory(repositoryPath);
  }
  return canonicalCandidate;
}

async function discoverSourcePaths(
  canonicalRoot: string,
  governedRoots: readonly string[],
  signal?: AbortSignal
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const governedRoot of governedRoots) {
    const absoluteSourceRoot = await containedDirectory(canonicalRoot, governedRoot);
    const directories = [absoluteSourceRoot];
    while (directories.length > 0) {
      assertSourceReadActive(signal);
      const directoryPath = directories.pop();
      if (directoryPath === undefined) {
        break;
      }
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        assertSourceReadActive(signal);
        const absoluteEntry = join(directoryPath, entry.name);
        inspectSourceEntry(canonicalRoot, absoluteEntry, entry, directories, paths);
      }
    }
  }
  const uniquePaths = [...new Set(paths)].toSorted();
  const caseFoldedPaths = new Map<string, string>();
  for (const path of uniquePaths) {
    const caseFolded = portablePathIdentity(path);
    const existing = caseFoldedPaths.get(caseFolded);
    if (existing !== undefined && existing !== path) {
      sourcePathCollision(existing, path);
    }
    caseFoldedPaths.set(caseFolded, path);
  }
  return uniquePaths;
}

function inspectSourceEntry(
  canonicalRoot: string,
  absoluteEntry: string,
  entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; name: string },
  directories: string[],
  paths: string[]
): void {
  if (entry.isSymbolicLink()) {
    sourceEntrySymlink(toPosixPath(relative(canonicalRoot, absoluteEntry)));
  }
  if (entry.isDirectory()) {
    directories.push(absoluteEntry);
    return;
  }
  if (!entry.isFile() || !SOURCE_EXTENSIONS.has(posix.extname(entry.name))) {
    return;
  }
  paths.push(toPosixPath(relative(canonicalRoot, absoluteEntry)));
  if (paths.length > MAX_SOURCE_FILES) {
    sourceFileCountExceeded(MAX_SOURCE_FILES);
  }
}

async function readSourceFiles(
  canonicalRoot: string,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<readonly SourceFileSnapshot[]> {
  const files: SourceFileSnapshot[] = [];
  let totalBytes = 0;
  for (let index = 0; index < paths.length; index += READ_CONCURRENCY) {
    const loaded = await Promise.all(
      paths.slice(index, index + READ_CONCURRENCY).map(async (path) => {
        assertSourceReadActive(signal);
        let bytes: Buffer;
        try {
          bytes = await readContainedRegularFile({
            candidate: resolve(canonicalRoot, path),
            maxBytes: MAX_SOURCE_FILE_BYTES,
            root: canonicalRoot
          });
        } catch (error) {
          if (error instanceof ContainedFileReadError) {
            unstableSourceFile(path);
          }
          throw error;
        }
        const source = bytes.toString("utf8");
        if (source.includes("\0")) {
          nulSourceFile(path);
        }
        return { path, source, bytes: bytes.byteLength };
      })
    );
    for (const file of loaded) {
      totalBytes += file.bytes;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
        sourceByteBudgetExceeded(MAX_TOTAL_SOURCE_BYTES);
      }
      files.push({ path: file.path, source: file.source });
    }
  }
  return files;
}

export class FilesystemSourceTreeReader implements SourceTreeReader {
  async read(
    consumerRoot: string,
    governedRoots: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly SourceFileSnapshot[]> {
    assertSourceReadActive(signal);
    const canonicalRoot = await realpath(consumerRoot).catch(() =>
      sourceConsumerUnavailable()
    );
    return readSourceFiles(
      canonicalRoot,
      await discoverSourcePaths(canonicalRoot, governedRoots, signal),
      signal
    );
  }
}
