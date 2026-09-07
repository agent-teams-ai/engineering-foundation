import { createMutationLeaseOperations, type MutationLease } from "../application/mutation-lease.js";
import { nodeMutationLeasePort } from "../adapters/node/node-mutation-observation.js";

const mutationLeaseOperations = createMutationLeaseOperations(nodeMutationLeasePort);

export function acquireMutationLease(root: string): Promise<MutationLease> {
  return mutationLeaseOperations.acquireMutationLease(root);
}
