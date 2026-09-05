import { createAgentWorkflowChangedCommand } from "../adapters/inbound/cli/changed-command.js";
import { createAgentWorkflowInstructionsCommand } from "../adapters/inbound/cli/instructions-command.js";
import { GitRepositoryChangesReader } from "../adapters/outbound/git/git-repository-changes-reader.js";
import { PnpmPackageScriptRunner, type PnpmProcessEnvironment } from "../adapters/outbound/pnpm/pnpm-package-script-runner.js";
import { FilesystemEffectiveInstructionsReader } from "../adapters/outbound/filesystem/filesystem-effective-instructions-reader.js";
import { loadAgentWorkflowPolicy } from "../contract/config.js";

export function createNodeAgentWorkflowCommands(environment: PnpmProcessEnvironment) {
  return {
    changed: createAgentWorkflowChangedCommand({
      changesReader: new GitRepositoryChangesReader(),
      scriptRunner: new PnpmPackageScriptRunner(environment),
      loadPolicy: loadAgentWorkflowPolicy
    }),
    instructions: createAgentWorkflowInstructionsCommand(new FilesystemEffectiveInstructionsReader())
  };
}
