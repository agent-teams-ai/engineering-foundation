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
      describeReleasedBaselineWrite: async (...args) => {
        if (typeof dependencies.repository.describeReleasedBaselineWrite !== "function") {
          throw new TypeError("Public API baseline authorization requires a write-plan adapter.");
        }
        return dependencies.repository.describeReleasedBaselineWrite(...args);
      },
      writeReleasedBaseline: async (...args) => {
        if (authorize !== undefined) {
          plan.push(await repository.describeReleasedBaselineWrite(args[0], args[1], args[2], args[4] ?? "replace"));
        }
        writes.push(() => authorize === undefined
          ? dependencies.repository.writeReleasedBaseline(...args)
          : dependencies.repository.writeReleasedBaseline(args[0], args[1], args[2], undefined, args[4]));
      }
    };
    results.push(await promotePublicApiBaselines(input, { ...dependencies, repository }));
  }
  await authorize?.(plan);
  for (const write of writes) { await write(); }
  // Preserve the command's existing typed snapshot result contract.
  return results[0] ?? [];
}
