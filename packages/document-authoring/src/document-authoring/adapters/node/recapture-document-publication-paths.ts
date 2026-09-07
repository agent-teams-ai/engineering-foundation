import { readdir } from "node:fs/promises";

import { OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER } from "@agent-teams/repository-mutation/node";
import type { PortablePathIdentity } from "@agent-teams/repository-mutation/paths";
import {
  captureNodeRepositoryPathAuthority,
  recaptureNodeRepositoryPathAuthority,
  sameNodePathIdentity
} from "./node-path-authority.js";

export interface RecapturedDocumentPublicationPaths {
  readonly ancestryIdentities: readonly PortablePathIdentity[];
  readonly destinationPath: string;
  readonly parent: string;
  readonly parentIdentity: PortablePathIdentity;
  readonly root: string;
}

async function assertNoOwnedCleanupResidue(
  directories: readonly string[]
): Promise<void> {
  for (const directory of directories) {
    const entries = await readdir(directory);
    if (entries.some((entry) =>
      entry.includes(OWNED_TEMPORARY_CLEANUP_RESIDUE_MARKER))) {
      throw new Error(
        "A document temporary cleanup residue was preserved for manual recovery."
      );
    }
  }
}

/** Recaptures strict real-directory ancestry; the result is valid only for the immediate operation. */
export async function recaptureDocumentPublicationPaths(request: {
  readonly consumerRoot: string;
  readonly destination: string;
}): Promise<RecapturedDocumentPublicationPaths> {
  const authority = await captureNodeRepositoryPathAuthority({
    consumerRoot: request.consumerRoot,
    repositoryPath: request.destination
  });
  await assertNoOwnedCleanupResidue(
    authority.ancestry.map((entry) => entry.absolutePath)
  );
  const recaptured = await recaptureNodeRepositoryPathAuthority(authority);
  return Object.freeze({
    ancestryIdentities: Object.freeze(
      recaptured.ancestry.map((entry) => entry.identity)
    ),
    destinationPath: recaptured.destinationPath,
    parent: recaptured.parent,
    parentIdentity: recaptured.parentIdentity,
    root: recaptured.root.canonicalRoot
  });
}

export const sameDocumentPhysicalIdentity = sameNodePathIdentity;

export function sameDocumentAncestry(
  left: readonly PortablePathIdentity[],
  right: readonly PortablePathIdentity[]
): boolean {
  return left.length === right.length &&
    left.every((identity, index) =>
      sameNodePathIdentity(identity, right[index]!));
}
