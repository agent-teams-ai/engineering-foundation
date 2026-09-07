import { applyKnownFileTransaction, compileKnownFileTransactionPlan, inspectKnownFileTransactionBarrier, recoverKnownFileTransaction, assertKnownFileTransactionPlan } from "@agent-teams/repository-mutation";
import type { BootstrapFileImage, BootstrapTransactions } from "../../application/bootstrap-model.js";

function bytes(image: BootstrapFileImage) {
  return { bytes: Buffer.from(image.contentBase64, "base64"), ...(image.mode === undefined ? {} : { mode: image.mode }) };
}

export const nodeBootstrapTransactions: BootstrapTransactions = {
  compile(operations) {
    const plan = compileKnownFileTransactionPlan({ operations: operations.map((operation) => {
      if (operation.precondition.state === "absent") {
        return { path: operation.path, precondition: { state: "absent" }, postimage: bytes(operation.postimage) };
      }
      const mode = operation.postimage.mode;
      if (mode === undefined) {throw new TypeError("Known-file bootstrap postimage requires its observed mode.");}
      return {
        path: operation.path,
        precondition: { state: "known-file", acceptedPreimages: operation.precondition.acceptedPreimages.map((image) => ({ bytes: Buffer.from(image.contentBase64, "base64"), mode: image.mode })) },
        postimage: { bytes: Buffer.from(operation.postimage.contentBase64, "base64"), mode }
      };
    }) });
    return Object.freeze({ planDigest: plan.planDigest, serializedPlan: JSON.stringify(plan) });
  },
  apply({ consumerRoot, plan }) {
    const parsed: unknown = JSON.parse(plan.serializedPlan);
    assertKnownFileTransactionPlan(parsed);
    return applyKnownFileTransaction({ consumerRoot, plan: parsed });
  },
  inspect: inspectKnownFileTransactionBarrier,
  recover: recoverKnownFileTransaction
};
