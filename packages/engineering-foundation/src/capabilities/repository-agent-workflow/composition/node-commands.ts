import { createProcessExecution } from "../adapters/outbound/process/process-execution.js";
import type { WorkflowProcessExecutor } from "../application/ports/process-execution.js";
import { createAgentWorkflowChangedCommand } from "../adapters/inbound/cli/changed-command.js";
import { createAgentWorkflowInstructionsCommand } from "../adapters/inbound/cli/instructions-command.js";
import { GitRepositoryChangesReader } from "../adapters/outbound/git/git-repository-changes-reader.js";
import { PnpmPackageScriptRunner, type PnpmProcessEnvironment } from "../adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { FilesystemEffectiveInstructionsReader } from "../adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { loadAgentWorkflowPolicy, type AgentWorkflowConfigurationDependencies } from "../adapters/inbound/configuration/load-agent-workflow-policy.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";

export function createNodeAgentWorkflowCommands(
  environment: PnpmProcessEnvironment,
  executor: WorkflowProcessExecutor,
  assertSchema: AgentWorkflowConfigurationDependencies["assertSchema"]
) {
  const execute = createProcessExecution(executor);
  return {
    changed: createAgentWorkflowChangedCommand({
      changesReader: new GitRepositoryChangesReader(execute),
      scriptRunner: new PnpmPackageScriptRunner(environment, execute),
      loadPolicy: (consumerRoot, configPath, signal) => loadAgentWorkflowPolicy(
        { readYaml: loadStrictYamlFile, assertSchema }, consumerRoot, configPath, signal
      )
    }),
    instructions: createAgentWorkflowInstructionsCommand(new FilesystemEffectiveInstructionsReader())
  };
}
