import type { ScaffoldPlanV1 } from "../../contract/types.js";
import { createDefaultScaffoldRegistry } from "../../definitions/registry.js";
import { compileScaffoldPlan } from "../../kernel/compiler.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { installedFoundationVersion } from "./installed-foundation-version.js";
import { loadScaffoldCompilationInputFromIntent } from "./node-input-loader.js";

export async function assertPlanMatchesConsumerAuthority(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<void> {
  const input = await loadScaffoldCompilationInputFromIntent({
    consumerRoot,
    configPath: plan.authority.configPath,
    foundationVersion: await installedFoundationVersion(),
    intent: plan.intent
  });
  const expected = compileScaffoldPlan(input, createDefaultScaffoldRegistry());
  if (expected.planDigest !== plan.planDigest) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan was not produced by the closed compiler from current consumer authority."
    );
  }
}
