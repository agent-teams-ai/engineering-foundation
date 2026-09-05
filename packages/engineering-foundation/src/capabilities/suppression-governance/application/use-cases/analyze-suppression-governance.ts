import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type { SourceTreeReader } from "../../../../source-inventory/application/ports/source-tree-reader.js";
import { assertNotCancelled } from "../../../../strict-yaml.js";
import type { SuppressionGovernancePolicy } from "../model/suppression-governance.js";
import type { CalendarClock } from "../ports/calendar-clock.js";
import type { SuppressionScanner } from "../ports/suppression-scanner.js";
import { evaluateSuppressionGovernance } from "../policies/evaluate-suppression-governance.js";

export async function analyzeSuppressionGovernance(
  input: {
    readonly consumerRoot: string;
    readonly policy: SuppressionGovernancePolicy;
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly clock: CalendarClock;
    readonly scanner: SuppressionScanner;
    readonly sourceReader: SourceTreeReader;
  }
): Promise<readonly FoundationDiagnostic[]> {
  const files = await dependencies.sourceReader.read(
    input.consumerRoot,
    input.policy.governedRoots,
    input.signal
  );
  const scans = files.map((file) => {
    assertNotCancelled(input.signal);
    return dependencies.scanner.scan(file);
  });
  return evaluateSuppressionGovernance({
    policy: input.policy,
    scans,
    today: dependencies.clock.today()
  });
}
