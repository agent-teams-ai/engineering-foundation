import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { GrowthReportWriteError } from "../../../application/ports/growth-report-writer.js";
import type { GrowthDigest, GrowthReportWriter } from "../../../application/ports/growth-report-writer.js";

type ReportFilesystem = Pick<typeof filesystem, "lstat" | "realpath" | "open" | "rename" | "unlink">;
const maximumBytes = 32 * 1024 * 1024;
const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
function digest(bytes: Uint8Array): GrowthDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function conflict(reason: string): never { throw new GrowthReportWriteError("conflict", reason); }
function attachCleanupFailures(primary: unknown, failures: unknown[]): void {
  // Preserve cancellation identity, even for immutable or non-Error reasons.
  if (primary instanceof Error && Object.isExtensible(primary) &&
    Object.getOwnPropertyDescriptor(primary, "cause")?.configurable !== false) {
    Object.defineProperty(primary, "cause", {
      value: new AggregateError([...(primary.cause === undefined ? [] : [primary.cause]), ...failures], "Primary failure with cleanup failures"),
      configurable: true, writable: true
    });
  }
}

async function closeHandle(handle: FileHandle | undefined, failure: unknown): Promise<void> {
  try { await handle?.close(); } catch (error) {
    if (failure === undefined) { throw error; }
    attachCleanupFailures(failure, [error]);
  }
}

/** Cooperative writers share an exclusive fence. No stale-lock takeover, durable
 * journal or trust claim. Parent directories must already exist. Node cannot
 * protect path lookup against a hostile process replacing directory ancestors;
 * the caller owns isolation from non-cooperating writers (S3). */
export function createFilesystemGrowthReportWriter(consumerRoot: string, fs: ReportFilesystem = filesystem): GrowthReportWriter {
  async function parents(path: string): Promise<string> {
    if (path.length === 0 || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) {
      conflict("growth-report-path-invalid");
    }
    const root = resolve(consumerRoot), target = resolve(root, path);
    if (!target.startsWith(`${root}${sep}`)) { conflict("growth-report-outside-root"); }
    let current = root;
    for (const part of ["", ...path.split("/").slice(0, -1)]) {
      current = join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) {
        conflict("growth-report-parent-unsafe");
      }
    }
    return target;
  }
  async function sameFile(path: string, handle: FileHandle): Promise<boolean> {
    const [named, opened] = await Promise.all([fs.lstat(path), handle.stat()]);
    return named.isFile() && !named.isSymbolicLink() && named.dev === opened.dev && named.ino === opened.ino;
  }
  async function preimage(path: string): Promise<GrowthDigest | null> {
    let handle: FileHandle | undefined;
    let failure: unknown;
    try {
      try { handle = await fs.open(path, constants.O_RDONLY | noFollow); }
      catch (error) {
        if (code(error) === "ENOENT") { return null; }
        if (code(error) === "ELOOP" || code(error) === "EISDIR") { conflict("growth-report-slot-unsafe"); }
        throw error;
      }
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes) {
        conflict("growth-report-slot-unsafe");
      }
      if (!await sameFile(path, handle)) { conflict("growth-report-slot-changed"); }
      // Read at most the budget plus one even if a non-cooperating writer grows it.
      const bytes = Buffer.alloc(maximumBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (read.bytesRead === 0) { break; }
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (size > maximumBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !await sameFile(path, handle)) {
        conflict("growth-report-slot-changed");
      }
      return digest(bytes.subarray(0, size));
    } catch (error) { failure = error; throw error; }
    finally { await closeHandle(handle, failure); }
  }
  async function removeOwned(path: string, handle: FileHandle): Promise<void> {
    let failure: unknown;
    try {
      if (!await sameFile(path, handle)) { conflict("growth-report-owned-file-changed"); }
      await fs.unlink(path);
    } catch (error) { failure = error; throw error; }
    finally { await closeHandle(handle, failure); }
  }
  async function cleanup(state: {
    stage: FileHandle | undefined; stagePath: string; renamed: boolean;
    fence: FileHandle | undefined; fencePath: string; commitAttempted: boolean; failure: unknown;
  }): Promise<void> {
    const failures: unknown[] = [];
    if (state.stage !== undefined) {
      try {
        if (state.renamed) { await state.stage.close(); }
        else { await removeOwned(state.stagePath, state.stage); }
      } catch (error) { failures.push(error); }
    }
    if (state.fence !== undefined) {
      try { await removeOwned(state.fencePath, state.fence); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      if (state.failure !== undefined) {
        attachCleanupFailures(state.failure, failures);
        return;
      }
      throw new GrowthReportWriteError(state.commitAttempted ? "uncertain" : "io", "growth-report-cleanup-failed", {
        cause: new AggregateError(failures, "Owned-file cleanup failed")
      });
    }
  }
  return {
    async write(input, cancellation) {
      const request = { ...input };
      cancellation.throwIfCancelled();
      const bytes = Buffer.from(request.contents, "utf8"), outputDigest = digest(bytes);
      if (bytes.length > maximumBytes || (request.expectedPreimage !== null && !/^sha256:[a-f0-9]{64}$/u.test(request.expectedPreimage))) {
        conflict("growth-report-request-invalid");
      }
      let fence: FileHandle | undefined, stage: FileHandle | undefined;
      let fencePath = "", stagePath = "", commitAttempted = false, renamed = false;
      let failure: unknown;
      try {
        const target = await parents(request.path);
        fencePath = `${target}.growth-report.lock`;
        cancellation.throwIfCancelled();
        try { fence = await fs.open(fencePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600); }
        catch (error) {
          if (code(error) === "EEXIST") { conflict("growth-report-fence-busy"); }
          throw error;
        }
        cancellation.throwIfCancelled();
        const before = await preimage(target);
        cancellation.throwIfCancelled();
        if (before === outputDigest) { return { status: "replayed", digest: outputDigest }; }
        if (before !== request.expectedPreimage) { conflict("growth-report-preimage-mismatch"); }
        stagePath = join(dirname(target), `.growth-report-${randomUUID()}.tmp`);
        stage = await fs.open(stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
        await stage.writeFile(bytes);
        await stage.sync();
        await parents(request.path);
        if (!await sameFile(fencePath, fence) || !await sameFile(stagePath, stage) || await preimage(target) !== before) {
          conflict("growth-report-publication-conflict");
        }
        // Final cancellation boundary. Once rename starts, complete publication
        // and cleanup; a late abort cannot turn a committed report into cancelled.
        cancellation.throwIfCancelled();
        commitAttempted = true;
        await fs.rename(stagePath, target);
        renamed = true;
        if (await preimage(target) !== outputDigest) { throw new GrowthReportWriteError("uncertain", "growth-report-readback-mismatch"); }
        return { status: "published", digest: outputDigest };
      } catch (error) {
        try {
          if (commitAttempted) { throw new GrowthReportWriteError("uncertain", "growth-report-publication-uncertain", { cause: error }); }
          cancellation.throwIfCancelled();
          if (error instanceof GrowthReportWriteError) { throw error; }
          throw new GrowthReportWriteError("io", "growth-report-io-failed", { cause: error });
        } catch (primary) { failure = primary; throw primary; }
      } finally {
        await cleanup({ stage, stagePath, renamed, fence, fencePath, commitAttempted, failure });
      }
    }
  };
}
