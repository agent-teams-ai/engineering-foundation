import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import type { QualityGatePolicy } from "../model/quality-gate.js";
import { evaluateQualityGateScripts } from "../policies/evaluate-quality-gate-scripts.js";
import type { PackageScriptCatalogReader } from "../ports/package-script-catalog-reader.js";

export async function analyzeQualityGateRunner(input: {
  readonly consumerRoot: string;
  readonly policy: QualityGatePolicy;
  readonly signal?: AbortSignal;
}, reader: PackageScriptCatalogReader): Promise<readonly FoundationDiagnostic[]> {
  return evaluateQualityGateScripts(
    input.policy,
    await reader.read(input.consumerRoot, input.signal)
  );
}
