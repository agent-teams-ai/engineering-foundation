import { CapabilityInputError } from "../../capability-runtime.js";
import type { QualityGateRunReport } from "./application/model/quality-gate-report.js";
import type { MonotonicClock } from "./application/ports/monotonic-clock.js";
import type { QualityGateOperatorCancellationSource } from "./application/ports/operator-cancellation-source.js";
import type { PackageScriptCatalogReader } from "./application/ports/package-script-catalog-reader.js";
import type { PackageScriptExecutor } from "./application/ports/package-script-executor.js";
import { evaluateQualityGateScripts } from "./application/policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./application/use-cases/run-quality-gate-profile.js";
import { NodeSignalQualityGateCancellationSource } from "./adapters/inbound/cli/node-signal-cancellation-source.js";
import { FilesystemPackageScriptCatalogReader } from "./adapters/outbound/filesystem/filesystem-package-script-catalog-reader.js";
import { PnpmQualityGateScriptExecutor } from "./adapters/outbound/pnpm/pnpm-package-script-executor.js";
import { performanceMonotonicClock } from "./adapters/outbound/time/performance-monotonic-clock.js";
import {
  loadQualityGatePolicy,
  type QualityGatePolicyLoader
} from "./contract/config.js";

const ACTIVE_GATE_ENVIRONMENT_VARIABLE =
  "AGENT_TEAMS_FOUNDATION_QUALITY_GATE_ACTIVE";

function inputError(code: string, message: string): never {
  throw new CapabilityInputError({
    code,
    message,
    phase: "quality-gate-runner-command",
    retryable: false
  });
}

export interface QualityGateCommandInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface QualityGateCommandDependencies {
  readonly catalogReader: PackageScriptCatalogReader;
  readonly clock: MonotonicClock;
  readonly executor: PackageScriptExecutor;
  readonly policyLoader: QualityGatePolicyLoader;
}

export type QualityGateCommand = (
  input: QualityGateCommandInput
) => Promise<QualityGateRunReport>;

export type { QualityGateRunReport };

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
    if (input.environment[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined) {
      inputError(
        "QUALITY_GATE_RECURSION",
        "A quality gate task cannot start another quality gate runner."
      );
    }
    const environment = Object.freeze({
      ...input.environment,
      [ACTIVE_GATE_ENVIRONMENT_VARIABLE]: input.profileId
    });
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
        environment,
        profile,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      },
      dependencies.executor,
      dependencies.clock
    );
  };
}

export function createNodeQualityGateCommand(
  environment: NodeJS.ProcessEnv
): QualityGateCommand {
  return createQualityGateCommand({
    catalogReader: new FilesystemPackageScriptCatalogReader(),
    clock: performanceMonotonicClock,
    executor: new PnpmQualityGateScriptExecutor({
      ...(environment.npm_execpath === undefined
        ? {}
        : { npmExecPath: environment.npm_execpath }),
      ...(environment.PNPM_HOME === undefined
        ? {}
        : { pnpmHome: environment.PNPM_HOME }),
      ...(environment.PATH === undefined
        ? {}
        : { pathValue: environment.PATH })
    }),
    policyLoader: loadQualityGatePolicy
  });
}

export function createNodeQualityGateCancellationSource(): QualityGateOperatorCancellationSource {
  return new NodeSignalQualityGateCancellationSource();
}
