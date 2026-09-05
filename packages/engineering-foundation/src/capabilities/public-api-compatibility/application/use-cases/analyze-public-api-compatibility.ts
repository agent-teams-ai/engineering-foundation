import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../cancellation.js";
import type { PublicApiCompatibilityPolicy } from "../model/public-api.js";
import type { AcceptedDecisionEvidencePort } from "../ports/accepted-decision-evidence.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import {
  classifyPublicApiChange,
  evaluatePublicApiCompatibility
} from "../policies/evaluate-public-api-compatibility.js";
import { isApprovedBreakingChangeAccepted } from "../policies/accepted-breaking-change.js";

export async function analyzePublicApiCompatibility(
  input: {
    readonly consumerRoot: string;
    readonly policy: PublicApiCompatibilityPolicy;
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly extractor: PublicApiExtractor;
    readonly fingerprint: ChangeFingerprint;
    readonly repository: PublicApiRepository;
    readonly acceptedDecisionEvidence: AcceptedDecisionEvidencePort;
  }
): Promise<readonly FoundationDiagnostic[]> {
  const diagnostics: FoundationDiagnostic[] = [];
  let acceptedDecisionEvidence:
    | Awaited<ReturnType<AcceptedDecisionEvidencePort["readAcceptedDecisionEvidence"]>>
    | undefined;
  for (const packagePolicy of input.policy.packages) {
    assertNotCancelled(input.signal);
    const [released, releaseEvidence] = await Promise.all([
      dependencies.repository.readReleasedBaseline(
        input.consumerRoot,
        packagePolicy,
        input.signal
      ),
      dependencies.repository.readReleaseEvidence(
        input.consumerRoot,
        input.policy.changesetDirectory,
        packagePolicy,
        input.signal
      )
    ]);
    const current = await dependencies.extractor.extract(
      input.consumerRoot,
      packagePolicy,
      releaseEvidence.packageVersion,
      input.signal
    );
    const change = classifyPublicApiChange(
      released,
      current,
      dependencies.fingerprint
    );
    const approval =
      change.classification === "breaking"
        ? packagePolicy.approvedBreakingChanges.find(
            (candidate) => candidate.fingerprint === change.fingerprint
          )
        : undefined;
    if (
      approval !== undefined &&
      acceptedDecisionEvidence === undefined &&
      input.policy.governanceConfigPath !== undefined
    ) {
      acceptedDecisionEvidence =
        await dependencies.acceptedDecisionEvidence.readAcceptedDecisionEvidence({
          consumerRoot: input.consumerRoot,
          baselinePath: input.policy.acceptedDecisionBaselinePath,
          governanceConfigPath: input.policy.governanceConfigPath,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
    }
    const acceptedDecision =
      approval === undefined
        ? undefined
        : acceptedDecisionEvidence !== undefined &&
          isApprovedBreakingChangeAccepted(approval, acceptedDecisionEvidence);
    diagnostics.push(
      ...evaluatePublicApiCompatibility({
        policy: packagePolicy,
        released,
        current,
        change,
        releaseEvidence,
        acceptedDecision
      })
    );
  }
  return diagnostics;
}
