import type { FoundationCommandServices } from "../api.js";
import type { qualifyProtobufBreakingEvidence } from "../../../capabilities/contract-protobuf-evolution/qualification/module.js";
import { renderFoundationReportText } from "../../../features/foundation-check/module.js";
import { runFoundationCli } from "../adapters/inbound/cli/foundation-cli.js";
import { nodeCommandCancellation } from "../adapters/inbound/cli/node-process-lifecycle.js";
import { foundationCommandFailureJson } from "../application/command-failure.js";
import { createNodeCommandHost, readNodeProcessInputs } from "../adapters/inbound/cli/node-command-host.js";
import { createManagedProcessExecutor } from "../../../process-execution/module.js";
import { promoteArchitectureDecisionBaseline, readAcceptedArchitectureDecisionEvidence } from "../../../capabilities/governance-architecture-decisions/module.js";
import { promotePublicApiRelease } from "../../../capabilities/public-api-compatibility/module.js";
import { createNodeAgentWorkflowCommands } from "../../../capabilities/repository-agent-workflow/command-module.js";
import { createQualityGateCliCommand, createNodeQualityGateCommand, NodeSignalQualityGateCancellationSource } from "../../../capabilities/quality-gate-runner/command-module.js";
import { systemNow } from "../../../local-mode/adapters/outbound/time/system-clock.js";
import { createNodeProcessRunner } from "../../../local-mode/composition/process-runner.js";
import { installedFoundationVersion } from "../../../transaction-coordination/adapters/node/installed-foundation-version.js";
import { runScaffoldingCliCommand } from "../../../scaffolding/composition/node-scaffolding.js";

export interface CommandHostDependencies<SchemaId extends string> {
  readonly artifactSchemaInspector: Parameters<typeof promotePublicApiRelease>[3];
  readonly scaffoldingApi: Parameters<typeof runScaffoldingCliCommand>[2];
  readonly assertSchema: Parameters<typeof createNodeQualityGateCommand>[2]
    & Parameters<typeof promoteArchitectureDecisionBaseline>[1]
    & Parameters<typeof promotePublicApiRelease>[2]
    & Parameters<typeof createNodeAgentWorkflowCommands>[2]
    & Parameters<typeof qualifyProtobufBreakingEvidence>[2];
  readonly loadFoundationConfig: FoundationCommandServices["readConfig"];
  readonly runFoundationCheck: FoundationCommandServices["check"];
  readonly RULE_REGISTRY: FoundationCommandServices["rules"];
  readonly FoundationLocalModeService: new (options: import("../../../local-mode/api.js").FoundationLocalModeServiceOptions) => FoundationCommandServices["localMode"];
  readonly inspectFoundationPackage: (packageRoot: string) => Promise<unknown>;
  readonly isFoundationSchemaId: FoundationCommandServices<SchemaId>["isSchemaId"];
  readonly readFoundationSchema: FoundationCommandServices<SchemaId>["readSchema"];
}

// Select feature integrations without reaching back into module assembly.
function createCommandServices<SchemaId extends string>(dependencies: CommandHostDependencies<SchemaId>, environment: NodeJS.ProcessEnv, readPackageRoot: () => string): FoundationCommandServices<SchemaId> {
  const processExecutor = createManagedProcessExecutor();
  const packageRoot = readPackageRoot();
  const { scaffoldingApi, assertSchema, loadFoundationConfig, runFoundationCheck, RULE_REGISTRY, FoundationLocalModeService, inspectFoundationPackage, isFoundationSchemaId, readFoundationSchema } = dependencies;
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
    promotePublicApi: (input) => promotePublicApiRelease(input, (request) => readAcceptedArchitectureDecisionEvidence(request, assertSchema), assertSchema, dependencies.artifactSchemaInspector),
    loadProtobufQualifier: async () => {
      const { qualifyProtobufBreakingEvidence } = await import("../../../capabilities/contract-protobuf-evolution/qualification/module.js");
      return (input) => qualifyProtobufBreakingEvidence(input, processExecutor, assertSchema);
    },
    scaffold: (parsed, json) => runScaffoldingCliCommand(parsed, json, scaffoldingApi),
    inspectPackage: () => inspectFoundationPackage(packageRoot),
    installedVersion: installedFoundationVersion,
    isSchemaId: isFoundationSchemaId,
    readSchema: readFoundationSchema
  };
}

export function createFoundationCommandHost<SchemaId extends string>(dependencies: CommandHostDependencies<SchemaId>) {
  return createNodeCommandHost((environment, packageRoot) =>
    createCommandServices(dependencies, environment, packageRoot), runFoundationCli, readNodeProcessInputs);
}
