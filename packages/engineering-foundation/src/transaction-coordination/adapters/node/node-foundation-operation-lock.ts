import {
  acquireMutationLease,
  releaseMutationLease,
  retainMutationBarrier,
  type MutationLease
} from "@agent-teams/repository-mutation/node";

import type {
  FoundationOperationLock,
  FoundationOperationReleaseOptions
} from "../../application/ports/foundation-operation-lock.js";
import { FoundationError } from "../../../errors.js";

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
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Another Foundation operation is active or its shared mutation lock is not safely recoverable.",
        { cause: error }
      );
    }
    let released = false;
    return async (options = {}) => {
      if (released) {return;}
      if (options.retainTransactionBarrier === true) {retainMutationBarrier(lease);}
      try {
        await releaseMutationLease(lease);
      } catch (error) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Foundation could not release the shared mutation lock without violating ownership.",
          { cause: error }
        );
      }
      released = true;
    };
  }
}
