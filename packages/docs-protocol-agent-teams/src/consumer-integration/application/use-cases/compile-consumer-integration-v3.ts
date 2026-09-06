import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation/known-file";

import type { ConsumerIntegrationPlanningPorts } from "../ports/consumer-integration-planners.js";
import type {
  ConsumerIntegrationAssetPlan,
  ConsumerIntegrationDesiredStateV3,
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationIssue,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";
import {
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalConsumerIntegrationJson,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  describeCanonicalConsumerAssets,
  digestBytes
} from "../policies/consumer-integration-assets.js";
import { consumerIntegrationAuthorityGuards } from
  "../policies/consumer-integration-authority-guards.js";
import { assertConsumerIntegrationDesiredStateV3 } from
  "../policies/consumer-integration-desired-state.js";

export interface FullAssetResult {
  readonly plan: ConsumerIntegrationAssetPlan;
  readonly operation?: KnownFileTransactionOperationInput;
  readonly issue?: ConsumerIntegrationIssue;
}

export function issue(code: string, subject: string, message: string): ConsumerIntegrationIssue {
  return { code, severity: "error", subject, message };
}

function assertFileObservation(
  observation: object, key: string
): asserts observation is Extract<ConsumerIntegrationFileObservation, { state: "file" }> {
  if (!("state" in observation) || observation.state !== "file" || !("bytes" in observation) ||
    !(observation.bytes instanceof Uint8Array) || !("mode" in observation) ||
    typeof observation.mode !== "number" || !Number.isInteger(observation.mode) ||
    observation.mode < 0 || observation.mode > 0o777 ||
    Object.keys(observation).toSorted().join("\u0000") !== "bytes\u0000mode\u0000state") {
    throw new TypeError(`File snapshot observation is invalid: ${key}.`);
  }
}

export function assertSnapshotRuntime(snapshot: unknown): asserts snapshot is ConsumerIntegrationSnapshot {
  const expected = [
    "agents", "callerWorkflow", "integrationProfile", "lockfile",
    "managedState", "packageManifest", "skill"
  ];
  if (typeof snapshot !== "object" || snapshot === null || Object.getPrototypeOf(snapshot) !== Object.prototype ||
    Object.keys(snapshot).toSorted().join("\u0000") !== expected.join("\u0000")) {
    throw new TypeError("Consumer snapshot must contain only the seven V1 observations.");
  }
  let totalBytes = 0;
  for (const key of expected) {
    const observation: unknown = (snapshot as Record<string, unknown>)[key];
    if (typeof observation !== "object" || observation === null || !("state" in observation) ||
      Object.getPrototypeOf(observation) !== Object.prototype) {
      throw new TypeError(`Consumer snapshot observation is invalid: ${key}.`);
    }
    if (observation.state === "absent") {
      if (Object.keys(observation).length !== 1) {
        throw new TypeError(`Absent snapshot observation has extra fields: ${key}.`);
      }
      continue;
    }
    assertFileObservation(observation, key);
    totalBytes += observation.bytes.byteLength;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new TypeError("Consumer snapshot exceeds the bounded 64 MiB runtime contract.");
    }
  }
}

export function fullAsset(input: {
  readonly id: ConsumerIntegrationAssetPlan["id"];
  readonly path: string;
  readonly observation: ConsumerIntegrationFileObservation;
  readonly postimage: Uint8Array;
  readonly knownPrior: readonly Uint8Array[];
  readonly ownership?: ConsumerIntegrationAssetPlan["ownership"];
}): FullAssetResult {
  const expectedDigest = digestBytes(input.postimage);
  if (input.observation.state === "absent") {
    return {
      plan: {
        id: input.id,
        path: input.path,
        ownership: input.ownership ?? "full-bytes",
        state: "absent",
        expectedDigest,
        action: "create"
      },
      operation: {
        path: input.path,
        precondition: { state: "absent" },
        postimage: { bytes: input.postimage }
      }
    };
  }
  const currentBytes = input.observation.bytes;
  const currentMode = input.observation.mode;
  const currentDigest = digestBytes(currentBytes);
  if (currentDigest === expectedDigest &&
    Buffer.from(input.observation.bytes).equals(Buffer.from(input.postimage))) {
    return {
      plan: {
        id: input.id,
        path: input.path,
        ownership: input.ownership ?? "full-bytes",
        state: "exact-current",
        currentDigest,
        expectedDigest,
        action: "none"
      }
    };
  }
  const known = input.knownPrior.some((candidate) =>
    Buffer.from(candidate).equals(Buffer.from(currentBytes))
  );
  if (!known) {
    return {
      plan: {
        id: input.id,
        path: input.path,
        ownership: input.ownership ?? "full-bytes",
        state: "unknown-modified",
        currentDigest,
        expectedDigest,
        action: "blocked"
      },
      issue: issue(
        "DOCS_CONSUMER_UNKNOWN_MANAGED_ASSET",
        input.path,
        "Managed bytes are not exact-current or a known prior revision and were not overwritten."
      )
    };
  }
  return {
    plan: {
      id: input.id,
      path: input.path,
      ownership: input.ownership ?? "full-bytes",
      state: "known-prior",
      currentDigest,
      expectedDigest,
      action: "replace"
    },
    operation: {
      path: input.path,
      precondition: {
        state: "known-file",
        acceptedPreimages: [{ bytes: currentBytes, mode: currentMode }]
      },
      postimage: { bytes: input.postimage, mode: currentMode }
    }
  };
}

