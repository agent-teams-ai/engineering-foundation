import { FilesystemMarkdownRepository } from "../../documentation-observation/adapters/outbound/filesystem/filesystem-markdown-repository.js";
import { installedFoundationVersion } from "../../package-version.js";
import { installedFoundationBuildIdentity } from "../../transaction-coordination/adapters/node/installed-foundation-build-identity.js";
import { NodeAuthoringProfileReader } from "../adapters/node/node-authoring-profile-reader.js";
import { NodeDocumentPlanningProfileReader } from "../adapters/node/node-document-planning-profile-reader.js";
import { NodeDocumentReachabilityProjector } from "../adapters/node/node-document-reachability-projector.js";
import { NodeDocumentStructureVerifier } from "../adapters/node/node-document-structure-verifier.js";
import { NodeMetadataInstanceValidator } from "../adapters/node/node-metadata-instance-validator.js";
import { NodeOwnerMembershipReader } from "../adapters/node/node-owner-membership-reader.js";
import { NodeDocumentEnvironmentInspector } from "../adapters/node/node-document-environment-inspector.js";
import { BuildDocumentationCatalog } from "../application/use-cases/build-documentation-catalog.js";
import { RunDocumentDoctor } from "../application/use-cases/run-document-doctor.js";
import { FindDocuments } from "../application/use-cases/find-documents.js";
import { RunDocumentNew } from "../application/use-cases/run-document-new.js";
import { RunDocumentRecover } from "../application/use-cases/run-document-recover.js";
import { inspectDocumentTransactionV1 } from "./inspect-document-transaction.js";
import { planNodeDocumentationDocument } from "./node-document-planning.js";
import {
  applyNodeDocumentationPlan,
  recoverNodeDocumentationTransaction,
} from "./node-document-writing.js";

/** Closed Node composition for the document mutation command family. */
export function createNodeDocumentCommands(): Readonly<{
  readonly doctor: RunDocumentDoctor;
  readonly newDocument: RunDocumentNew;
  readonly recover: RunDocumentRecover;
}> {
  const inspect = inspectDocumentTransactionV1;
  const planningProfiles = new NodeDocumentPlanningProfileReader();
  const catalog = new BuildDocumentationCatalog({
    metadata: new NodeMetadataInstanceValidator(),
    owners: new NodeOwnerMembershipReader(),
    profile: new NodeAuthoringProfileReader(),
    repository: new FilesystemMarkdownRepository(),
  });
  const find = new FindDocuments(catalog);
  return Object.freeze({
    doctor: new RunDocumentDoctor({
      environment: new NodeDocumentEnvironmentInspector({
        buildIdentity: installedFoundationBuildIdentity,
        version: installedFoundationVersion
      }),
      inspect
    }),
    newDocument: new RunDocumentNew({
      apply: applyNodeDocumentationPlan,
      inspect,
      plan: planNodeDocumentationDocument,
      reachability: new NodeDocumentReachabilityProjector(planningProfiles),
      similar: {
        async advise(request) {
          const result = await find.execute({
            consumerRoot: request.consumerRoot,
            profilePath: request.profilePath,
            query: { text: request.title },
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          return Object.freeze({
            matches: Object.freeze(result.documents.map(({ id, repositoryPath }) =>
              Object.freeze({ id, repositoryPath })
            )),
            query: request.title,
          });
        },
      },
      structure: new NodeDocumentStructureVerifier({
        catalog,
        profiles: planningProfiles,
      }),
    }),
    recover: new RunDocumentRecover({
      inspect,
      recover: recoverNodeDocumentationTransaction,
    }),
  });
}
