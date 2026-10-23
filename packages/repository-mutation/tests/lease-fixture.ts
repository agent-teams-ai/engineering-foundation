import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileKnownFileTransactionPlan,
  installedRepositoryMutationVersion,
  installedRepositoryMutationBuildIdentity,
  REPOSITORY_MUTATION_PACKAGE_NAME,
} from "../dist/index.js";
import { claimMutation, observeMutationState } from "../dist/node.js";
export async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "repository-mutation-lease-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

export function plan() {
  return compileKnownFileTransactionPlan({
    operations: [
      {
        path: "owned.txt",
        precondition: { state: "absent" },
        postimage: { bytes: Buffer.from("owned\n", "utf8") },
      },
    ],
  });
}

export async function artifact() {
  return {
    name: REPOSITORY_MUTATION_PACKAGE_NAME,
    version: await installedRepositoryMutationVersion(),
    buildIdentity: await installedRepositoryMutationBuildIdentity(),
  };
}

export async function validClaim(
  lease: Parameters<typeof claimMutation>[0],
  selectedPlan: ReturnType<typeof compileKnownFileTransactionPlan>,
) {
  const identity = await artifact();
  return claimMutation(lease, await observeMutationState(lease), {
    kind: "apply-known-file",
    planDigest: selectedPlan.planDigest,
    ownerArtifact: identity,
    kernelArtifact: identity,
  });
}
