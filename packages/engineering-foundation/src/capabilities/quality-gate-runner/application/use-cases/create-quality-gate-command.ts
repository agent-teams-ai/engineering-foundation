import { CapabilityInputError } from "../../../../features/validation-reporting/api.js";
import type { QualityGateRunReport } from "../model/quality-gate-report.js";
import type { NormalizedQualityGatePolicy, QualityGatePolicyInput } from "../model/quality-gate.js";
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
    retryable: false,
  });
}

interface QualityGateCommandInput {
  readonly consumerRoot: string;
  readonly configPath: string;
  readonly profileId: string;
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
}

export interface QualityGateCommandDependencies {
  readonly catalogReader: PackageScriptCatalogReader;
  readonly clock: MonotonicClock;
  readonly executor: PackageScriptExecutor;
  readonly qualityGateActive?: boolean;
  readonly policyLoader: QualityGatePolicyLoader;
}

export type QualityGateCommand = (input: QualityGateCommandInput) => Promise<QualityGateRunReport>;

function normalizePolicy(input: QualityGatePolicyInput): NormalizedQualityGatePolicy {
  if ("packageManager" in input) {
    return Object.freeze({
      profiles: Object.freeze(
        input.profiles.map((profile) =>
          Object.freeze({
            ...profile,
            packageManager: input.packageManager,
          }),
        ),
      ),
    });
  }
  return input;
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    inputError("EXECUTION_CANCELLED", "Quality gate execution was cancelled.");
  }
}

export function createQualityGateCommand(
  dependencies: QualityGateCommandDependencies,
): QualityGateCommand {
  return async (input) => {
    if (dependencies.qualityGateActive === true) {
      inputError(
        "QUALITY_GATE_RECURSION",
        "A quality gate task cannot start another quality gate runner.",
      );
    }
    assertNotCancelled(input.signal);
    if (
      input.budgetMs !== undefined &&
      (!Number.isSafeInteger(input.budgetMs) ||
        input.budgetMs < 1 ||
        input.budgetMs > 2_147_483_647)
    ) {
      inputError(
        "QUALITY_GATE_BUDGET_INVALID",
        "Aggregate gate budget must be a positive bounded integer.",
      );
    }
    const deadlineMs =
      input.budgetMs === undefined ? undefined : dependencies.clock.nowMs() + input.budgetMs;
    const assertBudget = () => {
      if (deadlineMs !== undefined && dependencies.clock.nowMs() >= deadlineMs) {
        inputError(
          "QUALITY_GATE_BUDGET_EXCEEDED",
          "Aggregate gate budget was exhausted before execution.",
        );
      }
    };
    const policy = normalizePolicy(
      await dependencies.policyLoader(input.consumerRoot, input.configPath, input.signal),
    );
    assertNotCancelled(input.signal);
    assertBudget();
    const profile = policy.profiles.find(({ id }) => id === input.profileId);
    if (profile === undefined) {
      inputError(
        "QUALITY_GATE_PROFILE_UNKNOWN",
        `Unknown quality gate profile: ${input.profileId}.`,
      );
    }
    const catalog = await dependencies.catalogReader.read(input.consumerRoot, input.signal);
    assertNotCancelled(input.signal);
    assertBudget();
    const diagnostics = evaluateQualityGateScripts(policy, catalog);
    if (diagnostics.length > 0) {
      inputError(
        "QUALITY_GATE_SCRIPTS_INVALID",
        diagnostics.map(({ message }) => message).join(" "),
      );
    }
    return await runQualityGateProfile(
      {
        consumerRoot: input.consumerRoot,
        profile,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      dependencies.executor,
      dependencies.clock,
    );
  };
}
