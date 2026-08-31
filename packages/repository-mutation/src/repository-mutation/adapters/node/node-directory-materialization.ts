import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  BoundDirectoryCreation,
  CapturedDirectory,
  DirectoryCreatePolicy,
  DirectoryMaterializationProjection,
  ProjectedDirectory,
  UnboundDirectoryCreationRecovery
} from "../../application/model/directory-materialization.js";
import { DirectoryMutationError } from "../../application/model/directory-materialization.js";
import type { PortablePathIdentity } from "../../application/model/path-identity.js";
import {
  portableRepositoryPathIdentity,
  portableRepositoryPathProblem
} from "../../application/model/repository-path.js";
import { syncDirectoryStrictly } from "./node-directory-durability.js";
import { createAndBindNodeDirectory } from "./node-create-and-bind-directory.js";
import { isLexicallyContainedPath } from "./node-repository-path.js";

export interface DirectoryIdentityBindingPort {
  bindCreatedDirectory(directory: CapturedDirectory & {
    readonly parentIdentity: PortablePathIdentity;
  }): Promise<void>;
}

interface DirectoryCreationFaultPoint {
  readonly phase: "after-mkdir-before-capture" | "after-parent-sync-before-bind";
  readonly repositoryPath: string;
}

export type DirectoryCreationFaultInjector = (
  point: DirectoryCreationFaultPoint
) => Promise<void> | void;

const maximumDirectoryEntries = 1024;

