import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFilesystemGrowthReportWriter } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/adapters/outbound/filesystem/growth-report-writer.js";
import { GrowthReportWriteError } from "../packages/engineering-foundation/dist/capabilities/public-api-compatibility/application/ports/growth-report-writer.js";

const hash = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const cancellation = (controller = new AbortController()) => ({
  signal: controller.signal, throwIfCancelled() { controller.signal.throwIfAborted(); }
});
const request = (contents = "new\n", expectedPreimage = null) => ({ path: "report.json", contents, expectedPreimage });
const failure = (kind, reason) => (error) => error instanceof GrowthReportWriteError && error.kind === kind && (!reason || error.reason === reason);
async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "sdk-report-")));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("growth report creates, replays with stale preimage, CAS replaces and refuses lost updates", async () => fixture(async (root) => {
  const writer = createFilesystemGrowthReportWriter(root);
  assert.deepEqual(await writer.write(request(), cancellation()), { status: "published", digest: hash("new\n") });
  assert.deepEqual(await writer.write(request(), cancellation()), { status: "replayed", digest: hash("new\n") });
  await assert.rejects(writer.write(request("different"), cancellation()), failure("conflict", "growth-report-preimage-mismatch"));
  await writer.write(request("next", hash("new\n")), cancellation());
  assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), "next");
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report rejects traversal, symlinks, nonregular and multiply linked slots", async () => fixture(async (root) => {
  const writer = createFilesystemGrowthReportWriter(root);
  for (const path of ["../escape", "/escape", "a/../escape", "a\\b", "./report", "C:/report"]) {
    await assert.rejects(writer.write({ ...request(), path }, cancellation()), failure("conflict"));
  }
  await fs.mkdir(join(root, "directory"));
  await fs.symlink(join(root, "directory"), join(root, "parent-link"), "junction");
  await assert.rejects(writer.write({ ...request(), path: "parent-link/report.json" }, cancellation()), failure("conflict"));
  await assert.rejects(writer.write({ ...request(), path: "directory" }, cancellation()), failure("conflict"));
  await fs.writeFile(join(root, "original"), "untouched");
  await fs.symlink(join(root, "original"), join(root, "report.json"));
  await assert.rejects(writer.write(request(), cancellation()), failure("conflict"));
  await fs.unlink(join(root, "report.json"));
  await fs.link(join(root, "original"), join(root, "report.json"));
  await assert.rejects(writer.write(request(), cancellation()), failure("conflict"));
  assert.equal(await fs.readFile(join(root, "original"), "utf8"), "untouched");
}));

test("growth report exclusive fence rejects overlapping publishers without takeover", async () => fixture(async (root) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const first = createFilesystemGrowthReportWriter(root, { ...fs, async rename(...args) {
    entered.resolve(); await release.promise; return fs.rename(...args);
  } });
  const running = first.write(request("first"), cancellation());
  await entered.promise;
  await assert.rejects(createFilesystemGrowthReportWriter(root).write(request("second"), cancellation()), failure("conflict", "growth-report-fence-busy"));
  release.resolve();
  await running;
  assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), "first");
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report rechecks preimage after staging and preserves concurrent bytes", async () => fixture(async (root) => {
  let mutated = false;
  const writer = createFilesystemGrowthReportWriter(root, { ...fs, async open(path, ...args) {
    const handle = await fs.open(path, ...args);
    if (String(path).endsWith(".tmp") && !mutated) { mutated = true; await fs.writeFile(join(root, "report.json"), "other"); }
    return handle;
  } });
  await assert.rejects(writer.write(request(), cancellation()), failure("conflict", "growth-report-publication-conflict"));
  assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), "other");
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report cancellation before rename leaves no slot or fence; late abort retains publication", async () => fixture(async (root) => {
  const early = new AbortController(), reason = new Error("cancelled before commit");
  early.abort(reason);
  await assert.rejects(createFilesystemGrowthReportWriter(root).write(request(), cancellation(early)), (error) => error === reason);
  const beforeCommit = new AbortController();
  const writer = createFilesystemGrowthReportWriter(root, { ...fs, async open(path, ...args) {
    const handle = await fs.open(path, ...args);
    if (String(path).endsWith(".tmp")) { beforeCommit.abort(reason); }
    return handle;
  } });
  await assert.rejects(writer.write(request(), cancellation(beforeCommit)), (error) => error === reason);
  assert.deepEqual(await fs.readdir(root), []);
  const late = new AbortController();
  const lateWriter = createFilesystemGrowthReportWriter(root, { ...fs, async rename(...args) {
    await fs.rename(...args); late.abort(reason);
  } });
  assert.equal((await lateWriter.write(request(), cancellation(late))).status, "published");
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report separates IO from uncertain publication and supports exact replay after lost acknowledgement", async () => fixture(async (root) => {
  const io = Object.assign(new Error("disk failure"), { code: "EIO" });
  const unavailable = createFilesystemGrowthReportWriter(root, { ...fs, async open() { throw io; } });
  await assert.rejects(unavailable.write(request(), cancellation()), failure("io"));
  const uncertain = createFilesystemGrowthReportWriter(root, { ...fs, async rename(...args) {
    await fs.rename(...args); throw io;
  } });
  await assert.rejects(uncertain.write(request(), cancellation()), failure("uncertain"));
  assert.equal(await fs.readFile(join(root, "report.json"), "utf8"), "new\n");
  assert.equal((await createFilesystemGrowthReportWriter(root).write(request(), cancellation())).status, "replayed");
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report admits exactly 32 MiB and refuses one byte more without altering the slot", async () => fixture(async (root) => {
  const writer = createFilesystemGrowthReportWriter(root), contents = "x".repeat(32 * 1024 * 1024);
  assert.equal((await writer.write(request(contents), cancellation())).digest, hash(contents));
  await assert.rejects(writer.write(request(`${contents}x`, hash(contents)), cancellation()), failure("conflict", "growth-report-request-invalid"));
  assert.equal((await fs.stat(join(root, "report.json"))).size, contents.length);
  assert.deepEqual(await fs.readdir(root), ["report.json"]);
}));

test("growth report never removes another writer's replaced fence", async () => fixture(async (root) => {
  const writer = createFilesystemGrowthReportWriter(root, { ...fs, async open(path, ...args) {
    const handle = await fs.open(path, ...args);
    if (String(path).endsWith(".tmp")) {
      await fs.rename(join(root, "report.json.growth-report.lock"), join(root, "old-fence"));
      await fs.writeFile(join(root, "report.json.growth-report.lock"), "other-owner");
    }
    return handle;
  } });
  await assert.rejects(writer.write(request(), cancellation()), failure("io", "growth-report-cleanup-failed"));
  assert.equal(await fs.readFile(join(root, "report.json.growth-report.lock"), "utf8"), "other-owner");
  await assert.rejects(fs.stat(join(root, "report.json")), { code: "ENOENT" });
}));
