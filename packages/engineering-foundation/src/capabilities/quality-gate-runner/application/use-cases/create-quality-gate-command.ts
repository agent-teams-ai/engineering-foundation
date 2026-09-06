import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type { QualityGateRunReport } from "../model/quality-gate-report.js";
import type { MonotonicClock } from "../ports/monotonic-clock.js";
import type { PackageScriptCatalogReader } from "../ports/package-script-catalog-reader.js";
import type { PackageScriptExecutor } from "../ports/package-script-executor.js";
import { evaluateQualityGateScripts } from "../policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./run-quality-gate-profile.js";
import type { QualityGatePolicyLoader } from "../ports/quality-gate-policy-loader.js";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "quality-gate-runner-command",
    retryable: false
  });
}

interface QualityGateCommandInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly signal?: AbortSignal;
}

export interface QualityGateCommandDependencies {
  readonly catalogReader: PackageScriptCatalogReader;
  readonly clock: MonotonicClock;
  readonly executor: PackageScriptExecutor;
  readonly qualityGateActive?: boolean;
  readonly policyLoader: QualityGatePolicyLoader;
}

export type QualityGateCommand = (
  input: QualityGateCommandInput
) => Promise<QualityGateRunReport>;

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    inputError(
      "EXECUTION_CANCELLED",
      "Quality gate execution was cancelled."
    );
  }
}

export function createQualityGateCommand(
  dependencies: QualityGateCommandDependencies
): QualityGateCommand {
  return async (input) => {
    if (dependencies.qualityGateActive === true) {
      inputError(
        "QUALITY_GATE_RECURSION",
        "A quality gate task cannot start another quality gate runner."
      );
    }
    assertNotCancelled(input.signal);
    const policy = await dependencies.policyLoader(
      input.consumerRoot,
      input.configPath,
      input.signal
    );
    assertNotCancelled(input.signal);
    const profile = policy.profiles.find(({ id }) => id === input.profileId);
    if (profile === undefined) {
      inputError(
        "QUALITY_GATE_PROFILE_UNKNOWN",
        `Unknown quality gate profile: ${input.profileId}.`
      );
    }
    const catalog = await dependencies.catalogReader.read(
      input.consumerRoot,
      input.signal
    );
    assertNotCancelled(input.signal);
    const diagnostics = evaluateQualityGateScripts(policy, catalog);
    if (diagnostics.length > 0) {
      inputError(
        "QUALITY_GATE_SCRIPTS_INVALID",
        diagnostics.map(({ message }) => message).join(" ")
      );
    }
    return await runQualityGateProfile(
      {
        consumerRoot: input.consumerRoot,
        profile,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      dependencies.executor,
      dependencies.clock
    );
  };
}

