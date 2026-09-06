import type { KnownFileTransactionPlanV1 } from "@agent-teams/repository-mutation";
import type { ConsumerIntegrationDesiredStateV1, ConsumerIntegrationDesiredStateV3, QualifiedDocsCohortBindingV2 } from "../domain/model.js";
import { requireRestoration, restorationJson } from "../application-api.js";
import {
  CANONICAL_DOCS_SKILL_V2, canonicalCallerWorkflow, canonicalDocsScriptsDigest,
  canonicalManagedRoute, canonicalManagedState, describeCanonicalConsumerAssets, digestBytes
} from "../application/policies/consumer-integration-assets.js";
import { projectConsumerUpgradeFiles } from "./consumer-upgrade-file-projectors.js";
import { planAgentsRouteV1 } from "./agents-route-adapter-v1.js";
import { planPnpmManifestV2 } from "./pnpm-manifest-adapter-v2.js";
import { assertRestorationLockScope } from "./node-consumer-restoration-lock.js";
import { parseJsonRecord } from "./strict-json-record.js";
import { INTEGRATION_PROFILE_PATH } from "./node-consumer-repository-files.js";

// Git bytes and deterministic managed projections own scope, never a caller's Plan or receipt.
export async function assertRestorationManagedEffects(input: {
  readonly current: ConsumerIntegrationDesiredStateV1;
  readonly target: QualifiedDocsCohortBindingV2;
  readonly plan: KnownFileTransactionPlanV1;
  readonly originals: ReadonlyMap<string, Buffer>;
}): Promise<void> {
  const { current, target, plan, originals } = input;
  const original = (path: string): Buffer => {
    const bytes = originals.get(path);
    requireRestoration(bytes !== undefined, `original managed file is missing: ${path}.`);
    return bytes;
  };
  // Canonical evidence sorts object keys; JSON profile rendering retains the forward key order.
  // Accept that order only after proving the entire candidate Cohort equals independent authority.
  const profileOperation = plan.operations.find(({ path }) => path === INTEGRATION_PROFILE_PATH);
  requireRestoration(profileOperation !== undefined, "migration lacks its profile replacement.");
  const profileTarget = parseJsonRecord(Buffer.from(profileOperation.postimage.contentBase64, "base64").toString("utf8"))["cohort"];
  requireRestoration(restorationJson(profileTarget) === restorationJson(target), "profile target differs from selected authority.");
  const workspace = originals.get("pnpm-workspace.yaml");
  const projected = await projectConsumerUpgradeFiles({
    current, authority: { repository: "agent-teams-ai/.github", path: "governance/docs-qualified-cohorts.json", revision: "1".repeat(40), cohort: profileTarget as QualifiedDocsCohortBindingV2 },
    manifest: original("package.json"), profile: original(INTEGRATION_PROFILE_PATH),
    ...(workspace === undefined ? {} : { workspace })
  });
  const desired = parseJsonRecord(Buffer.from(projected.profile).toString("utf8")) as unknown as ConsumerIntegrationDesiredStateV3;
  const assets = describeCanonicalConsumerAssets(target);
  requireRestoration(restorationJson(assets) === restorationJson(target.assets), "target assets differ from retained controller projections.");
  const routeDigest = digestBytes(Buffer.from(canonicalManagedRoute(current.skillPath)));
  const scriptsDigest = canonicalDocsScriptsDigest(current.profilePath);
  const sourceState = canonicalManagedState(current, {
    ...current.cohort.assets, agentsRouteDigest: routeDigest, docsScriptsDigest: scriptsDigest
  });
  requireRestoration(digestBytes(original(current.skillPath)) === current.cohort.assets.skillDigest &&
    digestBytes(original(current.callerWorkflowPath)) === current.cohort.assets.callerWorkflowDigest &&
    original(current.managedStatePath).equals(Buffer.from(sourceState)), "source whole-file managed assets are not exact.");
  const route = planAgentsRouteV1({ observation: { state: "file", bytes: original("AGENTS.md"), mode: 0o644 }, skillPath: current.skillPath });
  const manifest = planPnpmManifestV2({ observation: { state: "file", bytes: projected.manifest, mode: 0o644 }, profilePath: current.profilePath, cohort: target });
  requireRestoration(route.issues.length === 0 && manifest.issues.length === 0, "managed field projection is conflicted.");
  const expected = new Map<string, Uint8Array>([
    [INTEGRATION_PROFILE_PATH, projected.profile], ["package.json", manifest.postimage ?? projected.manifest],
    ["AGENTS.md", route.postimage ?? original("AGENTS.md")],
    [current.skillPath, Buffer.from(CANONICAL_DOCS_SKILL_V2)],
    [current.callerWorkflowPath, Buffer.from(canonicalCallerWorkflow(target))],
    [current.managedStatePath, Buffer.from(canonicalManagedState(desired, {
      ...assets, agentsRouteDigest: routeDigest, docsScriptsDigest: scriptsDigest
    }))]
  ]);
  if (projected.targetWorkspace !== undefined) {expected.set("pnpm-workspace.yaml", projected.targetWorkspace);}
  const lock = plan.operations.find(({ path }) => path === "pnpm-lock.yaml");
  requireRestoration(lock !== undefined, "migration lacks its lock replacement.");
  const targetLock = Buffer.from(lock.postimage.contentBase64, "base64");
  assertRestorationLockScope(original("pnpm-lock.yaml"), targetLock, current, desired);
  expected.set("pnpm-lock.yaml", targetLock);
  const paths = [...expected].filter(([path, bytes]) => !original(path).equals(Buffer.from(bytes))).map(([path]) => path).toSorted();
  requireRestoration(restorationJson(paths) === restorationJson(plan.operations.map(({ path }) => path).toSorted()),
    "Plan paths differ from the exact deterministic managed effects.");
  for (const operation of plan.operations) {
    requireRestoration(operation.precondition.state === "known-file" &&
      operation.precondition.acceptedPreimages[0]!.mode === operation.postimage.mode &&
      Buffer.from(operation.postimage.contentBase64, "base64").equals(Buffer.from(expected.get(operation.path)!)),
    `Plan exceeds managed field/block ownership at ${operation.path}.`);
  }
  const oldPin = parseJsonRecord(original("package.json").toString("utf8"))["packageManager"];
  const newPin = parseJsonRecord(Buffer.from(expected.get("package.json")!).toString("utf8"))["packageManager"];
  requireRestoration(typeof oldPin === "string" && oldPin === newPin, "migration must preserve the real packageManager pin.");
}
