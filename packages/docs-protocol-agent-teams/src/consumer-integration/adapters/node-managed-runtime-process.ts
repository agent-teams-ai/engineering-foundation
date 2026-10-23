import { ManagedProbeOperation } from "./managed-probe-operation.js";
import {
  realSignals,
  type ManagedProbeInput,
  type ManagedProbeSignalSyscalls,
  type ProcessResult,
} from "./managed-probe-support.js";
export type { ProcessResult, ManagedProbeSignalSyscalls } from "./managed-probe-support.js";
export async function runManagedProbe(
  input: ManagedProbeInput,
  syscalls: ManagedProbeSignalSyscalls = realSignals,
): Promise<ProcessResult> {
  return new ManagedProbeOperation(input, syscalls).execute();
}
