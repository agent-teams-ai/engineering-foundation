import { CapabilityInputError } from "../../capability-runtime.js";
import type { QualityGateRunReport } from "./application/model/quality-gate-report.js";
import type { MonotonicClock } from "./application/ports/monotonic-clock.js";
import type { PackageScriptCatalogReader } from "./application/ports/package-script-catalog-reader.js";
import type { PackageScriptExecutor } from "./application/ports/package-script-executor.js";
import { evaluateQualityGateScripts } from "./application/policies/evaluate-quality-gate-scripts.js";
import { runQualityGateProfile } from "./application/use-cases/run-quality-gate-profile.js";
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

export function createNodeQualityGateCommand(
  environment: NodeJS.ProcessEnv
): QualityGateCommand {
  const snapshot = Object.freeze({ ...environment });
  return async (input) => createQualityGateCommand({
    catalogReader: new FilesystemPackageScriptCatalogReader(),
    clock: performanceMonotonicClock,
    executor: new PnpmQualityGateScriptExecutor({
      childEnvironment: Object.freeze({
        ...snapshot,
        [ACTIVE_GATE_ENVIRONMENT_VARIABLE]: input.profileId
      }),
      ...(snapshot.npm_execpath === undefined
        ? {}
        : { npmExecPath: snapshot.npm_execpath }),
      ...(snapshot.PNPM_HOME === undefined
        ? {}
        : { pnpmHome: snapshot.PNPM_HOME }),
      ...(snapshot.PATH === undefined
        ? {}
        : { pathValue: snapshot.PATH })
    }),
    policyLoader: loadQualityGatePolicy,
    qualityGateActive:
      snapshot[ACTIVE_GATE_ENVIRONMENT_VARIABLE] !== undefined
  })(input);
}
