import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { inputFailure } from "../../../application/configuration-input.js";
import type { FindingsBaselineStore } from "../../../application/model.js";

const MAX_BASELINE_BYTES = 8 * 1024 * 1024;

export interface BaselineFileOperations {
  readonly read: (input: { readonly candidate: string; readonly maxBytes: number; readonly root: string }) => Promise<Uint8Array>;
  readonly pathTraversesSymbolicLink: (root: string, candidate: string) => Promise<boolean>;
}

function reject(code: string, message: string): never {
  return inputFailure(code, message, "findings-baseline-store");
}

/** Reads and writes one contained regular file. Creation is exclusive and replacement is compare-and-swap. */
export class FilesystemFindingsBaselineStore implements FindingsBaselineStore {
  constructor(private readonly operations: BaselineFileOperations) {}

  private async locate(consumerRoot: string, path: string): Promise<{ readonly root: string; readonly candidate: string }> {
    const root = await realpath(consumerRoot);
    const candidate = resolve(root, path);
    const relation = relative(root, candidate);
    if (relation === "" || isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
      reject("FINDINGS_BASELINE_PATH_ESCAPE", `Findings baseline path escapes the consumer repository: ${path}.`);
    }
    if (await this.operations.pathTraversesSymbolicLink(root, candidate)) {
      reject("FINDINGS_BASELINE_PATH_SYMLINK", `Findings baseline path traverses a symbolic link: ${path}.`);
    }
    return { root, candidate };
  }

  async read(consumerRoot: string, path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const { root, candidate } = await this.locate(consumerRoot, path);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await this.operations.read({ root, candidate, maxBytes: MAX_BASELINE_BYTES }));
    } catch (error) {
      if (error instanceof Error && "failure" in error && error.failure === "missing") { return undefined; }
      reject("FINDINGS_BASELINE_UNREADABLE", `Findings baseline cannot be read as a contained UTF-8 file: ${path}.`);
    }
  }

  async create(consumerRoot: string, path: string, text: string): Promise<void> {
    const { root, candidate } = await this.locate(consumerRoot, path);
    await mkdir(dirname(candidate), { recursive: true });
    if (await this.operations.pathTraversesSymbolicLink(root, dirname(candidate))) {
      reject("FINDINGS_BASELINE_PATH_SYMLINK", `Findings baseline path traverses a symbolic link: ${path}.`);
    }
    try {
      const handle = await open(candidate, "wx", 0o644);
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        reject("FINDINGS_BASELINE_EXISTS", `A findings baseline already exists: ${path}.`);
      }
      throw error;
    }
  }

  async replace(consumerRoot: string, path: string, text: string, expected: string): Promise<void> {
    const { candidate } = await this.locate(consumerRoot, path);
    const temporary = `${candidate}.${process.pid}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o644);
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
      if (await this.read(consumerRoot, path) !== expected) {
        reject("FINDINGS_BASELINE_CHANGED", `Findings baseline changed while it was being pruned: ${path}.`);
      }
      await rename(temporary, candidate);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
