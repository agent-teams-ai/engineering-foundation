import assert from "node:assert/strict";
import { join } from "node:path";
import { writeJson } from "./pack-test-support.mjs";
export function canonicalArtifact<
  T extends { entrypoints: { items: { canonicalReference: string }[] }[] },
>(value: T): T {
  const artifact = structuredClone(value);
  for (const entry of artifact.entrypoints) {
    entry.items = entry.items.toSorted((left, right) =>
      left.canonicalReference < right.canonicalReference
        ? -1
        : left.canonicalReference > right.canonicalReference
          ? 1
          : 0,
    );
  }
  return artifact;
}

export async function writeReleasedSdkEvidence<
  T extends { entrypoints: { items: { canonicalReference: string }[] }[] },
>(
  candidate: string,
  snapshots: {
    typed: { snapshot: { status: string; value: unknown } };
    artifact: { snapshot: { status: string; value: T } };
  },
): Promise<T> {
  assert.equal(snapshots.typed.snapshot.status, "available");
  assert.equal(snapshots.artifact.snapshot.status, "available");
  // Persist the original v1 facts in the baseline reader's canonical item order.
  const releasedArtifact = structuredClone(snapshots.artifact.snapshot.value);
  for (const entry of releasedArtifact.entrypoints) {
    entry.items = entry.items.toSorted((left, right) =>
      left.canonicalReference < right.canonicalReference
        ? -1
        : left.canonicalReference > right.canonicalReference
          ? 1
          : 0,
    );
  }
  await writeJson(join(candidate, "evidence/released.json"), {
    typed: snapshots.typed.snapshot.value,
    artifact: releasedArtifact,
  });
  return releasedArtifact;
}
