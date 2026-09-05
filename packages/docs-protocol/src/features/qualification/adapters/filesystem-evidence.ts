import { hasInfrastructureSegment, overlapsGovernedRoot, isQualificationMutationObservationExcludedPath, isQualificationSourceCopyExcludedPath, qualificationEvidencePolicy, type QualificationEvidenceEntryKind, type QualificationEvidencePolicy } from "../application/evidence-policy.js";
export { isQualificationMutationObservationExcludedPath, isQualificationSourceCopyExcludedPath, qualificationEvidencePolicy } from "../application/evidence-policy.js";

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readFile, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";

interface TreeEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
}

const MAX_EVIDENCE_ENTRIES = 20_000;
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_TAG_BYTES = 1024;
const CACHE_TAG_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";

async function hasStableCacheDirectoryTag(root: string, repositoryPath: string): Promise<boolean> {
  const directoryPath = join(root, repositoryPath);
  const directoryBefore = await lstat(directoryPath);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {return false;}
  if (await realpath(directoryPath) !== directoryPath) {return false;}
  const tagPath = join(root, repositoryPath, "CACHEDIR.TAG");
  let before;
  try {before = await lstat(tagPath);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return false;}
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CACHE_TAG_BYTES) {return false;}
  const physical = await realpath(tagPath);
  if (physical !== tagPath) {return false;}
  const bytes = await readFile(physical);
  const after = await lstat(physical);
  const directoryAfter = await lstat(directoryPath);
  return directoryAfter.isDirectory() && !directoryAfter.isSymbolicLink() &&
    directoryAfter.ino === directoryBefore.ino && directoryAfter.dev === directoryBefore.dev &&
    after.isFile() && after.ino === before.ino && after.dev === before.dev &&
    after.size === before.size && after.mtimeMs === before.mtimeMs &&
    bytes.byteLength === after.size && bytes.toString("utf8").split("\n", 1)[0] === CACHE_TAG_SIGNATURE;
}

export async function isQualificationEvidenceExcludedPath(
  root: string,
  repositoryPath: string,
  policy: QualificationEvidencePolicy,
  observation: "mutation" | "source",
  entryKind: QualificationEvidenceEntryKind
): Promise<boolean> {
  if (hasInfrastructureSegment(repositoryPath)) {return true;}
  if (entryKind !== "directory") {return false;}
  if (overlapsGovernedRoot(repositoryPath, policy)) {return false;}
  const staticallyExcluded = observation === "source"
    ? isQualificationSourceCopyExcludedPath(repositoryPath, entryKind)
    : isQualificationMutationObservationExcludedPath(repositoryPath, entryKind);
  if (staticallyExcluded) {return true;}
  const leafName = repositoryPath.split("/").at(-1);
  return (leafName === "target" || leafName === ".cache") &&
    await hasStableCacheDirectoryTag(root, repositoryPath);
}

async function treeEntries(
  root: string,
  policy: QualificationEvidencePolicy,
  observation: "mutation" | "source"
): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolute = join(directory, entry.name);
      const repositoryPath = relative(root, absolute).split(sep).join("/");
      const entryKind: QualificationEvidenceEntryKind = entry.isDirectory() ? "directory"
        : entry.isFile() ? "file"
          : entry.isSymbolicLink() ? "symbolic-link"
            : "other";
      if (await isQualificationEvidenceExcludedPath(root, repositoryPath, policy, observation, entryKind)) {continue;}
      if (entries.length >= MAX_EVIDENCE_ENTRIES) {throw new Error("Qualification evidence exceeds its bounded repository entry budget.");}
      if (entry.isSymbolicLink()) {throw new Error(`Qualification fixtures cannot contain symlinks: ${repositoryPath}`);}
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", path: repositoryPath });
        await visit(absolute);
      } else if (entry.isFile()) {
        entries.push({ kind: "file", path: repositoryPath });
      } else {
        throw new Error(`Qualification fixtures must contain only directories and regular files: ${repositoryPath}`);
      }
    }
  }
  await visit(root);
  return Object.freeze(entries.toSorted((left, right) =>
    Buffer.compare(Buffer.from(`${left.kind}\0${left.path}`), Buffer.from(`${right.kind}\0${right.path}`))));
}

async function boundedEvidenceBytes(root: string, repositoryPath: string): Promise<Buffer> {
  const absolute = join(root, repositoryPath);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`Qualification evidence file is not a bounded regular file: ${repositoryPath}.`);
  }
  const physical = await realpath(absolute);
  if (physical !== absolute) {throw new Error(`Qualification evidence file traverses a symlink: ${repositoryPath}.`);}
  const bytes = await readFile(physical);
  const after = await lstat(physical);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.byteLength !== after.size) {
    throw new Error(`Qualification evidence file changed during read: ${repositoryPath}.`);
  }
  return bytes;
}

