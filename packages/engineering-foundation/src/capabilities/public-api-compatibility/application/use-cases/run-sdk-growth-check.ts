import { assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import { GrowthObservationInvariantError } from "../model/growth-observation.js";
import type { GrowthInvocation } from "../model/growth-observation.js";
import type { GrowthWorkspaceInventory } from "../model/growth-workspace.js";
import type { GrowthWorkspaceReader } from "../ports/growth-workspace.js";
import { assertGrowthReportDestination } from "../policies/growth-report-destination.js";
import { growthWorkspaceObservationKey } from "../policies/growth-workspace-observation-key.js";
import { checkSdkGrowth } from "./check-sdk-growth.js";

type SdkGrowthCheckInput = Omit<Parameters<typeof checkSdkGrowth>[0], "invocation">;

export interface SdkGrowthCheckDependencies extends Omit<
  Parameters<typeof checkSdkGrowth>[1],
  "readInvocation" | "workspace"
> {
  readonly workspace: GrowthWorkspaceReader;
  readonly readInvocation: (
    consumerRoot: string,
    inventory: GrowthWorkspaceInventory,
    signal?: AbortSignal,
  ) => Promise<GrowthInvocation>;
  readonly assertDestination: (consumerRoot: string, path: string) => Promise<void>;
}

/** Own the inventory lifetime used by one SDK check. Reobservation brackets
 * invocation identity and precedes publication; it does not freeze the filesystem.
 */
export async function runSdkGrowthCheck(
  input: SdkGrowthCheckInput,
  dependencies: SdkGrowthCheckDependencies,
) {
  const { consumerRoot, policy, signal } = input;
  assertNotCancelled(signal);
  await dependencies.assertDestination(consumerRoot, policy.sdkGrowth.reportPath);
  assertNotCancelled(signal);

  const readWorkspace = async () => {
    assertNotCancelled(signal);
    const inventory = structuredClone(
      await dependencies.workspace.read(consumerRoot, "pnpm-workspace.yaml", signal),
    );
    assertNotCancelled(signal);
    return inventory;
  };
  const capture = async (expectedKey?: string) => {
    const inventory = await readWorkspace();
    const key = growthWorkspaceObservationKey(inventory);
    if (expectedKey !== undefined && key !== expectedKey) {
      throw new GrowthObservationInvariantError("growth-execution-inputs-changed");
    }
    assertGrowthReportDestination(
      policy.sdkGrowth.reportPath,
      inventory.packages.flatMap((pkg) => [pkg.rootPath, pkg.manifestPath]),
    );
    const invocation = await dependencies.readInvocation(consumerRoot, inventory, signal);
    assertNotCancelled(signal);
    if (growthWorkspaceObservationKey(await readWorkspace()) !== key) {
      throw new GrowthObservationInvariantError("growth-execution-inputs-changed");
    }
    return { inventory, invocation, key };
  };

  const initial = await capture();
  return checkSdkGrowth(
    { ...input, invocation: initial.invocation },
    {
      ...dependencies,
      // A stable projection for policy, backed by the initial and final captures.
      workspace: { read: async () => structuredClone(initial.inventory) },
      async readInvocation(cancellation) {
        cancellation.throwIfCancelled();
        const current = await capture(initial.key);
        return current.invocation;
      },
    },
  );
}
