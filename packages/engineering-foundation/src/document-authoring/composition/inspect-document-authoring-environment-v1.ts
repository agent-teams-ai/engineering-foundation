import { installedFoundationVersion } from "../../package-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeDocumentEnvironmentInspector } from "../adapters/node/node-document-environment-inspector.js";
import type { DocumentEnvironmentInspection } from "../application/ports/document-environment-inspector.js";

export interface InspectDocumentAuthoringEnvironmentV1Request {
  readonly consumerRoot: string;
  readonly signal?: AbortSignal;
}

export async function inspectDocumentAuthoringEnvironmentV1(
  request: InspectDocumentAuthoringEnvironmentV1Request
): Promise<DocumentEnvironmentInspection> {
  return new NodeDocumentEnvironmentInspector({
    buildIdentity: installedFoundationBuildIdentity,
    version: installedFoundationVersion
  }).inspect(request.consumerRoot, request.signal);
}
