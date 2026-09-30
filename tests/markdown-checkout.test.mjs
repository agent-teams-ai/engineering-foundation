import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("SDK source bindings preserve accepted bytes under CRLF checkout filters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sdk-source-checkout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = join(import.meta.dirname, "..");
  const candidate = JSON.parse(await readFile(join(
    repositoryRoot,
    "architecture/contracts/sdk-growth-v2/current-candidate-evidence.json",
  ), "utf8"));
  assert.deepEqual(Object.keys(candidate.currentSources).toSorted(), [
    "loaderTest",
    "packedQualification",
    "qualificationPolicy",
  ]);
  const sources = Object.values(candidate.currentSources);
  // The fixture puts this historical blob in shallow checkouts. Normalize only
  // checkout line endings before authenticating the accepted Git blob bytes.
  const fixturePath = "tests/fixtures/sdk-growth-v2/public-api-compatibility-0e93ab31.yaml";
  const historicalPolicyBytes = Buffer.from((await readFile(join(repositoryRoot, fixturePath), "utf8"))
    .replaceAll("\r\n", "\n"), "utf8");
  const historicalPolicy = candidate.currentSources.qualificationPolicy;
  assert.equal(historicalPolicy.path, "architecture/foundation/public-api-compatibility.yaml");
  assert.equal(`sha256:${sha256(historicalPolicyBytes)}`, historicalPolicy.contentDigest);
  assert.equal(createHash("sha1")
    .update(`blob ${historicalPolicyBytes.length}\0`)
    .update(historicalPolicyBytes)
    .digest("hex"), historicalPolicy.blob);
  const acceptedSourceBytes = source => source.path === "architecture/foundation/public-api-compatibility.yaml"
    ? historicalPolicyBytes
    : readFile(join(repositoryRoot, source.path));

  await writeFile(join(root, ".gitattributes"), await readFile(join(repositoryRoot, ".gitattributes")));
  for (const source of sources) {
    const sourceBytes = await acceptedSourceBytes(source);
    await mkdir(dirname(join(root, source.path)), { recursive: true });
    await writeFile(join(root, source.path), sourceBytes);
  }
  const controlPath = "unprotected.txt";
  await writeFile(join(root, controlPath), "first\nsecond\n");

  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=true", "-c", "core.eol=crlf", ...args],
    { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("add", "--", ".gitattributes", controlPath, ...sources.map(({ path }) => path));

  for (const source of sources) {
    const acceptedBytes = await acceptedSourceBytes(source);
    const stagedBytes = git("show", `:${source.path}`);
    assert.equal(`sha256:${sha256(stagedBytes)}`, source.contentDigest, `${source.path} clean-filter bytes`);
    assert.deepEqual(stagedBytes, acceptedBytes, `${source.path} clean-filter bytes`);
  }

  git("checkout-index", "--all", "--prefix=checkout/");
  assert.deepEqual(await readFile(join(root, "checkout", controlPath)), Buffer.from("first\r\nsecond\r\n"));
  for (const source of sources) {
    const acceptedBytes = await acceptedSourceBytes(source);
    const checkedOutBytes = await readFile(join(root, "checkout", source.path));
    assert.equal(`sha256:${sha256(checkedOutBytes)}`, source.contentDigest, `${source.path} checkout bytes`);
    assert.deepEqual(checkedOutBytes, acceptedBytes, `${source.path} checkout bytes`);
  }
});
