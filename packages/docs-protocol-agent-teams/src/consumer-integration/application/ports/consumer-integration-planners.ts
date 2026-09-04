import type {
  ConsumerIntegrationDigest,
  ConsumerIntegrationFileObservation,
  ConsumerIntegrationIssue,
  QualifiedDocsCohortBindingV1,
  QualifiedDocsCohortBindingV2
} from "../../domain/model.js";

export interface AgentsRoutePlanV1 {
  readonly state: "absent" | "conflict" | "exact-current" | "known-prior";
  readonly currentDigest: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly postimage?: Uint8Array;
  readonly issues: readonly ConsumerIntegrationIssue[];
}

export interface PnpmManifestPlanV1 {
  readonly state: "conflict" | "exact-current" | "known-prior";
  readonly currentDigest: ConsumerIntegrationDigest;
  readonly expectedDigest: ConsumerIntegrationDigest;
  readonly postimage?: Uint8Array;
  readonly issues: readonly ConsumerIntegrationIssue[];
}

export interface AgentsRoutePlannerV1 {
  plan(input: {
    readonly observation: ConsumerIntegrationFileObservation;
    readonly skillPath: string;
    readonly knownPriorRouteDigest?: ConsumerIntegrationDigest;
  }): AgentsRoutePlanV1;
}

export interface PnpmManifestPlanner {
  plan(input: {
    readonly observation: ConsumerIntegrationFileObservation;
    readonly profilePath: string;
    readonly cohort: QualifiedDocsCohortBindingV1 | QualifiedDocsCohortBindingV2;
    readonly knownPriorScriptsDigest?: ConsumerIntegrationDigest;
  }): PnpmManifestPlanV1;
}

export interface ConsumerIntegrationPlanningPorts {
  readonly agentsRoute: AgentsRoutePlannerV1;
  readonly packageManifest: PnpmManifestPlanner;
}
