import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { repositoryRoot } from "./runtime-policy.mts";

const excludedSourceDirectories = new Set([
  ".git",
  ".worker-tmp",
  ".cache",
  ".nx",
  "node_modules",
  ".pnpm-store",
  "coverage",
  ".coverage-evidence"
]);

function isExcludedSourceEntry(
  sourceRoot: string,
  path: string,
  entry: {
    readonly name: string;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  }
): boolean {
  if (excludedSourceDirectories.has(entry.name)) {
    return true;
  }
  if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
    return true;
  }
  const pathParts = relative(sourceRoot, path).split(/[\\/]/u);
  if (
    entry.isFile() &&
    pathParts.length === 1 &&
    pathParts[0] === ".agent-teams-runtime-profile.json"
  ) {
    return true;
  }
  // prepare-package owns these generated package copies; the root LICENSE is source.
  if (entry.isFile() && pathParts.length === 3 && pathParts[0] === "packages" && pathParts[2] === "LICENSE") {
    return true;
  }
  return entry.isDirectory() &&
    pathParts.length === 3 &&
    pathParts[0] === "packages" &&
    pathParts[2] === "dist";
}

async function copyTree(source: string, destination: string, sourceRoot: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = (await readdir(source, { withFileTypes: true }))
    .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const from = resolve(source, entry.name);
    if (isExcludedSourceEntry(sourceRoot, from, entry)) {
      continue;
    }
    const to = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, sourceRoot);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    } else {
      throw new Error(`Profile source contains an unsupported entry: ${relative(sourceRoot, from)}.`);
    }
  }
}

export async function copySourceTree(source: string, destination: string): Promise<void> {
  await copyTree(source, destination, source);
}

export async function sourceTreeDigest(sourceRoot: string = repositoryRoot, normalized: ReadonlyMap<string, string> = new Map()): Promise<string> {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (isExcludedSourceEntry(sourceRoot, path, entry)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(relative(sourceRoot, path).split(/[\\/]/u).join("/"));
      } else {
        throw new Error(`Profile source contains an unsupported entry: ${relative(sourceRoot, path)}.`);
      }
    }
  };
  await walk(sourceRoot);
  files.sort();
  for (const path of files) {
    const bytes = normalized.has(path)
      ? Buffer.from(normalized.get(path) ?? "", "utf8")
      : await readFile(resolve(sourceRoot, path));
    hash.update(`${JSON.stringify([path, bytes.length])}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
