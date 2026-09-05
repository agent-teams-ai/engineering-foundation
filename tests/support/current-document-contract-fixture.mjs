import { documentPlanDigest, documentReceiptDigest } from "../../packages/document-authoring/dist/document-authoring/application/policies/document-contract-digests.js";
import { sha256Json } from "../../packages/repository-mutation/dist/index.js";
import { createDocumentEnvelopeV3 } from "../fixtures/document-authoring-envelope-v3.mjs";

export const fixtureKernelArtifact = Object.freeze({
  name: "@agent-teams/repository-mutation", version: "0.0.0",
  buildIdentity: `sha256:${"9".repeat(64)}`
});

// Synthetic current policy input, deliberately separate from frozen old JSON.
// Native writer outputs are qualified separately by the installed consumer tests.
export function currentDocumentContractFixture(historical) {
  const fixture = structuredClone(historical);
  fixture.plan.compiler.id = "@agent-teams/document-authoring";
  fixture.plan.planDigest = documentPlanDigest(fixture.plan);
  fixture.receipt.planDigest = fixture.plan.planDigest;
  fixture.receipt.receiptDigest = documentReceiptDigest(fixture.receipt);
  return fixture;
}

export function createCurrentDocumentEnvelopeV3(fixture, state = "PREPARED") {
  const envelope = createDocumentEnvelopeV3(currentDocumentContractFixture(fixture), state);
  envelope.recoveryHandler.id = "document-authoring";
  envelope.kernelArtifact = fixtureKernelArtifact;
  envelope.payloadDigest = sha256Json(envelope.journal);
  const { envelopeDigest: _digest, ...body } = envelope;
  return { ...body, envelopeDigest: sha256Json(body) };
}