export function partialAsset(input: {
  readonly id: "agents-route" | "package-manifest";
  readonly path: string;
  readonly ownership: "managed-block" | "partial-fields";
  readonly state: "absent" | "conflict" | "exact-current" | "known-prior";
  readonly currentDigest: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly current: ConsumerIntegrationFileObservation;
  readonly postimage?: Uint8Array;
}): { readonly plan: ConsumerIntegrationAssetPlan; readonly operation?: KnownFileTransactionOperationInput } {
  const action = input.state === "conflict" ? "blocked" : input.state === "absent" ? "create" :
    input.state === "exact-current" ? "none" : "replace";
  const plan: ConsumerIntegrationAssetPlan = {
    id: input.id,
    path: input.path,
    ownership: input.ownership,
    state: input.state,
    currentDigest: input.currentDigest,
    expectedDigest: input.expectedDigest,
    action
  };
  if ((action !== "replace" && action !== "create") || input.postimage === undefined) {
    return { plan };
  }
  if (action === "create") {
    return {
      plan,
      operation: {
        path: input.path,
        precondition: { state: "absent" },
        postimage: { bytes: input.postimage }
      }
    };
  }
  if (input.current.state !== "file") {return { plan };}
  return {
    plan,
    operation: {
      path: input.path,
      precondition: {
        state: "known-file",
        acceptedPreimages: [{ bytes: input.current.bytes, mode: input.current.mode }]
      },
      postimage: { bytes: input.postimage, mode: input.current.mode }
    }
  };
}

function cohortIssuesV3(
  desired: ConsumerIntegrationDesiredStateV3
): readonly ConsumerIntegrationIssue[] {
  const canonical = describeCanonicalConsumerAssets(desired.cohort);
  if (canonical.skillDigest === desired.cohort.assets.skillDigest &&
    canonical.callerWorkflowDigest === desired.cohort.assets.callerWorkflowDigest &&
    canonical.assetCatalogDigest === desired.cohort.assets.assetCatalogDigest &&
    canonical.transitionCatalogDigest === desired.cohort.assets.transitionCatalogDigest) {
    return [];
  }
  return [issue(
    "DOCS_CONSUMER_COHORT_ASSET_MISMATCH",
    desired.cohort.cohortId,
    "Qualified Cohort v2 asset digests do not match this exact package build."
  )];
}

