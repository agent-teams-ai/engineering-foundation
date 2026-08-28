import {
  DOCS_PROTOCOL_ID,
  DOCS_PROTOCOL_VERSION,
  type DocsCommandOutcome,
  type DocsDiagnostic,
  type DocsProtocolProfile
} from "../domain/model.js";
import type {
  DocsCommandEnvelopeV2,
  DocsCommandV2,
  DocsExecutionV2,
  DocsProtocolProfileV2,
  NormalizedDocsProtocolProfile
} from "../domain/model-v2.js";
import type {
  DocsCommandEnvelopeV3,
  DocsCommandV3,
  DocsExecutionV3
} from "../domain/model-v3.js";
import { boundedDiagnostics } from "./docs-new-completion.js";

function exitCode(outcome: DocsCommandOutcome): 0 | 1 | 2 | 3 | 130 {
  return outcome === "success" ? 0
    : outcome === "invalid-input" ? 2
      : outcome === "execution-failure" ? 3
        : outcome === "cancelled" ? 130
          : 1;
}

export function execution<Result>(command: DocsCommandV2, outcome: DocsCommandOutcome, result: Result, diagnostics: readonly DocsDiagnostic[] = []): DocsExecutionV2<Result> {
  const commandEnvelope: DocsCommandEnvelopeV2<Result> = Object.freeze({
    schemaVersion: 2,
    protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
    command,
    outcome,
    diagnostics: boundedDiagnostics(diagnostics),
    result
  });
  return Object.freeze({ envelope: commandEnvelope, exitCode: exitCode(outcome) });
}

export function executionV3<Result>(command: DocsCommandV3, outcome: DocsCommandOutcome, result: Result, diagnostics: readonly DocsDiagnostic[] = []): DocsExecutionV3<Result> {
  const commandEnvelope: DocsCommandEnvelopeV3<Result> = Object.freeze({
    schemaVersion: 3,
    protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }),
    command,
    outcome,
    diagnostics: boundedDiagnostics(diagnostics),
    result
  });
  return Object.freeze({ envelope: commandEnvelope, exitCode: exitCode(outcome) });
}

export function compatibleProfileV2(profile: NormalizedDocsProtocolProfile): DocsProtocolProfile | DocsProtocolProfileV2 {
  return profile.foundationProfile.schemaVersion === 2
    ? Object.freeze({
        schemaVersion: 1,
        protocol: profile.protocol,
        foundationProfile: profile.foundationProfile,
        agentWorkflow: Object.freeze({ skillPath: profile.agentWorkflow.skillPath }),
        semanticValidatorIds: profile.semanticValidatorIds
      })
    : Object.freeze({
        schemaVersion: 2,
        protocol: profile.protocol,
        foundationProfile: profile.foundationProfile,
        agentWorkflow: Object.freeze({ skillPath: profile.agentWorkflow.skillPath }),
        semanticValidatorIds: profile.semanticValidatorIds
      });
}
