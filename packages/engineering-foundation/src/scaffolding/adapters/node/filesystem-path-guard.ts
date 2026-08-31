import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  assertNoPortableNameCollision,
  assertSafeExistingRepositoryAncestors,
  ExistingRepositoryAncestorError,
  isLexicallyContainedPath,
  syncDirectoryDurably
} from "@agent-teams/repository-mutation/node";
import { legacyScaffoldingRepositoryPathProblem } from "../../application/policies/legacy-scaffolding-repository-path.js";
import type { ScaffoldPlan } from "../../contract/scaffold-contract.js";
import { ScaffoldError } from "../../scaffold-error.js";

const PROTECTED_ROOTS = new Set([".agent-teams-local", ".git", "node_modules"]);

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function isContainedPath(root: string, candidate: string): boolean {
  return isLexicallyContainedPath(root, candidate);
}

export function assertSafeOperationPaths(plan: ScaffoldPlan): void {
  const folded = new Map<string, string>();
  const operationIds = new Set<string>();
  const targetPrefix = `${plan.target.path}/`;
  for (const operation of plan.operations) {
    const segments = operation.path.split("/");
    if (
      !operation.path.startsWith(targetPrefix) ||
      legacyScaffoldingRepositoryPathProblem(operation.path) !== undefined ||
      segments.some((segment) => PROTECTED_ROOTS.has(segment.toLowerCase()))
    ) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Scaffolding operation path is unsafe: ${operation.path}.`
      );
    }
    const key = operation.path.toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        existing === operation.path
          ? `Duplicate scaffolding operation path: ${operation.path}.`
          : `Scaffolding operation paths collide under case folding: ${existing}, ${operation.path}.`
      );
    }
    if (operationIds.has(operation.id)) {
      throw new ScaffoldError(
        "SCAFFOLD_PLAN_INVALID",
        `Duplicate scaffolding operation ID: ${operation.id}.`
      );
    }
    folded.set(key, operation.path);
    operationIds.add(operation.id);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  await syncDirectoryDurably(path);
}

async function assertNoCaseCollision(
  parent: string,
  requestedName: string
): Promise<void> {
  try {
    await assertNoPortableNameCollision(
      parent,
      requestedName,
      (path) => path.toLowerCase(),
      "filesystem"
    );
  } catch (error) {
    if (
      error instanceof ExistingRepositoryAncestorError &&
      error.problem === "name-collision"
    ) {
      const collision = error.existingName ?? "";
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Path collides under case folding: ${collision}, ${requestedName}.`
      );
    }
    throw error;
  }
}

export async function ensureSafeParent(
  root: string,
  repositoryPath: string
): Promise<string> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    await assertNoCaseCollision(current, segment);
    const next = join(current, segment);
    try {
      const metadata = await lstat(next);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding parent is not a real directory: ${repositoryPath}.`
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await mkdir(next);
      await syncDirectory(current);
    }
    const canonical = await realpath(next);
    if (!isContainedPath(root, canonical)) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent escapes the repository: ${repositoryPath}.`
      );
    }
    current = canonical;
  }
  await assertNoCaseCollision(current, segments.at(-1) ?? "");
  return current;
}

export async function assertSafeExistingAncestors(
  root: string,
  repositoryPath: string
): Promise<void> {
  try {
    await assertSafeExistingRepositoryAncestors(
      root,
      repositoryPath,
      (path) => path.toLowerCase(),
      "filesystem"
    );
  } catch (error) {
    if (error instanceof ExistingRepositoryAncestorError) {
      if (error.problem === "name-collision") {
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Path collides under case folding: ${error.existingName ?? ""}, ${error.requestedName ?? ""}.`
        );
      }
      if (error.problem === "not-directory") {
        throw new ScaffoldError(
          "SCAFFOLD_APPLY_CONFLICT",
          `Scaffolding parent is not a real directory: ${repositoryPath}.`
        );
      }
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent escapes the repository: ${repositoryPath}.`
      );
    }
    throw error;
  }
}
