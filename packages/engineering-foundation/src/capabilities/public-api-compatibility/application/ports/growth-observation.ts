import type { GrowthCancellation, GrowthInvocation, GrowthObservationExecution } from "../model/growth-observation.js";

/** Internal S1 boundary. No release, decision or activation authority. */
export interface GrowthObservationPort {
  observe(invocation: GrowthInvocation, cancellation: GrowthCancellation): Promise<GrowthObservationExecution>;
}
