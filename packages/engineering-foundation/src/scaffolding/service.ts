import { loadScaffoldCompilationInput } from "./adapters/node/node-input-loader.js";
import { installedFoundationVersion } from "./adapters/node/installed-foundation-version.js";
import type { ScaffoldPlanV1 } from "./contract/types.js";
import { createDefaultScaffoldRegistry } from "./definitions/registry.js";
import { compileScaffoldPlan } from "./kernel/compiler.js";

export const DEFAULT_SCAFFOLDING_CONFIG_PATH =
  "architecture/foundation/scaffolding.yaml";

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
    createDefaultScaffoldRegistry()
  );
}
