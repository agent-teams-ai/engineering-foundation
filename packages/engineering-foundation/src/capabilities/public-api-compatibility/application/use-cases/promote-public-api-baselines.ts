import { CapabilityInputError } from "../../../../capability-runtime.js";
import { semanticVersionBumpBetween } from "../../../../semantic-version.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiSnapshot
} from "../model/public-api.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { AcceptedDecisionEvidencePort } from "../ports/accepted-decision-evidence.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { classifyPublicApiChange } from "../policies/evaluate-public-api-compatibility.js";

function promotionError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "public-api-baseline-promotion",
    retryable: false
  });
}

const BUMP_RANK = Object.freeze({ patch: 0, minor: 1, major: 2 });

export async function promotePublicApiBaselines(
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
): Promise<readonly PublicApiSnapshot[]> {
  const promotions: Array<{
    readonly packagePolicy: PublicApiCompatibilityPolicy["packages"][number];
    readonly snapshot: PublicApiSnapshot;
  }> = [];
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
    if (released.extractorVersion !== current.extractorVersion) {
      promotionError(
        "PUBLIC_API_BASELINE_PROMOTION_TOOL_MISMATCH",
        `API Extractor changed from ${released.extractorVersion} to ${current.extractorVersion}; migrate the baseline in an explicitly reviewed tool-upgrade change.`
      );
    }
    const change = classifyPublicApiChange(released, current, dependencies.fingerprint);
    if (released.packageVersion === releaseEvidence.packageVersion) {
      if (change.classification !== "none") {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_RELEASE_DRIFT",
          `Package ${packagePolicy.packageName} changed after baseline ${released.packageVersion} was promoted.`
        );
      }
      continue;
    }
    const actualBump = semanticVersionBumpBetween(
      released.packageVersion,
      releaseEvidence.packageVersion
    );
    if (actualBump === undefined) {
      promotionError(
        "PUBLIC_API_BASELINE_PROMOTION_NOT_RELEASE",
        `Package ${packagePolicy.packageName} must have a version newer than released baseline ${released.packageVersion}.`
      );
    }
    const requiredBump =
      change.classification === "none"
        ? "patch"
        : change.classification === "additive" || released.packageVersion.startsWith("0.")
          ? "minor"
          : "major";
    if (BUMP_RANK[actualBump] < BUMP_RANK[requiredBump]) {
      promotionError(
        "PUBLIC_API_BASELINE_PROMOTION_VERSION_INSUFFICIENT",
        `API change for ${packagePolicy.packageName} requires ${requiredBump}; release advances by ${actualBump}.`
      );
    }
    if (change.classification === "breaking") {
      const approval = packagePolicy.approvedBreakingChanges.find(
        (candidate) => candidate.fingerprint === change.fingerprint
      );
      if (approval === undefined) {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_UNAPPROVED_BREAK",
          `Breaking API fingerprint is not approved: ${change.fingerprint ?? "missing"}.`
        );
      }
      const baselinePath = input.policy.acceptedDecisionBaselinePath;
      if (baselinePath === undefined) {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_DECISION_EVIDENCE_MISSING",
          "Breaking API approval requires immutable accepted-decision evidence."
        );
      }
      if (
        !(await dependencies.acceptedDecisionEvidence.hasAcceptedDecision({
          consumerRoot: input.consumerRoot,
          decisionPath: approval.decisionPath,
          baselinePath,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        }))
      ) {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_DECISION_NOT_ACCEPTED",
          `Breaking API decision is not accepted: ${approval.decisionPath}.`
        );
      }
    }
    promotions.push({ packagePolicy, snapshot: current });
  }

  for (const promotion of promotions) {
    assertNotCancelled(input.signal);
    await dependencies.repository.writeReleasedBaseline(
      input.consumerRoot,
      promotion.packagePolicy,
      promotion.snapshot,
      input.signal
    );
  }

  return Object.freeze(promotions.map(({ snapshot }) => snapshot));
}
