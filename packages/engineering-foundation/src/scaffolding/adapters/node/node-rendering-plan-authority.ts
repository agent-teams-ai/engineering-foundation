import type { ScaffoldPlanV1 } from "../../contract/types.js";
import { createRenderingRegressionRegistry } from "../../definitions/registry.js";
import { compileScaffoldPlan } from "../../kernel/rendering-plan-compiler.js";
import { ScaffoldError } from "../../scaffold-error.js";
import { installedFoundationVersion } from "./installed-foundation-version.js";
import { loadScaffoldCompilationInputFromIntent } from "./node-input-loader.js";

export async function assertRenderingPlanMatchesConsumerAuthority(
  consumerRoot: string,
  plan: ScaffoldPlanV1
): Promise<void> {
  const input = await loadScaffoldCompilationInputFromIntent({
    consumerRoot,
    configPath: plan.authority.configPath,
    foundationVersion: await installedFoundationVersion(),
    intent: plan.intent
  });
  const expected = compileScaffoldPlan(
    input,
    createRenderingRegressionRegistry()
  );
  if (expected.planDigest !== plan.planDigest) {
    throw new ScaffoldError(
      "SCAFFOLD_PLAN_INVALID",
      "Scaffolding Plan was not produced by the closed compiler from current consumer authority."
    );
  }
}
