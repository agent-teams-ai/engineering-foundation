import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { promotePublicApiBaselines } from "./promote-public-api-baselines.js";

/** Validate every typed and artifact change before the first release-owned write. */
export async function preflightPublicApiPromotions(
  input: Parameters<typeof promotePublicApiBaselines>[0],
  surfaces: readonly Parameters<typeof promotePublicApiBaselines>[1][]
) {
  const writes: Array<() => Promise<void>> = [];
  const results = [];
  for (const dependencies of surfaces) {
    const repository: PublicApiRepository = {
      readReleasedBaseline: dependencies.repository.readReleasedBaseline.bind(dependencies.repository),
      readReleaseEvidence: dependencies.repository.readReleaseEvidence.bind(dependencies.repository),
      writeReleasedBaseline: (...args) => {
        writes.push(() => dependencies.repository.writeReleasedBaseline(...args));
        return Promise.resolve();
      }
    };
    results.push(await promotePublicApiBaselines(input, { ...dependencies, repository }));
  }
  for (const write of writes) { await write(); }
  // Preserve the command's existing typed snapshot result contract.
  return results[0] ?? [];
}
