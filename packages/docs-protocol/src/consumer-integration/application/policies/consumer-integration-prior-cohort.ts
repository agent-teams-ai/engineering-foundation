import type {
  ConsumerIntegrationDesiredStateV1,
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationSnapshot
} from "../../domain/model.js";
import {
  CANONICAL_DOCS_SKILL_V2,
  canonicalCallerWorkflow,
  canonicalConsumerIntegrationJson,
  canonicalDocsScripts,
  canonicalDocsScriptsDigest,
  canonicalManagedRoute,
  canonicalManagedState,
  type ConsumerAssetCatalogV1,
  digestBytes,
  type KnownPriorCohortCatalogEntryV1
} from "./consumer-integration-assets.js";
import { assertConsumerIntegrationDesiredStateV1 } from "./consumer-integration-desired-state.js";

export interface TrustedPriorCohort {
  readonly cohortId: string;
  readonly allowedTargetCohortIds: readonly string[];
  readonly schemas: ConsumerIntegrationDesiredStateV1["cohort"]["schemas"];
  readonly skill: Uint8Array;
  readonly callerWorkflow: Uint8Array;
  readonly agentsRouteDigest: ConsumerIntegrationDigest;
  readonly docsScriptsDigest: ConsumerIntegrationDigest;
  readonly managedState: Uint8Array;
}

function desiredAtRecordedRepository(
  desired: ConsumerIntegrationDesiredStateV1,
  record: Record<string, unknown>
): ConsumerIntegrationDesiredStateV1 | undefined {
  const repository = record["repository"];
  if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
    return undefined;
  }
  const candidate = repository as ConsumerIntegrationDesiredStateV1["repository"];
  if (candidate.provider !== desired.repository.provider || candidate.id !== desired.repository.id) {
    return undefined;
  }
  const recorded = { ...desired, repository: candidate };
  try {
    assertConsumerIntegrationDesiredStateV1(recorded);
    return recorded;
  } catch {
    return undefined;
  }
}

function inputDigest(
  observation: ConsumerIntegrationFileObservation
): ConsumerIntegrationDigest | undefined {
  return observation.state === "file" ? digestBytes(observation.bytes) : undefined;
}

function managedRouteDigest(
  observation: ConsumerIntegrationFileObservation
): ConsumerIntegrationDigest | undefined {
  if (observation.state !== "file") {return undefined;}
  const source = Buffer.from(observation.bytes).toString("utf8").replaceAll("\r\n", "\n");
  const begin = source.indexOf("<!-- agent-teams-docs:route/v1 begin -->");
  const endMarker = "<!-- agent-teams-docs:route/v1 end -->";
  const end = source.indexOf(endMarker, begin);
  return begin >= 0 && end >= begin
    ? digestBytes(Buffer.from(source.slice(begin, end + endMarker.length), "utf8"))
    : undefined;
}

function manifestScriptsDigest(
  observation: ConsumerIntegrationFileObservation,
  profilePath: string
): ConsumerIntegrationDigest | undefined {
  if (observation.state !== "file") {return undefined;}
  try {
    const manifest = JSON.parse(
      Buffer.from(observation.bytes).toString("utf8")
    ) as Record<string, unknown>;
    const scripts = typeof manifest["scripts"] === "object" && manifest["scripts"] !== null &&
      !Array.isArray(manifest["scripts"])
      ? manifest["scripts"] as Record<string, unknown>
      : {};
    const observed = Object.fromEntries(Object.keys(canonicalDocsScripts(profilePath)).map((name) => [
      name,
      scripts[name] ?? null
    ]));
    return digestBytes(Buffer.from(canonicalConsumerIntegrationJson(observed), "utf8"));
  } catch {
    return undefined;
  }
}

