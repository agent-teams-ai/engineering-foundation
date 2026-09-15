import type { GrowthExportTarget } from "../model/growth-workspace.js";
import type { GrowthResolutionStep, GrowthResolutionTree } from "../model/growth-observation.js";
import { GrowthObservationInvariantError, GrowthObservationUnavailableError } from "../model/growth-observation.js";

/** Translate the existing workspace observer's retained tree, without parsing a
 * manifest or resolving Node conditions again. Arrays and conditions are ordered.
 */
export function projectGrowthResolution(target: GrowthExportTarget): GrowthResolutionTree {
  const budget = { nodes: 0 };
  function visit(value: GrowthExportTarget, depth: number): GrowthResolutionTree {
    if (++budget.nodes > 10_000 || depth > 64) {
      throw new GrowthObservationUnavailableError("growth-resolution-budget-exhausted");
    }
    if (value === null) { return { kind: "null" }; }
    if (typeof value === "string") { return { kind: "target", target: value }; }
    if (Array.isArray(value)) { return { kind: "fallbacks", entries: (value as readonly GrowthExportTarget[]).map((entry) => visit(entry, depth + 1)) }; }
    if (typeof value !== "object") { throw new GrowthObservationInvariantError("invalid-observed-export-target"); }
    return { kind: "conditions", entries: Object.entries(value).map(([condition, entry]) => ({ condition, value: visit(entry, depth + 1) })) };
  }
  return visit(target, 0);
}

/** A typed declaration identity may occur in several ordered branches. This is
 * coordinate attribution only; the existing export observer owns admissibility.
 */
export function growthDeclarationBranches(tree: GrowthResolutionTree, target: string): readonly (readonly GrowthResolutionStep[])[] {
  const branches: (readonly GrowthResolutionStep[])[] = [];
  function visit(value: GrowthResolutionTree, path: readonly GrowthResolutionStep[]): void {
    switch (value.kind) {
      case "target": if (value.target === target) { branches.push(path); } break;
      case "null": break;
      case "conditions": for (const entry of value.entries) { visit(entry.value, [...path, { condition: entry.condition }]); } break;
      case "fallbacks": value.entries.forEach((entry, index) => { visit(entry, [...path, { index }]); }); break;
    }
  }
  visit(tree, []);
  return branches;
}
