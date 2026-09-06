export { readNodeProcessInputs } from "./node-process-inputs.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FoundationCommandServices } from "../../../application/command-services.js";

export function createNodeCommandHost<SchemaId extends string>(
  createServices: (environment: NodeJS.ProcessEnv, readPackageRoot: () => string) => FoundationCommandServices<SchemaId>,
  runCli: (createServices: () => FoundationCommandServices<SchemaId>, args: readonly string[]) => Promise<void>,
  readProcessInputs: () => { readonly environment: NodeJS.ProcessEnv; readonly entrypointUrl: string; readonly args: readonly string[] }
) {
  return {
    async runNodeFoundationCli(environment: NodeJS.ProcessEnv, entrypointUrl: string, args: readonly string[]): Promise<void> {
      await runCli(() => createServices(environment, () => dirname(dirname(fileURLToPath(entrypointUrl)))), args);
    },
    async runProcessFoundationCli(): Promise<void> {
      const input = readProcessInputs();
      await this.runNodeFoundationCli(input.environment, input.entrypointUrl, input.args);
    }
  };
}
