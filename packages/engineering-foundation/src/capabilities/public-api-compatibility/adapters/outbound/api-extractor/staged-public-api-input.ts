import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { CapabilityInputError } from "../../../../../features/validation-reporting/api.js";
import { ContainedFileReadError } from "../../../../../source-inventory/api.js";
import { pathTraversesSymbolicLink, readContainedRegularFile } from "../../../../../source-inventory/node.js";
import {
  compareCanonicalReferences,
  type PublicApiPackagePolicy
} from "../../../application/model/public-api.js";
import { linkStagedNodeModules } from "./link-staged-package-node-modules.js";

const MAX_EXTRACTOR_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_STAGED_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_STAGED_REPOSITORY_ENTRIES = 10_000;
const STAGING_DIRECTORY_PREFIX = ".agent-teams-public-api-stage-";
const REPOSITORY_COMPILER_INPUT = /\.(?:[cm]?tsx?|jsonc?)$/u;

export interface StagedPackageSnapshot {
  readonly packageRoot: string;
  readonly sourceRoot: string;
  readonly sourcePackageRoot: string;
  readonly stagingRoot: string;
}

interface StagingBudget {
  entryCount: number;
  totalBytes: number;
}

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "public-api-extraction",
    retryable: false
  });
}

function contained(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function extractionReadError(error: unknown, repositoryPath: string): never {
  if (error instanceof ContainedFileReadError) {
    const code =
      error.failure === "symlink"
        ? "PUBLIC_API_PATH_SYMLINK_PROHIBITED"
        : error.failure === "escape"
          ? "PUBLIC_API_PATH_ESCAPE"
          : error.failure === "invalid"
            ? "PUBLIC_API_PATH_INVALID"
            : "PUBLIC_API_PATH_UNAVAILABLE";
    inputError(
      code,
      `Public API extraction input is unavailable or changed: ${repositoryPath}.`
    );
  }
  throw error;
}

export function sourcePathFor(root: string, repositoryPath: string): string {
  const candidate = resolve(root, repositoryPath);
  if (!contained(root, candidate)) {
    inputError(
      "PUBLIC_API_PATH_ESCAPE",
      `Public API extraction path escapes the consumer repository: ${repositoryPath}.`
    );
  }
  return candidate;
}

export function stagedPathForSource(input: {
  readonly snapshot: StagedPackageSnapshot;
  readonly sourcePath: string;
}): string {
  const repositoryRelativePath = relative(input.snapshot.sourceRoot, input.sourcePath);
  if (
    repositoryRelativePath.length === 0 ||
    isAbsolute(repositoryRelativePath) ||
    repositoryRelativePath === ".." ||
    repositoryRelativePath.startsWith(`..${sep}`)
  ) {
    inputError(
      "PUBLIC_API_PATH_ESCAPE",
      "Configured public API evidence must stay inside the consumer repository."
    );
  }
  return join(input.snapshot.stagingRoot, repositoryRelativePath);
}

async function readStagedSourceFile(input: {
  readonly root: string;
  readonly sourcePath: string;
}): Promise<Buffer> {
  try {
    return await readContainedRegularFile({
      candidate: input.sourcePath,
      maxBytes: MAX_EXTRACTOR_INPUT_BYTES,
      root: input.root
    });
  } catch (error) {
    return extractionReadError(error, relative(input.root, input.sourcePath));
  }
}

function consumeDirectoryEntries(budget: StagingBudget, count: number): void {
  budget.entryCount += count;
  if (budget.entryCount > MAX_STAGED_REPOSITORY_ENTRIES) {
    inputError(
      "PUBLIC_API_PATH_INVALID",
      `Public API input exceeds ${MAX_STAGED_REPOSITORY_ENTRIES} staged repository entries.`
    );
  }
}

function consumeBytes(budget: StagingBudget, source: Buffer, scope: string): void {
  budget.totalBytes += source.byteLength;
  if (budget.totalBytes > MAX_STAGED_PACKAGE_BYTES) {
    inputError(
      "PUBLIC_API_PATH_INVALID",
      `Public API ${scope} input exceeds the staged extraction resource limit.`
    );
  }
}

async function stagePackageDirectory(input: {
  readonly budget: StagingBudget;
  readonly destinationDirectory: string;
  readonly root: string;
  readonly sourceDirectory: string;
}): Promise<void> {
  if (await pathTraversesSymbolicLink(input.root, input.sourceDirectory)) {
    inputError(
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
      `Public API package tree cannot traverse a symbolic link: ${relative(input.root, input.sourceDirectory)}.`
    );
  }
  let entries;
  try {
    entries = await readdir(input.sourceDirectory, { withFileTypes: true });
  } catch {
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API package directory is unavailable: ${relative(input.root, input.sourceDirectory)}.`
    );
  }
  consumeDirectoryEntries(input.budget, entries.length);
  for (const entry of entries.toSorted((left, right) =>
    compareCanonicalReferences(left.name, right.name)
  )) {
    const sourcePath = join(input.sourceDirectory, entry.name);
    if (entry.name === "node_modules" || entry.name.startsWith(STAGING_DIRECTORY_PREFIX)) {
      continue;
    }
    const destinationPath = join(input.destinationDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      inputError(
        "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
        `Public API package tree cannot include a symbolic link: ${relative(input.root, sourcePath)}.`
      );
    }
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700, recursive: true });
      await stagePackageDirectory({
        budget: input.budget,
        destinationDirectory: destinationPath,
        root: input.root,
        sourceDirectory: sourcePath
      });
      continue;
    }
    if (!entry.isFile()) {
      inputError(
        "PUBLIC_API_PATH_INVALID",
        `Public API package tree contains an unsupported entry: ${relative(input.root, sourcePath)}.`
      );
    }
    const source = await readStagedSourceFile({ root: input.root, sourcePath });
    consumeBytes(input.budget, source, "package");
    await writeFile(destinationPath, source, { mode: 0o600 });
  }
}

async function stageRepositoryCompilerInputs(input: {
  readonly budget: StagingBudget;
  readonly destinationDirectory: string;
  readonly root: string;
  readonly sourceDirectory: string;
  readonly sourcePackageRoot: string;
}): Promise<void> {
  let entries;
  try {
    entries = await readdir(input.sourceDirectory, { withFileTypes: true });
  } catch {
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API repository evidence is unavailable: ${relative(input.root, input.sourceDirectory)}.`
    );
  }
  consumeDirectoryEntries(input.budget, entries.length);
  for (const entry of entries.toSorted((left, right) =>
    compareCanonicalReferences(left.name, right.name)
  )) {
    const sourcePath = join(input.sourceDirectory, entry.name);
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name.startsWith(STAGING_DIRECTORY_PREFIX) ||
      sourcePath === input.sourcePackageRoot
    ) {
      continue;
    }
    const destinationPath = join(input.destinationDirectory, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700, recursive: true });
      await stageRepositoryCompilerInputs({
        ...input,
        destinationDirectory: destinationPath,
        sourceDirectory: sourcePath
      });
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile() || !REPOSITORY_COMPILER_INPUT.test(entry.name)) {
      continue;
    }
    const source = await readStagedSourceFile({ root: input.root, sourcePath });
    consumeBytes(input.budget, source, "repository");
    await writeFile(destinationPath, source, { mode: 0o600 });
  }
}

