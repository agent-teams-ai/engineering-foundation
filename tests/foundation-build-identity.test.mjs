import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeFoundationBuildIdentity } from "../packages/engineering-foundation/dist/transaction-coordination/adapters/node/installed-foundation-build-identity.js";

async function createRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function prepareBuild(root) {
  await Promise.all(
    ["dist", "schemas", "presets", "assets/transaction-coordination/historical"].map((path) =>
      mkdir(join(root, path), { recursive: true }),
    ),
  );
  await Promise.all([
    writeFile(join(root, "dist", "runtime.js"), "export const value = 1;\n"),
    writeFile(join(root, "dist", "ignored.d.ts"), "export {};\n"),
    writeFile(join(root, "schemas", "contract.json"), "{}\n"),
    writeFile(join(root, "presets", "base.json"), "{}\n"),
    writeFile(join(root, "assets/transaction-coordination/historical/document-plan-v1.schema.json"), "{}\n"),
    writeFile(
      join(root, "package.json"),
      '{"name":"@agent-teams/engineering-foundation","version":"0.12.0"}\n',
    ),
  ]);
}

test("build identity is path-independent and binds package and shipped artifacts", async () => {
  const first = await createRoot("foundation-build-first-");
  const second = await createRoot("foundation-build-second-");
  try {
    await Promise.all([prepareBuild(first), prepareBuild(second)]);
    assert.equal(
      await computeFoundationBuildIdentity(first),
      await computeFoundationBuildIdentity(second),
    );
    for (const [path, changed, restored] of [
      ["dist/runtime.js", "export const value = 2;\n", "export const value = 1;\n"],
      ["package.json", '{"name":"@agent-teams/engineering-foundation","version":"0.12.1"}\n', '{"name":"@agent-teams/engineering-foundation","version":"0.12.0"}\n'],
      ["assets/transaction-coordination/historical/document-plan-v1.schema.json", '{"const":"changed"}\n', "{}\n"],
      ["schemas/contract.json", '{"type":"object"}\n', "{}\n"],
    ]) {
      await writeFile(join(second, path), changed);
      assert.notEqual(
        await computeFoundationBuildIdentity(first),
        await computeFoundationBuildIdentity(second),
      );
      await writeFile(join(second, path), restored);
    }
    await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        writeFile(join(first, "dist", `ignored-${index}.d.ts`), "export {};\n"),
      ),
    );
    await assert.rejects(
      computeFoundationBuildIdentity(first, { maximumVisitedEntries: 6 }),
      /too many entries/u,
    );
  } finally {
    await Promise.all([
      rm(first, { force: true, recursive: true }),
      rm(second, { force: true, recursive: true }),
    ]);
  }
});
