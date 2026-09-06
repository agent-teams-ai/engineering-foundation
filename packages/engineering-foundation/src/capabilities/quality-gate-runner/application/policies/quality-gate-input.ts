import { CapabilityInputError, FoundationError, assertNotCancelled } from "../../../../features/validation-reporting/api.js";

export function rejectPackageScriptCatalog(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_GATE_RUNNER_PACKAGE_INVALID",
    message,
    phase: "quality-gate-runner-package-catalog",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapPackageScriptCatalog(input: unknown) {
  if (!isRecord(input)) {
    rejectPackageScriptCatalog("The consumer root package.json must be an object.");
  }
  const scriptsInput = input["scripts"];
  if (!isRecord(scriptsInput)) {
    rejectPackageScriptCatalog("The consumer root package.json must declare a scripts object.");
  }
  const scripts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [id, command] of Object.entries(scriptsInput)) {
    if (typeof command !== "string") {
      rejectPackageScriptCatalog(`package.json script ${id} must be a string.`);
    }
    scripts[id] = command;
  }
  return Object.freeze({ scripts: Object.freeze(scripts) });
}

export function assertPackageScriptCatalogActive(signal: AbortSignal | undefined): void {
  assertNotCancelled(signal);
}

export function rejectQualityGateExecutor(): never {
  throw new FoundationError(
    "PROCESS_FAILED",
    "Unable to resolve a shell-free pnpm entrypoint on Windows."
  );
}

export function requireQualityGateProfile(profileId: string | undefined): string {
  if (profileId === undefined) {
    throw new FoundationError("CONSUMER_INVALID", "gate run requires a profile ID.");
  }
  return profileId;
}

export function requireQualityGateConfigPath(
  declarations: readonly { readonly id: string; readonly configPath: string }[]
): string {
  const declaration = declarations.find(({ id }) => id === "quality.gate-runner");
  if (declaration === undefined) {
    throw new FoundationError(
      "CONSUMER_INVALID",
      "The consumer must declare quality.gate-runner before using gate run."
    );
  }
  return declaration.configPath;
}

export function isQualityGateExecutionCancellation(error: unknown): boolean {
  return error instanceof CapabilityInputError &&
    error.problem.code === "EXECUTION_CANCELLED";
}

export function qualityGateSetupCancellationFailure(): Error {
  return new CapabilityInputError({
    code: "EXECUTION_CANCELLED",
    message: "Quality gate execution was cancelled.",
    phase: "quality-gate-runner-command",
    retryable: false
  });
}
