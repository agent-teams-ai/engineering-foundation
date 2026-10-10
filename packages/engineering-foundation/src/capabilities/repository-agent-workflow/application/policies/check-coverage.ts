import type { CoverageFacet, CoverageRow, WorkflowCoveragePolicy } from "../model/check-changed.js";

function matches(path: string, root: string): boolean {
  return root === "*" || path === root || path.startsWith(`${root}/`);
}
/** C1 selects repository-wide commands only. Paths explain selection and are
 * never forwarded as compiler/test arguments. No dependency narrowing claim. */
export function planCheckCoverage(policy: WorkflowCoveragePolicy, paths: readonly string[]) {
  const rows: CoverageRow[] = [];
  const selected = new Set<string>();
  let unknown = false;
  let missingFacet = false;
  const allFacets = [...new Set(policy.scopes.flatMap((scope) => scope.requiredFacets))].toSorted();
  for (const path of paths) {
    const exclusion = policy.exclusions.find((entry) => matches(path, entry.path));
    if (exclusion !== undefined) {
      rows.push({ path, facet: null, state: "explicitly-skipped", reason: exclusion.reason, checkIds: [] });
      continue;
    }
    const scopes = policy.scopes.filter((scope) => scope.roots.some((root) => matches(path, root)));
    const facets: readonly CoverageFacet[] = scopes.length === 0 ? allFacets : [...new Set(scopes.flatMap((scope) => scope.requiredFacets))].toSorted();
    const ids = scopes.length === 0 ? [policy.escalationCheck] : [...new Set(scopes.flatMap((scope) => scope.checks))].toSorted();
    unknown ||= scopes.length === 0;
    if (facets.some((facet) => !ids.some((id) => policy.checks.some((check) => check.id === id && check.supplies.includes(facet))))) {
      missingFacet = true;
      if (!ids.includes(policy.escalationCheck)) { ids.push(policy.escalationCheck); ids.sort(); }
    }
    for (const id of ids) {selected.add(id);}
    for (const facet of facets) {rows.push({ path, facet, state: "uncovered", reason: scopes.length === 0 ? "Unknown path requires adequate repository escalation." : "Required facet awaits observation.", checkIds: ids });}
  }
  return { rows, selected: [...selected].toSorted(), unknown, missingFacet };
}
