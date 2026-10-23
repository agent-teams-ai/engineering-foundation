import { createHash, type Hash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { CheckInputCustody } from "../../../application/ports/check-changed.js";
import { InputRevocationError } from "../../../application/ports/check-changed.js";
import type { ContainedFileReader } from "../../../application/ports/contained-file-reader.js";
import type { ExecuteWorkflowProcess } from "../../../application/ports/process-execution.js";
import { assertConfigRepositoryRelativePath } from "../../../application/configuration-input.js";
import { GitRepositoryChangesReader } from "../git/git-repository-changes-reader.js";

/** Structural subset of the bigint stat identity used here; this layer declares
 * no node:fs type dependency of its own. */
interface EntryMetadata {
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const MAX_OBSERVED_PATHS = 50_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Cheap stat identity plus content fingerprint, reused while the identity is
 * unchanged so assertCurrent does not re-hash the whole repository per step. */
interface PathFingerprint {
  readonly identity: string;
  readonly fingerprint: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

/** Only a genuinely absent path maps to null; every other failure rethrows so
 * an inaccessible input fails closed instead of reading as deleted. */
async function statOrMissing(path: string): Promise<EntryMetadata | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Per-path observation state shared by the entry helpers below. */
interface Observation {
  readonly root: string;
  readonly configPath: string;
  readonly files: ContainedFileReader;
  readonly cache: Map<string, PathFingerprint>;
  readonly hash: Hash;
  bytes: number;
  configIdentity: string;
}

function boundBytes(observation: Observation, add: number): void {
  observation.bytes += add;
  if (observation.bytes > MAX_TOTAL_BYTES) {
    throw new Error("Input observation exceeds byte bound.");
  }
}

async function observeLink(
  path: string,
  candidate: string,
  metadata: EntryMetadata,
  observation: Observation,
): Promise<void> {
  const link = await readlink(candidate);
  const fingerprint = createHash("sha256").update(link).digest("hex");
  boundBytes(observation, Buffer.byteLength(link));
  const mode = String(metadata.mode);
  observation.hash.update(JSON.stringify([path, "link", mode]));
  observation.hash.update(fingerprint);
  observation.cache.set(path, {
    identity: `${mode}:${metadata.size}:${metadata.mtimeNs}`,
    fingerprint,
  });
}

async function observeFile(
  path: string,
  candidate: string,
  metadata: EntryMetadata,
  observation: Observation,
): Promise<void> {
  if (metadata.size > BigInt(MAX_FILE_BYTES)) {
    throw new Error("Input is not a bounded regular file.");
  }
  boundBytes(observation, Number(metadata.size));
  const mode = String(metadata.mode);
  const identity = `${mode}:${metadata.size}:${metadata.mtimeNs}`;
  const cached = observation.cache.get(path);
  let fingerprint =
    cached !== undefined && cached.identity === identity ? cached.fingerprint : undefined;
  if (fingerprint === undefined) {
    // Contained read: no leaf-symlink follow, ancestry re-checked, snapshot
    // stable across the read. Races surface as read failures, never bytes.
    const bytes = await observation.files.read({
      candidate,
      root: observation.root,
      maxBytes: MAX_FILE_BYTES,
    });
    fingerprint = createHash("sha256").update(bytes).digest("hex");
    observation.cache.set(path, { identity, fingerprint });
  }
  observation.hash.update(JSON.stringify([path, "file", mode]));
  observation.hash.update(fingerprint);
  if (path === observation.configPath) {
    observation.configIdentity = fingerprint;
  }
}

async function observePath(path: string, observation: Observation): Promise<void> {
  let parent = observation.root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const metadata = await statOrMissing(parent);
    if (metadata !== null && !metadata.isDirectory()) {
      throw new Error("Input ancestor is not a directory.");
    }
  }
  const candidate = join(observation.root, path);
  const metadata = await statOrMissing(candidate);
  if (metadata === null) {
    observation.hash.update(JSON.stringify([path, "absent"]));
    observation.cache.delete(path);
    return;
  }
  if (metadata.isFile()) {
    await observeFile(path, candidate, metadata, observation);
  } else if (metadata.isSymbolicLink()) {
    await observeLink(path, candidate, metadata, observation);
  } else {
    // Gitlinks (submodules), directories and other non-regular entries are
    // recorded by mode only so nested repositories never kill the run.
    observation.hash.update(JSON.stringify([path, "mode-only", String(metadata.mode)]));
    observation.cache.delete(path);
  }
}

/** Diagnostics over Git-visible files, never a complete dependency custody
 * implementation. The mutable classification cannot produce exact-byte PASS,
 * including when a transient ABA edit leaves these brackets unchanged. */
export function createMutableCheckInputCustody(
  execute: ExecuteWorkflowProcess,
  files: ContainedFileReader,
): CheckInputCustody {
  async function observe(
    root: string,
    configPath: string,
    cache: Map<string, PathFingerprint>,
    signal?: AbortSignal,
  ) {
    assertConfigRepositoryRelativePath(configPath);
    const result = await execute(
      "git",
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { cwd: root, strictUtf8: true, ...(signal === undefined ? {} : { signal }) },
    );
    if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith("\0"))) {
      throw new Error("Cannot observe Git-visible input scope.");
    }
    const paths = [
      ...new Set([...result.stdout.split("\0").filter(Boolean), configPath]),
    ].toSorted();
    if (paths.length > MAX_OBSERVED_PATHS) {
      throw new Error("Input observation exceeds path bound.");
    }
    const observation: Observation = {
      root,
      configPath,
      files,
      cache,
      hash: createHash("sha256"),
      bytes: 0,
      configIdentity: "",
    };
    for (const path of paths) {
      signal?.throwIfAborted();
      assertConfigRepositoryRelativePath(path);
      await observePath(path, observation);
    }
    if (observation.configIdentity === "") {
      throw new Error("Workflow configuration is missing.");
    }
    return {
      sourceIdentity: observation.hash.digest("hex"),
      configIdentity: observation.configIdentity,
    };
  }
  return {
    async acquire({ consumerRoot, configPath, signal }) {
      const executionRoot = await realpath(consumerRoot);
      const cache = new Map<string, PathFingerprint>();
      const initial = await observe(executionRoot, configPath, cache, signal);
      return {
        executionRoot,
        classification: "mutable",
        ...initial,
        closureIdentity: `unverified-git-visible:${initial.sourceIdentity}`,
        changesReader: new GitRepositoryChangesReader(execute),
        async assertCurrent(currentSignal) {
          try {
            const current = await observe(executionRoot, configPath, cache, currentSignal);
            if (
              current.sourceIdentity !== initial.sourceIdentity ||
              current.configIdentity !== initial.configIdentity
            ) {
              throw new InputRevocationError();
            }
          } catch (error) {
            if (error instanceof InputRevocationError) {
              throw error;
            }
            if (
              currentSignal?.aborted === true ||
              (error instanceof Error && error.name === "AbortError")
            ) {
              throw error;
            }
            // Failure to re-verify the lease is revocation: the run must stop
            // as stale instead of continuing on an unproven input set.
            const revoked = new InputRevocationError();
            (revoked as { cause?: unknown }).cause = error;
            throw revoked;
          }
        },
        async release() {
          /* No enforcement resource acquired by mutable diagnostics. */
        },
      };
    },
  };
}
