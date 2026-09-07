import type { DocumentObservationDependencies } from "../../application/ports/document-observation.js";
import { installedDocumentAuthoringVersion } from "./package-version.js";
import { installedDocumentAuthoringBuildIdentity } from "./installed-artifact-identity.js";
import {
  CanonicalMarkdownError,
  YamlCanonicalDocumentRenderer
} from "../canonical-markdown.js";
import { NodeAuthoringProfileReaderV2 } from "./node-authoring-profile-reader-v2.js";
import { NodeDocumentContractValidator } from "./node-document-contract-validator.js";
import { NodeDocumentPlanningProfileReader } from "./node-document-planning-profile-reader.js";
import { NodeDocumentPlanningStateReader } from "./node-document-planning-state-reader.js";
import { NodeDocumentTemplateReader } from "./node-document-template-reader.js";
import { NodeMetadataInstanceValidator } from "./node-metadata-instance-validator.js";
import { NodeDocumentMetadataSidecarReader } from "./node-document-metadata-sidecar-reader.js";
import { NodeOwnerMembershipReader } from "./node-owner-membership-reader.js";
import { DocumentPlanningPolicyError } from "../../application/policies/document-planning-policy-error.js";
import {
  classifyDocumentLogicalPreimage,
  isDestinationCoveredByCatalog
} from "../../application/policies/document-logical-preimage.js";
import { normalizeDocumentIntent } from "../../application/policies/normalize-document-intent.js";
import {
  resolveDocumentAuthoring,
  selectDocumentArtifact
} from "../../application/policies/resolve-document-authoring.js";
import {
  BuildDocumentationCatalog,
  BuildDocumentationCatalogV2
} from "../../application/use-cases/build-documentation-catalog.js";
import {
  PlanDocumentationDocument,
  type PlanDocumentationDocumentRequestContract
} from "../../application/use-cases/plan-documentation-document.js";
import { DocumentPlanningError } from "../../application/model/document-planning-error.js";
import {
  describeDocumentAuthoringProfileV2,
  describeDocumentAuthoringProfileV3
} from "./describe-document-authoring-profile-v2.js";

function planningPolicyFailure(error: DocumentPlanningPolicyError): never {
  const code = error.problem === "catalog-incomplete"
    ? "DOCUMENT_PLANNING_CATALOG_PARTIAL"
    : ["catalog-collision", "destination-conflict"].includes(error.problem)
      ? "DOCUMENT_PLANNING_CONFLICT"
      : "DOCUMENT_PLANNING_INPUT_INVALID";
  throw new DocumentPlanningError(code, error.message, { cause: error });
}

/**
 * Closed Node composition shared by public planning and Foundation-owned replay.
 * This module is intentionally absent from the package export map.
 */
export async function planNodeDocumentationDocument(
  request: PlanDocumentationDocumentRequestContract,
  observation: DocumentObservationDependencies
) {
  const catalogDependencies = {
    metadata: new NodeMetadataInstanceValidator(observation.readFile),
    owners: new NodeOwnerMembershipReader(observation.readFile),
    profile: new NodeAuthoringProfileReaderV2(observation.readFile),
    repository: observation.repository,
    sidecar: new NodeDocumentMetadataSidecarReader(observation.readFile)
  };
  const profileReader = new NodeDocumentPlanningProfileReader(observation.readFile);
  const catalogV1 = new BuildDocumentationCatalog(catalogDependencies);
  const catalogV2 = new BuildDocumentationCatalogV2(catalogDependencies);
  const catalog = {
    async execute(input: Parameters<typeof catalogV1.execute>[0]) {
      const profile = await profileReader.read({
        consumerRoot: input.consumerRoot,
        path: input.profilePath,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      return profile.schemaVersion === 2 || profile.schemaVersion === 3
        ? catalogV2.execute(input)
        : catalogV1.execute(input);
    }
  };
  const [version, buildIdentity] = await Promise.all([
    installedDocumentAuthoringVersion(),
    installedDocumentAuthoringBuildIdentity()
  ]);
  const planner = new PlanDocumentationDocument({
    catalog,
    compiler: {
      id: "@agent-teams/document-authoring",
      version,
      buildIdentity
    },
    contracts: new NodeDocumentContractValidator(),
    metadata: new NodeMetadataInstanceValidator(observation.readFile),
    owners: new NodeOwnerMembershipReader(observation.readFile),
    policies: {
      classifyDocumentLogicalPreimage,
      isDestinationCoveredByCatalog,
      normalizeDocumentIntent,
      resolveDocumentAuthoring,
      selectDocumentArtifact
    },
    profile: profileReader,
    profileDescription: {
      describeV2: (input) => describeDocumentAuthoringProfileV2(input, observation.readFile),
      describeV3: (input) => describeDocumentAuthoringProfileV3(input, observation.readFile)
    },
    renderer: new YamlCanonicalDocumentRenderer(observation.syntax),
    state: new NodeDocumentPlanningStateReader(observation.readFile),
    templates: new NodeDocumentTemplateReader(observation.readFile)
  });
  try {
    return await planner.execute(request);
  } catch (error) {
    if (error instanceof DocumentPlanningPolicyError) {
      planningPolicyFailure(error);
    }
    if (error instanceof CanonicalMarkdownError) {
      throw new DocumentPlanningError(
        "DOCUMENT_PLANNING_AUTHORITY_UNAVAILABLE",
        `Document template authority is invalid: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}
