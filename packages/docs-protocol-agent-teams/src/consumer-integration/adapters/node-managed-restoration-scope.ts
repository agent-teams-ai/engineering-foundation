import type { KnownFileTransactionPlanV1 } from "@agent-teams/repository-mutation";
import type {
  ConsumerIntegrationDesiredStateV3,
  ConsumerUpgradeAuthorityV3,
} from "../domain/model.js";
import {
  assertManagedSuccessorProfileV4,
  requireRestoration,
  restorationJson,
} from "../application-api.js";
import {
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  describeCanonicalConsumerAssets,
  digestBytes,
} from "../application/policies/consumer-integration-assets.js";
import { projectConsumerUpgradeFiles } from "./consumer-upgrade-file-projectors.js";
import { planAgentsRouteV1 } from "./agents-route-adapter-v1.js";
import { planPnpmManifestV2 } from "./pnpm-manifest-adapter-v2.js";
import { assertManagedRestorationLockScope } from "./node-consumer-restoration-lock.js";
import { parseJsonRecord } from "./strict-json-record.js";
import { INTEGRATION_PROFILE_PATH } from "./node-consumer-repository-files.js";

/** Git preimages and deterministic owner projections authenticate the ninth-file transition. */
export async function assertManagedRestorationEffects(input: {
  readonly current: ConsumerIntegrationDesiredStateV3;
  readonly target: ConsumerUpgradeAuthorityV3["cohort"];
  readonly plan: KnownFileTransactionPlanV1;
  readonly originals: ReadonlyMap<string, Buffer>;
}): Promise<void> {
  const { current, target, plan, originals } = input;
  const original = (path: string): Buffer => {
    const bytes = originals.get(path);
    requireRestoration(bytes !== undefined, `original managed file is missing: ${path}.`);
    return bytes;
  };
  const profile = plan.operations.find(({ path }) => path === INTEGRATION_PROFILE_PATH);
  requireRestoration(profile !== undefined, "generation transition lacks profile replacement.");
  const targetRecord = parseJsonRecord(
    Buffer.from(profile.postimage.contentBase64, "base64").toString("utf8"),
  );
  assertManagedSuccessorProfileV4(targetRecord);
  requireRestoration(
    restorationJson(targetRecord.cohort) === restorationJson(target),
    "profile target differs from authority.",
  );
  const workspace = originals.get("pnpm-workspace.yaml");
  const projected = await projectConsumerUpgradeFiles({
    current,
    authority: {
      repository: "agent-teams-ai/.github",
      path: "governance/docs-qualified-cohorts.json",
      revision: "1".repeat(40),
      cohort: {
        ...targetRecord.cohort,
        recordDigest: target.recordDigest,
        qualificationEventDigest: target.qualificationEventDigest,
      },
    },
    manifest: original("package.json"),
    profile: original(INTEGRATION_PROFILE_PATH),
    ...(workspace === undefined ? {} : { workspace }),
  });
  const desired = parseJsonRecord(Buffer.from(projected.profile).toString("utf8"));
  assertManagedSuccessorProfileV4(desired);
  const assets = describeCanonicalConsumerAssets(target);
  requireRestoration(
    restorationJson(assets) === restorationJson(target.assets),
    "target assets differ from controller projections.",
  );
  const routeDigest = digestBytes(Buffer.from(canonicalManagedRoute(current.skillPath)));
  const scriptsDigest = canonicalDocsScriptsDigest(current.profilePath);
  requireRestoration(
    digestBytes(original(current.skillPath)) === current.cohort.assets.skillDigest &&
      digestBytes(original(current.callerWorkflowPath)) ===
        current.cohort.assets.callerWorkflowDigest &&
      original(current.managedStatePath).equals(
        Buffer.from(
          canonicalManagedState(current, {
            ...current.cohort.assets,
            agentsRouteDigest: routeDigest,
            docsScriptsDigest: scriptsDigest,
          }),
        ),
      ) &&
      /^24\.(?:1[89]|[2-9][0-9])\.[0-9]+\n?$/u.test(original(".node-version").toString("utf8")),
    "source managed assets or runtime pin are not exact.",
  );
  const sourceManifest = planPnpmManifestV2({
    observation: { state: "file", bytes: original("package.json"), mode: 0o644 },
    profilePath: current.profilePath,
    cohort: current.cohort,
  });
  const sourceRoute = planAgentsRouteV1({
    observation: { state: "file", bytes: original("AGENTS.md"), mode: 0o644 },
    skillPath: current.skillPath,
  });
  requireRestoration(
    sourceManifest.issues.length === 0 &&
      sourceManifest.postimage === undefined &&
      sourceRoute.issues.length === 0 &&
      sourceRoute.postimage === undefined,
    "source managed manifest or route is not current.",
  );
  const route = planAgentsRouteV1({
    observation: { state: "file", bytes: original("AGENTS.md"), mode: 0o644 },
    skillPath: current.skillPath,
  });
  const manifest = planPnpmManifestV2({
    observation: { state: "file", bytes: projected.manifest, mode: 0o644 },
    profilePath: current.profilePath,
    cohort: target,
  });
  requireRestoration(
    route.issues.length === 0 && manifest.issues.length === 0,
    "managed field projection conflicts.",
  );
  const expected = new Map<string, Uint8Array>([
    [INTEGRATION_PROFILE_PATH, projected.profile],
    ["package.json", manifest.postimage ?? projected.manifest],
    ["AGENTS.md", route.postimage ?? original("AGENTS.md")],
    [current.skillPath, Buffer.from(CANONICAL_DOCS_SKILL_V2)],
    [current.callerWorkflowPath, Buffer.from(canonicalCallerWorkflow(target))],
    [".node-version", projected.nodeVersion!],
    [
      current.managedStatePath,
      Buffer.from(
        canonicalManagedState(desired, {
          ...assets,
          agentsRouteDigest: routeDigest,
          docsScriptsDigest: scriptsDigest,
        }),
      ),
    ],
  ]);
  if (projected.targetWorkspace !== undefined) {
    expected.set("pnpm-workspace.yaml", projected.targetWorkspace);
  }
  const lock = plan.operations.find(({ path }) => path === "pnpm-lock.yaml");
  requireRestoration(lock !== undefined, "migration lacks lock replacement.");
  const targetLock = Buffer.from(lock.postimage.contentBase64, "base64");
  assertManagedRestorationLockScope(original("pnpm-lock.yaml"), targetLock, current, desired);
  expected.set("pnpm-lock.yaml", targetLock);
  const changed = [...expected]
    .filter(([path, bytes]) => !original(path).equals(Buffer.from(bytes)))
    .map(([path]) => path)
    .toSorted();
  requireRestoration(
    restorationJson(changed) ===
      restorationJson(plan.operations.map(({ path }) => path).toSorted()),
    "plan differs from deterministic managed write inventory.",
  );
  for (const operation of plan.operations) {
    requireRestoration(
      operation.precondition.state === "known-file" &&
        operation.precondition.acceptedPreimages[0]!.mode === operation.postimage.mode &&
        Buffer.from(operation.postimage.contentBase64, "base64").equals(
          Buffer.from(expected.get(operation.path)!),
        ),
      `plan exceeds managed ownership at ${operation.path}.`,
    );
  }
}
