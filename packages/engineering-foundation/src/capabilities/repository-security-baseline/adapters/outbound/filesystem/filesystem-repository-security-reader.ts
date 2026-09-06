import type { SecurityEvidenceObservation } from "../../../application/ports/security-evidence-observation.js";
import type {
  RepositorySecurityEvidence,
  RepositorySecurityPolicy
} from "../../../application/model/repository-security.js";
import type { RepositorySecurityReader } from "../../../application/ports/repository-security-reader.js";
import { readPublishablePackageEvidence } from "./publishable-package-evidence-reader.js";
import { resolveConsumerRoot } from "./repository-security-filesystem.js";
import { assertSecurityObservationActive, requireConfiguredWorkflows } from "../../../application/policies/repository-security-input.js";
import { readSecurityToolEvidence } from "./security-tool-evidence-reader.js";
import { readWorkflowDirectoryEvidence } from "./workflow-evidence-reader.js";

export class FilesystemRepositorySecurityReader implements RepositorySecurityReader {
  constructor(private readonly observation: SecurityEvidenceObservation) {}

  async read(
    consumerRoot: string,
    policy: RepositorySecurityPolicy,
    signal?: AbortSignal
  ): Promise<RepositorySecurityEvidence> {
    assertSecurityObservationActive(signal);
    const root = await resolveConsumerRoot(consumerRoot);
    const [workflowDirectory, packages] = await Promise.all([
      readWorkflowDirectoryEvidence(this.observation, root, policy, signal),
      Promise.all(
        policy.publishablePackageManifests.map((manifestPath) =>
          readPublishablePackageEvidence(this.observation, root, manifestPath)
        )
      )
    ]);
    requireConfiguredWorkflows(workflowDirectory.workflows, policy);
    const toolEvidence = await readSecurityToolEvidence(
      this.observation,
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