export async function stagePackageSnapshot(input: {
  readonly policy: PublicApiPackagePolicy;
  readonly root: string;
}): Promise<StagedPackageSnapshot> {
  const sourcePackageRoot = sourcePathFor(input.root, input.policy.packageRoot);
  if (await pathTraversesSymbolicLink(input.root, sourcePackageRoot)) {
    inputError(
      "PUBLIC_API_PATH_SYMLINK_PROHIBITED",
      `Public API package root cannot traverse a symbolic link: ${input.policy.packageRoot}.`
    );
  }
  try {
    if (!(await stat(sourcePackageRoot)).isDirectory()) {
      inputError(
        "PUBLIC_API_PATH_INVALID",
        `Public API package root is not a directory: ${input.policy.packageRoot}.`
      );
    }
  } catch (error) {
    if (error instanceof CapabilityInputError) {
      throw error;
    }
    inputError(
      "PUBLIC_API_PATH_UNAVAILABLE",
      `Public API package root is unavailable: ${input.policy.packageRoot}.`
    );
  }
  let stagingRoot: string;
  try {
    stagingRoot = await mkdtemp(join(tmpdir(), STAGING_DIRECTORY_PREFIX));
  } catch {
    inputError(
      "PUBLIC_API_EXTRACTION_FAILED",
      "Unable to allocate a private public API staging directory."
    );
  }
  const snapshot: StagedPackageSnapshot = Object.freeze({
    packageRoot: join(stagingRoot, input.policy.packageRoot),
    sourceRoot: input.root,
    sourcePackageRoot,
    stagingRoot
  });
  try {
    const budget = { entryCount: 0, totalBytes: 0 };
    await mkdir(snapshot.packageRoot, { mode: 0o700, recursive: true });
    await stageRepositoryCompilerInputs({
      budget,
      destinationDirectory: snapshot.stagingRoot,
      root: input.root,
      sourceDirectory: input.root,
      sourcePackageRoot: snapshot.sourcePackageRoot
    });
    await stagePackageDirectory({
      budget,
      destinationDirectory: snapshot.packageRoot,
      root: input.root,
      sourceDirectory: snapshot.sourcePackageRoot
    });
    await linkStagedNodeModules({
      sourceDirectory: snapshot.sourceRoot,
      stagedDirectory: snapshot.stagingRoot
    });
    await linkStagedNodeModules({
      sourceDirectory: snapshot.sourcePackageRoot,
      stagedDirectory: snapshot.packageRoot
    });
    return snapshot;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}
