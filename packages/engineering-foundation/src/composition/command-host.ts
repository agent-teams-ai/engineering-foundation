import type { FoundationCommandServices } from "../features/command-host/api.js";
import { renderFoundationReportText } from "../features/foundation-check/module.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFoundationCli, nodeCommandCancellation, foundationCommandFailureJson } from "../features/command-host/module.js";
import { promoteArchitectureDecisionBaseline } from "../capabilities/governance-architecture-decisions/module.js";
import { promotePublicApiRelease } from "../capabilities/public-api-compatibility/module.js";
import { createNodeAgentWorkflowCommands } from "../capabilities/repository-agent-workflow/command-module.js";
import { createQualityGateCliCommand, createNodeQualityGateCommand, NodeSignalQualityGateCancellationSource } from "../capabilities/quality-gate-runner/command-module.js";
import { systemNow } from "../local-mode/adapters/outbound/time/system-clock.js";
import { createNodeProcessRunner } from "../local-mode/process-runner.js";
import { FoundationLocalModeService } from "../local-mode/service.js";
import { inspectFoundationPackage } from "../package-self-check.js";
import { installedFoundationVersion } from "../package-version.js";
import { runScaffoldingCliCommand } from "../scaffolding/cli-command.js";
import { isFoundationSchemaId, readFoundationSchema } from "../schema-catalog.js";
import { loadFoundationConfig, runFoundationCheck } from "./foundation-check.js";
import { RULE_REGISTRY } from "./rule-registry.js";

// Executable composition owns the concrete adapters and process environment.
function createCommandServices(environment: NodeJS.ProcessEnv, entrypointUrl: string): FoundationCommandServices {
  const packageRoot = dirname(dirname(fileURLToPath(entrypointUrl)));
  const qualityGate = createQualityGateCliCommand({
    cancellationSource: new NodeSignalQualityGateCancellationSource(),
    commandFactory: createNodeQualityGateCommand,
    foundationConfigLoader: loadFoundationConfig,
    failureJson: foundationCommandFailureJson
  });
  return {
    cancellation: nodeCommandCancellation,
    check: runFoundationCheck,
    renderCheck: renderFoundationReportText,
    readConfig: loadFoundationConfig,
    localMode: new FoundationLocalModeService({ runner: createNodeProcessRunner(environment), now: systemNow }),
    qualityGate: (input) => qualityGate(input, environment),
    agentWorkflow: createNodeAgentWorkflowCommands({
      ...(environment.npm_execpath === undefined ? {} : { npmExecPath: environment.npm_execpath }),
      ...(environment.PNPM_HOME === undefined ? {} : { pnpmHome: environment.PNPM_HOME }),
      ...(environment.PATH === undefined ? {} : { pathValue: environment.PATH })
    }),
    rules: RULE_REGISTRY,
    promoteDecisions: promoteArchitectureDecisionBaseline,
    promotePublicApi: promotePublicApiRelease,
    loadProtobufQualifier: async () => {
      const { qualifyProtobufBreakingEvidence } = await import("../capabilities/contract-protobuf-evolution/qualification/module.js");
      return qualifyProtobufBreakingEvidence;
    },
    scaffold: runScaffoldingCliCommand,
    inspectPackage: () => inspectFoundationPackage(packageRoot),
    installedVersion: installedFoundationVersion,
    isSchemaId: isFoundationSchemaId,
    readSchema: readFoundationSchema
  };
}

export async function runNodeFoundationCli(environment: NodeJS.ProcessEnv, entrypointUrl: string, args: readonly string[]): Promise<void> {
  await runFoundationCli(() => createCommandServices(environment, entrypointUrl), args);
}
