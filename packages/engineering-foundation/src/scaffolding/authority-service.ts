import {
  loadAuthorityScaffoldCompilationInputFromFile
} from "./adapters/node/node-authority-input-loader.js";
import { installedFoundationVersion } from "./adapters/node/installed-foundation-version.js";
import type { AuthorityScaffoldPlan } from "./contract/types.js";
import { createDefaultScaffoldRegistry } from "./definitions/registry.js";
import { compileAuthorityScaffoldPlan } from "./kernel/authority-compiler.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "./scaffold-defaults.js";

export async function planAuthorityScaffoldFromFile(options: {
  readonly consumerRoot: string;
  readonly intentPath: string;
  readonly configPath?: string;
}): Promise<AuthorityScaffoldPlan> {
  const input = await loadAuthorityScaffoldCompilationInputFromFile({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath ?? DEFAULT_SCAFFOLDING_CONFIG_PATH,
    intentPath: options.intentPath,
    foundationVersion: await installedFoundationVersion()
  });
  return compileAuthorityScaffoldPlan(input, createDefaultScaffoldRegistry());
}
