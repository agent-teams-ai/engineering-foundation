import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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

test("accepts an explicit workspace peer minimum with the current development link", async () => {
  await withFixture(async (consumerRoot) => {
    const corePath = join(consumerRoot, "packages", "core", "package.json");
    const core = JSON.parse(await readFile(corePath, "utf8"));
    await writeFile(corePath, JSON.stringify({ ...core, version: "1.9.0" }), "utf8");
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", peerDependencies: { "@fixture/core": "workspace:^1.8.0" },
      devDependencies: { "@fixture/core": "workspace:*" }, peerDependenciesMeta: { "@fixture/core": { optional: true } },
    }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0, JSON.stringify(report));
    assert.equal(report.outcome, "passed", JSON.stringify(report));
  });
});

test("accepts different peer and development catalogs for the same normalized package", async () => {
  await withFixture(async (consumerRoot) => {
    const workspacePath = join(consumerRoot, "pnpm-workspace.yaml");
    await writeFile(workspacePath, `${await readFile(workspacePath, "utf8")}\ncatalogs:\n  peer:\n    same-slot: npm:is-number@7.0.0\n  development:\n    same-slot: npm:is-number@7.0.0\n`, "utf8");
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", peerDependencies: { "same-slot": "catalog:peer" },
      devDependencies: { "same-slot": "catalog:development" },
    }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 0, JSON.stringify(report));
    assert.equal(report.outcome, "passed", JSON.stringify(report));
  });
});

test("rejects peer and development catalogs resolving the same slot to different packages", async () => {
  await withFixture(async (consumerRoot) => {
    const workspacePath = join(consumerRoot, "pnpm-workspace.yaml");
    await writeFile(workspacePath, `${await readFile(workspacePath, "utf8")}\ncatalogs:\n  peer:\n    same-slot: npm:is-number@7.0.0\n  development:\n    same-slot: npm:is-odd@3.0.1\n`, "utf8");
    await writeFile(join(consumerRoot, "packages", "app", "package.json"), JSON.stringify({
      name: "@fixture/app", version: "0.0.0", peerDependencies: { "same-slot": "catalog:peer" },
      devDependencies: { "same-slot": "catalog:development" },
    }), "utf8");
    const { result, report } = check(consumerRoot);
    assert.equal(result.status, 1, JSON.stringify(report));
    assert.equal(report.outcome, "violations", JSON.stringify(report));
    assert.deepEqual(report.capabilities[0].diagnostics.map(({ ruleId }) => ruleId), [
      "workspace.dependency-declarations.dependency-declared-multiple-times",
    ]);
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
