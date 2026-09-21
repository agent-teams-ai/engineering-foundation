import type { GrowthCancellation, GrowthCoverage, GrowthSurfaceObservation } from "../model/growth-observation.js";
import type { GrowthContextRequest, GrowthInputContext } from "../model/growth-admission-context.js";
import type { ResolvedGrowthAuthority } from "../model/growth-authority.js";

/** Input evidence only. Candidate/config files never establish verified
 * authority. Future trusted composition supplies independently verified context;
 * current S1 records alone cannot fill missing retained or initial history. */
export interface GrowthInputContextPort {
  read(request: GrowthContextRequest, cancellation: GrowthCancellation): Promise<GrowthInputContext>;
}

export interface GrowthPackedCandidateEvidence {
  readonly packageName: string;
  readonly observation: GrowthSurfaceObservation;
  readonly coverage: GrowthCoverage;
}

export interface ResolvedGrowthInputContextPort extends GrowthInputContextPort {
  resolution(): ResolvedGrowthAuthority;
  packedCandidates(): readonly GrowthPackedCandidateEvidence[];
}
