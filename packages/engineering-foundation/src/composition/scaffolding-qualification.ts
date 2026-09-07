import type { ScaffoldPlan, ScaffoldReceipt, ScaffoldQualificationPhaseCallback } from "../scaffolding/testing/api.js";
import { createScaffoldCrashQualification } from "../scaffolding/testing/api.js";
import { applyAuthorityFilesystemScaffoldWithFaultInjection } from "./scaffold-filesystem.js";

const qualification = createScaffoldCrashQualification(applyAuthorityFilesystemScaffoldWithFaultInjection);

export function runScaffoldCrashQualification(
  consumerRoot: string,
  plan: ScaffoldPlan,
  onPhase: ScaffoldQualificationPhaseCallback
): Promise<ScaffoldReceipt> {
  return qualification.runScaffoldCrashQualification(consumerRoot, plan, onPhase);
}