function matchesRecordedCatalogEvidence(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly record: Record<string, unknown>;
  readonly prior: KnownPriorCohortCatalogEntryV1;
}): boolean {
  const recordedDesired = desiredAtRecordedRepository(input.desired, input.record);
  if (recordedDesired === undefined) {return false;}
  const expected = canonicalManagedState(
    { ...recordedDesired, cohort: input.prior.cohort },
    {
      skillDigest: digestBytes(input.prior.skill),
      callerWorkflowDigest: digestBytes(input.prior.callerWorkflow),
      assetCatalogDigest: input.prior.cohort.assets.assetCatalogDigest,
      transitionCatalogDigest: input.prior.cohort.assets.transitionCatalogDigest,
      agentsRouteDigest: input.prior.agentsRouteDigest,
      docsScriptsDigest: input.prior.docsScriptsDigest
    }
  );
  return canonicalConsumerIntegrationJson(input.record) ===
    canonicalConsumerIntegrationJson(JSON.parse(expected) as unknown);
}

function matchesObservedCatalogEvidence(input: {
  readonly desired: ConsumerIntegrationDesiredStateV1;
  readonly snapshot: ConsumerIntegrationSnapshot;
  readonly prior: KnownPriorCohortCatalogEntryV1;
}): boolean {
  return input.snapshot.skill.state === "file" &&
    Buffer.from(input.snapshot.skill.bytes).equals(Buffer.from(input.prior.skill)) &&
    input.snapshot.callerWorkflow.state === "file" &&
    Buffer.from(input.snapshot.callerWorkflow.bytes).equals(Buffer.from(input.prior.callerWorkflow)) &&
    managedRouteDigest(input.snapshot.agents) === input.prior.agentsRouteDigest &&
    manifestScriptsDigest(input.snapshot.packageManifest, input.desired.profilePath) ===
      input.prior.docsScriptsDigest;
}

