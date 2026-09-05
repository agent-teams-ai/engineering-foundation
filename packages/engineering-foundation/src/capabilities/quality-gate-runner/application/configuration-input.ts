import { CapabilityInputError } from "../../../features/validation-reporting/api.js";

export function configurationInputError(message: string): never {
  throw new CapabilityInputError({
    code: "QUALITY_GATE_RUNNER_CONFIG_INVALID",
    message,
    phase: "quality-gate-runner-config",
    retryable: false
  });
}

