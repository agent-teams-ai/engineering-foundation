import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { portableRepositoryPathIdentity } from "../../application/model/repository-path.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";

export type ExistingRepositoryAncestorProblem =
  | "name-collision"
  | "not-directory"
  | "outside-root";

export class ExistingRepositoryAncestorError extends Error {
  readonly problem: ExistingRepositoryAncestorProblem;
  readonly existingName: string | undefined;
  readonly requestedName: string | undefined;

  constructor(
    problem: ExistingRepositoryAncestorProblem,
    options: { readonly existingName?: string; readonly requestedName?: string } = {}
  ) {
    super(`Existing repository ancestor is unsafe: ${problem}.`);
    this.name = "ExistingRepositoryAncestorError";
    this.problem = problem;
    this.existingName = options.existingName;
    this.requestedName = options.requestedName;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function assertNoPortableNameCollision(
  parent: string,
  requestedName: string,
  pathIdentity: (path: string) => string = portableRepositoryPathIdentity
): Promise<void> {
  const entries = await readdir(parent).catch((error: unknown) => {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  });
  const requestedIdentity = pathIdentity(requestedName);
  const collision = entries.find(
    (entry) => entry !== requestedName && pathIdentity(entry) === requestedIdentity
  );
  if (collision !== undefined) {
    throw new ExistingRepositoryAncestorError("name-collision", {
      existingName: collision,
      requestedName
    });
  }
}

export async function assertSafeExistingRepositoryAncestors(
  root: string,
  repositoryPath: string,
  pathIdentity: (path: string) => string = portableRepositoryPathIdentity
): Promise<void> {
  const segments = repositoryPath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    await assertNoPortableNameCollision(current, segment, pathIdentity);
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
      throw new ExistingRepositoryAncestorError("not-directory");
    }
    const canonical = await realpath(next);
    if (!isLexicallyContainedPath(root, canonical)) {
      throw new ExistingRepositoryAncestorError("outside-root");
    }
    current = canonical;
  }
  await assertNoPortableNameCollision(
    current,
    segments.at(-1) ?? "",
    pathIdentity
  );
}
