import { FoundationError } from "../../features/validation-reporting/foundation-error.js";
import { attachFoundation } from "./attach-transaction.js";
import { isExactVersion } from "../../semantic-version.js";
import { releaseFoundationTransactionLeaseSafely } from "../../transaction-coordination/application/release-foundation-transaction-lease.js";
import type { AttachResult, FoundationDevOnlyStatus, FoundationStatus } from "./model.js";
import { FOUNDATION_PACKAGE_NAME } from "./model.js";
import type { LocalPackageLifecyclePorts } from "./ports.js";

export interface LocalPackageLifecycleOptions {
  readonly ports: LocalPackageLifecyclePorts;
  readonly now: () => Date;
}

export class LocalPackageLifecycle {
  readonly #ports: LocalPackageLifecyclePorts;
  readonly #now: () => Date;

  constructor(options: LocalPackageLifecycleOptions) {
    this.#ports = options.ports;
    this.#now = options.now;
  }

  async #readStatus(
    consumerPath: string,
    ignoreOperationLock: boolean
  ): Promise<FoundationStatus> {
    const status = await this.#ports.inspection.mode(consumerPath, {
      ignoreOperationLock
    });
    if (status.mode !== "LOCAL" || status.linkState === undefined) {
      return status;
    }

    try {
      const git = await this.#ports.target.git(status.consumerRoot, status.linkState.targetPackageRoot);
      return { ...status, sourceGitCommit: git.gitCommit, sourceGitDirty: git.gitDirty };
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
      ports: this.#ports,
      now: this.#now,
      readStatus: async (path, ignoreOperationLock) =>
        await this.#readStatus(path, ignoreOperationLock)
    });
  }

  async detach(consumerPath: string): Promise<FoundationStatus> {
    const before = await this.#ports.inspection.mode(consumerPath);
    if (
      before.dependencySpec === undefined ||
      !isExactVersion(before.dependencySpec)
    ) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Consumer must retain an exact ${FOUNDATION_PACKAGE_NAME} registry dependency.`
      );
    }
    const coordinator = await this.#ports.coordinator(
      before.consumerRoot
    );
    const lease = await coordinator.acquire({
      requestedMutation: "detach",
      allowRecoveryOf: "local-mode"
    });
    try {
      const current = await this.#ports.inspection.mode(before.consumerRoot, {
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
        await this.#ports.state.write(before.consumerRoot, {
          ...current.linkState,
          phase: "DETACHING"
        });
      }
      await this.#ports.links.restore(
        before.consumerRoot,
        current.dependencySpec,
        current.linkState
      );
      await this.#ports.state.remove(before.consumerRoot);
    } finally {
      await releaseFoundationTransactionLeaseSafely({
        lease,
        inspectRetainTransactionBarrier: async () =>
          (await coordinator.inspect()).state !== "idle"
      });
    }

    const after = await this.#ports.inspection.mode(before.consumerRoot);
    if (after.mode !== "REGISTRY") {
      throw new FoundationError(
        "LOCAL_STATE_INVALID",
        `Registry restoration failed: ${after.issues.join(" ")}`
      );
    }
    return after;
  }

  async assertRegistry(consumerPath: string): Promise<FoundationStatus> {
    const status = await this.#ports.inspection.mode(consumerPath);
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
    const status = await this.#ports.inspection.devOnly(consumerPath);
    if (status.issues.length > 0) {
      throw new FoundationError(
        "CONSUMER_INVALID",
        `Development-only foundation dependency required: ${status.issues.join(" ")}`
      );
    }
    return status;
  }
}
