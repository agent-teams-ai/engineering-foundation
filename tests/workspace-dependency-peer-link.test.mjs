import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { check, withFixture } from "./support/capability-fixtures.mjs";

test("accepts a peer range together with its development link", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", peerDependencies: { "@fixture/core": "workspace:^" },
      devDependencies: { "@fixture/core": "workspace:*" }, peerDependenciesMeta: { "@fixture/core": { optional: true } },
    }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0, JSON.stringify(report));
    assert.equal(report.outcome, "passed", JSON.stringify(report));
  });
});

test("still rejects the same dependency in two other sections", async () => {
  await withFixture(async (consumerRoot) => {
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", dependencies: { "@fixture/core": "workspace:*" }, devDependencies: { "@fixture/core": "workspace:*" },
    }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1, JSON.stringify(report));
    assert.equal(report.capabilities[0].diagnostics.some(({ ruleId }) => ruleId.endsWith("multiple-times")), true);
  });
});
