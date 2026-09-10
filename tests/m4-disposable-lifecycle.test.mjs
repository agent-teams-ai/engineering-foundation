import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { M4, runDirectoryName, selectedPostimage, snapshot } from "../scripts/m4-disposable-lifecycle.mjs";

test("M4 refuses non-hosted and ambiguous run identities before allocation", () => {
  for (const env of [{}, { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "../consumer", GITHUB_RUN_ATTEMPT: "1" },
    { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "0" }]) {
    assert.throws(() => runDirectoryName(env));
  }
  assert.equal(runDirectoryName({ GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" }), "TEST-m4-123-2");
});

test("M4 selection binds exact bytes and rejects substituted or duplicate operation images", async () => {
  const bytes = await readFile(new URL("../packages/docs-protocol-agent-teams/tests/fixtures/target-lockfile/candidate-target-lock.yaml", import.meta.url));
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, M4.lockDigest);
  const operation = { path: "pnpm-lock.yaml", postimage: { contentBase64: bytes.toString("base64"), digest: M4.lockDigest } };
  assert.deepEqual(selectedPostimage({ plan: { operations: [operation] } }, "pnpm-lock.yaml"), bytes);
  assert.throws(() => selectedPostimage({ plan: { operations: [operation, operation] } }, "pnpm-lock.yaml"));
  assert.throws(() => selectedPostimage({ plan: { operations: [{ ...operation, postimage: {
    ...operation.postimage, contentBase64: Buffer.from("tampered").toString("base64")
  } }] } }, "pnpm-lock.yaml"));
});

test("M4 inventory retains ignored product files and modes but excludes installation and kernel evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "TEST-m4-inventory-"));
  try {
    await writeFile(join(root, "ignored.txt"), "source", { mode: 0o755 });
    for (const name of [".git", "node_modules", ".agent-teams-local"]) {
      await mkdir(join(root, name)); await writeFile(join(root, name, "generated"), "ignored");
    }
    const entries = await snapshot(root);
    assert.deepEqual(entries.map(entry => entry.path), ["ignored.txt"]);
    if (process.platform !== "win32") {assert.equal(entries[0].mode, 0o755);}
    await symlink(join(root, "ignored.txt"), join(root, "alias"));
    await assert.rejects(snapshot(root), /Nonregular/u);
  } finally {await rm(root, { recursive: true, force: true });}
});
