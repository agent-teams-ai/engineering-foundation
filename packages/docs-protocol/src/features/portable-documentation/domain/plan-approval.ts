const PLAN_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export type PlanApproval =
  | Readonly<{ state: "direct" | "pending" | "matched" }>
  | Readonly<{ state: "malformed" | "stale" }>;

export function inspectPlanApproval(
  expectedPlanDigest: unknown,
  actualPlanDigest?: string
): PlanApproval {
  if (expectedPlanDigest === undefined) {return Object.freeze({ state: "direct" });}
  if (typeof expectedPlanDigest !== "string" || !PLAN_DIGEST.test(expectedPlanDigest)) {return Object.freeze({ state: "malformed" });}
  if (actualPlanDigest === undefined) {return Object.freeze({ state: "pending" });}
  if (expectedPlanDigest !== actualPlanDigest) {
    return Object.freeze({ state: "stale" });
  }
  return Object.freeze({ state: "matched" });
}
