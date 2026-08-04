import {
  CapabilityInputError,
  capabilityReport,
  type CapabilityDefinition,
  type CapabilityInvocation
} from "../../capability-runtime.js";
import { FilesystemMarkdownRepository } from "../../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { NodeArchitectureDecisionFingerprint } from "./adapters/outbound/crypto/node-architecture-decision-fingerprint.js";
import { FilesystemArchitectureDecisionBaselineRepository } from "./adapters/outbound/filesystem/filesystem-architecture-decision-baseline-repository.js";
import { parseAcceptedArchitectureDecisionBaseline } from "./application/policies/accepted-architecture-decision-baseline.js";
import { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID } from "./application/rules.js";
import {
  analyzeArchitectureDecisionEvidence,
  analyzeArchitectureDecisions
} from "./application/use-cases/analyze-architecture-decisions.js";
import { promoteArchitectureDecisionBaseline as promoteBaseline } from "./application/use-cases/promote-architecture-decision-baseline.js";
import {
  CAPABILITY_CONFIG_SCHEMA_VERSION,
  CAPABILITY_ID,
  loadCapabilityConfig
} from "./contract/config.js";

export { ARCHITECTURE_DECISION_GOVERNANCE_RULES_BY_ID };

export interface AcceptedArchitectureDecisionEvidence {
  readonly acceptedDecisionIds: readonly `ADR-${string}`[];
  readonly acceptedDecisionPaths: readonly string[];
}

function createDependencies() {
  return Object.freeze({
    baselineRepository: new FilesystemArchitectureDecisionBaselineRepository(),
    fingerprint: new NodeArchitectureDecisionFingerprint(),
    markdownRepository: new FilesystemMarkdownRepository()
  });
}

export async function promoteArchitectureDecisionBaseline(input: {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}) {
  const policy = await loadCapabilityConfig(
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  return promoteBaseline(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    createDependencies()
  );
}

/**
 * Provides a narrow, validated view of accepted ADR history to another
 * capability. The caller receives only stable IDs and immutable historical
 * paths; the governance catalog, baseline, immutable digests, and lifecycle
 * validation remain owned here.
 */
export async function readAcceptedArchitectureDecisionEvidence(input: {
  readonly baselinePath: string;
  readonly configPath: string;
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}): Promise<AcceptedArchitectureDecisionEvidence> {
  const dependencies = createDependencies();
  const policy = await loadCapabilityConfig(
    input.consumerRoot,
    input.configPath,
    input.signal
  );
  if (policy.acceptedBaselinePath !== input.baselinePath) {
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_BASELINE_MISMATCH",
      message:
        "Accepted ADR evidence must use the baseline configured by architecture decision governance.",
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const analysis = await analyzeArchitectureDecisionEvidence(
    {
      consumerRoot: input.consumerRoot,
      policy,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    },
    dependencies
  );
  if (analysis.diagnostics.length > 0) {
    const subjects = analysis.diagnostics
      .map((diagnostic) => diagnostic.subject)
      .toSorted()
      .slice(0, 3)
      .join(", ");
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
      message: `Accepted ADR evidence requires a valid immutable governance catalog${subjects.length === 0 ? "." : `: ${subjects}.`}`,
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const baseline = analysis.baseline;
  const parsed =
    baseline.kind === "valid"
      ? parseAcceptedArchitectureDecisionBaseline(baseline.value)
      : undefined;
  if (parsed === undefined) {
    throw new CapabilityInputError({
      code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
      message: "Accepted ADR evidence baseline was invalid while resolving governance evidence.",
      phase: "architecture-decision-evidence",
      retryable: false
    });
  }
  const baselineById = new Map(parsed.decisions.map((entry) => [entry.id, entry]));
  const acceptedDecisions = analysis.decisions
    .filter((decision) => decision.status === "accepted")
    .map((decision) => {
      const baselineEntry = baselineById.get(decision.id);
      if (
        baselineEntry === undefined ||
        baselineEntry.path !== decision.document.repositoryPath
      ) {
        throw new CapabilityInputError({
          code: "ARCHITECTURE_DECISION_EVIDENCE_INVALID",
          message: `Accepted ADR ${decision.id} is not represented by the validated immutable governance baseline.`,
          phase: "architecture-decision-evidence",
          retryable: false
        });
      }
      return Object.freeze({ id: decision.id as `ADR-${string}`, path: baselineEntry.path });
    });
  return Object.freeze({
    acceptedDecisionIds: Object.freeze(acceptedDecisions.map((decision) => decision.id)),
    acceptedDecisionPaths: Object.freeze(acceptedDecisions.map((decision) => decision.path))
  });
}

export function createArchitectureDecisionGovernanceCapability(): CapabilityDefinition {
  return Object.freeze({
    configSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    async run(invocation: CapabilityInvocation) {
      try {
        const dependencies = createDependencies();
        const policy = await loadCapabilityConfig(
          invocation.consumerRoot,
          invocation.configPath,
          invocation.signal
        );
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          diagnostics: await analyzeArchitectureDecisions(
            {
              consumerRoot: invocation.consumerRoot,
              policy,
              ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
            },
            dependencies
          )
        });
      } catch (error) {
        if (error instanceof CapabilityInputError) {
          return capabilityReport({
            capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
            capabilityId: CAPABILITY_ID,
            outcome:
              error.problem.code === "EXECUTION_CANCELLED" ? "cancelled" : "invalid-input",
            problem: error.problem
          });
        }
        return capabilityReport({
          capabilityConfigSchemaVersion: CAPABILITY_CONFIG_SCHEMA_VERSION,
          capabilityId: CAPABILITY_ID,
          outcome: "failed",
          problem: {
            code: "CAPABILITY_EXECUTION_FAILED",
            message: "Architecture decision governance capability execution failed.",
            phase: "architecture-decision-governance-execution",
            retryable: false
          }
        });
      }
    }
  });
}
