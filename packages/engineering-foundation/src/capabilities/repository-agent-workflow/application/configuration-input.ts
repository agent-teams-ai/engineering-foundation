import { CapabilityInputError } from "../../../features/validation-reporting/api.js";
import { assertRepositoryRelativePath } from "../../../source-inventory/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "REPOSITORY_AGENT_WORKFLOW_CONFIG_INVALID",
    message,
    phase: "repository-agent-workflow-config",
    retryable: false
  });
}


export function assertConfigRepositoryRelativePath(path: string): void {
  assertRepositoryRelativePath(path, "repository-agent-workflow-config");
}
