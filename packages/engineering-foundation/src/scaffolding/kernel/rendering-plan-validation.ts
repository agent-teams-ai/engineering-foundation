import type { ScaffoldPlanV1 } from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { assertScaffoldPlanContent } from "./plan-content-validation.js";

export function assertScaffoldPlanDigest(plan: ScaffoldPlanV1): void {
  const candidate = plan as {
    readonly schemaVersion: number;
    readonly protocolVersion: number;
  };
  if (candidate.schemaVersion !== 1 || candidate.protocolVersion !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Rendering regression Plan uses an unsupported protocol."
    );
  }
  assertScaffoldPlanContent(plan);
}
