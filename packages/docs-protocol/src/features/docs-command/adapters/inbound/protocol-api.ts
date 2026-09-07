import { type DocumentationOperations, type DocsOperationResult, type DocsCommandV2, DOCS_PROTOCOL_ID, DOCS_PROTOCOL_VERSION } from "../../application/command-operations.js";
import { type DocsExecutionV2, type DocsExecutionV3 } from "../../contracts/command.js";
async function present<Result>(operation: Promise<DocsOperationResult<Result, DocsCommandV2>>, version: 2): Promise<DocsExecutionV2<Result>>;
async function present<Result>(operation: Promise<DocsOperationResult<Result>>, version: 3): Promise<DocsExecutionV3<Result>>;
async function present<Result>(operation: Promise<DocsOperationResult<Result>>, version: 2 | 3) {
  const result = await operation;
  const outcome = result.outcome;
  const exitCode = outcome === "success" ? 0 : outcome === "invalid-input" ? 2 : outcome === "execution-failure" ? 3 : outcome === "cancelled" ? 130 : 1;
  return Object.freeze({ exitCode, envelope: Object.freeze({ schemaVersion: version, protocol: Object.freeze({ id: DOCS_PROTOCOL_ID, version: DOCS_PROTOCOL_VERSION }), command: result.command, outcome, diagnostics: result.diagnostics, result: result.result }) });
}

/** Maps the documentation use cases to their supported SDK envelope versions. */
export function createDocsProtocolApi(protocol: DocumentationOperations) {
  return {
    infoV2: (request: Parameters<DocumentationOperations["infoV2"]>[0]) => present(protocol.infoV2(request), 2),
    findV2: (request: Parameters<DocumentationOperations["findV2"]>[0]) => present(protocol.findV2(request), 2),
    findV3: (request: Parameters<DocumentationOperations["findV3"]>[0]) => present(protocol.findV3(request), 3),
    contextV1: (request: Parameters<DocumentationOperations["contextV1"]>[0]) => present(protocol.contextV1(request), 3),
    newDocumentV2: (request: Parameters<DocumentationOperations["newDocumentV2"]>[0]) => present(protocol.newDocumentV2(request), 2),
    doctorV2: (request: Parameters<DocumentationOperations["doctorV2"]>[0]) => present(protocol.doctorV2(request), 2),
    recoverV2: (request: Parameters<DocumentationOperations["recoverV2"]>[0]) => present<Awaited<ReturnType<DocumentationOperations["recoverV2"]>>["result"]>(protocol.recoverV2(request), 2),
    checkV2: (request: Parameters<DocumentationOperations["checkV2"]>[0]) => present(protocol.checkV2(request), 2),
  };
}
export type DocsProtocolApi = ReturnType<typeof createDocsProtocolApi>;
