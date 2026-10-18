import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { check, withFixture } from "./support/capability-fixtures.mjs";

test("accepts a peer range together with its development link", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog:\n  typescript: 7.0.2\n', "utf8");
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", peerDependencies: { typescript: "catalog:" }, devDependencies: { typescript: "catalog:" },
    }), "utf8");
    const { report } = check(consumerRoot);
    assert.equal(report.capabilities[0].diagnostics.some(({ ruleId }) => ruleId.endsWith("multiple-times")), false);
  });
});

test("still rejects the same dependency in two other sections", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\ncatalogMode: strict\ncatalog:\n  typescript: 7.0.2\n', "utf8");
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", dependencies: { typescript: "catalog:" }, devDependencies: { typescript: "catalog:" },
    }), "utf8");
    const { report } = check(consumerRoot);
    assert.equal(report.capabilities[0].diagnostics.some(({ ruleId }) => ruleId.endsWith("multiple-times")), true);
  });
});
