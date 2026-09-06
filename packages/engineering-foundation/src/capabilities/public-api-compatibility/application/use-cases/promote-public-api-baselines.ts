import { CapabilityInputError,assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import {
  sameNumberedPrereleaseTrain,
  semanticVersionBumpBetween
} from "../../../../semantic-version.js";
import type {
  PublicApiCompatibilityPolicy,
  PublicApiSnapshot
} from "../model/public-api.js";
import type { PublicApiExtractor } from "../ports/public-api-extractor.js";
import type { AcceptedDecisionEvidencePort } from "../ports/accepted-decision-evidence.js";
import type { ChangeFingerprint } from "../ports/change-fingerprint.js";
import type { PublicApiRepository } from "../ports/public-api-repository.js";
import { approvedBreakingChangeReference } from "../model/public-api.js";
import { isApprovedBreakingChangeAccepted } from "../policies/accepted-breaking-change.js";
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
const INITIAL_UNRELEASED_VERSION = "0.0.0";

function effectiveReleaseBump(input: {
  readonly actualBump: keyof typeof BUMP_RANK;
  readonly candidateVersion: string;
  readonly prereleaseInitialVersion: string | undefined;
  readonly prereleaseTag: string | undefined;
  readonly releasedVersion: string;
}): keyof typeof BUMP_RANK {
  if (input.prereleaseInitialVersion === undefined || input.prereleaseTag === undefined) {
    return input.actualBump;
  }
  const prereleaseLineBump = semanticVersionBumpBetween(
    input.prereleaseInitialVersion,
    input.candidateVersion
  );
  if (
    prereleaseLineBump === undefined ||
    !sameNumberedPrereleaseTrain(
      input.releasedVersion,
      input.candidateVersion,
      input.prereleaseTag
    )
  ) {
    return input.actualBump;
  }
  return prereleaseLineBump;
}

function assertReviewedBootstrap(
  packagePolicy: PublicApiCompatibilityPolicy["packages"][number],
  releaseEvidence: Awaited<ReturnType<PublicApiRepository["readReleaseEvidence"]>>
): void {
  if (releaseEvidence.packageVersion !== INITIAL_UNRELEASED_VERSION) {
    promotionError(
      "PUBLIC_API_BASELINE_BOOTSTRAP_NOT_INITIAL",
      `Missing baseline for ${packagePolicy.packageName} can be bootstrapped only at the initial unreleased version ${INITIAL_UNRELEASED_VERSION}.`
    );
  }
  if (releaseEvidence.declaredBump === undefined) {
    promotionError(
      "PUBLIC_API_BASELINE_BOOTSTRAP_CHANGESET_MISSING",
      `Initial public API baseline for ${packagePolicy.packageName} requires a Changeset.`
    );
  }
  if (BUMP_RANK[releaseEvidence.declaredBump] < BUMP_RANK.minor) {
    promotionError(
      "PUBLIC_API_BASELINE_BOOTSTRAP_CHANGESET_INSUFFICIENT",
      `Initial public API baseline for ${packagePolicy.packageName} requires at least a minor Changeset.`
    );
  }
}

function assertExtractorVersionMatch(
  released: PublicApiSnapshot,
  current: PublicApiSnapshot
): void {
  if (released.extractorVersion !== current.extractorVersion) {
    promotionError(
      "PUBLIC_API_BASELINE_PROMOTION_TOOL_MISMATCH",
      `API Extractor changed from ${released.extractorVersion} to ${current.extractorVersion}; migrate the baseline in an explicitly reviewed tool-upgrade change.`
    );
  }
}

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
    readonly mode: "create" | "replace";
    readonly packagePolicy: PublicApiCompatibilityPolicy["packages"][number];
    readonly snapshot: PublicApiSnapshot;
  }> = [];
  let acceptedDecisionEvidence:
    | Awaited<ReturnType<AcceptedDecisionEvidencePort["readAcceptedDecisionEvidence"]>>
    | undefined;
  for (const packagePolicy of input.policy.packages) {
    assertNotCancelled(input.signal);
    const [released, releaseEvidence] = await Promise.all([
      dependencies.repository.readReleasedBaseline(
        input.consumerRoot,
        packagePolicy,
        input.signal,
        "release-promotion"
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
    if (released === undefined) {
      assertReviewedBootstrap(packagePolicy, releaseEvidence);
      promotions.push({ packagePolicy, snapshot: current, mode: "create" });
      continue;
    }
    assertExtractorVersionMatch(released, current);
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
    const effectiveBump = effectiveReleaseBump({
      actualBump,
      candidateVersion: releaseEvidence.packageVersion,
      prereleaseInitialVersion: releaseEvidence.prereleaseInitialVersion,
      prereleaseTag: releaseEvidence.prereleaseTag,
      releasedVersion: released.packageVersion
    });
    if (BUMP_RANK[effectiveBump] < BUMP_RANK[requiredBump]) {
      promotionError(
        "PUBLIC_API_BASELINE_PROMOTION_VERSION_INSUFFICIENT",
        `API change for ${packagePolicy.packageName} requires ${requiredBump}; release intent advances by ${effectiveBump}.`
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
      const governanceConfigPath = input.policy.governanceConfigPath;
      if (governanceConfigPath === undefined) {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_DECISION_EVIDENCE_MISSING",
          "Breaking API approval requires architecture-governance evidence."
        );
      }
      acceptedDecisionEvidence ??=
        await dependencies.acceptedDecisionEvidence.readAcceptedDecisionEvidence({
          consumerRoot: input.consumerRoot,
          baselinePath,
          governanceConfigPath,
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
      if (!isApprovedBreakingChangeAccepted(approval, acceptedDecisionEvidence)) {
        promotionError(
          "PUBLIC_API_BASELINE_PROMOTION_DECISION_NOT_ACCEPTED",
          `Breaking API decision is not accepted: ${approvedBreakingChangeReference(approval)}.`
        );
      }
    }
    promotions.push({ packagePolicy, snapshot: current, mode: "replace" });
  }

  for (const promotion of promotions) {
    assertNotCancelled(input.signal);
    await dependencies.repository.writeReleasedBaseline(
      input.consumerRoot,
      promotion.packagePolicy,
      promotion.snapshot,
      input.signal,
      promotion.mode
    );
  }

  return Object.freeze(promotions.map(({ snapshot }) => snapshot));
}
