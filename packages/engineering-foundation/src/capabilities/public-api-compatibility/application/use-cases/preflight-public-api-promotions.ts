import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { promotePublicApiBaselines } from "./promote-public-api-baselines.js";

/** Validate every typed and artifact change before the first release-owned write. */
export async function preflightPublicApiPromotions(
  input: Parameters<typeof promotePublicApiBaselines>[0],
  surfaces: readonly Parameters<typeof promotePublicApiBaselines>[1][],
  authorize?: (writes: readonly Awaited<ReturnType<PublicApiRepository["describeReleasedBaselineWrite"]>>[]) => Promise<void>
) {
  const writes: Array<() => Promise<void>> = [];
  const plan: Array<Awaited<ReturnType<PublicApiRepository["describeReleasedBaselineWrite"]>>> = [];
  const results = [];
  for (const dependencies of surfaces) {
    const repository: PublicApiRepository = {
      readReleasedBaseline: dependencies.repository.readReleasedBaseline.bind(dependencies.repository),
      readReleaseEvidence: dependencies.repository.readReleaseEvidence.bind(dependencies.repository),
      describeReleasedBaselineWrite: dependencies.repository.describeReleasedBaselineWrite.bind(dependencies.repository),
      writeReleasedBaseline: async (...args) => {
        plan.push(await dependencies.repository.describeReleasedBaselineWrite(args[0], args[1], args[2], args[4] ?? "replace"));
        writes.push(() => dependencies.repository.writeReleasedBaseline(...args));
      }
    };
    results.push(await promotePublicApiBaselines(input, { ...dependencies, repository }));
  }
  await authorize?.(plan);
  for (const write of writes) { await write(); }
  // Preserve the command's existing typed snapshot result contract.
  return results[0] ?? [];
}
