import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { FoundationError } from "../errors.js";
import { attachFoundation } from "./attach-transaction.js";
import {
  inspectFoundationDevOnly
} from "./consumer-policy.js";
import { isExactVersion } from "../semantic-version.js";
import { inspectFoundationMode } from "./inspection.js";
import {
  removeLinkState,
  writeLinkState
} from "./local-state-store.js";
import { createNodeFoundationTransactionCoordinator } from "../transaction-coordination/adapters/node/node-foundation-transaction-coordinator.js";
import { releaseFoundationTransactionLeaseSafely } from "../transaction-coordination/application/release-foundation-transaction-lease.js";
import {
  restoreRegistryEntry
} from "./registry-recovery.js";
import type {
  AttachResult,
  FoundationDevOnlyStatus,
  FoundationStatus,
  ProcessRunner
} from "./types.js";
import { FOUNDATION_PACKAGE_NAME } from "./types.js";

export { acquireFoundationOperationLock } from "./local-state-store.js";

export interface FoundationLocalModeServiceOptions {
  readonly runner: ProcessRunner;
  readonly now: () => Date;
}

export class FoundationLocalModeService {
  readonly #runner: ProcessRunner;
  readonly #now: () => Date;

  constructor(options: FoundationLocalModeServiceOptions) {
    this.#runner = options.runner;
    this.#now = options.now;
  }

  async #readStatus(
    consumerPath: string,
    ignoreOperationLock: boolean
  ): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath, {
      ignoreOperationLock
    });
    if (status.mode !== "LOCAL" || status.linkState === undefined) {
      return status;
    }

    try {
      const sourceGitCommit = (
        await this.#runner.run({
          command: "git",
          args: [
            "-C",
            status.linkState.targetPackageRoot,
            "rev-parse",
            "HEAD"
          ],
          cwd: status.consumerRoot
        })
      ).stdout.trim();
      const sourceGitDirty =
        (
          await this.#runner.run({
            command: "git",
            args: [
              "-C",
              status.linkState.targetPackageRoot,
              "status",
              "--porcelain"
            ],
            cwd: status.consumerRoot
          })
        ).stdout.trim().length > 0;
      return { ...status, sourceGitCommit, sourceGitDirty };
    } catch (error) {
      return {
        ...status,
        mode: "INVALID",
        issues: [
          ...status.issues,
          `Local foundation Git evidence is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        ]
      };
    }
  }

  async status(consumerPath: string): Promise<FoundationStatus> {
    return await this.#readStatus(consumerPath, false);
  }

  async attach(
    consumerPath: string,
    targetPath: string
  ): Promise<AttachResult> {
    return await attachFoundation({
      consumerPath,
      targetPath,
      runner: this.#runner,
      now: this.#now,
      readStatus: async (path, ignoreOperationLock) =>
        await this.#readStatus(path, ignoreOperationLock)
    });
  }

  async detach(consumerPath: string): Promise<FoundationStatus> {
    const before = await inspectFoundationMode(consumerPath);
    if (
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must retain an exact ${FOUNDATION_PACKAGE_NAME} registry dependency.`
      );
    }
    const coordinator = await createNodeFoundationTransactionCoordinator(
      before.consumerRoot
    );
    const lease = await coordinator.acquire({
      requestedMutation: "detach",
      allowRecoveryOf: "local-mode"
    });
    try {
      const current = await inspectFoundationMode(before.consumerRoot, {
        ignoreOperationLock: true
      });
      if (
        current.consumerRoot !== before.consumerRoot ||
        current.dependencySpec === undefined ||
        current.dependencySpec !== before.dependencySpec ||
        !isExactVersion(current.dependencySpec)
      ) {
        throw new FoundationError(
          "LOCAL_STATE_INVALID",
          "Consumer foundation dependency changed before detach acquired its operation lock."
        );
      }
      if (current.mode === "REGISTRY") {
        return current;
      }
      if (current.linkState !== undefined) {
        await writeLinkState(before.consumerRoot, {
          ...current.linkState,
          phase: "DETACHING"
        });
      }
      await restoreRegistryEntry(
        before.consumerRoot,
        current.dependencySpec,
        current.linkState
      );
      await removeLinkState(before.consumerRoot);
    } finally {
      await releaseFoundationTransactionLeaseSafely({
        lease,
        inspectRetainTransactionBarrier: async () =>
          (await coordinator.inspect()).state !== "idle"
      });
    }

    const after = await inspectFoundationMode(before.consumerRoot);
    if (after.mode !== "REGISTRY") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Registry restoration failed: ${after.issues.join(" ")}`
      );
    }
    return after;
  }

  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    const status = await inspectFoundationMode(consumerPath);
    if (status.mode !== "REGISTRY") {
      throw new FoundationError(
        "REGISTRY_MODE_REQUIRED",
        `Registry foundation mode required: ${status.issues.join(" ") || status.mode}`
      );
    }
    return status;
  }

  async assertDevOnly(
    consumerPath: string
  ): Promise<FoundationDevOnlyStatus> {
    const consumerRoot = await realpath(resolve(consumerPath));
    const status = await inspectFoundationDevOnly(consumerRoot);
    if (status.issues.length > 0) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Development-only foundation dependency required: ${status.issues.join(" ")}`
      );
    }
    return status;
  }
}
