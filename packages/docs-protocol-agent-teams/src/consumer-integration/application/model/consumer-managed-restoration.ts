import type { ConsumerRestorationPreparation } from "./consumer-restoration.js";
import type {
  ConsumerUpgradeAuthorityV3,
  QualifiedDocsCohortBindingV2,
} from "../../domain/model.js";

/** Finite successor-controller intent. This does not extend the historical 1->2 wire family. */
export interface ManagedGenerationPreparation extends Omit<
  ConsumerRestorationPreparation,
  "protocol" | "sourceGeneration" | "targetGeneration" | "sourceCohort" | "targetCohort"
> {
  readonly protocol: "agent-teams.managed-generation3-preparation/v1";
  readonly sourceGeneration: 2;
  readonly targetGeneration: 3;
  readonly sourceCohort: QualifiedDocsCohortBindingV2;
  readonly targetCohort: ConsumerUpgradeAuthorityV3["cohort"];
}
export interface ManagedGenerationFinalizationOptions {
  readonly consumerRoot: string;
  readonly sourceGeneration: 2;
  readonly targetGeneration: 3;
  readonly from: string;
  readonly to: string;
  readonly preparationPath: string;
  readonly expect: string;
  readonly proofPath: string;
}
export interface ManagedGenerationRestorationOptions {
  readonly consumerRoot: string;
  readonly sourceGeneration: 3;
  readonly targetGeneration: 2;
  readonly from: string;
  readonly to: string;
  readonly preparationPath: string;
  readonly expect: string;
}

/** Explicit fresh admission of the current committed target; historical root identity is not reused. */
export interface ManagedCommittedRestorationOptions extends ManagedGenerationRestorationOptions {
  readonly currentRevision: string;
  readonly currentTree: string;
  readonly selectionPath: string;
  readonly selectionExpect?: string;
}

export interface ManagedCurrentRestorationSelection extends Pick<
  import("./consumer-restoration.js").ConsumerRestorationIntent,
  | "consumer"
  | "sourceRevision"
  | "sourceTree"
  | "sourceInventoryDigest"
  | "controller"
  | "kernel"
  | "plan"
> {
  readonly schemaVersion: 1;
  readonly protocol: "agent-teams.managed-generation3-current-restoration/v1";
  readonly sourceGeneration: 3;
  readonly targetGeneration: 2;
  readonly originalPreparationDigest: string;
}
