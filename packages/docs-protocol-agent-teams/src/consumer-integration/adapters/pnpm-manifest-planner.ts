import type { PnpmManifestPlanner } from "../application-api.js";
import { planPnpmManifestV1 } from "./pnpm-manifest-adapter-v1.js";
import { planPnpmManifestV2 } from "./pnpm-manifest-adapter-v2.js";

export const pnpmManifestPlanner: PnpmManifestPlanner = Object.freeze({
  plan(
    input: Parameters<PnpmManifestPlanner["plan"]>[0]
  ): ReturnType<PnpmManifestPlanner["plan"]> {
    const common = {
      observation: input.observation,
      profilePath: input.profilePath,
      ...(input.knownPriorScriptsDigest === undefined
        ? {}
        : { knownPriorScriptsDigest: input.knownPriorScriptsDigest })
    };
    switch (input.cohort.schemaVersion) {
      case 1:
        return planPnpmManifestV1({ ...common, cohort: input.cohort });
      case 2:
        return planPnpmManifestV2({ ...common, cohort: input.cohort });
      default:
        throw new TypeError("Unsupported Qualified Docs Cohort schema version.");
    }
  }
});
