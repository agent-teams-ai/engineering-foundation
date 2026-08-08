import { loadScaffoldCompilationInput } from "./adapters/node/node-input-loader.js";
import { installedFoundationVersion } from "./adapters/node/installed-foundation-version.js";
import type { ScaffoldPlanV1 } from "./contract/types.js";
import { createRenderingRegressionRegistry } from "./definitions/registry.js";
import { compileScaffoldPlan } from "./kernel/rendering-plan-compiler.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffold-defaults.js";

/** Retains the released 0.5 rendering planner for regression evidence only. */
export async function planScaffoldFromFile(options: {
  readonly consumerRoot: string;
  readonly intentPath: string;
  readonly configPath?: string;
}): Promise<ScaffoldPlanV1> {
  const input = await loadScaffoldCompilationInput({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath ?? DEFAULT_SCAFFOLDING_CONFIG_PATH,
    intentPath: options.intentPath,
    foundationVersion: await installedFoundationVersion()
  });
  return compileScaffoldPlan(
    input,
    createRenderingRegressionRegistry()
  );
}
