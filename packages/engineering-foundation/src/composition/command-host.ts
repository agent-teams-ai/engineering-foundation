import { createFoundationCommandHost } from "../features/command-host/node.js";
import { scaffoldingApi } from "./scaffolding-api.js";
import { FoundationLocalModeService } from "./local-mode-service.js";
import { inspectFoundationPackage } from "./local-package-inspection.js";
import { assertSchema, isFoundationSchemaId, readFoundationSchema } from "../schema-catalog.js";
import { loadFoundationConfig, runFoundationCheck } from "./foundation-check.js";
import { RULE_REGISTRY } from "./rule-registry.js";

const host = createFoundationCommandHost({
  scaffoldingApi, FoundationLocalModeService, inspectFoundationPackage,
  assertSchema, isFoundationSchemaId, readFoundationSchema,
  loadFoundationConfig, runFoundationCheck, RULE_REGISTRY
});

export async function runNodeFoundationCli(environment: NodeJS.ProcessEnv, entrypointUrl: string, args: readonly string[]): Promise<void> {
  return host.runNodeFoundationCli(environment, entrypointUrl, args);
}

export async function runProcessFoundationCli(): Promise<void> {
  return host.runProcessFoundationCli();
}
