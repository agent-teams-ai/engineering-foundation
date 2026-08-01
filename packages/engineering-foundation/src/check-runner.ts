import {
  CapabilityInputError,
  foundationReport
} from "./capability-runtime.js";
import type { FoundationCheckReport } from "./check-contract.js";
import { CAPABILITY_REGISTRY } from "./composition/capability-registry.js";
import {
  loadFoundationConfig,
  WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY
} from "./foundation-config.js";

export interface FoundationCheckInvocation {
  readonly consumerRoot: string;
  readonly foundationVersion: string;
  readonly capabilityId?: string;
  readonly signal?: AbortSignal;
}

function rootProblemReport(
  foundationVersion: string,
  error: unknown
): FoundationCheckReport {
  if (error instanceof CapabilityInputError) {
    const cancelled = error.problem.code === "EXECUTION_CANCELLED";
    return foundationReport({
      foundationVersion,
      outcome: cancelled ? "cancelled" : "invalid-input",
      problem: error.problem
    });
  }
  return foundationReport({
    foundationVersion,
    outcome: "failed",
    problem: {
      code: "FOUNDATION_CHECK_FAILED",
      message: "Foundation check failed before capability execution.",
      phase: "foundation-check",
      retryable: false
    }
  });
}

export async function runFoundationCheck(
  invocation: FoundationCheckInvocation
): Promise<FoundationCheckReport> {
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
      capabilities: reports
    });
  } catch (error) {
    return rootProblemReport(invocation.foundationVersion, error);
  }
}

export function supportedCapabilityIds(): readonly string[] {
  return [...CAPABILITY_REGISTRY.keys()].toSorted();
}

export function defaultCapabilityId(): string {
  return WORKSPACE_DEPENDENCY_DECLARATIONS_CAPABILITY;
}
