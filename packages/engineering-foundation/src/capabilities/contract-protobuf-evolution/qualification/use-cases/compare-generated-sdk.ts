import { compareBinaryStrings } from "../../../../binary-string-comparator.js";
import type {
  GenerationDriftEvidence,
  Sha256Digest,
} from "../../application/model/protobuf-release-evidence.js";
import type { Sha256DigestPort } from "../../application/ports/sha256-digest.js";

export interface GeneratedSdkLeaf {
  readonly path: string;
  readonly contentDigest: Sha256Digest;
}

export interface GeneratedSdkSnapshot {
  readonly files: readonly GeneratedSdkLeaf[];
  readonly digest: Sha256Digest;
}

export interface GeneratedSdkDrift {
  readonly generationDrift: GenerationDriftEvidence;
  readonly missingPaths: readonly string[];
  readonly unexpectedPaths: readonly string[];
  readonly changedPaths: readonly string[];
}

export function generatedSdkSnapshot(
  files: readonly GeneratedSdkLeaf[],
  digest: Sha256DigestPort,
): GeneratedSdkSnapshot {
  const sorted = files
    .map((file) => Object.freeze({ path: file.path, contentDigest: file.contentDigest }))
    .toSorted((left, right) => compareBinaryStrings(left.path, right.path));
  return Object.freeze({
    files: Object.freeze(sorted),
    digest: digest.digest(JSON.stringify(sorted)),
  });
}

/** Compares independently captured complete generated-only file inventories. */
export function compareGeneratedSdkSnapshots(
  expected: GeneratedSdkSnapshot,
  observed: GeneratedSdkSnapshot,
): GeneratedSdkDrift {
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file.contentDigest]));
  const observedByPath = new Map(observed.files.map((file) => [file.path, file.contentDigest]));
  const missingPaths: string[] = [];
  const changedPaths: string[] = [];
  for (const file of expected.files) {
    const actual = observedByPath.get(file.path);
    if (actual === undefined) {
      missingPaths.push(file.path);
    } else if (actual !== file.contentDigest) {
      changedPaths.push(file.path);
    }
  }
  const unexpectedPaths = observed.files
    .filter((file) => !expectedByPath.has(file.path))
    .map((file) => file.path);
  return Object.freeze({
    generationDrift: Object.freeze({
      expectedGeneratedOutputDigest: expected.digest,
      observedGeneratedOutputDigest: observed.digest,
    }),
    missingPaths: Object.freeze(missingPaths),
    unexpectedPaths: Object.freeze(unexpectedPaths),
    changedPaths: Object.freeze(changedPaths),
  });
}
