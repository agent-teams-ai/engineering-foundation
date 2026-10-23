import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundation-publication-"));
  return {
    allowUnsupportedDirectoryDurability: process.platform === "win32",
    destinationPath: join(root, "result.txt"),
    root,
    temporaryPath: join(root, ".result.tmp"),
  };
}

export async function missing(path: string) {
  await assert.rejects(
    access(path),
    (error) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT",
  );
}

export async function quarantinedEvidence(root: string) {
  const entry = (await readdir(root)).find((name) => name.includes(".foundation-owned-cleanup-"));
  assert.ok(entry, "expected preserved cleanup quarantine");
  return readFile(join(root, entry, "owned-temporary"));
}
