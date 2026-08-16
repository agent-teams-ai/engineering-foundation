import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput
} from "@agent-teams/engineering-foundation/mutation";

import { planAgentsRouteV1 } from "../../adapters/agents-route-adapter-v1.js";
import { planPnpmManifestV1 } from "../../adapters/pnpm-manifest-adapter-v1.js";
import type {
  ConsumerIntegrationAssetPlan,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationIssue,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot,
  KnownPriorConsumerAssets
} from "../../domain/model.js";
import {
  BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
  BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS,
  CANONICAL_DOCS_SKILL,
  canonicalCallerWorkflow,
  canonicalConsumerIntegrationJson,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  describeCanonicalConsumerAssets,
  digestBytes,
  isBootstrapKnownPriorCallerWorkflow
} from "../policies/consumer-integration-assets.js";
import { consumerIntegrationAuthorityGuards } from "../policies/consumer-integration-authority-guards.js";
import { assertConsumerIntegrationDesiredStateV1 } from "../policies/consumer-integration-desired-state.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COHORT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

interface FullAssetResult {
  readonly plan: ConsumerIntegrationAssetPlan;
  readonly operation?: KnownFileTransactionOperationInput;
  readonly issue?: ConsumerIntegrationIssue;
}

interface ManagedStateEvidence {
  readonly managedState: readonly Uint8Array[];
  readonly cohort?: {
    readonly cohortId: string;
    readonly channel: "rc" | "stable";
    readonly rollbackTo: readonly string[];
  };
  readonly skillDigest?: ConsumerIntegrationDigest;
  readonly callerWorkflowDigest?: ConsumerIntegrationDigest;
  readonly agentsRouteDigest?: ConsumerIntegrationDigest;
  readonly docsScriptsDigest?: ConsumerIntegrationDigest;
}

function isManagedStateIdentity(
  record: Record<string, unknown>,
  desired: ConsumerIntegrationDesiredStateV1
): boolean {
  const repository = record["repository"];
  return record["schemaVersion"] === 1 &&
    typeof record["stateDigest"] === "string" &&
    SHA256.test(record["stateDigest"]) &&
    typeof repository === "object" &&
    repository !== null &&
    !Array.isArray(repository) &&
    (repository as Record<string, unknown>)["provider"] === desired.repository.provider &&
    (repository as Record<string, unknown>)["id"] === desired.repository.id;
}

function managedAssetDigests(
  record: Record<string, unknown>,
  bytes: Uint8Array
): ManagedStateEvidence {
  const assets = record["assets"];
  if (typeof assets !== "object" || assets === null || Array.isArray(assets)) {
    return { managedState: [] };
  }
  const assetRecord = assets as Record<string, unknown>;
  const digest = (key: string): ConsumerIntegrationDigest | undefined => {
    const value = assetRecord[key];
    return typeof value === "string" && SHA256.test(value)
      ? value as ConsumerIntegrationDigest
      : undefined;
  };
  const skillDigest = digest("skillDigest");
  const callerWorkflowDigest = digest("callerWorkflowDigest");
  const agentsRouteDigest = digest("agentsRouteDigest");
  const docsScriptsDigest = digest("docsScriptsDigest");
  const cohortId = record["cohortId"];
  const cohortAuthority = record["cohortAuthority"];
  const cohort = typeof cohortId === "string" && COHORT_ID.test(cohortId) &&
    typeof cohortAuthority === "object" && cohortAuthority !== null &&
    !Array.isArray(cohortAuthority) &&
    ["rc", "stable"].includes(String((cohortAuthority as Record<string, unknown>)["channel"])) &&
    Array.isArray((cohortAuthority as Record<string, unknown>)["rollbackTo"])
    ? {
        cohortId,
        channel: (cohortAuthority as Record<string, unknown>)["channel"] as "rc" | "stable",
        rollbackTo: Object.freeze([
          ...((cohortAuthority as Record<string, unknown>)["rollbackTo"] as string[])
        ])
      }
    : undefined;
  return {
    managedState: [bytes],
    ...(cohort === undefined ? {} : { cohort }),
    ...(skillDigest === undefined ? {} : { skillDigest }),
    ...(callerWorkflowDigest === undefined ? {} : { callerWorkflowDigest }),
    ...(agentsRouteDigest === undefined ? {} : { agentsRouteDigest }),
    ...(docsScriptsDigest === undefined ? {} : { docsScriptsDigest })
  };
}

