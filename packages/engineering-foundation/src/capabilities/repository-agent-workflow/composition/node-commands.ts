import { inspectContainedRegularFile, readContainedRegularFile } from "../../../source-inventory/node.js";
import { createProcessExecution } from "../adapters/outbound/process/process-execution.js";
import type { WorkflowProcessExecutor } from "../application/ports/process-execution.js";
import { createAgentWorkflowChangedCommand } from "../adapters/inbound/cli/changed-command.js";
import { createAgentWorkflowCheckChangedCommand } from "../adapters/inbound/cli/check-changed-command.js";
import { createAgentWorkflowInstructionsCommand } from "../adapters/inbound/cli/instructions-command.js";
import { GitRepositoryChangesReader } from "../adapters/outbound/git/git-repository-changes-reader.js";
import { PnpmPackageScriptRunner, type PnpmProcessEnvironment } from "../adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { FilesystemEffectiveInstructionsReader } from "../adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { loadAgentWorkflowPolicy } from "../adapters/inbound/configuration/load-agent-workflow-policy.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import { loadAgentWorkflowPolicyV2 } from "../adapters/inbound/configuration/load-agent-workflow-policy-v2.js";
import type { VersionedWorkflowDependencies } from "../adapters/inbound/configuration/load-versioned-agent-workflow-policy.js";
import { createMutableCheckInputCustody } from "../adapters/outbound/filesystem/mutable-check-input-custody.js";
import { createMutablePnpmCheckRunner } from "../adapters/outbound/pnpm/mutable-pnpm-check-runner.js";

export function createNodeAgentWorkflowCommands(
  environment: PnpmProcessEnvironment,
  executor: WorkflowProcessExecutor,
  assertSchema: VersionedWorkflowDependencies["assertSchema"]
) {
  const execute = createProcessExecution(executor);
  return {
    checkChanged: createAgentWorkflowCheckChangedCommand({
      custody: createMutableCheckInputCustody(execute),
      runner: createMutablePnpmCheckRunner(environment, execute),
      loadPolicy: (consumerRoot, configPath, signal) => loadAgentWorkflowPolicyV2(
        { readYaml: loadStrictYamlFile, assertSchema }, consumerRoot, configPath, signal
      ),
      writeReport: (text) => { process.stdout.write(text); },
      setExitCode: (code) => { process.exitCode = code; }
    }),
    changed: createAgentWorkflowChangedCommand({
      changesReader: new GitRepositoryChangesReader(execute),
      scriptRunner: new PnpmPackageScriptRunner(environment, execute),
      loadPolicy: (consumerRoot, configPath, signal) => loadAgentWorkflowPolicy(
        { readYaml: loadStrictYamlFile, assertSchema }, consumerRoot, configPath, signal
      )
    }),
    instructions: createAgentWorkflowInstructionsCommand(new FilesystemEffectiveInstructionsReader({
      read: readContainedRegularFile,
      inspect: inspectContainedRegularFile
    }))
  };
}