export async function snapshot(
  root: string,
  policy: QualificationEvidencePolicy = qualificationEvidencePolicy([])
): Promise<string> {
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const entry of await treeEntries(root, policy, "source")) {
    hash.update(entry.kind).update("\0").update(entry.path).update("\0");
    if (entry.kind === "file") {
      const bytes = await boundedEvidenceBytes(root, entry.path);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {throw new Error("Qualification evidence exceeds its bounded repository byte budget.");}
      hash.update(bytes).update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function fileSnapshot(
  root: string,
  policy: QualificationEvidencePolicy = qualificationEvidencePolicy([])
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of await treeEntries(root, policy, "mutation")) {
    const key = `${entry.kind}:${entry.path}`;
    if (entry.kind === "directory") {
      result.set(key, "directory");
      continue;
    }
    const bytes = await boundedEvidenceBytes(root, entry.path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {throw new Error("Qualification evidence exceeds its bounded repository byte budget.");}
    result.set(key, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return result;
}

const MAX_REACHABILITY_INDEX_BYTES = 8 * 1024 * 1024;

function sameFileObservation(
  left: { readonly dev: bigint; readonly ino: bigint; readonly mtimeNs: bigint; readonly size: bigint },
  right: { readonly dev: bigint; readonly ino: bigint; readonly mtimeNs: bigint; readonly size: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.size === right.size;
}

async function readAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {return Buffer.concat(chunks, total);}
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return undefined;
}

async function verifyCurrentRegularFile(path: string, expected: { readonly dev: bigint; readonly ino: bigint }): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
      throw new Error("Qualification reachability index identity changed before atomic publication.");
    }
  } finally {await handle.close();}
}

async function verifyPublishedFile(path: string, expected: Buffer): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await readAtMost(handle, MAX_REACHABILITY_INDEX_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || bytes === undefined || !sameFileObservation(before, after) || !bytes.equals(expected)) {
      throw new Error("Qualification reachability index atomic publication could not be verified.");
    }
  } finally {await handle.close();}
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {await handle.sync();} finally {await handle.close();}
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(code ?? "")) {throw error;}
  }
}

export async function applyReachability(root: string, reachability: unknown): Promise<void> {
  const action = reachability as Record<string, unknown>;
  if (action["state"] === "not-required") {return;}
  if (action["state"] !== "manual-required" || typeof action["indexPath"] !== "string" || typeof action["markdownLink"] !== "string") {
    throw new Error("Qualification apply did not emit one explicit reachability action.");
  }
  const indexPath = resolvePath(root, action["indexPath"]);
  const physicalRoot = await realpath(root);
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const sourceHandle = await open(indexPath, flags);
  let source: string;
  let identity: { readonly dev: bigint; readonly ino: bigint };
  let mode: number;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_REACHABILITY_INDEX_BYTES)) {throw new Error("Qualification reachability index is not a bounded regular file.");}
    const physicalIndex = await realpath(indexPath);
    const pathFromRoot = relative(physicalRoot, physicalIndex);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || physicalIndex !== indexPath) {
      throw new Error("Qualification reachability index is not a contained regular file without symlinks.");
    }
    await verifyCurrentRegularFile(physicalIndex, before);
    const bytes = await readAtMost(sourceHandle, MAX_REACHABILITY_INDEX_BYTES);
    const after = await sourceHandle.stat({ bigint: true });
    if (bytes === undefined || !sameFileObservation(before, after) || after.size !== BigInt(bytes.byteLength)) {
      throw new Error("Qualification reachability index changed during its bounded read.");
    }
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    identity = { dev: after.dev, ino: after.ino };
    mode = Number(after.mode & 0o777n);
  } finally {await sourceHandle.close();}
  const next = Buffer.from(`${source.replace(/\n?$/u, "\n")}- ${action["markdownLink"]}\n`);
  if (next.byteLength > MAX_REACHABILITY_INDEX_BYTES) {throw new Error("Qualification reachability index update exceeds its bounded size.");}
  const parent = dirname(indexPath);
  const temporary = join(parent, `.${basename(indexPath)}.docs-protocol-${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const temporaryHandle = await open(temporary, "wx", mode);
    temporaryExists = true;
    try {await temporaryHandle.writeFile(next); await temporaryHandle.chmod(mode); await temporaryHandle.sync();} finally {await temporaryHandle.close();}
    await verifyCurrentRegularFile(indexPath, identity);
    await rename(temporary, indexPath);
    temporaryExists = false;
    await verifyPublishedFile(indexPath, next);
    await syncDirectory(parent);
  } finally {
    if (temporaryExists) {await rm(temporary, { force: true });}
  }
}
