import { DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION, type DocsCommand, type DocsExecution, type DocsNewResult, type DocsProtocolProfile } from "../domain/model.js";
import type { DocsExecutionV2, DocsNewResultV2 } from "../domain/model-v2.js";
import { DocsProfileError } from "../domain/profile-policy.js";
import type { DocsProtocol } from "./docs-protocol.js";

function present<Result>(command: DocsCommand, rich: DocsExecutionV2<unknown>, result: Result): DocsExecution<Result> {
  return Object.freeze({
    envelope: Object.freeze({
      schemaVersion: 1 as const,
      protocol: rich.envelope.protocol,
      command,
      outcome: rich.envelope.outcome,
      diagnostics: rich.envelope.diagnostics,
      result
    }),
    exitCode: rich.exitCode
  });
}

function newResult(result: DocsNewResultV2): DocsNewResult {
  if ("compiled" in result) {
    const { compiled: _compiled, ...compatible } = result;
    return Object.freeze(compatible);
  }
  return result;
}

export function presentInfoV1(rich: Awaited<ReturnType<DocsProtocol["infoV2"]>>) {
  const result = rich.envelope.result;
  if (result.foundationProfile.schemaVersion !== 2) {throw new DocsProfileError("Docs Protocol profile v2 requires docsInfoV2.");}
  const profile: DocsProtocolProfile = {
    schemaVersion: 1,
    protocol: { id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION },
    foundationProfile: result.foundationProfile,
    agentWorkflow: { skillPath: result.agentWorkflow.skillPath },
    semanticValidatorIds: result.semanticValidatorIds
  };
  return present("docs.info", rich, Object.freeze({
    kind: "info" as const,
    projectId: result.projectId,
    protocol: profile.protocol,
    foundationProfile: profile.foundationProfile,
    agentWorkflow: profile.agentWorkflow,
    metadataSchemaPath: result.metadataSchemaPath,
    metadataSidecar: result.metadataSidecar,
    ownerIds: result.ownerIds,
    types: result.types,
    semanticValidatorIds: result.semanticValidatorIds
  }));
}

export function presentFindV1(rich: Awaited<ReturnType<DocsProtocol["findV2"]>>) {return present("docs.find", rich, rich.envelope.result);}
export function presentNewV1(rich: DocsExecutionV2<DocsNewResultV2>) {return present("docs.new", rich, newResult(rich.envelope.result));}
export function presentDoctorV1(rich: Awaited<ReturnType<DocsProtocol["doctorV2"]>>) {return present("docs.doctor", rich, rich.envelope.result);}
export function presentRecoverV1(rich: Awaited<ReturnType<DocsProtocol["recoverV2"]>>) {
  const result = rich.envelope.result;
  if (result.transactionState === "no-pending-transaction") {return present("docs.recover", rich, result);}
  if (result.transactionState === "manual-required") {return present("docs.recover", rich, result);}
  return present("docs.recover", rich, result);
}

export function presentCheckV1(rich: Awaited<ReturnType<DocsProtocol["checkV2"]>>) {
  const result = rich.envelope.result;
  if (result.foundationProfile.schemaVersion !== 2) {throw new DocsProfileError("Docs Protocol profile v2 requires docsCheckV2.");}
  return present("docs.check", rich, Object.freeze({
    kind: "check" as const,
    projectId: result.projectId,
    catalogStatus: result.catalogStatus,
    documents: result.documents,
    foundationProfile: result.foundationProfile,
    metadataSidecar: result.metadataSidecar,
    semanticValidatorIds: result.semanticValidatorIds,
    valid: result.valid
  }));
}
