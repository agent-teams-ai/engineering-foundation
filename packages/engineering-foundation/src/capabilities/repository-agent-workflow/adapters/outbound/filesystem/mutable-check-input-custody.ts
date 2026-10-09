import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CheckInputCustody } from "../../../application/ports/check-changed.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";
import { assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";
import { GitRepositoryChangesReader } from "../git/git-repository-changes-reader.js";

/** Diagnostics over Git-visible files, never a complete dependency custody
 * implementation. The mutable classification cannot produce exact-byte PASS,
 * including when a transient ABA edit leaves these brackets unchanged. */
export function createMutableCheckInputCustody(execute: ExecuteWorkflowProcess): CheckInputCustody {
  async function observe(root: string, configPath: string, signal?: AbortSignal) {
    assertConfigRepositoryRelativePath(configPath);
    const result = await execute("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, strictUtf8: true, ...(signal === undefined ? {} : { signal }) });
    if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith("\0"))) {throw new Error("Cannot observe Git-visible input scope.");}
    const paths = [...new Set([...result.stdout.split("\0").filter(Boolean), configPath])].toSorted();
    if (paths.length > 50_000) {throw new Error("Input observation exceeds path bound.");}
    const hash = createHash("sha256");
    let total = 0;
    let configIdentity = "";
    for (const path of paths) {
      assertConfigRepositoryRelativePath(path);
      let parent = root;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        const metadata = await lstat(parent).catch(() => null);
        if (metadata !== null && !metadata.isDirectory()) {throw new Error("Input ancestor is not a directory.");}
      }
      const candidate = join(root, path);
      const metadata = await lstat(candidate).catch(() => null);
      hash.update(JSON.stringify([path, metadata?.mode ?? null]));
      if (metadata === null) {continue;}
      if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {throw new Error("Input is not a bounded regular file.");}
      total += metadata.size;
      if (total > 256 * 1024 * 1024) {throw new Error("Input observation exceeds byte bound.");}
      const bytes = await readFile(candidate);
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      hash.update(fingerprint);
      if (path === configPath) {configIdentity = fingerprint;}
    }
    if (configIdentity === "") {throw new Error("Workflow configuration is missing.");}
    return { sourceIdentity: hash.digest("hex"), configIdentity };
  }
  return {
    async acquire({ consumerRoot, configPath, signal }) {
      const executionRoot = await realpath(consumerRoot);
      const initial = await observe(executionRoot, configPath, signal);
      return {
        executionRoot, classification: "mutable", ...initial,
        closureIdentity: `unverified-git-visible:${initial.sourceIdentity}`,
        changesReader: new GitRepositoryChangesReader(execute),
        async assertCurrent(currentSignal) {
          const current = await observe(executionRoot, configPath, currentSignal);
          if (current.sourceIdentity !== initial.sourceIdentity || current.configIdentity !== initial.configIdentity) {throw new Error("Input observation changed.");}
        },
        async release() { /* No enforcement resource acquired by mutable diagnostics. */ }
      };
    }
  };
}
