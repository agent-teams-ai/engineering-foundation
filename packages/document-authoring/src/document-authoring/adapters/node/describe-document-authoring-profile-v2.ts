import { assertNotCancelled, type ContainedFileReader } from "../../../documentation-observation/api.js";
import { compareBinaryStrings } from "../../../binary-string-comparator.js";

import { NodeDocumentMetadataSidecarReader } from "./node-document-metadata-sidecar-reader.js";
import { loadValidatedDocumentAuthoringProfileV2 } from "./load-validated-document-authoring-profile-v2.js";
import { NodeMetadataInstanceValidator } from "./node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "./node-owner-membership-reader.js";
import { readDocumentAuthorityFile } from "./read-document-authority-file.js";
import { DocumentCatalogError } from "../../application/model/document-catalog-error.js";
import type { DocumentAuthorityEvidence } from "../../application/model/document-catalog.js";
import type { DescriptionRequest, ValidatedDescriptionProfile, LoadedDescriptionAuthority, DescribeDocumentAuthoringProfileV2Request, DescribeDocumentAuthoringProfileV3Request } from "../../application/model/document-description-authority.js";
import type { DocumentAuthoringProfileDescriptionV2, DocumentAuthoringProfileDescriptionV3 } from "../../application/model/document-authoring-profile-description.js";
import { describeDocumentAuthoringProfile } from "../../application/use-cases/describe-document-authoring-profile.js";
const MAX_TEMPLATE_BYTES = 256 * 1024;
async function loadTemplateEvidence(
  request: DescriptionRequest,
  profile: ValidatedDescriptionProfile,
  readFile: ContainedFileReader
): Promise<ReadonlyMap<string, DocumentAuthorityEvidence>> {
  const paths = [...new Set(
    profile.authoring.artifactTypes.map((artifactType) => artifactType.template.path)
  )].toSorted(compareBinaryStrings);
  const files = await Promise.all(
    paths.map((path) =>
      readDocumentAuthorityFile(readFile, {
        consumerRoot: request.consumerRoot,
        maxBytes: MAX_TEMPLATE_BYTES,
        path
      })
    )
  );
  assertNotCancelled(request.signal);
  return new Map(files.map((file) => [file.evidence.path, file.evidence]));
}

async function loadDescriptionAuthority(
  request: DescriptionRequest,
  expectedVersion: 2 | 3,
  readFile: ContainedFileReader
): Promise<LoadedDescriptionAuthority> {
  const { evidence, profile } = await loadValidatedDocumentAuthoringProfileV2(readFile, {
    consumerRoot: request.consumerRoot,
    path: request.profilePath,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  if (profile.schemaVersion !== expectedVersion) {
    throw new DocumentCatalogError(
      "DOCUMENT_CATALOG_INPUT_INVALID",
      `Document authoring profile description v${expectedVersion} requires schemaVersion ${expectedVersion}.`
    );
  }
  const [ownerCatalog, metadata, sidecar, templateEvidenceByPath] =
    await Promise.all([
      new NodeOwnerMembershipReader(readFile).read({
        consumerRoot: request.consumerRoot,
        contract: profile.catalog.ownerCatalog.contract,
        path: profile.catalog.ownerCatalog.path,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }),
      new NodeMetadataInstanceValidator(readFile).load({
        consumerRoot: request.consumerRoot,
        path: profile.catalog.metadataSchemaPath,
        ...(request.signal === undefined ? {} : { signal: request.signal })
      }),
      profile.catalog.metadataSidecar === undefined
        ? undefined
        : new NodeDocumentMetadataSidecarReader(readFile).read({
            consumerRoot: request.consumerRoot,
            path: profile.catalog.metadataSidecar.path,
            ...(request.signal === undefined ? {} : { signal: request.signal })
          }),
      loadTemplateEvidence(request, profile, readFile)
    ]);
  return Object.freeze({
    metadata,
    ownerCatalog,
    profile,
    profileEvidence: evidence,
    ...(sidecar === undefined ? {} : { sidecarEvidence: sidecar.evidence }),
    templateEvidenceByPath
  });
}

export async function describeDocumentAuthoringProfileV2(
  request: DescribeDocumentAuthoringProfileV2Request,
  readFile: ContainedFileReader
): Promise<DocumentAuthoringProfileDescriptionV2> {
  const description = await describeDocumentAuthoringProfile(request, 2, (input, version) => loadDescriptionAuthority(input, version, readFile));
  if (description.profileSchemaVersion !== 2) {
    throw new TypeError("Document authoring profile v2 projection is inconsistent.");
  }
  return description;
}

export async function describeDocumentAuthoringProfileV3(
  request: DescribeDocumentAuthoringProfileV3Request,
  readFile: ContainedFileReader
): Promise<DocumentAuthoringProfileDescriptionV3> {
  const description = await describeDocumentAuthoringProfile(request, 3, (input, version) => loadDescriptionAuthority(input, version, readFile));
  if (description.profileSchemaVersion !== 3) {
    throw new TypeError("Document authoring profile v3 projection is inconsistent.");
  }
  return description;
}
