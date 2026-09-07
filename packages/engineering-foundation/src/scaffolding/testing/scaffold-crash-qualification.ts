import type { ScaffoldPlan, ScaffoldReceipt } from "../contract/scaffold-contract.js";
import type { ScaffoldAuthorityFaultInjector } from "../adapters/node/filesystem-authority-workspace.js";

export type ScaffoldQualificationPhase =
  | "after-journal-temporary-synced"
  | "after-journal-prepared"
  | "before-operation-authority-recheck"
  | "after-journal-operation-publishing"
  | "after-temporary-synced"
  | "after-hard-link"
  | "after-journal-operation-published"
  | "before-final-authority-recheck"
  | "after-final-verification"
  | "before-journal-quarantine"
  | "after-journal-unlinked";

export interface ScaffoldQualificationPoint {
  readonly phase: ScaffoldQualificationPhase;
}

export type ScaffoldQualificationPhaseCallback =
  (point: ScaffoldQualificationPoint) => void | Promise<void>;

const supportedPhases: ReadonlySet<string> = new Set<ScaffoldQualificationPhase>([
  "after-journal-temporary-synced",
  "after-journal-prepared",
  "before-operation-authority-recheck",
  "after-journal-operation-publishing",
  "after-temporary-synced",
  "after-hard-link",
  "after-journal-operation-published",
  "before-final-authority-recheck",
  "after-final-verification",
  "before-journal-quarantine",
  "after-journal-unlinked",
]);

function isQualificationPhase(phase: string): phase is ScaffoldQualificationPhase {
  return supportedPhases.has(phase);
}

export function createScaffoldCrashQualification(
  apply: (
    consumerRoot: string,
    plan: ScaffoldPlan,
    faultInjector: ScaffoldAuthorityFaultInjector
  ) => Promise<ScaffoldReceipt>
): {
  runScaffoldCrashQualification: (
    consumerRoot: string,
    plan: ScaffoldPlan,
    onPhase: ScaffoldQualificationPhaseCallback
  ) => Promise<ScaffoldReceipt>;
} {
  return {
    async runScaffoldCrashQualification(consumerRoot, plan, onPhase) {
      if (typeof onPhase !== "function") {
        throw new TypeError("Scaffold qualification requires an onPhase callback.");
      }
      return apply(consumerRoot, plan, async ({ phase }) => {
        if (isQualificationPhase(phase)) {
          await onPhase(Object.freeze({ phase }));
        }
      });
    }
  };
}
