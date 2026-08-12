import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sha256Digest } from "../../../scaffolding/contract/types.js";
import { readBoundedRegularFile } from "../../../scaffolding/adapters/node/filesystem-file-identity.js";

const maximumBuildFileBytes = 8 * 1024 * 1024;
const maximumBuildFiles = 4096;
const maximumBuildBytes = 64 * 1024 * 1024;
const maximumVisitedBuildEntries = 16_384;
const maximumBuildTreeDepth = 64;
const packageRoot = dirname(
  fileURLToPath(new URL("../../../../package.json", import.meta.url))
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
  include: (path: string) => boolean,
  output: string[],
  budget: { depth: number; maximumVisited: number; visited: number }
): Promise<void> {
  if (budget.depth > maximumBuildTreeDepth) {
    throw new Error("Installed Foundation build tree is too deep.");
  }
  const entries = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      budget.visited += 1;
      if (budget.visited > budget.maximumVisited) {
        throw new Error("Installed Foundation build contains too many entries.");
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
        await collectRegularFiles(root, path, include, output, budget);
      } finally {
        budget.depth -= 1;
      }
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Installed Foundation build contains a non-regular artifact: ${portableRelativePath(root, path)}.`
      );
    }
    if (include(path)) {
      output.push(path);
      if (output.length > maximumBuildFiles) {
        throw new Error("Installed Foundation build contains too many artifacts.");
      }
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Installed Foundation build directory is unsafe: ${path}.`);
  }
}

async function buildIdentityFiles(
  root: string,
  maximumVisited: number
): Promise<string[]> {
  const files: string[] = [];
  const budget = { depth: 0, maximumVisited, visited: 0 };
  const distribution = join(root, "dist");
  const schemas = join(root, "schemas");
  const presets = join(root, "presets");
  await Promise.all([
    assertRealDirectory(distribution),
    assertRealDirectory(schemas),
    assertRealDirectory(presets)
  ]);
  await collectRegularFiles(
    root,
    distribution,
    (path) => path.endsWith(".js"),
    files,
    budget
  );
  await collectRegularFiles(root, schemas, () => true, files, budget);
  await collectRegularFiles(root, presets, () => true, files, budget);
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
 * Derives an identity from the installed executable JavaScript and every
 * shipped schema/preset contract. Length-prefixed portable paths and bytes
 * make the digest independent of directory enumeration and installation path.
 */
export async function computeFoundationBuildIdentity(
  root: string,
  limits: { readonly maximumVisitedEntries?: number } = {}
): Promise<Sha256Digest> {
  const hash = createHash("sha256");
  let totalBytes = 0;
  const maximumVisitedEntries =
    limits.maximumVisitedEntries ?? maximumVisitedBuildEntries;
  if (!Number.isSafeInteger(maximumVisitedEntries) || maximumVisitedEntries <= 0) {
    throw new TypeError("maximumVisitedEntries must be a positive safe integer.");
  }
  for (const path of await buildIdentityFiles(root, maximumVisitedEntries)) {
    const relativePath = portableRelativePath(root, path);
    const record = await readBoundedRegularFile(path, maximumBuildFileBytes);
    if (record.outcome !== "read") {
      throw new Error(
        `Installed Foundation build artifact is not a stable bounded regular file: ${relativePath}.`
      );
    }
    totalBytes += record.bytes.byteLength;
    if (totalBytes > maximumBuildBytes) {
      throw new Error("Installed Foundation build artifacts exceed the byte limit.");
    }
    const pathBytes = Buffer.from(relativePath, "utf8");
    hashLength(hash, pathBytes.byteLength);
    hash.update(pathBytes);
    hashLength(hash, record.bytes.byteLength);
    hash.update(record.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

let installedBuildIdentity: Promise<Sha256Digest> | undefined;

export function installedFoundationBuildIdentity(): Promise<Sha256Digest> {
  installedBuildIdentity ??= computeFoundationBuildIdentity(packageRoot);
  return installedBuildIdentity;
}
