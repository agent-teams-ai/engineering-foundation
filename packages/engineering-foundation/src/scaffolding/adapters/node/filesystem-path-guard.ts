import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { ScaffoldPlan } from "../../contract/scaffold-contract.js";
import { ScaffoldError } from "../../scaffold-error.js";

const PROTECTED_ROOTS = new Set([".agent-teams-local", ".git", "node_modules"]);
const WINDOWS_RESERVED_NAMES = new Set([
  "AUX",
  "CON",
  "NUL",
  "PRN",
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`)
]);

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function isContainedPath(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

export function assertSafeOperationPaths(plan: ScaffoldPlan): void {
  const folded = new Map<string, string>();
  const operationIds = new Set<string>();
  const targetPrefix = `${plan.target.path}/`;
  for (const operation of plan.operations) {
    const segments = operation.path.split("/");
    if (
      !operation.path.startsWith(targetPrefix) ||
      operation.path.length === 0 ||
      operation.path.length > 512 ||
      operation.path.includes("\\") ||
      isAbsolute(operation.path) ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.length > 255 ||
          segment.endsWith(".") ||
          Array.from(segment).some(
            (character) => (character.codePointAt(0) ?? 0) < 32
          ) ||
          WINDOWS_RESERVED_NAMES.has((segment.split(".")[0] ?? "").toUpperCase())
      ) ||
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
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      return;
    }
    throw error;
  }
}

async function assertNoCaseCollision(
  parent: string,
  requestedName: string
): Promise<void> {
  const entries = await readdir(parent).catch((error: unknown) => {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  });
  const collision = entries.find(
    (entry) =>
      entry !== requestedName && entry.toLowerCase() === requestedName.toLowerCase()
  );
  if (collision !== undefined) {
    throw new ScaffoldError(
      "SCAFFOLD_APPLY_CONFLICT",
      `Path collides under case folding: ${collision}, ${requestedName}.`
    );
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
  const segments = repositoryPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    await assertNoCaseCollision(current, segment);
    const next = join(current, segment);
    const metadata = await lstat(next).catch((error: unknown) => {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    });
    if (metadata === null) {
      return;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ScaffoldError(
        "SCAFFOLD_APPLY_CONFLICT",
        `Scaffolding parent is not a real directory: ${repositoryPath}.`
      );
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
}