function planFullAssetsV3(input: {
  readonly desired: ConsumerIntegrationDesiredStateV3;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): readonly FullAssetResult[] {
  const skillBytes = Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8");
  const callerBytes = Buffer.from(canonicalCallerWorkflow(input.desired.cohort), "utf8");
  const routeBytes = Buffer.from(canonicalManagedRoute(input.desired.skillPath), "utf8");
  const managedStateBytes = Buffer.from(canonicalManagedState(input.desired, {
    skillDigest: digestBytes(skillBytes),
    callerWorkflowDigest: digestBytes(callerBytes),
    assetCatalogDigest: input.desired.cohort.assets.assetCatalogDigest,
    transitionCatalogDigest: input.desired.cohort.assets.transitionCatalogDigest,
    agentsRouteDigest: digestBytes(routeBytes),
    docsScriptsDigest: canonicalDocsScriptsDigest(input.desired.profilePath)
  }), "utf8");
  return [
    fullAsset({
      id: "skill",
      path: input.desired.skillPath,
      observation: input.snapshot.skill,
      postimage: skillBytes,
      knownPrior: []
    }),
    fullAsset({
      id: "caller-workflow",
      path: input.desired.callerWorkflowPath,
      observation: input.snapshot.callerWorkflow,
      postimage: callerBytes,
      knownPrior: []
    }),
    fullAsset({
      id: "managed-state",
      path: input.desired.managedStatePath,
      observation: input.snapshot.managedState,
      postimage: managedStateBytes,
      knownPrior: []
    })
  ];
}

export function compileConsumerIntegrationV3(input: {
  readonly desired: ConsumerIntegrationDesiredStateV3;
  readonly snapshot: ConsumerIntegrationSnapshot;
}, ports: ConsumerIntegrationPlanningPorts): {
  readonly plan: ConsumerIntegrationPlanV1;
  readonly mutationPlan?: ReturnType<typeof compileKnownFileTransactionPlan>;
} {
  assertConsumerIntegrationDesiredStateV3(input.desired);
  assertSnapshotRuntime(input.snapshot);
  const desired = input.desired;
  const issues: ConsumerIntegrationIssue[] = [...cohortIssuesV3(desired)];
  const manifest = ports.packageManifest.plan({
    observation: input.snapshot.packageManifest,
    profilePath: desired.profilePath,
    cohort: desired.cohort
  });
  issues.push(...manifest.issues);
  const route = ports.agentsRoute.plan({
    observation: input.snapshot.agents,
    skillPath: desired.skillPath
  });
  issues.push(...route.issues);
  const results = planFullAssetsV3({ desired, snapshot: input.snapshot });
  for (const result of results) {
    if (result.issue !== undefined) {issues.push(result.issue);}
  }
  const manifestAsset = partialAsset({
    id: "package-manifest",
    path: "package.json",
    ownership: "partial-fields",
    state: manifest.state,
    currentDigest: manifest.currentDigest,
    expectedDigest: manifest.expectedDigest,
    current: input.snapshot.packageManifest,
    ...(manifest.postimage === undefined ? {} : { postimage: manifest.postimage })
  });
  const routeAsset = partialAsset({
    id: "agents-route",
    path: "AGENTS.md",
    ownership: "managed-block",
    state: route.state,
    currentDigest: route.currentDigest,
    expectedDigest: route.expectedDigest,
    current: input.snapshot.agents,
    ...(route.postimage === undefined ? {} : { postimage: route.postimage })
  });
  const assets = Object.freeze([
    manifestAsset.plan,
    routeAsset.plan,
    ...results.map(({ plan }) => plan)
  ].toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const operations = [
    manifestAsset.operation,
    routeAsset.operation,
    ...results.map(({ operation }) => operation)
  ].filter((operation): operation is KnownFileTransactionOperationInput => operation !== undefined);
  const blocked = issues.some(({ severity }) => severity === "error");
  const outcome = blocked ? "blocked" : operations.length === 0 ? "current" : "change-required";
  const guardOperations = consumerIntegrationAuthorityGuards(input.snapshot, operations.length > 0);
  const mutationPlan = blocked
    ? undefined
    : compileKnownFileTransactionPlan({ operations: [...operations, ...guardOperations] });
  const planDigest = digestBytes(Buffer.from(canonicalConsumerIntegrationJson({
    domain: "agent-teams.docs-protocol.consumer-integration-plan/v1",
    desired,
    assets: assets.map(({ id, path, ownership, state, currentDigest, expectedDigest, action }) => ({
      id,
      path,
      ownership,
      state,
      currentDigest: currentDigest ?? null,
      expectedDigest,
      action
    })),
    issues,
    mutationPlanDigest: mutationPlan?.planDigest ?? null
  }), "utf8"));
  const plan = Object.freeze({
    schemaVersion: 1,
    cohortId: desired.cohort.cohortId,
    repository: Object.freeze({ ...desired.repository }),
    planDigest,
    outcome,
    assets,
    issues: Object.freeze(issues)
  });
  return Object.freeze({
    plan,
    ...(mutationPlan === undefined ? {} : { mutationPlan })
  });
}
