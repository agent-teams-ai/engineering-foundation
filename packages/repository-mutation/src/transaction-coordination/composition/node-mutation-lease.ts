import { createMutationLeaseOperations } from "../application/mutation-lease.js";
import { nodeMutationLeasePort } from "../adapters/node/node-mutation-observation.js";

export const { acquireMutationLease } = createMutationLeaseOperations(nodeMutationLeasePort);
