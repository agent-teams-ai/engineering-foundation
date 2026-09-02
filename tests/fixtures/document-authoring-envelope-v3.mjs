import { documentPlanDigest } from "../../packages/document-authoring/dist/application/policies/document-contract-digests.js";
import { documentTemporaryPath } from "../../packages/document-authoring/dist/application/policies/document-temporary-path.js";
import { sha256Json } from "../../packages/engineering-foundation/dist/canonical-json.js";

export const documentEnvelopeV3BuildIdentity = `sha256:${"2".repeat(64)}`;
export const documentEnvelopeV3Version = "0.16.0";

const physicalIdentity = Object.freeze({
  adapter: "node-filesystem",
  version: 1,
  dev: "1",
  ino: "2",
  birthtimeNs: "3",
});

export function createDocumentEnvelopeV3(documentContractFixture, state = "PREPARED") {
  const plan = structuredClone(documentContractFixture.plan);
  plan.compiler = {
    ...plan.compiler,
    version: documentEnvelopeV3Version,
    buildIdentity: documentEnvelopeV3BuildIdentity,
  };
  plan.planDigest = documentPlanDigest(plan);

  const journal = {
    schemaVersion: 2,
    plan,
    destination: {
      path: plan.destination,
      state:
        state === "PREPARED"
          ? "pending"
          : state === "PUBLISHING"
            ? "publishing"
            : "published",
    },
  };
  if (state === "PUBLISHING") {
    journal.ownedTemporary = {
      path: documentTemporaryPath(plan.destination, plan.planDigest),
      digest: plan.output.digest,
      identity: physicalIdentity,
    };
  }
  if (state === "PUBLISHED") {
    journal.publicationIdentity = physicalIdentity;
  }

  const envelope = {
    schemaVersion: 3,
    operationKind: "document-authoring",
    recoveryHandler: {
      id: "foundation.document-authoring",
      contractVersion: 2,
    },
    foundation: {
      version: documentEnvelopeV3Version,
      buildIdentity: documentEnvelopeV3BuildIdentity,
    },
    adapterContractVersion: 1,
    payloadKind: "document-authoring-journal/v2",
    journal,
    payloadDigest: sha256Json(journal),
    state,
  };
  return {
    ...envelope,
    envelopeDigest: sha256Json(envelope),
  };
}
