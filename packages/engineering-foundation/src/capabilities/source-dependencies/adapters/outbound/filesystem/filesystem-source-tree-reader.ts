import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../capability-runtime.js";
import { pathTraversesSymbolicLink } from "../../../../../filesystem-path-safety.js";
import {
  assertNotCancelled,
  assertRepositoryRelativePath
} from "../../../../../strict-yaml.js";
import type { SourceFileSnapshot } from "../../../application/model/source-workspace.js";
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

function inputError(code: string, message: string, phase: string): never {
  throw new CapabilityInputError({ code, message, phase, retryable: false });
}

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
    inputError(
      "SOURCE_SYMLINK_PROHIBITED",
      `Governed source roots cannot be symbolic links: ${repositoryPath}.`,
      "source-discovery"
    );
  }
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    inputError(
      "SOURCE_DIRECTORY_UNAVAILABLE",
      `Required source directory is unavailable: ${repositoryPath}.`,
      "source-discovery"
    );
  }
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    inputError(
      "SOURCE_DIRECTORY_ESCAPE",
      `Source directory escapes the consumer repository: ${repositoryPath}.`,
      "source-discovery"
    );
  }
  if (!(await stat(canonicalCandidate)).isDirectory()) {
    inputError(
      "SOURCE_DIRECTORY_INVALID",
      `Source path must be a directory: ${repositoryPath}.`,
      "source-discovery"
    );
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
      assertNotCancelled(signal);
      const directoryPath = directories.pop();
      if (directoryPath === undefined) {
        break;
      }
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
        assertNotCancelled(signal);
        const absoluteEntry = join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
          inputError(
            "SOURCE_SYMLINK_PROHIBITED",
            `Source trees cannot contain symbolic links: ${toPosixPath(relative(canonicalRoot, absoluteEntry))}.`,
            "source-discovery"
          );
        }
        if (entry.isDirectory()) {
          directories.push(absoluteEntry);
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(posix.extname(entry.name))) {
          paths.push(toPosixPath(relative(canonicalRoot, absoluteEntry)));
          if (paths.length > MAX_SOURCE_FILES) {
            inputError(
              "SOURCE_FILE_LIMIT_EXCEEDED",
              `Governed source contains more than ${MAX_SOURCE_FILES} files.`,
              "source-discovery"
            );
          }
        }
      }
    }
  }
  const uniquePaths = [...new Set(paths)].toSorted();
  const caseFoldedPaths = new Map<string, string>();
  for (const path of uniquePaths) {
    const caseFolded = portablePathIdentity(path);
    const existing = caseFoldedPaths.get(caseFolded);
    if (existing !== undefined && existing !== path) {
      inputError(
        "SOURCE_PATH_CASE_COLLISION",
        `Source paths differ only by letter case: ${existing} and ${path}.`,
        "source-discovery"
      );
    }
    caseFoldedPaths.set(caseFolded, path);
  }
  return uniquePaths;
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
        assertNotCancelled(signal);
        const absolutePath = resolve(canonicalRoot, path);
        const metadata = await lstat(absolutePath);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size > MAX_SOURCE_FILE_BYTES
        ) {
          inputError(
            "SOURCE_FILE_INVALID",
            `Source must be a regular file no larger than ${MAX_SOURCE_FILE_BYTES} bytes: ${path}.`,
            "source-read"
          );
        }
        const source = await readFile(absolutePath, "utf8");
        if (source.includes("\0")) {
          inputError(
            "SOURCE_FILE_INVALID",
            `Source file contains prohibited NUL bytes: ${path}.`,
            "source-read"
          );
        }
        return { path, source, bytes: metadata.size };
      })
    );
    for (const file of loaded) {
      totalBytes += file.bytes;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES) {
        inputError(
          "SOURCE_SIZE_LIMIT_EXCEEDED",
          `Governed source exceeds ${MAX_TOTAL_SOURCE_BYTES} bytes.`,
          "source-read"
        );
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
    assertNotCancelled(signal);
    const canonicalRoot = await realpath(consumerRoot).catch(() =>
      inputError(
        "CONSUMER_ROOT_UNAVAILABLE",
        "Consumer root must be an existing accessible directory.",
        "source-workspace"
      )
    );
    return readSourceFiles(
      canonicalRoot,
      await discoverSourcePaths(canonicalRoot, governedRoots, signal),
      signal
    );
  }
}
