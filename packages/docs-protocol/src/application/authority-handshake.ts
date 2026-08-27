import type { DocumentPlanV2 } from "@agent-teams/engineering-foundation/document-authoring";

import type { FoundationDocsPortV2 } from "../domain/model-v2.js";

type Catalog = Awaited<ReturnType<FoundationDocsPortV2["buildCatalog"]>>;
type Description = Awaited<ReturnType<FoundationDocsPortV2["describe"]>>;
type Plan = Awaited<ReturnType<FoundationDocsPortV2["plan"]>>;

function isPlanV2(plan: Plan): plan is DocumentPlanV2 {
  return plan.schemaVersion === 2;
}

export function planAuthorityStable(
  plan: Plan,
  before: { readonly catalog: Catalog; readonly description: Description },
  after: { readonly catalog: Catalog; readonly description: Description }
): boolean {
  if (!isPlanV2(plan)) {return false;}
  const catalogDigest = before.catalog.semanticDigest;
  const catalogIsStable = catalogDigest === after.catalog.semanticDigest;
  const catalogMatchesPlan =
    catalogDigest === plan.authority.catalogPreimageSemanticDigest ||
    catalogDigest === plan.authority.expectedCatalogPostimageSemanticDigest;
  return before.description.semanticDigest === plan.authority.profileSemanticDigest &&
    plan.authority.profileSemanticDigest === after.description.semanticDigest &&
    catalogIsStable && catalogMatchesPlan;
}

export function catalogMatchesExpectedPostimage(plan: Plan, catalog: Catalog): boolean {
  return isPlanV2(plan) &&
    catalog.semanticDigest === plan.authority.expectedCatalogPostimageSemanticDigest;
}
