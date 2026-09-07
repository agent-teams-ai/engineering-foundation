import type { DocumentParentMaterializationJournalV2 } from "../model/document-parent-materialization.js";
import type { DocumentPhysicalIdentity } from "../model/document-physical-identity.js";
import type { DocumentPlanV1, DocumentPlanV2 } from "../model/document-planning.js";
import type {
  DocumentOwnedTemporary,
  DocumentTransactionEnvelope,
  DocumentTransactionEnvelopeBody
} from "../model/document-transaction.js";

export function envelopeBodyV3(
  plan: DocumentPlanV1,
  kernelArtifact: DocumentTransactionEnvelope["kernelArtifact"],
  lifecycle:
    | { readonly state: "PREPARED"; readonly destination: "pending" | "preexisting" }
    | { readonly state: "PUBLISHING"; readonly temporary: DocumentOwnedTemporary }
    | { readonly state: "PUBLISHED"; readonly publicationIdentity: DocumentPhysicalIdentity }
): DocumentTransactionEnvelopeBody {
  const base = {
    adapterContractVersion: 1 as const,
    kernelArtifact: Object.freeze({ ...kernelArtifact }),
    foundation: Object.freeze({
      buildIdentity: plan.compiler.buildIdentity,
      version: plan.compiler.version
    }),
    operationKind: "document-authoring" as const,
    payloadKind: "document-authoring-journal/v2" as const,
    recoveryHandler: Object.freeze({
      contractVersion: 2 as const,
      id: "document-authoring" as const
    }),
    schemaVersion: 3 as const
  };
  if (lifecycle.state === "PREPARED") {
    const prepared = { ...base, state: lifecycle.state };
    return lifecycle.destination === "pending"
      ? {
          ...prepared,
          journal: {
            destination: { path: plan.destination, state: "pending" },
            plan,
            schemaVersion: 2
          }
        }
      : {
          ...prepared,
          journal: {
            destination: { path: plan.destination, state: "preexisting" },
            plan,
            schemaVersion: 2
          }
        };
  }
  if (lifecycle.state === "PUBLISHING") {
    return {
      ...base,
      journal: {
        destination: { path: plan.destination, state: "publishing" },
        ownedTemporary: lifecycle.temporary,
        plan,
        schemaVersion: 2
      },
      state: lifecycle.state
    };
  }
  return {
    ...base,
    journal: {
      destination: { path: plan.destination, state: "published" },
      plan,
      publicationIdentity: lifecycle.publicationIdentity,
      schemaVersion: 2
    },
    state: lifecycle.state
  };
}

export function envelopeBodyV4(
  plan: DocumentPlanV2,
  kernelArtifact: DocumentTransactionEnvelope["kernelArtifact"],
  materialization: DocumentParentMaterializationJournalV2,
  lifecycle:
    | { readonly state: "PREPARED"; readonly destination: "pending" | "preexisting" }
    | { readonly state: "MATERIALIZING"; readonly pendingDirectory?: string }
    | { readonly state: "PUBLISHING"; readonly temporary: DocumentOwnedTemporary }
    | { readonly state: "PUBLISHED"; readonly publicationIdentity: DocumentPhysicalIdentity }
): DocumentTransactionEnvelopeBody {
  const parentMaterialization = Object.freeze({
    anchorIdentity: materialization.anchorIdentity,
    createdDirectories: materialization.createdDirectories,
    ...(lifecycle.state === "MATERIALIZING" && lifecycle.pendingDirectory !== undefined
      ? { pendingDirectory: lifecycle.pendingDirectory }
      : {})
  });
  const base = {
    adapterContractVersion: 1 as const,
    kernelArtifact: Object.freeze({ ...kernelArtifact }),
    foundation: Object.freeze({
      buildIdentity: plan.compiler.buildIdentity,
      version: plan.compiler.version
    }),
    operationKind: "document-authoring" as const,
    payloadKind: "document-authoring-journal/v3" as const,
    recoveryHandler: Object.freeze({
      contractVersion: 3 as const,
      id: "document-authoring" as const
    }),
    schemaVersion: 4 as const
  };
  if (lifecycle.state === "PREPARED") {
    const prepared = { ...base, state: lifecycle.state };
    return lifecycle.destination === "pending"
      ? {
          ...prepared,
          journal: {
            destination: { path: plan.destination, state: "pending" },
            parentMaterialization,
            plan,
            schemaVersion: 3
          }
        }
      : {
          ...prepared,
          journal: {
            destination: { path: plan.destination, state: "preexisting" },
            parentMaterialization,
            plan,
            schemaVersion: 3
          }
        };
  }
  if (lifecycle.state === "MATERIALIZING") {
    return {
      ...base,
      journal: {
        destination: { path: plan.destination, state: "materializing" },
        parentMaterialization,
        plan,
        schemaVersion: 3
      },
      state: lifecycle.state
    };
  }
  if (lifecycle.state === "PUBLISHING") {
    return {
      ...base,
      journal: {
        destination: { path: plan.destination, state: "publishing" },
        ownedTemporary: lifecycle.temporary,
        parentMaterialization,
        plan,
        schemaVersion: 3
      },
      state: lifecycle.state
    };
  }
  return {
    ...base,
    journal: {
      destination: { path: plan.destination, state: "published" },
      parentMaterialization,
      plan,
      publicationIdentity: lifecycle.publicationIdentity,
      schemaVersion: 3
    },
    state: lifecycle.state
  };
}
