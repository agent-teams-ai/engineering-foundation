import { compareBinaryStrings } from "../../binary-string-comparator.js";
import type {
  DocumentCatalogCollection
} from "../model/document-planning.js";
import type {
  DocumentIdentityProjectionEntry,
  DocumentationCatalogSnapshot
} from "../model/document-catalog.js";
import { DocumentPlanningPolicyError } from "./document-planning-policy-error.js";

function isPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isDestinationCoveredByCatalog(
  destination: string,
  collections: readonly DocumentCatalogCollection[],
  excludedPrefixes: readonly string[]
): boolean {
  if (excludedPrefixes.some((prefix) => isPrefix(prefix, destination))) {
    return false;
  }
  return collections.some((collection) =>
    collection.kind === "markdown-tree"
      ? isPrefix(collection.root, destination)
      : destination.endsWith("/README.md") &&
        collection.roots.some((root) => isPrefix(root, destination))
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function portablePath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function sortedProjection(
  entries: readonly DocumentIdentityProjectionEntry[]
): readonly DocumentIdentityProjectionEntry[] {
  return Object.freeze(entries
    .map((entry) => Object.freeze({ id: entry.id, repositoryPath: entry.repositoryPath }))
    .toSorted((left, right) =>
      compareBinaryStrings(left.id, right.id) ||
      compareBinaryStrings(left.repositoryPath, right.repositoryPath)
    ));
}

export function classifyDocumentLogicalPreimage(input: {
  readonly catalog: DocumentationCatalogSnapshot;
  readonly destination: string;
  readonly expectedBytes: Uint8Array;
  readonly id: string;
  readonly observedBytes?: Uint8Array;
}): {
  readonly identityProjection: readonly DocumentIdentityProjectionEntry[];
  readonly isExactSelf: boolean;
} {
  if (input.catalog.status !== "complete") {
    throw new DocumentPlanningPolicyError("catalog-incomplete", "Document planning requires a complete catalog.");
  }
  const entries = input.catalog.identityProjection;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of entries) {
    const path = portablePath(entry.repositoryPath);
    if (ids.has(entry.id) || paths.has(path)) {
      throw new DocumentPlanningPolicyError("catalog-collision", "Document catalog contains an identity or portable path collision.");
    }
    ids.add(entry.id);
    paths.add(path);
  }

  const exactDescriptor = input.catalog.documents.filter(
    (document) => document.id === input.id && document.repositoryPath === input.destination
  );
  const exactEntry = entries.filter(
    (entry) => entry.id === input.id && entry.repositoryPath === input.destination
  );
  const isExactSelf = input.observedBytes !== undefined &&
    sameBytes(input.observedBytes, input.expectedBytes) &&
    exactDescriptor.length === 1 &&
    exactEntry.length === 1;

  const idCollision = entries.some(
    (entry) => entry.id === input.id && !(isExactSelf && entry.repositoryPath === input.destination)
  );
  const pathCollision = entries.some(
    (entry) => portablePath(entry.repositoryPath) === portablePath(input.destination) &&
      !(isExactSelf && entry.repositoryPath === input.destination && entry.id === input.id)
  );
  if (idCollision || pathCollision || (input.observedBytes !== undefined && !isExactSelf)) {
    throw new DocumentPlanningPolicyError("destination-conflict", "Document identity or destination conflicts with the logical preimage.");
  }

  return Object.freeze({
    identityProjection: sortedProjection(
      isExactSelf
        ? entries.filter((entry) => !(entry.id === input.id && entry.repositoryPath === input.destination))
        : entries
    ),
    isExactSelf
  });
}