function issue(code: string, subject: string, message: string): ConsumerIntegrationIssue {
  return { code, severity: "error", subject, message };
}

function fullAsset(input: {
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
        acceptedPreimages: [{
          bytes: currentBytes,
          mode: currentMode
        }]
      },
      postimage: {
        bytes: input.postimage,
        mode: currentMode
      }
    }
  };
}

function managedStateEvidence(
  observation: ConsumerIntegrationFileObservation,
  desired: ConsumerIntegrationDesiredStateV1
): ManagedStateEvidence {
  if (observation.state === "absent") {
    return { managedState: [] };
  }
  try {
    const source = Buffer.from(observation.bytes).toString("utf8");
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { managedState: [] };
    }
    const record = parsed as Record<string, unknown>;
    if (!isManagedStateIdentity(record, desired)) {
      return { managedState: [] };
    }
    const stateDigest = record["stateDigest"] as string;
    const { stateDigest: _ignored, ...body } = record;
    const expected = digestBytes(Buffer.from(canonicalConsumerIntegrationJson({
      domain: "agent-teams.docs-protocol.managed-state/v1",
      body
    }), "utf8"));
    if (expected !== stateDigest || `${canonicalConsumerIntegrationJson(record)}\n` !== source) {
      return { managedState: [] };
    }
    return managedAssetDigests(record, observation.bytes);
  } catch {
    return { managedState: [] };
  }
}

function knownObservedBytes(
  observation: ConsumerIntegrationFileObservation,
  recordedDigest: ConsumerIntegrationDigest | undefined,
  explicit: readonly Uint8Array[]
): readonly Uint8Array[] {
  if (observation.state !== "file" || recordedDigest === undefined ||
    digestBytes(observation.bytes) !== recordedDigest) {
    return explicit;
  }
  return [...explicit, observation.bytes];
}