// oxlint-disable-next-line complexity
export function trustedPriorCohort(
  desired: ConsumerIntegrationDesiredStateV1,
  snapshot: ConsumerIntegrationSnapshot,
  catalog: ConsumerAssetCatalogV1
): TrustedPriorCohort | undefined {
  if (snapshot.managedState.state !== "file") {return undefined;}
  try {
    const stateSource = Buffer.from(snapshot.managedState.bytes).toString("utf8");
    const record = JSON.parse(stateSource) as Record<string, unknown>;
    const { stateDigest, ...body } = record;
    if (typeof stateDigest !== "string" || stateDigest !== digestBytes(Buffer.from(
      canonicalConsumerIntegrationJson({ domain: "agent-teams.docs-protocol.managed-state/v1", body }),
      "utf8"
    )) || `${canonicalConsumerIntegrationJson(record)}\n` !== stateSource) {return undefined;}
    const recordedDesired = desiredAtRecordedRepository(desired, record);
    const currentSkill = Buffer.from(CANONICAL_DOCS_SKILL_V2, "utf8");
    const currentCaller = Buffer.from(canonicalCallerWorkflow(desired.cohort), "utf8");
    const currentRouteDigest = digestBytes(Buffer.from(canonicalManagedRoute(desired.skillPath), "utf8"));
    const currentScriptsDigest = canonicalDocsScriptsDigest(desired.profilePath);
    const currentState = recordedDesired === undefined ? undefined : canonicalManagedState(
      recordedDesired,
      {
        skillDigest: digestBytes(currentSkill),
        callerWorkflowDigest: digestBytes(currentCaller),
        assetCatalogDigest: catalog.catalogDigest,
        transitionCatalogDigest: catalog.transitionCatalogDigest,
        agentsRouteDigest: currentRouteDigest,
        docsScriptsDigest: currentScriptsDigest
      }
    );
    if (record["cohortId"] === desired.cohort.cohortId &&
      desired.cohort.assets.skillDigest === digestBytes(currentSkill) &&
      desired.cohort.assets.callerWorkflowDigest === digestBytes(currentCaller) &&
      desired.cohort.assets.assetCatalogDigest === catalog.catalogDigest &&
      desired.cohort.assets.transitionCatalogDigest === catalog.transitionCatalogDigest &&
      currentState === stateSource && inputDigest(snapshot.skill) === digestBytes(currentSkill) &&
      inputDigest(snapshot.callerWorkflow) === digestBytes(currentCaller) &&
      managedRouteDigest(snapshot.agents) === currentRouteDigest &&
      manifestScriptsDigest(snapshot.packageManifest, desired.profilePath) === currentScriptsDigest &&
      snapshot.skill.state === "file" && snapshot.callerWorkflow.state === "file") {
      return {
        cohortId: desired.cohort.cohortId,
        allowedTargetCohortIds: [],
        schemas: desired.cohort.schemas,
        skill: snapshot.skill.bytes,
        callerWorkflow: snapshot.callerWorkflow.bytes,
        agentsRouteDigest: currentRouteDigest,
        docsScriptsDigest: currentScriptsDigest,
        managedState: snapshot.managedState.bytes
      };
    }
    const prior = catalog.directTargetBundles.find(({ cohort }) =>
      cohort.cohortId === record["cohortId"]
    );
    if (prior !== undefined && matchesRecordedCatalogEvidence({ desired, record, prior }) &&
      matchesObservedCatalogEvidence({ desired, snapshot, prior })) {
      return {
        cohortId: prior.cohort.cohortId,
        allowedTargetCohortIds: desired.cohort.upgradeFrom.includes(prior.cohort.cohortId) ||
          prior.cohort.rollbackTo.includes(desired.cohort.cohortId)
          ? [desired.cohort.cohortId]
          : [],
        schemas: prior.cohort.schemas,
        skill: prior.skill,
        callerWorkflow: prior.callerWorkflow,
        agentsRouteDigest: prior.agentsRouteDigest,
        docsScriptsDigest: prior.docsScriptsDigest,
        managedState: snapshot.managedState.bytes
      };
    }
    const technicalRecordedDesired = desiredAtRecordedRepository(desired, record);
    const assets = record["assets"] as Record<string, unknown> | undefined;
    const sources = assets === undefined || technicalRecordedDesired === undefined ||
      typeof record["cohortId"] !== "string" ? [] :
      catalog.currentSourceExecutors.filter((candidate) =>
        canonicalConsumerIntegrationJson(record["packages"]) ===
          canonicalConsumerIntegrationJson(candidate.packages) &&
        canonicalConsumerIntegrationJson(record["schemas"]) ===
          canonicalConsumerIntegrationJson(candidate.schemas) &&
        canonicalConsumerIntegrationJson(record["runtime"]) ===
          canonicalConsumerIntegrationJson(candidate.runtime) &&
        assets["skillDigest"] === candidate.skillDigest &&
        assets["callerWorkflowDigest"] === candidate.callerWorkflowDigest &&
        assets["assetCatalogDigest"] === candidate.assetCatalogDigest &&
        assets["assetCatalogDigest"] === catalog.catalogDigest &&
        assets["transitionCatalogDigest"] === catalog.transitionCatalogDigest &&
        assets["agentsRouteDigest"] === candidate.agentsRouteDigest &&
        assets["docsScriptsDigest"] === candidate.docsScriptsDigest &&
        inputDigest(snapshot.skill) === candidate.skillDigest &&
        inputDigest(snapshot.callerWorkflow) === candidate.callerWorkflowDigest &&
        managedRouteDigest(snapshot.agents) === candidate.agentsRouteDigest &&
        manifestScriptsDigest(snapshot.packageManifest, desired.profilePath) ===
          candidate.docsScriptsDigest
      );
    const source = sources.length === 1 ? sources[0] : undefined;
    if (source === undefined || snapshot.skill.state !== "file" ||
      snapshot.callerWorkflow.state !== "file") {
      return undefined;
    }
    return {
      cohortId: String(record["cohortId"]),
      allowedTargetCohortIds: source.directTargetCohortIds,
      schemas: source.schemas,
      skill: snapshot.skill.bytes,
      callerWorkflow: snapshot.callerWorkflow.bytes,
      agentsRouteDigest: source.agentsRouteDigest,
      docsScriptsDigest: source.docsScriptsDigest,
      managedState: snapshot.managedState.bytes
    };
  } catch {
    return undefined;
  }
}
