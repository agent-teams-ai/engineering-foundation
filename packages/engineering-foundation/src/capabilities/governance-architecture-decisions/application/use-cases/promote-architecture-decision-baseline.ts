import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type {
  AcceptedArchitectureDecisionBaseline,
  ArchitectureDecisionPolicy
} from "../model/architecture-decision.js";
import {
  buildAcceptedArchitectureDecisionBaseline,
  findHistoricalArchitectureDecisionBaselineViolation,
  parseAcceptedArchitectureDecisionBaseline
} from "../policies/accepted-architecture-decision-baseline.js";
import type { ArchitectureDecisionFingerprint } from "../ports/architecture-decision-fingerprint.js";
import type {
  ArchitectureDecisionBaselineExpectedState,
  ArchitectureDecisionBaselineRepository,
  ArchitectureDecisionBaselineWriteResult
} from "../ports/architecture-decision-baseline-repository.js";
import {
  inspectArchitectureDecisionCatalog,
  type InspectArchitectureDecisionCatalogDependencies
} from "./inspect-architecture-decision-catalog.js";

export interface ArchitectureDecisionBaselinePromotion {
  readonly baseline: AcceptedArchitectureDecisionBaseline;
  readonly writeResult: ArchitectureDecisionBaselineWriteResult;
}

export interface PromoteArchitectureDecisionBaselineInput {
  readonly consumerRoot: string;
  readonly policy: ArchitectureDecisionPolicy;
  readonly signal?: AbortSignal;
}

export interface PromoteArchitectureDecisionBaselineDependencies
  extends InspectArchitectureDecisionCatalogDependencies {
  readonly baselineRepository: ArchitectureDecisionBaselineRepository;
  readonly fingerprint: ArchitectureDecisionFingerprint;
}

function promotionError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "architecture-decision-baseline-promotion",
    retryable: false
  });
}

function expectedBaselineState(input: {
  readonly kind: "missing" | "valid";
  readonly revision?: string;
}): ArchitectureDecisionBaselineExpectedState {
  if (input.kind === "missing") {
    return { kind: "missing" };
  }
  if (input.revision === undefined) {
    promotionError(
      "ARCHITECTURE_DECISION_BASELINE_PROMOTION_INVALID_STATE",
      "The accepted-decision baseline is missing its concurrency revision."
    );
  }
  return { kind: "valid", revision: input.revision };
}

function validateHistoricalBaseline(input: {
  readonly existing: AcceptedArchitectureDecisionBaseline;
  readonly next: AcceptedArchitectureDecisionBaseline;
}): void {
  const violation = findHistoricalArchitectureDecisionBaselineViolation(input);
  if (violation === undefined) {
    return;
  }
  switch (violation.kind) {
    case "missing":
      promotionError(
        "ARCHITECTURE_DECISION_BASELINE_PROMOTION_HISTORICAL_ENTRY_MISSING",
        `Historical ADR ${violation.id} is absent from the current accepted or superseded ADR catalog.`
      );
      break;
    case "path-mismatch":
      promotionError(
        "ARCHITECTURE_DECISION_BASELINE_PROMOTION_HISTORICAL_ENTRY_MOVED",
        `Historical ADR ${violation.id} moved from ${violation.expectedPath} to ${violation.actualPath}.`
      );
      break;
    case "digest-mismatch":
      promotionError(
        "ARCHITECTURE_DECISION_BASELINE_PROMOTION_HISTORICAL_ENTRY_MUTATED",
        `Historical ADR ${violation.id} differs from immutable baseline digest ${violation.expectedDigest}.`
      );
      break;
  }
}

export async function promoteArchitectureDecisionBaseline(
  input: PromoteArchitectureDecisionBaselineInput,
  dependencies: PromoteArchitectureDecisionBaselineDependencies
): Promise<ArchitectureDecisionBaselinePromotion> {
  assertNotCancelled(input.signal);
  const catalog = await inspectArchitectureDecisionCatalog(input, dependencies);
  if (catalog.diagnostics.length > 0) {
    const subjects = catalog.diagnostics
      .map((diagnostic) => diagnostic.subject)
      .toSorted()
      .slice(0, 3)
      .join(", ");
    promotionError(
      "ARCHITECTURE_DECISION_BASELINE_PROMOTION_CATALOG_INVALID",
      `ADR catalog must pass parse, identity, lifecycle, and index validation before baseline promotion${subjects.length === 0 ? "." : `: ${subjects}.`}`
    );
  }

  const baseline = buildAcceptedArchitectureDecisionBaseline({
    decisions: catalog.decisions,
    fingerprint: dependencies.fingerprint
  });
  assertNotCancelled(input.signal);
  const existing = await dependencies.baselineRepository.read({
    consumerRoot: input.consumerRoot,
    path: input.policy.acceptedBaselinePath,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  let expected: ArchitectureDecisionBaselineExpectedState;
  if (existing.kind === "missing") {
    expected = expectedBaselineState(existing);
  } else if (existing.kind === "valid") {
    const historical = parseAcceptedArchitectureDecisionBaseline(existing.value);
    if (historical === undefined) {
      promotionError(
        "ARCHITECTURE_DECISION_BASELINE_PROMOTION_EXISTING_INVALID",
        "The existing accepted-decision baseline has an invalid immutable shape."
      );
    }
    validateHistoricalBaseline({ existing: historical, next: baseline });
    expected = expectedBaselineState(existing);
  } else {
    promotionError(
      "ARCHITECTURE_DECISION_BASELINE_PROMOTION_EXISTING_UNSAFE",
      `The existing accepted-decision baseline cannot be safely promoted: ${existing.message}`
    );
  }

  assertNotCancelled(input.signal);
  const writeResult = await dependencies.baselineRepository.write({
    baseline,
    consumerRoot: input.consumerRoot,
    expected,
    path: input.policy.acceptedBaselinePath,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return Object.freeze({ baseline, writeResult });
}