function partialAsset(input: {
  readonly id: "agents-route" | "package-manifest";
  readonly path: string;
  readonly ownership: "managed-block" | "partial-fields";
  readonly state: "conflict" | "exact-current" | "known-prior";
  readonly currentDigest: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly current: ConsumerIntegrationFileObservation;
  readonly postimage?: Uint8Array;
}): { readonly plan: ConsumerIntegrationAssetPlan; readonly operation?: KnownFileTransactionOperationInput } {
  const action = input.state === "conflict" ? "blocked" :
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
  if (action !== "replace" || input.current.state !== "file" || input.postimage === undefined) {
    return { plan };
  }
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

function cohortIssues(
  desired: ConsumerIntegrationDesiredStateV1,
  previous: ManagedStateEvidence
): readonly ConsumerIntegrationIssue[] {
  const issues: ConsumerIntegrationIssue[] = [];
  const prior = previous.cohort;
  if (prior !== undefined && prior.cohortId !== desired.cohort.cohortId) {
    const isUpgrade = desired.cohort.channel === prior.channel &&
      desired.cohort.upgradeFrom.includes(prior.cohortId);
    const isRollback = prior.rollbackTo.includes(desired.cohort.cohortId);
    if (!isUpgrade && !isRollback) {
      issues.push(issue(
        "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
        desired.cohort.cohortId,
        `Cohort transition from ${prior.cohortId} is not an authorized upgrade or rollback edge.`
      ));
    }
  }
  const canonical = describeCanonicalConsumerAssets(desired.cohort);
  if (canonical.skillDigest !== desired.cohort.assets.skillDigest ||
    canonical.callerWorkflowDigest !== desired.cohort.assets.callerWorkflowDigest ||
    canonical.assetCatalogDigest !== desired.cohort.assets.assetCatalogDigest) {
    issues.push(issue(
      "DOCS_CONSUMER_COHORT_ASSET_MISMATCH",
      desired.cohort.cohortId,
      "Qualified Cohort asset digests do not match this exact Docs Protocol build."
    ));
  }
  return issues;
}

function planFullAssets(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly knownPrior: KnownPriorConsumerAssets;
  readonly previous: ManagedStateEvidence;
  readonly snapshot: ConsumerIntegrationSnapshot;
}): readonly FullAssetResult[] {
  const skillBytes = Buffer.from(CANONICAL_DOCS_SKILL, "utf8");
  const callerBytes = Buffer.from(canonicalCallerWorkflow(input.desired.cohort), "utf8");
  const routeBytes = Buffer.from(canonicalManagedRoute(input.desired.skillPath), "utf8");
  const bootstrapCaller = input.snapshot.callerWorkflow.state === "file" &&
    isBootstrapKnownPriorCallerWorkflow(input.snapshot.callerWorkflow.bytes)
    ? [input.snapshot.callerWorkflow.bytes]
    : [];
  const managedStateBytes = Buffer.from(canonicalManagedState(input.desired, {
    skillDigest: digestBytes(skillBytes),
    callerWorkflowDigest: digestBytes(callerBytes),
    agentsRouteDigest: digestBytes(routeBytes),
    docsScriptsDigest: canonicalDocsScriptsDigest(input.desired.profilePath)
  }), "utf8");
  return [
    fullAsset({
      id: "skill",
      path: input.desired.skillPath,
      observation: input.snapshot.skill,
      postimage: skillBytes,
      knownPrior: knownObservedBytes(
        input.snapshot.skill,
        input.previous.skillDigest,
        input.knownPrior.skill ?? BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS
      )
    }),
    fullAsset({
      id: "caller-workflow",
      path: input.desired.callerWorkflowPath,
      observation: input.snapshot.callerWorkflow,
      postimage: callerBytes,
      knownPrior: knownObservedBytes(
        input.snapshot.callerWorkflow,
        input.previous.callerWorkflowDigest,
        input.knownPrior.callerWorkflow ?? [
          ...BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
          ...bootstrapCaller
        ]
      )
    }),
    fullAsset({
      id: "managed-state",
      path: input.desired.managedStatePath,
      observation: input.snapshot.managedState,
      postimage: managedStateBytes,
      knownPrior: input.previous.managedState
    })
  ];
}

export function planConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly knownPrior?: KnownPriorConsumerAssets;
}): ConsumerIntegrationPlanV1 {
  assertConsumerIntegrationDesiredStateV1(input.desired);
  const desired = input.desired;
  const knownPrior = input.knownPrior ?? {};
  const previous = managedStateEvidence(input.snapshot.managedState, desired);
  const issues: ConsumerIntegrationIssue[] = [...cohortIssues(desired, previous)];

  const manifest = planPnpmManifestV1({
    observation: input.snapshot.packageManifest,
    profilePath: desired.profilePath,
    cohort: desired.cohort,
    ...(previous.docsScriptsDigest === undefined
      ? {}
      : { knownPriorScriptsDigest: previous.docsScriptsDigest })
  });
  issues.push(...manifest.issues);
  const route = planAgentsRouteV1({
    observation: input.snapshot.agents,
    skillPath: desired.skillPath,
    ...(previous.agentsRouteDigest === undefined
      ? {}
      : { knownPriorRouteDigest: previous.agentsRouteDigest })
  });
  issues.push(...route.issues);

  const results = planFullAssets({ desired, knownPrior, previous, snapshot: input.snapshot });
  for (const result of results) {
    if (result.issue !== undefined) {
      issues.push(result.issue);
    }
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
  const guardOperations = consumerIntegrationAuthorityGuards(
    input.snapshot,
    operations.length > 0
  );
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
  return Object.freeze({
    schemaVersion: 1,
    cohortId: desired.cohort.cohortId,
    repository: Object.freeze({ ...desired.repository }),
    planDigest,
    outcome,
    assets,
    issues: Object.freeze(issues),
    ...(mutationPlan === undefined ? {} : { mutationPlan })
  });
}
