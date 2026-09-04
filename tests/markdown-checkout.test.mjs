import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../scripts/pack-artifact-archive.mjs";

test("reviewed supplementary license preserves authenticated bytes under CRLF checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "markdown-checkout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(import.meta.dirname, "..");
  const licensePath = "scripts/markdown-licenses/format-0.2.2.txt";
  const licenseBytes = await readFile(join(repositoryRoot, licensePath));
  await mkdir(join(root, "scripts/markdown-licenses"), { recursive: true });
  await writeFile(join(root, licensePath), licenseBytes);
  await writeFile(join(root, ".gitattributes"), await readFile(join(repositoryRoot, ".gitattributes")));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.eol=crlf", ...args],
    { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("add", "--", ".gitattributes", licensePath);
  git("checkout-index", "--all", "--prefix=checkout/");
  const checkedOutBytes = await readFile(join(root, "checkout", licensePath));
  assert.equal(sha256(checkedOutBytes), "0b2c94863590ca2aed327e89642b7e74b1608ec423bfec1d8f1beba2945fc4ba");
  assert.deepEqual(checkedOutBytes, licenseBytes);
});
