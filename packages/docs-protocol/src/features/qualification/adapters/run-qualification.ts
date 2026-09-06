import { cp, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";

import { applyReachability, fileSnapshot, snapshot } from "./filesystem-evidence.js";
import { bootstrapQualificationInstallation } from "./qualification-runtime.js";
import { hasInfrastructureSegment } from "../application/evidence-policy.js";
import type { QualificationWorkspace } from "../application/workspace.js";

async function parentState(root: string, documentPath: string): Promise<"directory" | "missing"> {
  const repositoryParent = dirname(documentPath);
  const absolute = resolvePath(root, repositoryParent);
  const relativeParent = relative(resolvePath(root), absolute);
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`)) {
    throw new Error("Qualification document parent escapes its owned temporary consumer.");
  }
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Qualification document parent must be a real directory.");
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return "missing";}
    throw error;
  }
}

export const qualificationWorkspace: QualificationWorkspace = {
  async resolveRoot(root) { return realpath(resolvePath(root)); },
  snapshot,
  fileSnapshot,
  bootstrapInstallation: bootstrapQualificationInstallation,
  parentState,
  applyReachability,
  async createDisposable() {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "atd-q-")));
    const consumerRoot = join(temporary, "consumer");
    return {
      consumerRoot,
      async copyFrom(sourceRoot) {
        await cp(sourceRoot, consumerRoot, {
          recursive: true, errorOnExist: true, force: false, dereference: false,
          // Match the unconditional infrastructure exclusion in both evidence observations.
          // Keep journals and mutable authority for recovery; bootstrap owns tooling links.
          filter: (source) => !hasInfrastructureSegment(relative(sourceRoot, source).split(sep).join("/"))
        });
      },
      async dispose() { await rm(temporary, { recursive: true, force: true }); }
    };
  }
};
