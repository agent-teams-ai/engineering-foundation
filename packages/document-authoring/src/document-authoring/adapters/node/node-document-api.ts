import { assertSchema } from "./schema-catalog.js";
import { NodeAuthoringProfileReader } from "./node-authoring-profile-reader.js";
import { NodeAuthoringProfileReaderV2 } from "./node-authoring-profile-reader-v2.js";
import { NodeDocumentMetadataSidecarReader } from "./node-document-metadata-sidecar-reader.js";
import { NodeMetadataInstanceValidator } from "./node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "./node-owner-membership-reader.js";
import {
  BuildDocumentationCatalog,
  BuildDocumentationCatalogV2,
  type BuildDocumentationCatalogRequest
} from "../../application/use-cases/build-documentation-catalog.js";
import {
  FindDocuments,
  FindDocumentsV2,
  type FindDocumentsRequest
} from "../../application/use-cases/find-documents.js";
import type {
  PlanDocumentationDocumentRequestContract,
  PlanDocumentationDocumentRequestV2
} from "../../application/use-cases/plan-documentation-document.js";
import type { DocumentPlanContract } from "../../application/model/document-planning.js";
import type { DocumentReceiptContract } from "../../application/model/document-receipt.js";
import { planNodeDocumentationDocument } from "./node-document-planning.js";
import type { DocumentObservationDependencies } from "../../application/ports/document-observation.js";
import type { ApplyDocumentPlanRequest } from "../../application/use-cases/apply-document-plan.js";
import type { RecoverDocumentTransactionRequest } from "../../application/use-cases/recover-document-transaction.js";
import {
  applyNodeDocumentationPlan,
  recoverNodeDocumentationTransaction
} from "./node-document-writing.js";
import {
  describeDocumentAuthoringProfileV2 as describeV2,
  describeDocumentAuthoringProfileV3 as describeV3
} from "./describe-document-authoring-profile-v2.js";
import { inspectDocumentAuthoringEnvironmentV1 } from "./inspect-document-authoring-environment-v1.js";
import { RecompileDocumentAuthority } from "../../application/use-cases/document-authority-recompiler.js";
import { NodeDocumentContractValidator } from "./node-document-contract-validator.js";

export function createNodeDocumentAuthoring(observation: DocumentObservationDependencies) {
  const authority = createNodeDocumentAuthority(observation);
  async function buildDocumentationCatalog(
    request: BuildDocumentationCatalogRequest
  ) {
    const builder = new BuildDocumentationCatalog({
      metadata: new NodeMetadataInstanceValidator(observation.readFile),
      owners: new NodeOwnerMembershipReader(observation.readFile),
      profile: new NodeAuthoringProfileReader(observation.readFile),
      repository: observation.repository
    });
    return builder.execute(request);
  }

  async function buildDocumentationCatalogV2(
    request: BuildDocumentationCatalogRequest
  ) {
    const builder = new BuildDocumentationCatalogV2({
      metadata: new NodeMetadataInstanceValidator(observation.readFile),
      owners: new NodeOwnerMembershipReader(observation.readFile),
      profile: new NodeAuthoringProfileReaderV2(observation.readFile),
      repository: observation.repository,
      sidecar: new NodeDocumentMetadataSidecarReader(observation.readFile)
    });
    return builder.execute(request);
  }

  async function findDocumentationDocuments(request: FindDocumentsRequest) {
    const catalog = new BuildDocumentationCatalog({
      metadata: new NodeMetadataInstanceValidator(observation.readFile),
      owners: new NodeOwnerMembershipReader(observation.readFile),
      profile: new NodeAuthoringProfileReader(observation.readFile),
      repository: observation.repository
    });
    return new FindDocuments(catalog).execute(request);
  }

  async function findDocumentationDocumentsV2(request: FindDocumentsRequest) {
    const catalog = new BuildDocumentationCatalogV2({
      metadata: new NodeMetadataInstanceValidator(observation.readFile),
      owners: new NodeOwnerMembershipReader(observation.readFile),
      profile: new NodeAuthoringProfileReaderV2(observation.readFile),
      repository: observation.repository,
      sidecar: new NodeDocumentMetadataSidecarReader(observation.readFile)
    });
    return new FindDocumentsV2(catalog).execute(request);
  }

  /**
   * Compiles a deterministic Document Plan without reserving an identity or
   * mutating the consumer repository. Narrow schemaVersion before using fields
   * specific to either Plan generation.
   */
  async function planDocumentationDocument(
    request: PlanDocumentationDocumentRequestContract
  ): Promise<DocumentPlanContract> {
    return planNodeDocumentationDocument(request, observation);
  }

  /** Compiles the directory-materializing Document Plan v2 contract. */
  async function planDocumentationDocumentV2(
    request: PlanDocumentationDocumentRequestV2
  ): Promise<import("../../application/model/document-planning.js").DocumentPlanV2> {
    const plan = await planNodeDocumentationDocument(request, observation);
    if (plan.schemaVersion !== 2) {
      throw new TypeError(
        "Document Plan v2 entrypoint received a legacy planning result."
      );
    }
    return plan;
  }

  /** Applies one exact Plan; the Receipt generation follows the validated Plan. */
  async function applyDocumentationPlan(
    request: ApplyDocumentPlanRequest
  ): Promise<DocumentReceiptContract> {
    return applyNodeDocumentationPlan(request, authority);
  }

  /** Applies one exact Document Plan v2 through envelope v4. */
  async function applyDocumentationPlanV2(
    request: Omit<ApplyDocumentPlanRequest, "plan"> & {
      readonly plan: import("../../application/model/document-planning.js").DocumentPlanV2;
    }
  ): Promise<import("../../application/model/document-receipt.js").DocumentReceiptV2> {
    const receipt = await applyNodeDocumentationPlan(request, authority);
    if (receipt.schemaVersion !== 2) {
      throw new TypeError("Document Plan v2 produced a legacy Receipt.");
    }
    return receipt;
  }

  /** Recovers one qualified transaction; persisted evidence selects its generation. */
  async function recoverDocumentationTransaction(
    request: RecoverDocumentTransactionRequest
  ): Promise<DocumentReceiptContract> {
    return recoverNodeDocumentationTransaction(request, authority);
  }

  /** Recovers either exact supported document transaction generation. */
  async function recoverDocumentationTransactionV2(
    request: RecoverDocumentTransactionRequest
  ): Promise<DocumentReceiptContract> {
    return recoverNodeDocumentationTransaction(request, authority);
  }
  return {
    buildDocumentationCatalog,
    buildDocumentationCatalogV2,
    findDocumentationDocuments,
    findDocumentationDocumentsV2,
    planDocumentationDocument,
    planDocumentationDocumentV2,
    applyDocumentationPlan,
    applyDocumentationPlanV2,
    recoverDocumentationTransaction,
    recoverDocumentationTransactionV2,
    describeDocumentAuthoringProfileV2: (request: Parameters<typeof describeV2>[0]) => describeV2(request, observation.readFile),
    describeDocumentAuthoringProfileV3: (request: Parameters<typeof describeV3>[0]) => describeV3(request, observation.readFile),
    inspectDocumentAuthoringEnvironmentV1
  };
}

export function createNodeDocumentAuthority(observation: DocumentObservationDependencies) {
  return new RecompileDocumentAuthority({ contracts: new NodeDocumentContractValidator(), plan: (request) => planNodeDocumentationDocument(request, observation) });
}

export const documentSchemaValidator = { assertSchema };
