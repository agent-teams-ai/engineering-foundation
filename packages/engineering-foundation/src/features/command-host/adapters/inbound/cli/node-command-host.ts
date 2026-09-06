import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FoundationCommandServices } from "../../../application/command-services.js";

export function createNodeCommandHost<SchemaId extends string>(
  createServices: (environment: NodeJS.ProcessEnv, readPackageRoot: () => string) => FoundationCommandServices<SchemaId>,
  runCli: (createServices: () => FoundationCommandServices<SchemaId>, args: readonly string[]) => Promise<void>
) {
  return {
    async runNodeFoundationCli(environment: NodeJS.ProcessEnv, entrypointUrl: string, args: readonly string[]): Promise<void> {
      await runCli(() => createServices(environment, () => dirname(dirname(fileURLToPath(entrypointUrl)))), args);
    },
    async runProcessFoundationCli(): Promise<void> {
      await this.runNodeFoundationCli(process.env, new URL("../../../../../cli.js", import.meta.url).href, process.argv.slice(2));
    }
  };
}
