import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PortablePathIdentity } from "../../../repository-mutation/application/model/path-identity.js";
import { OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER } from "../../../repository-mutation/adapters/node/node-cleanup-owned-temporary.js";
import { isDocumentRepositoryPath } from "../../application/policies/document-repository-path.js";

export interface RecapturedDocumentPublicationPaths {
  readonly ancestryIdentities: readonly PortablePathIdentity[];
  readonly destinationPath: string;
  readonly parent: string;
  readonly parentIdentity: PortablePathIdentity;
  readonly root: string;
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function portableNameIdentity(name: string): string {
  return name.normalize("NFC").replace(/[A-Z]/gu, (character) =>
    character.toLowerCase());
}

async function assertNoPortableAlias(parent: string, segment: string): Promise<void> {
  const identity = portableNameIdentity(segment);
  const entries = await readdir(parent);
  if (entries.some((entry) =>
    entry !== segment && portableNameIdentity(entry) === identity)) {
    throw new Error(`Document publication ancestry has a portable name alias: ${segment}.`);
  }
}

async function assertNoOwnedCleanupResidue(parent: string): Promise<void> {
  const entries = await readdir(parent);
  if (entries.some((entry) =>
    entry.includes(OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER))) {
    throw new Error(
      "A document temporary cleanup residue was preserved for manual recovery."
    );
  }
}

function pathIdentity(metadata: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): PortablePathIdentity {
  const identity = {
    birthtimeNs: metadata.birthtimeNs,
    dev: metadata.dev,
    ino: metadata.ino
  };
  if (identity.dev === 0n || identity.ino === 0n || identity.birthtimeNs === 0n) {
    throw new Error("Document publication ancestry has zero physical identity.");
  }
  return identity;
}

/** Recaptures strict real-directory ancestry; the result is valid only for the immediate operation. */
export async function recaptureDocumentPublicationPaths(request: {
  readonly consumerRoot: string;
  readonly destination: string;
}): Promise<RecapturedDocumentPublicationPaths> {
  if (!isDocumentRepositoryPath(request.destination)) {
    throw new Error("Document publication destination is not a portable repository path.");
  }
  const lexicalRoot = resolve(request.consumerRoot);
  const rootMetadata = await lstat(lexicalRoot, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Document publication root must be a real directory.");
  }
  const root = await realpath(lexicalRoot);

  let parent = root;
  const ancestryIdentities = [pathIdentity(rootMetadata)];
  for (const segment of request.destination.split("/").slice(0, -1)) {
    await assertNoOwnedCleanupResidue(parent);
    await assertNoPortableAlias(parent, segment);
    const candidate = join(parent, segment);
    const metadata = await lstat(candidate, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Document publication ancestry is not a real directory: ${segment}.`);
    }
    const canonical = await realpath(candidate);
    if (resolve(canonical) !== resolve(candidate) || !contained(root, canonical)) {
      throw new Error("Document publication ancestry is redirected or escapes the repository.");
    }
    ancestryIdentities.push(pathIdentity(metadata));
    parent = canonical;
  }
  const parentMetadata = await lstat(parent, { bigint: true });
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("Document publication parent changed during recapture.");
  }
  const basename = request.destination.split("/").at(-1)!;
  await assertNoOwnedCleanupResidue(parent);
  await assertNoPortableAlias(parent, basename);
  return Object.freeze({
    ancestryIdentities: Object.freeze(ancestryIdentities),
    destinationPath: join(parent, basename),
    parent,
    parentIdentity: pathIdentity(parentMetadata),
    root
  });
}

export function sameDocumentPhysicalIdentity(
  left: PortablePathIdentity,
  right: PortablePathIdentity
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs;
}

export function sameDocumentAncestry(
  left: readonly PortablePathIdentity[],
  right: readonly PortablePathIdentity[]
): boolean {
  return left.length === right.length &&
    left.every((identity, index) =>
      sameDocumentPhysicalIdentity(identity, right[index]!));
}
