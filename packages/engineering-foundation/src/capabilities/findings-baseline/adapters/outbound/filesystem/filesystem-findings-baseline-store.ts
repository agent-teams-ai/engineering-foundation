import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  acquireMutationLease,
  observeAtomicFileReplacement,
  observeMutationState,
  releaseMutationLease,
  retainMutationBarrier,
  retainMutationBarrierOnEvidence,
  NodeAtomicFileReplacementError,
  type MutationLease,
  type NodeAtomicFileReplacement,
} from "@agent-teams/repository-mutation/node";
import { RepositoryMutationError } from "@agent-teams/repository-mutation/coordination";

import { inputFailure } from "../../../application/configuration-input.js";
import type { FindingsBaselineStore } from "../../../application/model.js";

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;

export interface BaselineFileOperations {
  readonly read: (input: {
    readonly candidate: string;
    readonly maxBytes: number;
    readonly root: string;
  }) => Promise<Uint8Array>;
  readonly pathTraversesSymbolicLink: (root: string, candidate: string) => Promise<boolean>;
}

function reject(code: string, message: string, options?: ErrorOptions): never {
  return inputFailure(code, message, "findings-baseline-store", options);
}

async function acquireBaselineLease(root: string): Promise<MutationLease> {
  try {
    return await acquireMutationLease(root);
  } catch (error) {
    if (!(error instanceof RepositoryMutationError)) {
      throw error;
    }
    reject(
      "FINDINGS_BASELINE_LOCK_UNAVAILABLE",
      "The repository mutation lease is unavailable. Reconcile active or interrupted operations before pruning the baseline.",
      { cause: error },
    );
  }
}

async function rejectCommonEvidence(lease: MutationLease): Promise<void> {
  await observeMutationState(lease);
  if (await retainMutationBarrierOnEvidence(lease)) {
    reject(
      "FINDINGS_BASELINE_CHANGED",
      "Common repository mutation evidence must be recovered before pruning the findings baseline.",
    );
  }
}

async function finalizeReplacement(
  replacement: NodeAtomicFileReplacement,
  lease: MutationLease,
  failures: unknown[],
): Promise<void> {
  try {
    await replacement.cleanup();
  } catch (error) {
    failures.push(error);
  }
  try {
    await observeMutationState(lease);
  } catch (error) {
    failures.push(error);
    // Observation can fail before the physical-root identity comparison.
    try {
      retainMutationBarrier(lease);
    } catch (retentionError) {
      failures.push(retentionError);
    }
  }
  try {
    await retainMutationBarrierOnEvidence(lease);
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseMutationLease(lease);
  } catch (error) {
    failures.push(error);
  }
}

function throwReplacementFailures(failures: readonly unknown[], replaced: boolean): void {
  if (failures.length === 0) {
    return;
  }
  const cause =
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Findings baseline replacement and finalization failed.", {
          cause: failures[0],
        });
  if (replaced) {
    reject(
      "FINDINGS_BASELINE_WRITE_UNCERTAIN",
      "The findings baseline was replaced, but finalization failed. Inspect the baseline and repository mutation evidence before retrying.",
      { cause },
    );
  }
  if (cause instanceof NodeAtomicFileReplacementError) {
    reject(
      "FINDINGS_BASELINE_CHANGED",
      "Findings baseline resource identity changed. Foreign evidence was preserved; reconcile the repository before retrying.",
      { cause },
    );
  }
  throw cause;
}

/** Exclusive creation and expected-byte replacement under the cooperative repository lease. */
export class FilesystemFindingsBaselineStore implements FindingsBaselineStore {
  constructor(private readonly operations: BaselineFileOperations) {}

  private async locate(
    consumerRoot: string,
    path: string,
  ): Promise<{ readonly root: string; readonly candidate: string }> {
    const root = await realpath(consumerRoot);
    const candidate = resolve(root, path);
    const relation = relative(root, candidate);
    if (
      relation === "" ||
      isAbsolute(relation) ||
      relation === ".." ||
      relation.startsWith(`..${sep}`)
    ) {
      reject(
        "FINDINGS_BASELINE_PATH_ESCAPE",
        `Findings baseline path escapes the consumer repository: ${path}.`,
      );
    }
    if (await this.operations.pathTraversesSymbolicLink(root, candidate)) {
      reject(
        "FINDINGS_BASELINE_PATH_SYMLINK",
        `Findings baseline path traverses a symbolic link: ${path}.`,
      );
    }
    return { root, candidate };
  }

  async read(
    consumerRoot: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    signal?.throwIfAborted();
    const { root, candidate } = await this.locate(consumerRoot, path);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await this.operations.read({ root, candidate, maxBytes: MAX_BASELINE_BYTES }),
      );
    } catch (error) {
      if (error instanceof Error && "failure" in error && error.failure === "missing") {
        return undefined;
      }
      reject(
        "FINDINGS_BASELINE_UNREADABLE",
        `Findings baseline cannot be read as a contained UTF-8 file: ${path}.`,
      );
    }
  }

  async create(consumerRoot: string, path: string, text: string): Promise<void> {
    const { root, candidate } = await this.locate(consumerRoot, path);
    await mkdir(dirname(candidate), { recursive: true });
    if (await this.operations.pathTraversesSymbolicLink(root, dirname(candidate))) {
      reject(
        "FINDINGS_BASELINE_PATH_SYMLINK",
        `Findings baseline path traverses a symbolic link: ${path}.`,
      );
    }
    try {
      const handle = await open(candidate, "wx", 0o644);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        reject("FINDINGS_BASELINE_EXISTS", `A findings baseline already exists: ${path}.`);
      }
      throw error;
    }
  }

  async replace(consumerRoot: string, path: string, text: string, expected: string): Promise<void> {
    const { root, candidate } = await this.locate(consumerRoot, path);
    const replacement = await observeAtomicFileReplacement({ root, candidate });
    const lease = await acquireBaselineLease(root);
    const failures: unknown[] = [];
    let replaced = false;
    try {
      await replacement.assertCurrent();
      await rejectCommonEvidence(lease);
      await replacement.bindParent();
      if ((await this.read(root, path)) !== expected) {
        reject(
          "FINDINGS_BASELINE_CHANGED",
          `Findings baseline changed while it was being pruned: ${path}.`,
        );
      }
      await replacement.prepare(Buffer.from(text, "utf8"));
      if ((await this.read(root, path)) !== expected) {
        reject(
          "FINDINGS_BASELINE_CHANGED",
          `Findings baseline changed while it was being pruned: ${path}.`,
        );
      }
      await rejectCommonEvidence(lease);
      if (await this.operations.pathTraversesSymbolicLink(root, candidate)) {
        reject(
          "FINDINGS_BASELINE_PATH_SYMLINK",
          `Findings baseline path traverses a symbolic link: ${path}.`,
        );
      }
      await replacement.replace();
      replaced = true;
    } catch (error) {
      failures.push(error);
    }
    await finalizeReplacement(replacement, lease, failures);
    throwReplacementFailures(failures, replaced);
  }
}
