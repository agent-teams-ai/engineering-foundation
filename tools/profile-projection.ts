import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertOwnedProfileRoot } from "./profile-root.mts";
import { copySourceTree, sourceTreeDigest } from "./profile-source.ts";
import {
  assertBunRootProjection,
  readRepositoryRuntimePolicy,
  projectNodeAgentWorkflowPolicy,
  projectNodeDependencyDeclarationsPolicy,
} from "./runtime-policy.mts";

export interface ProfileEvidence {
  readonly profile: "bun" | "node";
  readonly sourceSha: string;
  readonly sourceDigest: string;
  readonly originalManifestSha256: string;
  readonly derivedManifestSha256: string;
  readonly originalWorkflowPolicySha256: string;
  readonly derivedWorkflowPolicySha256: string;
  readonly originalDependencyDeclarationsPolicySha256: string;
  readonly derivedDependencyDeclarationsPolicySha256: string;
}

export async function prepareProfileProjection(input: {
  readonly profile: ProfileEvidence["profile"];
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly sourceSha: string;
}): Promise<ProfileEvidence> {
  if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) {
    throw new Error("Source identity must be a full lowercase Git SHA.");
  }
  await mkdir(resolve(input.sourceRoot, ".worker-tmp/profiles"), { recursive: true });
  const target = await assertOwnedProfileRoot(input.targetRoot, input.sourceRoot);
  const sourceDigest = await sourceTreeDigest(input.sourceRoot);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copySourceTree(input.sourceRoot, target);
  if ((await sourceTreeDigest(target)) !== sourceDigest) {
    throw new Error("Copied profile source digest differs from its source tree.");
  }
  await assertBunRootProjection(target);
  const policy = await readRepositoryRuntimePolicy(target);
  const originalManifest = await readFile(resolve(target, "package.json"), "utf8");
  const originalDigest = createHash("sha256").update(originalManifest).digest("hex");
  const derivedManifest =
    input.profile === "node"
      ? projectPackageManager(originalManifest, `pnpm@${policy.toolchain.pnpm.version}`)
      : originalManifest;
  if (input.profile === "node") {
    await writeFile(resolve(target, "package.json"), derivedManifest, "utf8");
  }
  const derivedDigest = createHash("sha256").update(derivedManifest).digest("hex");
  const workflowPath = resolve(target, "architecture/foundation/repository-agent-workflow.yaml");
  const originalWorkflow = await readFile(workflowPath, "utf8");
  const derivedWorkflow =
    input.profile === "node" ? projectNodeAgentWorkflowPolicy(originalWorkflow) : originalWorkflow;
  if (input.profile === "node") {
    await writeFile(workflowPath, derivedWorkflow, "utf8");
  }
  const dependencyPath = resolve(target, "architecture/foundation/dependency-declarations.yaml");
  const originalDependencies = await readFile(dependencyPath, "utf8");
  const derivedDependencies =
    input.profile === "node"
      ? projectNodeDependencyDeclarationsPolicy(originalDependencies)
      : originalDependencies;
  if (input.profile === "node") {
    await writeFile(dependencyPath, derivedDependencies, "utf8");
  }
  const evidence: ProfileEvidence = {
    profile: input.profile,
    sourceSha: input.sourceSha,
    sourceDigest,
    originalManifestSha256: originalDigest,
    derivedManifestSha256: derivedDigest,
    originalWorkflowPolicySha256: createHash("sha256").update(originalWorkflow).digest("hex"),
    derivedWorkflowPolicySha256: createHash("sha256").update(derivedWorkflow).digest("hex"),
    originalDependencyDeclarationsPolicySha256: createHash("sha256")
      .update(originalDependencies)
      .digest("hex"),
    derivedDependencyDeclarationsPolicySha256: createHash("sha256")
      .update(derivedDependencies)
      .digest("hex"),
  };
  await writeProfileEvidence(target, evidence);
  return evidence;
}

export function projectPackageManager(manifestSource: string, packageManager: string): string {
  const before: unknown = JSON.parse(manifestSource);
  const projected = manifestSource.replace(
    /("packageManager"\s*:\s*")[^"]+(")/u,
    `$1${packageManager}$2`,
  );
  if (projected === manifestSource) {
    throw new Error("The root packageManager field is missing or duplicated.");
  }
  const after: unknown = JSON.parse(projected);
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null ||
    !("packageManager" in after)
  ) {
    throw new Error("The Node profile projection may change only packageManager.");
  }
  const beforeWithoutManager = { ...before };
  const afterWithoutManager = { ...after };
  if ("packageManager" in beforeWithoutManager) {
    delete beforeWithoutManager.packageManager;
  }
  if ("packageManager" in afterWithoutManager) {
    delete afterWithoutManager.packageManager;
  }
  if (
    JSON.stringify(beforeWithoutManager) !== JSON.stringify(afterWithoutManager) ||
    after.packageManager !== packageManager
  ) {
    throw new Error("The Node profile projection may change only packageManager.");
  }
  return projected;
}

export async function writeProfileEvidence(root: string, evidence: ProfileEvidence): Promise<void> {
  await writeFile(
    resolve(root, ".agent-teams-runtime-profile.json"),
    `${JSON.stringify(
      {
        ...evidence,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
