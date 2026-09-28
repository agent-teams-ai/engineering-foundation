import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const policyPath = "architecture/foundation/docs-protocol-current-policy-v2.json";
const assetPath = "packages/docs-protocol-agent-teams/assets/runtime-policy.v1.json";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("Windows-style CRLF checkout preserves the canonical policy input digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundation-policy-checkout-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    git("init", "-q");
    for (const path of [".gitattributes", policyPath, assetPath]) {
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), await readFile(new URL(path, root)));
    }
    await writeFile(join(directory, "line-ending-control.txt"), "control\n");
    git("-c", "core.autocrlf=false", "add", "--", ".gitattributes", policyPath, assetPath,
      "line-ending-control.txt");
    await rm(join(directory, policyPath));
    await rm(join(directory, assetPath));
    await rm(join(directory, "line-ending-control.txt"));
    git("-c", "core.autocrlf=true", "checkout-index", "--", policyPath, assetPath,
      "line-ending-control.txt");

    assert.equal(await readFile(join(directory, "line-ending-control.txt"), "utf8"), "control\r\n");
    const checkedOutPolicy = await readFile(join(directory, policyPath));
    const checkedOutAsset = JSON.parse(await readFile(join(directory, assetPath), "utf8"));
    assert.equal(digest(checkedOutPolicy), checkedOutAsset.sourceDigest);
    assert.equal(digest(checkedOutPolicy), digest(await readFile(new URL(policyPath, root))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
