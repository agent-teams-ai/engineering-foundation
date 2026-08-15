import type { DocumentPlanV2 } from "@agent-teams/engineering-foundation/document-authoring";

import type { FoundationDocsPort } from "../domain/model.js";

type Catalog = Awaited<ReturnType<FoundationDocsPort["buildCatalog"]>>;
type Description = Awaited<ReturnType<FoundationDocsPort["describe"]>>;
type Plan = Awaited<ReturnType<FoundationDocsPort["plan"]>>;

function isPlanV2(plan: Plan): plan is DocumentPlanV2 {
  return plan.schemaVersion === 2;
}

export function planAuthorityStable(
  plan: Plan,
  before: { readonly catalog: Catalog; readonly description: Description },
  after: { readonly catalog: Catalog; readonly description: Description }
): boolean {
  return isPlanV2(plan) &&
    before.description.semanticDigest === plan.authority.profileSemanticDigest &&
    plan.authority.profileSemanticDigest === after.description.semanticDigest &&
    before.catalog.semanticDigest === plan.authority.catalogPreimageSemanticDigest &&
    plan.authority.catalogPreimageSemanticDigest === after.catalog.semanticDigest;
}

export function catalogMatchesExpectedPostimage(plan: Plan, catalog: Catalog): boolean {
  return isPlanV2(plan) &&
    catalog.semanticDigest === plan.authority.expectedCatalogPostimageSemanticDigest;
}
