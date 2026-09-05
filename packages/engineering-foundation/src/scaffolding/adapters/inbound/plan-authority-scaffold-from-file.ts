import type { ScaffoldSchemaValidator } from "../schema-validation.js";
import {
  loadAuthorityScaffoldCompilationInputFromFile
} from "../node/node-authority-input-loader.js";
import { installedFoundationVersion } from "../node/installed-foundation-version.js";
import type {
  AuthorityScaffoldPlan
} from "../../application/model/scaffold-compilation.js";
import type { ScaffoldDefinitionRegistry } from "../../kernel/definition-registry.js";
import { compileAuthorityScaffoldPlan } from "../../kernel/authority-compiler.js";
import { DEFAULT_SCAFFOLDING_CONFIG_PATH } from "../../scaffold-defaults.js";

export async function planAuthorityScaffoldFromFile(options: {
  readonly consumerRoot: string;
  readonly intentPath: string;
  readonly configPath?: string;
}, assertSchema: ScaffoldSchemaValidator,
createRegistry: () => ScaffoldDefinitionRegistry): Promise<AuthorityScaffoldPlan> {
  const input = await loadAuthorityScaffoldCompilationInputFromFile({
    consumerRoot: options.consumerRoot,
    configPath: options.configPath ?? DEFAULT_SCAFFOLDING_CONFIG_PATH,
    intentPath: options.intentPath,
    foundationVersion: await installedFoundationVersion()
  }, assertSchema);
  return compileAuthorityScaffoldPlan(input, createRegistry());
}
