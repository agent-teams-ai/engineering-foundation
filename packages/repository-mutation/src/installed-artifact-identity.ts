import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedRegularFile } from "./repository-mutation/adapters/node/node-bounded-regular-file.js";

export type InstalledArtifactDigest = `sha256:${string}`;
export interface InstalledArtifactClosure {
  readonly packageRoot: string;
  readonly roots: readonly ("assets" | "contract" | "dist" | "presets" | "schemas")[];
}

const maximumBuildFileBytes = 8 * 1024 * 1024;
const maximumBuildFiles = 4096;
const maximumBuildBytes = 64 * 1024 * 1024;
const maximumVisitedBuildEntries = 16_384;
const maximumBuildTreeDepth = 64;
const repositoryMutationPackageRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function collectRegularFiles(
  root: string,
  directory: string,
  output: string[],
  budget: { depth: number; maximumVisited: number; visited: number }
): Promise<void> {
  if (budget.depth > maximumBuildTreeDepth) {
    throw new Error("Installed artifact tree is too deep.");
  }
  const entries = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      budget.visited += 1;
      if (budget.visited > budget.maximumVisited) {
        throw new Error("Installed artifact contains too many entries.");
      }
      entries.push(entry);
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ERR_DIR_CLOSED"
        )
      ) {
        throw error;
      }
    });
  }
  entries.sort((left, right) => comparePortablePaths(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      budget.depth += 1;
      try {
        await collectRegularFiles(root, path, output, budget);
      } finally {
        budget.depth -= 1;
      }
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Installed artifact contains a non-regular entry: ${portableRelativePath(root, path)}.`
      );
    }
    output.push(path);
    if (output.length > maximumBuildFiles) {
      throw new Error("Installed artifact contains too many files.");
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Installed artifact directory is unsafe: ${path}.`);
  }
}

async function buildIdentityFiles(
  declaration: InstalledArtifactClosure,
  maximumVisited: number
): Promise<string[]> {
  const files: string[] = [];
  const budget = { depth: 0, maximumVisited, visited: 0 };
  const root = declaration.packageRoot;
  const manifest = join(root, "package.json");
  for (const name of declaration.roots) {
    const selected = join(root, name);
    await assertRealDirectory(selected);
    await collectRegularFiles(root, selected, files, budget);
  }
  files.push(manifest);
  return files.toSorted((left, right) =>
    comparePortablePaths(
      portableRelativePath(root, left),
      portableRelativePath(root, right)
    )
  );
}

function hashLength(hash: ReturnType<typeof createHash>, length: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(length));
  hash.update(encoded);
}

/**
 * Derives an identity from the installed package manifest, executable
 * JavaScript, and every shipped schema/preset contract. Length-prefixed paths and bytes
 * make the digest independent of directory enumeration and installation path.
 */
export async function computeInstalledArtifactBuildIdentity(
  declaration: InstalledArtifactClosure,
  limits: { readonly maximumVisitedEntries?: number } = {}
): Promise<InstalledArtifactDigest> {
  const hash = createHash("sha256");
  let totalBytes = 0;
  const maximumVisitedEntries =
    limits.maximumVisitedEntries ?? maximumVisitedBuildEntries;
  if (!Number.isSafeInteger(maximumVisitedEntries) || maximumVisitedEntries <= 0) {
    throw new TypeError("maximumVisitedEntries must be a positive safe integer.");
  }
  const root = declaration.packageRoot;
  for (const path of await buildIdentityFiles(declaration, maximumVisitedEntries)) {
    const relativePath = portableRelativePath(root, path);
    const record = await readBoundedRegularFile(path, maximumBuildFileBytes);
    if (record.outcome !== "read") {
      throw new Error(
        `Installed artifact is not a stable bounded regular file: ${relativePath}.`
      );
    }
    totalBytes += record.bytes.byteLength;
    if (totalBytes > maximumBuildBytes) {
      throw new Error("Installed artifact exceeds the byte limit.");
    }
    const pathBytes = Buffer.from(relativePath, "utf8");
    hashLength(hash, pathBytes.byteLength);
    hash.update(pathBytes);
    hashLength(hash, record.bytes.byteLength);
    hash.update(record.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

let installedBuildIdentity: Promise<InstalledArtifactDigest> | undefined;

export function installedRepositoryMutationBuildIdentity(): Promise<InstalledArtifactDigest> {
  installedBuildIdentity ??= computeInstalledArtifactBuildIdentity({
    packageRoot: repositoryMutationPackageRoot,
    roots: ["dist", "schemas"]
  });
  return installedBuildIdentity;
}
