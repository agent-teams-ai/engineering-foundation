import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { lock } from "proper-lockfile";

import { FoundationError } from "../../../errors.js";
import type { FoundationOperationLock } from "../../application/ports/foundation-operation-lock.js";
import { LOCAL_OPERATION_LOCK } from "./foundation-state-paths.js";
import {
  ensureFoundationStateDirectory,
  pruneFoundationStateDirectory,
  syncFoundationStateDirectory
} from "./node-foundation-state-directory.js";

export class NodeFoundationOperationLock implements FoundationOperationLock {
  readonly #consumerRoot: string;

  constructor(consumerRoot: string) {
    this.#consumerRoot = consumerRoot;
  }

  async acquire(): Promise<() => Promise<void>> {
    const directory = await ensureFoundationStateDirectory(this.#consumerRoot);
    const lockPath = join(directory, LOCAL_OPERATION_LOCK);
    try {
      const lockEntry = await lstat(lockPath);
      if (!lockEntry.isDirectory() || lockEntry.isSymbolicLink()) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Foundation operation lock path must be a real local directory."
        );
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
    try {
      const release = await lock(directory, {
        lockfilePath: lockPath,
        onCompromised: (error) => {
          throw error;
        },
        realpath: true,
        retries: 0,
        stale: 120_000,
        update: 30_000
      });
      return async () => {
        await release();
        await syncFoundationStateDirectory(directory);
        await pruneFoundationStateDirectory(this.#consumerRoot);
      };
    } catch (error) {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        "Another foundation operation is active or its lock is not safely recoverable.",
        { cause: error }
      );
    }
  }
}
