import type { InspectDocumentAuthoringEnvironmentV1Request } from "../../application/model/document-environment-request.js";
import { installedDocumentAuthoringVersion } from "./package-version.js";
import { installedDocumentAuthoringBuildIdentity } from "./installed-artifact-identity.js";
import { NodeDocumentEnvironmentInspector } from "./node-document-environment-inspector.js";
import type { DocumentEnvironmentInspection } from "../../application/ports/document-environment-inspector.js";

export async function inspectDocumentAuthoringEnvironmentV1(
  request: InspectDocumentAuthoringEnvironmentV1Request
): Promise<DocumentEnvironmentInspection> {
  return new NodeDocumentEnvironmentInspector({
    buildIdentity: installedDocumentAuthoringBuildIdentity,
    version: installedDocumentAuthoringVersion
  }).inspect(request.consumerRoot, request.signal);
}
