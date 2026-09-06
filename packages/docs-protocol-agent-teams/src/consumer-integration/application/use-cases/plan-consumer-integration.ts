import {
  compileKnownFileTransactionPlan,
  type KnownFileTransactionOperationInput
} from "@agent-teams/repository-mutation/known-file";

import type {
  ConsumerIntegrationPlanningPorts
} from "../ports/consumer-integration-planners.js";
import type {
  ConsumerIntegrationDesiredState,
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDigest,
  ConsumerIntegrationIssue,
  ConsumerIntegrationPlanV1,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";
import {
  BUNDLED_KNOWN_PRIOR_COHORTS,
  BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
  BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS,
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalConsumerIntegrationJson,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  type ConsumerAssetCatalogV1,
  BUNDLED_CURRENT_SOURCE_EXECUTORS,
  describeCanonicalConsumerAssets,
  digestBytes,
  isBootstrapKnownPriorCallerWorkflow,
  type KnownPriorCohortCatalogEntryV1
} from "../policies/consumer-integration-assets.js";
import { consumerIntegrationAuthorityGuards } from "../policies/consumer-integration-authority-guards.js";
import { assertConsumerIntegrationDesiredStateV1 } from
  "../policies/consumer-integration-desired-state.js";
import {
  trustedPriorCohort,
  type TrustedPriorCohort
} from "../policies/consumer-integration-prior-cohort.js";
import {
  assertSnapshotRuntime,
  compileConsumerIntegrationV3,
  fullAsset,
  issue,
  partialAsset,
  type FullAssetResult
} from "./compile-consumer-integration-v3.js";

function cohortIssues(
  desired: ConsumerIntegrationDesiredStateV1,
  prior: TrustedPriorCohort | undefined,
  catalog: ConsumerAssetCatalogV1
): readonly ConsumerIntegrationIssue[] {
  const issues: ConsumerIntegrationIssue[] = [];
  if (prior !== undefined && prior.cohortId !== desired.cohort.cohortId &&
    !prior.allowedTargetCohortIds.includes(desired.cohort.cohortId)) {
    issues.push(issue(
      "DOCS_CONSUMER_COHORT_TRANSITION_FORBIDDEN",
      desired.cohort.cohortId,
      `Cohort transition from ${prior.cohortId} is not an authorized upgrade or rollback edge.`
    ));
  }
  if (prior !== undefined && prior.cohortId !== desired.cohort.cohortId &&
    canonicalConsumerIntegrationJson(prior.schemas) !==
      canonicalConsumerIntegrationJson(desired.cohort.schemas)) {
    issues.push(issue(
      "DOCS_CONSUMER_COHORT_SCHEMA_INCOMPATIBLE",
      desired.cohort.cohortId,
      "The requested transition crosses a schema boundary and requires a qualified fix-forward Cohort."
    ));
  }
  const targetBundle = catalog.directTargetBundles.find(({ cohort }) =>
    cohort.cohortId === desired.cohort.cohortId &&
    canonicalConsumerIntegrationJson(cohort) === canonicalConsumerIntegrationJson(desired.cohort)
  );
  const canonical = targetBundle === undefined
    ? {
        ...describeCanonicalConsumerAssets(desired.cohort),
        assetCatalogDigest: catalog.catalogDigest,
        transitionCatalogDigest: catalog.transitionCatalogDigest
      }
    : {
      skillDigest: digestBytes(targetBundle.skill),
      callerWorkflowDigest: digestBytes(targetBundle.callerWorkflow),
      assetCatalogDigest: targetBundle.cohort.assets.assetCatalogDigest,
      transitionCatalogDigest: targetBundle.cohort.assets.transitionCatalogDigest
      };
  if (canonical.skillDigest !== desired.cohort.assets.skillDigest ||
    canonical.callerWorkflowDigest !== desired.cohort.assets.callerWorkflowDigest ||
    canonical.assetCatalogDigest !== desired.cohort.assets.assetCatalogDigest ||
    canonical.transitionCatalogDigest !== desired.cohort.assets.transitionCatalogDigest) {
    issues.push(issue(
      "DOCS_CONSUMER_COHORT_ASSET_MISMATCH",
      desired.cohort.cohortId,
      "Qualified Cohort asset digests do not match this exact Docs Protocol build."
    ));
  }
  for (const rollbackId of desired.cohort.rollbackTo) {
    const bundled = catalog.directTargetBundles.find(({ cohort }) => cohort.cohortId === rollbackId);
    if (bundled === undefined || canonicalConsumerIntegrationJson(bundled.cohort.schemas) !==
      canonicalConsumerIntegrationJson(desired.cohort.schemas)) {
      issues.push(issue(
        "DOCS_CONSUMER_ROLLBACK_BUNDLE_MISSING",
        rollbackId,
        "Every declared rollback edge requires one exact schema-compatible package-owned target bundle."
      ));
    }
  }
  return issues;
}

function planFullAssets(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly prior: TrustedPriorCohort | undefined;
  readonly targetBundle: KnownPriorCohortCatalogEntryV1 | undefined;
  readonly targetCatalogDigest: ConsumerIntegrationDigest;
  readonly targetTransitionCatalogDigest: ConsumerIntegrationDigest;
}): readonly FullAssetResult[] {
  const skillBytes = input.targetBundle?.skill ?? Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8");
  const callerBytes = input.targetBundle?.callerWorkflow ??
    Buffer.from(canonicalCallerWorkflow(input.desired.cohort), "utf8");
  const routeBytes = Buffer.from(canonicalManagedRoute(input.desired.skillPath), "utf8");
  const bootstrapCaller = input.snapshot.callerWorkflow.state === "file" &&
    isBootstrapKnownPriorCallerWorkflow(input.snapshot.callerWorkflow.bytes)
    ? [input.snapshot.callerWorkflow.bytes]
    : [];
  const managedStateBytes = Buffer.from(canonicalManagedState(input.desired, {
    skillDigest: digestBytes(skillBytes),
    callerWorkflowDigest: digestBytes(callerBytes),
    assetCatalogDigest: input.targetCatalogDigest,
    transitionCatalogDigest: input.targetTransitionCatalogDigest,
    agentsRouteDigest: digestBytes(routeBytes),
    docsScriptsDigest: canonicalDocsScriptsDigest(input.desired.profilePath)
  }), "utf8");
  return [
    fullAsset({
      id: "skill",
      path: input.desired.skillPath,
      observation: input.snapshot.skill,
      postimage: skillBytes,
      knownPrior: input.prior === undefined
        ? BOOTSTRAP_KNOWN_PRIOR_DOCS_SKILLS
        : [input.prior.skill]
    }),
    fullAsset({
      id: "caller-workflow",
      path: input.desired.callerWorkflowPath,
      observation: input.snapshot.callerWorkflow,
      postimage: callerBytes,
      knownPrior: input.prior === undefined ? [
        ...BOOTSTRAP_KNOWN_PRIOR_CALLER_WORKFLOWS,
        ...bootstrapCaller
      ] : [input.prior.callerWorkflow]
    }),
    fullAsset({
      id: "managed-state",
      path: input.desired.managedStatePath,
      observation: input.snapshot.managedState,
      postimage: managedStateBytes,
      knownPrior: input.prior === undefined ? [] : [input.prior.managedState]
    })
  ];
}

