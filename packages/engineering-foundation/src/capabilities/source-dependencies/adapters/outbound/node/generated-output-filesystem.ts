import { GeneratedOutputManifestObservations } from "./generated-output-manifest-observations.js";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export interface GeneratedFilesystemIdentity {
  readonly device: string;
  readonly inode: string;
}

interface GeneratedPathSnapshot extends GeneratedFilesystemIdentity {
  readonly kind: "directory" | "file";
  readonly lexicalPath: string;
}

interface GeneratedConsumerRootSnapshot extends GeneratedFilesystemIdentity {
  readonly canonicalRoot: string;
}

function consumerRootSnapshot(
  consumerRoot: string,
  expected: GeneratedFilesystemIdentity | undefined
): GeneratedConsumerRootSnapshot | undefined {
  try {
    const canonicalRoot = realpathSync(consumerRoot);
    const metadata = lstatSync(canonicalRoot, { bigint: true });
    const snapshot = {
      canonicalRoot,
      device: String(metadata.dev),
      inode: String(metadata.ino)
    };
    return !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (expected !== undefined &&
        (snapshot.device !== expected.device || snapshot.inode !== expected.inode))
      ? undefined
      : snapshot;
  } catch {
    return undefined;
  }
}

function consumerRootIsStable(snapshot: GeneratedConsumerRootSnapshot): boolean {
  try {
    const metadata = lstatSync(snapshot.canonicalRoot, { bigint: true });
    return String(metadata.dev) === snapshot.device &&
      String(metadata.ino) === snapshot.inode;
  } catch {
    return false;
  }
}

function pathSnapshot(
  canonicalRoot: string,
  lexicalPath: string,
  kind: "directory" | "file"
): GeneratedPathSnapshot | undefined {
  try {
    const lexical = lstatSync(lexicalPath, { bigint: true });
    if (
      lexical.isSymbolicLink() ||
      (kind === "directory" ? !lexical.isDirectory() : !lexical.isFile())
    ) {
      return undefined;
    }
    const canonicalPath = realpathSync(lexicalPath);
    const containment = relative(canonicalRoot, canonicalPath);
    const canonical = lstatSync(canonicalPath, { bigint: true });
    if (
      containment === ".." ||
      containment.startsWith(`..${sep}`) ||
      isAbsolute(containment) ||
      String(lexical.dev) !== String(canonical.dev) ||
      String(lexical.ino) !== String(canonical.ino) ||
      (kind === "directory" ? !canonical.isDirectory() : !canonical.isFile())
    ) {
      return undefined;
    }
    return {
      device: String(lexical.dev),
      inode: String(lexical.ino),
      kind,
      lexicalPath
    };
  } catch {
    return undefined;
  }
}

function pathIsStable(
  canonicalRoot: string,
  snapshot: GeneratedPathSnapshot
): boolean {
  const current = pathSnapshot(canonicalRoot, snapshot.lexicalPath, snapshot.kind);
  return current !== undefined &&
    current.device === snapshot.device &&
    current.inode === snapshot.inode;
}

function pathRemainsMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function snapshotsAreStable(
  root: GeneratedConsumerRootSnapshot,
  snapshots: readonly GeneratedPathSnapshot[]
): boolean {
  return consumerRootIsStable(root) &&
    snapshots.every((snapshot) => pathIsStable(root.canonicalRoot, snapshot));
}

function matchesExpectedIdentity(
  actual: GeneratedFilesystemIdentity,
  expected: GeneratedFilesystemIdentity | undefined
): boolean {
  return expected === undefined || (actual.device === expected.device && actual.inode === expected.inode);
}

function observeNestedDirectory(
  packageRoot: string,
  snapshot: GeneratedPathSnapshot,
  manifests: GeneratedOutputManifestObservations | undefined
): boolean {
  const relation = relative(packageRoot, snapshot.lexicalPath);
  return manifests === undefined || snapshot.kind !== "directory" || relation === "" ||
    relation === ".." || relation.startsWith(`..${sep}`) || manifests.observe(snapshot.lexicalPath);
}

export function generatedOutputFilesystemIsSafe(input: {
  readonly consumerRoot: string;
  readonly enforceManifestFences?: boolean;
  readonly expectedPackageRootIdentity?: GeneratedFilesystemIdentity;
  readonly expectedRootIdentity?: GeneratedFilesystemIdentity;
  readonly packageRoot: string;
  readonly target: string;
}): boolean {
  const root = consumerRootSnapshot(input.consumerRoot, input.expectedRootIdentity);
  if (root === undefined) {
    return false;
  }
  const { canonicalRoot } = root;
  const absoluteTarget = join(canonicalRoot, ...input.target.split("/"));
  const absolutePackage = join(canonicalRoot, ...input.packageRoot.split("/"));
  const absoluteDist = join(absolutePackage, "dist");
  const relation = relative(absoluteDist, absoluteTarget);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    return false;
  }
  const manifests = input.enforceManifestFences === true ? new GeneratedOutputManifestObservations(canonicalRoot) : undefined;
  const snapshots: GeneratedPathSnapshot[] = [];
  const stable = (): boolean => snapshotsAreStable(root, snapshots) &&
    (manifests?.stable() ?? true) && snapshotsAreStable(root, snapshots);
  if (absolutePackage === canonicalRoot && !matchesExpectedIdentity(root, input.expectedPackageRootIdentity)) {
    return false;
  }
  let current = canonicalRoot;
  const targetSegments = input.target.split("/").filter((segment) => segment !== ".");
  for (const [index, segment] of targetSegments.entries()) {
    current = join(current, segment);
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return false;
      }
      return stable() &&
        pathRemainsMissing(current) &&
        stable() &&
        pathRemainsMissing(current);
    }
    const snapshot = pathSnapshot(
      canonicalRoot,
      current,
      index === targetSegments.length - 1 ? "file" : "directory"
    );
    if (
      snapshot === undefined ||
      (current === absolutePackage && !matchesExpectedIdentity(snapshot, input.expectedPackageRootIdentity))
    ) {
      return false;
    }
    snapshots.push(snapshot);
    if (!observeNestedDirectory(absolutePackage, snapshot, manifests)) {
      return false;
    }
  }
  return stable();
}
