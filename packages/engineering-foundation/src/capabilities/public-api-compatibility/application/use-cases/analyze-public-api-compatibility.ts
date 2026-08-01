import type { FoundationDiagnostic } from "../../../../check-contract.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { PublicApiCompatibilityPolicy } from "../model/public-api.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import {
  classifyPublicApiChange,
  evaluatePublicApiCompatibility
} from "../policies/evaluate-public-api-compatibility.js";

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
  }
): Promise<readonly FoundationDiagnostic[]> {
  const diagnostics: FoundationDiagnostic[] = [];
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
    const acceptedDecision =
      approval === undefined
        ? undefined
        : await dependencies.repository.isAcceptedDecision(
            input.consumerRoot,
            approval.decisionPath,
            input.signal
          );
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
