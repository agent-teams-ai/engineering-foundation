import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { inspectContainedRegularFile, readContainedRegularFile } from "../../../source-inventory/node.js";
import { createProcessExecution } from "../adapters/outbound/process/process-execution.js";
import type { WorkflowProcessExecutor } from "../application/ports/process-execution.js";
import { createAgentWorkflowChangedCommand } from "../adapters/inbound/cli/changed-command.js";
import { createAgentWorkflowInstructionsCommand } from "../adapters/inbound/cli/instructions-command.js";
import { GitRepositoryChangesReader } from "../adapters/outbound/git/git-repository-changes-reader.js";
import { PnpmPackageScriptRunner, type PnpmProcessEnvironment } from "../adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { BunPackageScriptRunner, type BunProcessEnvironment } from "../adapters/outbound/bun/bun-package-script-runner.js";
import { FilesystemEffectiveInstructionsReader } from "../adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { loadAgentWorkflowPolicy, type AgentWorkflowConfigurationDependencies } from "../adapters/inbound/configuration/load-agent-workflow-policy.js";
import { loadStrictYamlFile } from "../../../features/configuration-input/node.js";
import { resolveRepositoryRuntimeExecutables } from "../../../process-execution/application/runtime-selection.js";
import { createPackageManagerScriptRunner } from "./select-package-script-runner.js";
import { verifyRepositoryRuntimeExecutable } from "../../../process-execution/module.js";

export function createNodeAgentWorkflowCommands(
  environment: PnpmProcessEnvironment & BunProcessEnvironment & {
    readonly processEnvironment: Readonly<Record<string, string | undefined>>;
  },
  executor: WorkflowProcessExecutor,
  assertSchema: AgentWorkflowConfigurationDependencies["assertSchema"]
) {
  const execute = createProcessExecution(executor, environment.processEnvironment);
  const scriptRunner = {
    async run(input: {
      readonly packageManager: "bun" | "pnpm";
      readonly consumerRoot: string;
      readonly script: string;
      readonly paths: readonly string[];
      readonly signal?: AbortSignal;
    }) {
      const runtime = await resolveRepositoryRuntimeExecutables({
        environment: {
          ...(environment.nodeExecutablePath === undefined
            ? {}
            : { AGENT_TEAMS_FOUNDATION_NODE_EXECUTABLE: environment.nodeExecutablePath }),
          ...(environment.bunExecutablePath === undefined
            ? {}
            : { AGENT_TEAMS_FOUNDATION_BUN_EXECUTABLE: environment.bunExecutablePath })
        },
        currentExecutablePath: process.execPath,
        currentRuntime:
          "bun" in process.versions &&
          typeof process.versions["bun"] === "string"
            ? "bun"
            : "node",
        verifyExecutable: verifyRepositoryRuntimeExecutable
      }).catch((error: unknown) => {
        throw new CapabilityInputError({
          code: "REPOSITORY_AGENT_WORKFLOW_RUNTIME_INVALID",
          message: error instanceof Error ? error.message : "Repository runtime selection failed.",
          phase: "repository-agent-workflow-runtime",
          retryable: false
        });
      });
      return createPackageManagerScriptRunner({
        bun: new BunPackageScriptRunner(
          runtime.executables.bun === undefined
            ? {}
            : { bunExecutablePath: runtime.executables.bun },
          execute
        ),
        pnpm: new PnpmPackageScriptRunner({
          ...environment,
          nodeExecutablePath: runtime.executables.node
        }, execute)
      }).run(input);
    }
  };
  return {
    changed: createAgentWorkflowChangedCommand({
      changesReader: new GitRepositoryChangesReader(execute),
      scriptRunner,
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
