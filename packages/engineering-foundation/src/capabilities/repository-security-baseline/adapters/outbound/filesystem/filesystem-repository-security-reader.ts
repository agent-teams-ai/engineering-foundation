import { assertNotCancelled } from "../../../../../features/validation-reporting/api.js";
import type {
  RepositorySecurityEvidence,
  RepositorySecurityPolicy
} from "../../../application/model/repository-security.js";
import type { RepositorySecurityReader } from "../../../application/ports/repository-security-reader.js";
import { readPublishablePackageEvidence } from "./publishable-package-evidence-reader.js";
import { resolveConsumerRoot } from "./repository-security-filesystem.js";
import { repositorySecurityInputError } from "./repository-security-input.js";
import { readSecurityToolEvidence } from "./security-tool-evidence-reader.js";
import { readWorkflowDirectoryEvidence } from "./workflow-evidence-reader.js";

function requireConfiguredWorkflows(
  workflows: RepositorySecurityEvidence["workflows"],
  policy: RepositorySecurityPolicy
): void {
  for (const requiredWorkflow of [policy.dependencyReview.workflowPath, policy.sbomWorkflow]) {
    if (!workflows.some(({ path }) => path === requiredWorkflow)) {
      repositorySecurityInputError(
        "REPOSITORY_SECURITY_REQUIRED_WORKFLOW_UNAVAILABLE",
        `Required security workflow is not discovered: ${requiredWorkflow}.`
      );
    }
  }
}

export class FilesystemRepositorySecurityReader implements RepositorySecurityReader {
  async read(
    consumerRoot: string,
    policy: RepositorySecurityPolicy,
    signal?: AbortSignal
  ): Promise<RepositorySecurityEvidence> {
    assertNotCancelled(signal);
    const root = await resolveConsumerRoot(consumerRoot);
    const [workflowDirectory, packages] = await Promise.all([
      readWorkflowDirectoryEvidence(root, policy, signal),
      Promise.all(
        policy.publishablePackageManifests.map((manifestPath) =>
          readPublishablePackageEvidence(root, manifestPath)
        )
      )
    ]);
    requireConfiguredWorkflows(workflowDirectory.workflows, policy);
    const toolEvidence = await readSecurityToolEvidence(
      root,
      policy,
      workflowDirectory.workflowDigest
    );
    return Object.freeze({
      compositeActions: workflowDirectory.compositeActions,
      workflows: workflowDirectory.workflows,
      workflowUses: workflowDirectory.workflowUses,
      workflowDigest: workflowDirectory.workflowDigest,
      packages: Object.freeze(packages),
      toolEvidence: Object.freeze(toolEvidence)
    });
  }
}
