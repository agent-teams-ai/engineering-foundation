import { scaffoldingApi } from "./scaffolding-api.js";
import type { FoundationCommandServices } from "../features/command-host/api.js";
import type { FoundationSchemaId } from "../schema-ids.js";
import { renderFoundationReportText } from "../features/foundation-check/module.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runFoundationCli, nodeCommandCancellation, foundationCommandFailureJson } from "../features/command-host/module.js";
import { createManagedProcessExecutor } from "../process-execution/module.js";
import { promoteArchitectureDecisionBaseline, readAcceptedArchitectureDecisionEvidence } from "../capabilities/governance-architecture-decisions/module.js";
import { promotePublicApiRelease } from "../capabilities/public-api-compatibility/module.js";
import { createNodeAgentWorkflowCommands } from "../capabilities/repository-agent-workflow/command-module.js";
import { createQualityGateCliCommand, createNodeQualityGateCommand, NodeSignalQualityGateCancellationSource } from "../capabilities/quality-gate-runner/command-module.js";
import { systemNow } from "../local-mode/adapters/outbound/time/system-clock.js";
import { createNodeProcessRunner } from "../local-mode/composition/process-runner.js";
import { FoundationLocalModeService } from "./local-mode-service.js";
import { inspectFoundationPackage } from "./local-package-inspection.js";
import { installedFoundationVersion } from "../transaction-coordination/adapters/node/installed-foundation-version.js";
import { runScaffoldingCliCommand } from "../scaffolding/adapters/inbound/scaffolding-cli-command.js";
import { assertSchema, isFoundationSchemaId, readFoundationSchema } from "../schema-catalog.js";
import { loadFoundationConfig, runFoundationCheck } from "./foundation-check.js";
import { RULE_REGISTRY } from "./rule-registry.js";

// Executable composition owns the concrete adapters and process environment.
function createCommandServices(environment: NodeJS.ProcessEnv, entrypointUrl: string): FoundationCommandServices<FoundationSchemaId> {
  const processExecutor = createManagedProcessExecutor();
  const packageRoot = dirname(dirname(fileURLToPath(entrypointUrl)));
  const qualityGate = createQualityGateCliCommand({
    cancellationSource: new NodeSignalQualityGateCancellationSource(),
    commandFactory: (snapshot) => createNodeQualityGateCommand(snapshot, processExecutor, assertSchema),
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
    }, processExecutor, assertSchema),
    rules: RULE_REGISTRY,
    promoteDecisions: (input) => promoteArchitectureDecisionBaseline(input, assertSchema),
    promotePublicApi: (input) => promotePublicApiRelease(input, (request) => readAcceptedArchitectureDecisionEvidence(request, assertSchema), assertSchema),
    loadProtobufQualifier: async () => {
      const { qualifyProtobufBreakingEvidence } = await import("../capabilities/contract-protobuf-evolution/qualification/module.js");
      return (input) => qualifyProtobufBreakingEvidence(input, processExecutor, assertSchema);
    },
    scaffold: (parsed, json) => runScaffoldingCliCommand(parsed, json, scaffoldingApi),
    inspectPackage: () => inspectFoundationPackage(packageRoot),
    installedVersion: installedFoundationVersion,
    isSchemaId: isFoundationSchemaId,
    readSchema: readFoundationSchema
  };
}

export async function runNodeFoundationCli(environment: NodeJS.ProcessEnv, entrypointUrl: string, args: readonly string[]): Promise<void> {
  await runFoundationCli(() => createCommandServices(environment, entrypointUrl), args);
}
