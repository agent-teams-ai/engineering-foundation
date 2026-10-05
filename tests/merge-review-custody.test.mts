import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewCollector, reviewTreeInspector } from "../scripts/merge-reviewed-pr.mts";

// Linux-only qualification of the physical hosted custody boundary, not a Windows bypass.
test("physical source hashing rejects forged Git metadata, edits, extras, modes and missing files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-tree-TEST-")));
  const source = Buffer.from("independently reviewed source\n");
  const digest = createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex");
  const inspect = (entries: unknown[] = [{ path: "source.ts", mode: "100644", type: "blob", sha: digest }]) => JSON.parse(execFileSync("python3", ["-c", reviewTreeInspector], {
    input: JSON.stringify({ workspace: root, entries }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  })) as { sourceTreeVerified: boolean };
  try {
    await writeFile(join(root, "source.ts"), source, { mode: 0o600 });
    await mkdir(join(root, ".git"));
    const marker = join(root, "executed.txt");
    await writeFile(join(root, ".git", "config"), `[core]\nfsmonitor = touch ${marker}\n`);
    assert.equal(inspect().sourceTreeVerified, true); await assert.rejects(readFile(marker));
    await writeFile(join(root, "source.ts"), "dirty\n"); assert.throws(() => inspect());
    await writeFile(join(root, "source.ts"), source); await writeFile(join(root, "extra.ts"), "unreviewed"); assert.throws(() => inspect());
    await rm(join(root, "extra.ts")); await chmod(join(root, "source.ts"), 0o700); assert.throws(() => inspect());
    await chmod(join(root, "source.ts"), 0o600); await rm(join(root, "source.ts")); assert.throws(() => inspect());
    await symlink("/etc/passwd", join(root, "source.ts")); assert.throws(() => inspect());
    assert.throws(() => inspect([{ path: "../source.ts", mode: "100644", type: "blob", sha: digest }]));
    assert.throws(() => inspect([{ path: "module", mode: "160000", type: "commit", sha: digest }]));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("protected receipt collector rejects group-writable or symlinked custody before exposing metadata", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-receipt-TEST-")));
  try {
    const registry = join(root, "registry"); const jobs = join(root, "jobs"); const workspaces = join(root, "workspaces"); const job = "readonly-TEST";
    await mkdir(join(registry, job), { recursive: true }); await mkdir(join(jobs, job), { recursive: true });
    const manifest = join(registry, job, "job.json");
    await writeFile(manifest, JSON.stringify({ jobRootDir: join(jobs, job), promptPath: join(jobs, job, "prompt.md"), workspacePath: join(workspaces, job) }));
    await chmod(manifest, 0o666);
    const collect = () => execFileSync("python3", ["-c", reviewCollector], { input: JSON.stringify({ registry, jobs, workspaces, job }), stdio: ["pipe", "pipe", "pipe"] });
    assert.throws(collect); await rm(manifest); await symlink("/etc/passwd", manifest); assert.throws(collect);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const fault of ["enumeration", "descriptor"] as const) {
  test(`physical source verification rejects ${fault === "enumeration" ? "unreadable unexpected subtrees" : "substituted file descriptors"}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "review-race-TEST-")));
    const canonical = Buffer.from("reviewed canonical bytes\n");
    const sha = createHash("sha1").update(`blob ${canonical.length}\0`).update(canonical).digest("hex");
    try {
      await mkdir(join(root, ".git"));
      await writeFile(join(root, "source.ts"), fault === "descriptor" ? "unreviewed physical bytes\n" : canonical, { mode: 0o600 });
      await writeFile(join(root, ".git", "canonical"), canonical);
      await mkdir(join(root, "opaque")); await writeFile(join(root, "opaque", "unexpected.ts"), "unreviewed");
      if (fault === "descriptor") { await rm(join(root, "opaque"), { recursive: true }); }
      const prefix = fault === "enumeration" ? String.raw`import os, errno
real_scandir = os.scandir
def probe_scandir(path):
    if os.path.basename(os.fspath(path)) == "opaque": raise PermissionError(errno.EACCES, "TEST denied subtree", os.fspath(path))
    return real_scandir(path)
os.scandir = probe_scandir
` : String.raw`import os
real_open = os.open
def probe_open(path, flags):
    if os.path.basename(os.fspath(path)) == "source.ts": return real_open(os.path.join(os.path.dirname(path), ".git", "canonical"), flags)
    return real_open(path, flags)
os.open = probe_open
`;
      assert.throws(() => execFileSync("python3", ["-c", prefix + reviewTreeInspector], {
        input: JSON.stringify({ workspace: root, entries: [{ path: "source.ts", mode: "100644", type: "blob", sha }] }),
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }), fault === "enumeration" ? /TEST denied subtree/u : /source descriptor mismatch/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
