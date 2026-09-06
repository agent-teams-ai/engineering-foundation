import type { DocumentAuthoringPortV2 } from "./model-v2.js";

type Catalog = Awaited<ReturnType<DocumentAuthoringPortV2["buildCatalog"]>>;
type Description = Awaited<ReturnType<DocumentAuthoringPortV2["describe"]>>;
type Plan = Awaited<ReturnType<DocumentAuthoringPortV2["plan"]>>;

function isPlanV2(plan: { readonly schemaVersion: unknown }): boolean {
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
