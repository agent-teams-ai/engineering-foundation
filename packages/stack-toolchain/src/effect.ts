import { checkEffectProjects as check } from "./features/toolchain-execution/adapters/effect-check.js";
import type {
  EffectCheckInput,
  EffectCheckReport,
} from "./features/toolchain-execution/application/effect-policy.js";
export { effectDiagnosticsContractVersion } from "./features/toolchain-execution/application/effect-policy.js";
export type {
  EffectCheckInput,
  EffectCheckReport,
  EffectCheckOutcome,
  EffectProjectResult,
  EffectToolVersions,
} from "./features/toolchain-execution/application/effect-policy.js";

export function checkEffectProjects(input: EffectCheckInput): Promise<EffectCheckReport> {
  return check(input);
}
