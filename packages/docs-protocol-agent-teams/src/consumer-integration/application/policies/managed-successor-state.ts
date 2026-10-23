import { projectManagedSuccessorStateBody } from "./consumer-integration-assets.js";
import type { ManagedSuccessorAssetDigests, ManagedSuccessorProfile } from "../../domain/model.js";

export type { ManagedSuccessorAssetDigests, ManagedSuccessorProfile } from "../../domain/model.js";

/** Projects inert successor data; it neither selects a cohort nor writes a consumer file. */
export function projectManagedSuccessorState(
  profile: ManagedSuccessorProfile,
  assets: ManagedSuccessorAssetDigests,
): string {
  return projectManagedSuccessorStateBody(profile, assets);
}
