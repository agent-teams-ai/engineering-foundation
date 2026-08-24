import {
  CapabilityInputError,
  foundationReport,
  readCancellationProblem,
  readCapabilityInputProblem
} from "./capability-runtime.js";
import type {
  FoundationCheckCoverage,
  FoundationCheckReport
} from "./check-contract.js";
import { CAPABILITY_REGISTRY } from "./composition/capability-registry.js";
import { loadFoundationConfig } from "./foundation-config.js";
import { classifyUnexpectedFailure } from "./unexpected-failure.js";

export interface FoundationCheckInvocation {
  readonly consumerRoot: string;
  readonly foundationVersion: string;
  readonly capabilityId?: string;
  readonly signal?: AbortSignal;
}

function rootProblemReport(
  foundationVersion: string,
  coverage: FoundationCheckCoverage,
  error: unknown
): FoundationCheckReport {
  const inputProblem = readCapabilityInputProblem(error);
  if (inputProblem !== undefined) {
    const cancelled = inputProblem.code === "EXECUTION_CANCELLED";
    return foundationReport({
      foundationVersion,
      coverage,
      outcome: cancelled ? "cancelled" : "invalid-input",
      problem: inputProblem
    });
  }
  const cancellationProblem = readCancellationProblem(error, "foundation-check");
  if (cancellationProblem !== undefined) {
    return foundationReport({
      foundationVersion,
      coverage,
      outcome: "cancelled",
      problem: cancellationProblem
    });
  }
  return foundationReport({
    foundationVersion,
    coverage,
    outcome: "failed",
    problem: classifyUnexpectedFailure(error, "foundation-check")
  });
}

export async function runFoundationCheck(
  invocation: FoundationCheckInvocation
): Promise<FoundationCheckReport> {
  const coverage = invocation.capabilityId === undefined ? "full" : "selected";
  try {
    const config = await loadFoundationConfig(
      invocation.consumerRoot,
      invocation.signal
    );
    const declared = config.declaredCapabilities;
    const selected =
      invocation.capabilityId === undefined
        ? declared
        : declared.filter(({ id }) => id === invocation.capabilityId);
    if (invocation.capabilityId !== undefined && selected.length === 0) {
      throw new CapabilityInputError({
        code: "CAPABILITY_NOT_DECLARED",
        message: `Capability is not declared by the consumer: ${invocation.capabilityId}.`,
        phase: "capability-selection",
        retryable: false
      });
    }

    const reports = await Promise.all(
      selected.map(async ({ id, configPath }) => {
        const capability = CAPABILITY_REGISTRY.get(id);
        if (capability === undefined) {
          throw new CapabilityInputError({
            code: "CAPABILITY_UNSUPPORTED",
            message: `Capability is not supported by this foundation version: ${id}.`,
            phase: "capability-selection",
            retryable: false
          });
        }
        return capability.run({
          consumerRoot: invocation.consumerRoot,
          configPath,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
        });
      })
    );
    return foundationReport({
      foundationVersion: invocation.foundationVersion,
      coverage,
      capabilities: reports
    });
  } catch (error) {
    return rootProblemReport(invocation.foundationVersion, coverage, error);
  }
}
