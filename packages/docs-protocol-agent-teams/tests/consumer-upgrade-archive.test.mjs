import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractHead } from "../dist/consumer-integration/adapters/node-consumer-upgrade-archive.js";
import {
  readStableConsumerFile,
  sameConsumerFileObservation
} from "../dist/consumer-integration/adapters/node-consumer-repository-files.js";

const posix = { skip: process.platform === "win32" ? "Native Windows managed mutation is unsupported" : false };
const execute = (executable, args, cwd) => new Promise((resolve, reject) => {
  execFile(executable, args, { cwd }, (error, stdout, stderr) => {
    if (error !== null) {reject(error);}
    else {resolve({ stdout, stderr });}
  });
});

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "docs-upgrade-archive-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "source");
  await mkdir(root);
  await execute("git", ["init", "-q"], root);
  const files = new Map([
    ["package.json", 0o644],
    ["scripts/run.sh", 0o755],
    ["private.txt", 0o600],
    ["read-only.txt", 0o444],
    ["scripts/read-only.sh", 0o555],
    ["group.txt", 0o640],
    ["group-write.txt", 0o664],
    ["scripts/owner.sh", 0o744],
    ["scripts/group.sh", 0o750],
    ["other-execute.txt", 0o645],
    ["space and ünicode.txt", 0o644]
  ]);
  await mkdir(join(root, "scripts"));
  for (const [path, mode] of files) {
    await writeFile(join(root, path), `committed ${path}\n`);
    await chmod(join(root, path), mode);
  }
  return { temporary, root, files };
}

async function commit(root) {
  await execute("git", ["add", "."], root);
  await execute("git", ["commit", "-qm", "test: archive extraction fixture"], root);
  return (await execute("git", ["rev-parse", "HEAD"], root)).stdout.trim();
}

// -p is GNU/BSD tar's superuser permission default. Exercise it explicitly
// without requiring a privileged test runner; this is not a UID-0 claim.
for (const semantics of ["ordinary", "superuser-permissions"]) {
  for (const umask of ["022", "027", "077"]) {
    test(`archive preserves actual source modes under ${semantics}, umask ${umask}`, posix, async (t) => {
      const { temporary, root, files } = await fixture(t);
      const head = await commit(root);
      // Cover Git's default 0002 and a restrictive local override.
      if (umask !== "022") {await execute("git", ["config", "tar.umask", "077"], root);}
      assert.equal((await execute("git", ["status", "--porcelain"], root)).stdout, "");
      const target = join(temporary, "target");
      await extractHead({ root, head, target }, (executable, args, cwd) => execute(
        "sh", ["-c", 'umask "$1"; shift; exec "$@"', "archive-test", umask,
          executable, ...(executable === "tar" && semantics === "superuser-permissions" ? ["-p"] : []),
          ...args], cwd
      ));
      for (const [path, mode] of files) {
        const source = await readStableConsumerFile(root, path, 1024, true);
        const extracted = await readStableConsumerFile(target, path, 1024, true);
        assert.equal(extracted.mode, mode, path);
        assert.equal(sameConsumerFileObservation(source, extracted), true, path);
      }
      assert.equal((await lstat(join(target, "scripts"))).mode & 0o777, 0o755);
      assert.equal((await execute("git", ["status", "--porcelain"], root)).stdout, "");
      await assert.rejects(lstat(`${target}.tar`), { code: "ENOENT" });
    });
  }
}

test("archive keeps symlinks inert and never changes their outside referents", posix, async (t) => {
  const { temporary, root } = await fixture(t);
  const outside = join(temporary, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "outside\n");
  await chmod(join(outside, "sentinel"), 0o600);
  await symlink(outside, join(root, "outside-directory"));
  await symlink(join(outside, "sentinel"), join(root, "outside-file"));
  await symlink("missing", join(root, "dangling"));
  const head = await commit(root);
  const target = join(temporary, "target");
  await extractHead({ root, head, target }, execute);
  for (const path of ["outside-directory", "outside-file", "dangling"]) {
    assert.equal((await lstat(join(target, path))).isSymbolicLink(), true);
    assert.equal(await readlink(join(target, path)), await readlink(join(root, path)));
  }
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "outside\n");
  assert.equal((await lstat(join(outside, "sentinel"))).mode & 0o777, 0o600);
});

test("source modes require committed bytes even if Git hides a worktree change", posix, async (t) => {
  const { temporary, root } = await fixture(t);
  const head = await commit(root);
  await execute("git", ["update-index", "--assume-unchanged", "package.json"], root);
  await writeFile(join(root, "package.json"), "uncommitted\n");
  assert.equal((await execute("git", ["status", "--porcelain"], root)).stdout, "");
  await assert.rejects(extractHead({ root, head, target: join(temporary, "target") }, execute),
    { code: "DOCS_CONSUMER_UPGRADE_SOURCE_CHANGED" });
});

test("source symlink ancestry cannot authorize mode copying", posix, async (t) => {
  const { temporary, root } = await fixture(t);
  const head = await commit(root);
  const outside = join(temporary, "outside");
  await mkdir(outside);
  for (const path of ["run.sh", "owner.sh", "group.sh"]) {
    await writeFile(join(outside, path), await readFile(join(root, "scripts", path)));
  }
  await rm(join(root, "scripts"), { recursive: true });
  await symlink(outside, join(root, "scripts"));
  await assert.rejects(extractHead({ root, head, target: join(temporary, "target") }, execute),
    { code: "DOCS_CONSUMER_INPUT_UNSTABLE" });
  assert.equal((await lstat(join(outside, "run.sh"))).mode & 0o777, 0o644);
});

test("extraction rejects an existing target symlink before tar can write outside", posix, async (t) => {
  const { temporary, root } = await fixture(t);
  const head = await commit(root);
  const outside = join(temporary, "outside");
  await mkdir(outside);
  const target = join(temporary, "target");
  await symlink(outside, target);
  await assert.rejects(extractHead({ root, head, target }, execute));
  await assert.rejects(lstat(join(outside, "package.json")), { code: "ENOENT" });
});

test("archive cleanup runs when extraction fails", posix, async (t) => {
  const { temporary, root } = await fixture(t);
  const head = await commit(root);
  const target = join(temporary, "target");
  await assert.rejects(extractHead({ root, head, target }, (executable, args, cwd) => {
    if (executable === "tar") { throw new Error("injected tar failure"); }
    return execute(executable, args, cwd);
  }), /injected tar failure/u);
  await assert.rejects(lstat(`${target}.tar`), { code: "ENOENT" });
});
