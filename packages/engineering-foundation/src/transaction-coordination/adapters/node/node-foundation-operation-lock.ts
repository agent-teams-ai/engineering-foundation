import {
  acquireMutationLease,
  releaseMutationLease,
  retainMutationBarrier,
  type MutationLease
} from "@agent-teams/repository-mutation/node";
import { RepositoryMutationError } from "@agent-teams/repository-mutation";

import type {
  FoundationOperationLock,
  FoundationOperationReleaseOptions
} from "../../application/ports/foundation-operation-lock.js";
import { operationLockAcquisitionFailure, operationLockReleaseFailure } from "../../application/operation-lock-failure.js";

export class NodeFoundationOperationLock implements FoundationOperationLock {
  readonly #consumerRoot: string;

  constructor(consumerRoot: string) {
    this.#consumerRoot = consumerRoot;
  }

  async acquire(): Promise<(options?: FoundationOperationReleaseOptions) => Promise<void>> {
    let lease: MutationLease;
    try {
      lease = await acquireMutationLease(this.#consumerRoot);
    } catch (error) {
      throw operationLockAcquisitionFailure(error, error instanceof RepositoryMutationError ? error.message : undefined);
    }
    let released = false;
    return async (options = {}) => {
      if (released) {return;}
      if (options.retainTransactionBarrier === true) {retainMutationBarrier(lease);}
      try {
        await releaseMutationLease(lease);
      } catch (error) {
        throw operationLockReleaseFailure(error);
      }
      released = true;
    };
  }
}