function compileConsumerIntegrationV1(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly assetCatalog?: ConsumerAssetCatalogV1;
  /** Unit-level compatibility input; production composition loads package assets. */
  readonly knownPriorCohorts?: readonly KnownPriorCohortCatalogEntryV1[];
}, ports: ConsumerIntegrationPlanningPorts): {
  readonly plan: ConsumerIntegrationPlanV1;
  readonly mutationPlan?: ReturnType<typeof compileKnownFileTransactionPlan>;
} {
  assertConsumerIntegrationDesiredStateV1(input.desired);
  assertSnapshotRuntime(input.snapshot);
  const desired = input.desired;
  const assetCatalog = input.assetCatalog ?? Object.freeze({
    catalogDigest: describeCanonicalConsumerAssets(desired.cohort).assetCatalogDigest,
    transitionCatalogDigest: describeCanonicalConsumerAssets(desired.cohort).transitionCatalogDigest,
    currentSourceExecutors: BUNDLED_CURRENT_SOURCE_EXECUTORS,
    directTargetBundles: input.knownPriorCohorts ?? BUNDLED_KNOWN_PRIOR_COHORTS
  });
  const prior = trustedPriorCohort(
    desired,
    input.snapshot,
    assetCatalog
  );
  const issues: ConsumerIntegrationIssue[] = [...cohortIssues(desired, prior, assetCatalog)];

  const manifest = ports.packageManifest.plan({
    observation: input.snapshot.packageManifest,
    profilePath: desired.profilePath,
    cohort: desired.cohort,
    ...(prior === undefined ? {} : { knownPriorScriptsDigest: prior.docsScriptsDigest })
  });
  issues.push(...manifest.issues);
  const route = ports.agentsRoute.plan({
    observation: input.snapshot.agents,
    skillPath: desired.skillPath,
    ...(prior === undefined ? {} : { knownPriorRouteDigest: prior.agentsRouteDigest })
  });
  issues.push(...route.issues);

  const targetBundle = assetCatalog.directTargetBundles.find(({ cohort }) =>
    cohort.cohortId === desired.cohort.cohortId &&
    canonicalConsumerIntegrationJson(cohort) === canonicalConsumerIntegrationJson(desired.cohort)
  );
  const results = planFullAssets({
    desired,
    snapshot: input.snapshot,
    prior,
    targetBundle,
    targetCatalogDigest: targetBundle?.cohort.assets.assetCatalogDigest ?? assetCatalog.catalogDigest,
    targetTransitionCatalogDigest: targetBundle?.cohort.assets.transitionCatalogDigest ??
      assetCatalog.transitionCatalogDigest
  });
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

export function compileConsumerIntegration(input: {
  readonly desired: ConsumerIntegrationDesiredState;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly assetCatalog?: ConsumerAssetCatalogV1;
  /** Unit-level compatibility input; production composition loads package assets. */
  readonly knownPriorCohorts?: readonly KnownPriorCohortCatalogEntryV1[];
}, ports: ConsumerIntegrationPlanningPorts): {
  readonly plan: ConsumerIntegrationPlanV1;
  readonly mutationPlan?: ReturnType<typeof compileKnownFileTransactionPlan>;
} {
  switch (input.desired.schemaVersion) {
    case 1:
      return compileConsumerIntegrationV1({
        desired: input.desired,
        snapshot: input.snapshot,
        ...(input.assetCatalog === undefined ? {} : { assetCatalog: input.assetCatalog }),
        ...(input.knownPriorCohorts === undefined
          ? {}
          : { knownPriorCohorts: input.knownPriorCohorts })
      }, ports);
    case 3:
      if (input.assetCatalog !== undefined || input.knownPriorCohorts !== undefined) {
        throw new TypeError("Consumer integration profile v3 does not accept V1 asset catalogs.");
      }
      return compileConsumerIntegrationV3({
        desired: input.desired,
        snapshot: input.snapshot
      }, ports);
  }
}
