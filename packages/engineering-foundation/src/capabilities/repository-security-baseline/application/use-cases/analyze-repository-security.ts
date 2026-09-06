import type { FoundationDiagnostic } from "../../../../features/validation-reporting/api.js";
import { assertNotCancelled } from "../../../../features/validation-reporting/api.js";
import type { RepositorySecurityPolicy } from "../model/repository-security.js";
import type { RepositorySecurityReader } from "../ports/repository-security-reader.js";
import { evaluateRepositorySecurity } from "../policies/evaluate-repository-security.js";

export async function analyzeRepositorySecurity(
  input: {
    readonly consumerRoot: string;
    readonly policy: RepositorySecurityPolicy;
    readonly signal?: AbortSignal;
  },
  reader: RepositorySecurityReader
): Promise<readonly FoundationDiagnostic[]> {
  assertNotCancelled(input.signal);
  return evaluateRepositorySecurity(
    input.policy,
    await reader.read(input.consumerRoot, input.policy, input.signal)
  );
}
