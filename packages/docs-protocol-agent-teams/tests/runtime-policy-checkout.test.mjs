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
const historicalDigests = new Map([
  ["architecture/foundation/docs-protocol-current-policy.json",
    "sha256:b446075de07aa2655561e0cba7d15ed13cc2062b91303e961f06b6afddb18efc"],
  ["architecture/contracts/docs-protocol-current-policy/v1.schema.json",
    "sha256:3067433b3e5b8f964049f5b83dc29ac06bb32d6c88ac3d39eee3ad7769bd6f70"],
]);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("Windows-style CRLF checkout preserves current and historical policy digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundation-policy-checkout-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    git("init", "-q");
    const checkoutPaths = [policyPath, assetPath, ...historicalDigests.keys()];
    for (const path of [".gitattributes", ...checkoutPaths]) {
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), await readFile(new URL(path, root)));
    }
    await writeFile(join(directory, "line-ending-control.txt"), "control\n");
    git("-c", "core.autocrlf=false", "add", "--", ".gitattributes", ...checkoutPaths,
      "line-ending-control.txt");
    for (const path of checkoutPaths) {
      await rm(join(directory, path));
    }
    await rm(join(directory, "line-ending-control.txt"));
    git("-c", "core.autocrlf=true", "checkout-index", "--", ...checkoutPaths,
      "line-ending-control.txt");

    assert.equal(await readFile(join(directory, "line-ending-control.txt"), "utf8"), "control\r\n");
    const checkedOutPolicy = await readFile(join(directory, policyPath));
    const checkedOutAsset = JSON.parse(await readFile(join(directory, assetPath), "utf8"));
    assert.equal(digest(checkedOutPolicy), checkedOutAsset.sourceDigest);
    assert.equal(digest(checkedOutPolicy), digest(await readFile(new URL(policyPath, root))));
    for (const [path, expected] of historicalDigests) {
      assert.equal(digest(await readFile(new URL(path, root))), expected, `${path} source digest`);
      assert.equal(digest(await readFile(join(directory, path))), expected, `${path} checkout digest`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
