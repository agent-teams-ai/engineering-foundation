import type { DocsCommandOutcome, DocsDiagnostic } from "./model.js";
import type { DocsCommandV3 } from "./model-v3.js";
import type { NormalizedDocsProtocolProfile } from "../domain/documentation-model.js";
import { boundedDiagnostics } from "./docs-new-completion.js";

export interface DocsOperationResult<Result, Command extends DocsCommandV3 = DocsCommandV3> {
  readonly command: Command;
  readonly outcome: DocsCommandOutcome;
  readonly diagnostics: readonly DocsDiagnostic[];
  readonly result: Result;
}

export function execution<Result, Command extends DocsCommandV3>(command: Command, outcome: DocsCommandOutcome, result: Result, diagnostics: readonly DocsDiagnostic[] = []): DocsOperationResult<Result, Command> {
  return Object.freeze({ command, outcome, result, diagnostics: boundedDiagnostics(diagnostics) });
}

export function compatibleProfileV2(profile: NormalizedDocsProtocolProfile): Pick<
  NormalizedDocsProtocolProfile,
  "agentWorkflow" | "foundationProfile" | "protocol" | "semanticValidatorIds"
> {
  return Object.freeze({
    protocol: profile.protocol,
    foundationProfile: profile.foundationProfile,
    agentWorkflow: profile.agentWorkflow,
    semanticValidatorIds: profile.semanticValidatorIds
  });
}
