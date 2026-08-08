import type { AuthorityScaffoldPlan } from "../contract/types.js";
import { ScaffoldError } from "../scaffold-error.js";
import { assertAuthorityEvidenceSourceBindings } from "./authority-evidence.js";
import { assertScaffoldPlanContent } from "./plan-content-validation.js";

export function assertAuthorityScaffoldPlanDigest(
  plan: AuthorityScaffoldPlan
): void {
  const candidate = plan as {
    readonly schemaVersion: number;
    readonly protocolVersion: number;
  };
  if (candidate.schemaVersion !== 1 || candidate.protocolVersion !== 1) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan does not use the canonical protocol."
    );
  }
  assertScaffoldPlanContent(plan);
  assertAuthorityEvidenceSourceBindings({
    evidence: plan.authorityEvidence,
    target: plan.target,
    projectId: plan.projectId,
    targetRef: plan.intent.targetRef,
    configPath: plan.authority.configPath,
    targetCatalogPath: plan.authority.targetCatalogPath,
    authorityReadSet: plan.readSet
  });
}