async function boundedDirectoryNames(path: string): Promise<readonly string[]> {
  const directory = await opendir(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) {return names;}
      names.push(entry.name);
      if (names.length > maximumDirectoryEntries) {
        throw new DirectoryMutationError(
          "CONCURRENT_CHANGE",
          "Repository directory contains too many entries to inspect portable aliases safely."
        );
      }
    }
  } finally {
    await directory.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function sameIdentity(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function identityFromMetadata(metadata: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): PortablePathIdentity {
  const identity = {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
  if (
    identity.birthtimeNs === 0n ||
    identity.dev === 0n ||
    identity.ino === 0n
  ) {
    throw new DirectoryMutationError(
      "IDENTITY_UNAVAILABLE",
      "The filesystem did not provide a nonzero directory identity."
    );
  }
  return identity;
}

function assertRepositoryPath(repositoryPath: string): readonly string[] {
  const problem = portableRepositoryPathProblem(repositoryPath);
  if (problem !== undefined) {
    throw new DirectoryMutationError(
      "INVALID_PATH",
      `Invalid portable repository directory path (${problem}): ${repositoryPath}.`
    );
  }
  return repositoryPath.split("/");
}

async function captureRealDirectory(
  absolutePath: string,
  repositoryPath: string
): Promise<CapturedDirectory> {
  const metadata = await lstat(absolutePath, { bigint: true });
  if (metadata.isSymbolicLink()) {
    throw new DirectoryMutationError(
      "SYMLINK",
      `Repository directory must not be a symbolic link: ${repositoryPath}.`
    );
  }
  if (!metadata.isDirectory()) {
    throw new DirectoryMutationError(
      "NOT_DIRECTORY",
      `Repository path is not a directory: ${repositoryPath}.`
    );
  }
  return {
    absolutePath,
    identity: identityFromMetadata(metadata),
    repositoryPath
  };
}

async function assertCanonicalContainment(
  canonicalRoot: string,
  directory: CapturedDirectory
): Promise<void> {
  const canonical = await realpath(directory.absolutePath);
  if (!isLexicallyContainedPath(canonicalRoot, canonical)) {
    throw new DirectoryMutationError(
      "OUTSIDE_ROOT",
      `Repository directory resolves outside its root: ${directory.repositoryPath}.`
    );
  }
  const recaptured = await captureRealDirectory(
    directory.absolutePath,
    directory.repositoryPath
  );
  if (!sameIdentity(directory.identity, recaptured.identity)) {
    throw new DirectoryMutationError(
      "CONCURRENT_CHANGE",
      `Directory identity changed while checking containment: ${directory.repositoryPath}.`
    );
  }
}

async function assertNoAlias(
  parent: string,
  requestedName: string
): Promise<boolean> {
  const requestedIdentity = portableRepositoryPathIdentity(requestedName);
  const entries = await boundedDirectoryNames(parent);
  const aliases = entries.filter(
    (entry) => portableRepositoryPathIdentity(entry) === requestedIdentity
  );
  if (aliases.some((entry) => entry !== requestedName)) {
    throw new DirectoryMutationError(
      "ALIAS_COLLISION",
      `Portable case/NFC alias collides with requested directory: ${requestedName}.`
    );
  }
  return aliases.includes(requestedName);
}

async function captureRoot(repositoryRoot: string): Promise<{
  readonly canonicalRoot: string;
  readonly root: CapturedDirectory;
}> {
  const absoluteRoot = resolve(repositoryRoot);
  const root = await captureRealDirectory(absoluteRoot, ".");
  const canonicalRoot = await realpath(absoluteRoot);
  const recapturedRoot = await captureRealDirectory(canonicalRoot, ".");
  if (!sameIdentity(root.identity, recapturedRoot.identity)) {
    throw new DirectoryMutationError(
      "CONCURRENT_CHANGE",
      "Repository root identity changed while it was captured."
    );
  }
  return {
    canonicalRoot,
    root: recapturedRoot
  };
}

async function captureExistingPath(
  canonicalRoot: string,
  repositoryPath: string
): Promise<CapturedDirectory> {
  if (repositoryPath === ".") {
    return captureRealDirectory(canonicalRoot, ".");
  }
  let current = canonicalRoot;
  let captured = await captureRealDirectory(canonicalRoot, ".");
  const traversed: string[] = [];
  for (const segment of assertRepositoryPath(repositoryPath)) {
    await assertNoAlias(current, segment);
    traversed.push(segment);
    current = join(current, segment);
    captured = await captureRealDirectory(current, traversed.join("/"));
    await assertCanonicalContainment(canonicalRoot, captured);
  }
  return captured;
}

export async function projectDirectoryMaterialization(options: {
  readonly createPolicy: DirectoryCreatePolicy;
  readonly repositoryPath: string;
  readonly repositoryRoot: string;
}): Promise<DirectoryMaterializationProjection> {
  const segments = assertRepositoryPath(options.repositoryPath);
  const { canonicalRoot, root } = await captureRoot(options.repositoryRoot);
  let anchor = root;
  let currentAbsolute = canonicalRoot;
  const traversed: string[] = [];
  const missingDirectories: ProjectedDirectory[] = [];

  for (const segment of segments) {
    traversed.push(segment);
    currentAbsolute = join(currentAbsolute, segment);
    const repositoryPath = traversed.join("/");
    if (missingDirectories.length > 0) {
      missingDirectories.push({ absolutePath: currentAbsolute, repositoryPath });
      continue;
    }
    const exists = await assertNoAlias(dirname(currentAbsolute), segment);
    if (!exists) {
      missingDirectories.push({
        absolutePath: currentAbsolute,
        repositoryPath
      });
      continue;
    }
    const captured = await captureRealDirectory(currentAbsolute, repositoryPath);
    await assertCanonicalContainment(canonicalRoot, captured);
    anchor = captured;
  }

  return {
    anchor,
    createPolicy: options.createPolicy,
    finalParent: {
      absolutePath: join(canonicalRoot, ...segments),
      repositoryPath: options.repositoryPath
    },
    missingDirectories,
    repositoryRoot: root
  };
}

export async function recaptureExactDirectoryIdentity(options: {
  readonly expectedIdentity: PortablePathIdentity;
  readonly repositoryPath: string;
  readonly repositoryRoot: string;
}): Promise<CapturedDirectory> {
  assertRepositoryPath(options.repositoryPath);
  const { canonicalRoot } = await captureRoot(options.repositoryRoot);
  const captured = await captureExistingPath(canonicalRoot, options.repositoryPath);
  if (!sameIdentity(captured.identity, options.expectedIdentity)) {
    throw new DirectoryMutationError(
      "CONCURRENT_CHANGE",
      `Directory identity changed: ${options.repositoryPath}.`
    );
  }
  return captured;
}

export async function createAndBindOneDirectory(options: {
  readonly binding: Pick<DirectoryIdentityBindingPort, "bindCreatedDirectory">;
  readonly createPolicy: DirectoryCreatePolicy;
  readonly expectedParentIdentity: PortablePathIdentity;
  readonly faultInjector?: DirectoryCreationFaultInjector;
  readonly mode?: number;
  readonly repositoryPath: string;
  readonly repositoryRoot: string;
}): Promise<BoundDirectoryCreation> {
  const segments = assertRepositoryPath(options.repositoryPath);
  if (options.createPolicy !== "allow") {
    throw new DirectoryMutationError(
      "CREATE_FORBIDDEN",
      `Directory creation is forbidden by policy: ${options.repositoryPath}.`
    );
  }
  return createAndBindNodeDirectory({
    ambiguousError: (error) => new DirectoryMutationError(
      "AMBIGUOUS_CREATION",
      `Directory may exist without a durable identity binding: ${options.repositoryPath}. Manual recovery is required.`,
      { cause: error, manualRecoveryRequired: true }
    ),
    async bind(bound) {
      await options.binding.bindCreatedDirectory(bound);
    },
    async captureParent() {
      const { canonicalRoot } = await captureRoot(options.repositoryRoot);
      const absolutePath = join(canonicalRoot, ...segments);
      const parentPath = dirname(absolutePath);
      const parentRepositoryPath = segments.slice(0, -1).join("/") || ".";
      const parent = await captureExistingPath(
        canonicalRoot,
        parentRepositoryPath
      );
      if (!sameIdentity(parent.identity, options.expectedParentIdentity)) {
        throw new DirectoryMutationError(
          "CONCURRENT_CHANGE",
          `Parent directory identity changed: ${parentRepositoryPath}.`
        );
      }
      await assertNoAlias(parentPath, segments.at(-1) ?? "");
      return { absolutePath, canonicalRoot, parent, parentPath, parentRepositoryPath };
    },
    async createAndObserve(parent, markCreated) {
      await mkdir(parent.absolutePath, {
        mode: options.mode ?? 0o755,
        recursive: false
      });
      markCreated();
      // Portable Node cannot atomically return mkdir's identity. The first
      // observation is authoritative only for cooperative writers.
      const observed = await captureRealDirectory(
        parent.absolutePath,
        options.repositoryPath
      );
      await options.faultInjector?.({
        phase: "after-mkdir-before-capture",
        repositoryPath: options.repositoryPath
      });
      return observed;
    },
    async recapture(parent, observed) {
      const captured = await captureExistingPath(
        parent.canonicalRoot,
        options.repositoryPath
      );
      const recapturedParent = await captureExistingPath(
        parent.canonicalRoot,
        parent.parentRepositoryPath
      );
      await assertNoAlias(parent.parentPath, segments.at(-1) ?? "");
      if (!sameIdentity(observed.identity, captured.identity) ||
        !sameIdentity(recapturedParent.identity, parent.parent.identity)) {
        throw new DirectoryMutationError(
          "CONCURRENT_CHANGE",
          `Created directory or its parent changed before binding: ${options.repositoryPath}.`
        );
      }
      return {
        ...captured,
        outcome: "created-and-bound" as const,
        parentIdentity: parent.parent.identity
      };
    },
    async syncParent(parent) {
      await syncDirectoryStrictly(parent.parentPath);
      await options.faultInjector?.({
        phase: "after-parent-sync-before-bind",
        repositoryPath: options.repositoryPath
      });
    }
  });
}

export async function classifyUnboundDirectoryCreation(options: {
  readonly repositoryPath: string;
  readonly repositoryRoot: string;
}): Promise<UnboundDirectoryCreationRecovery> {
  assertRepositoryPath(options.repositoryPath);
  const { canonicalRoot } = await captureRoot(options.repositoryRoot);
  try {
    const captured = await captureExistingPath(canonicalRoot, options.repositoryPath);
    return { observedIdentity: captured.identity, outcome: "ambiguous-manual" };
  } catch (error) {
    if (isMissing(error)) {
      return { outcome: "not-created" };
    }
    throw error;
  }
}
