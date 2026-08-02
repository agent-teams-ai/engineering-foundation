import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  cliPath,
  withPublicApiFixture
} from "./support/capability-fixtures.mjs";

test("promotes namespace exports with a deterministic non-empty signature", async () => {
  await withPublicApiFixture(async (consumerRoot) => {
    const declarationsRoot = join(consumerRoot, "packages", "library", "dist");
    await writeFile(
      join(declarationsRoot, "index.d.ts"),
      'export * as tools from "./tools.js";\nexport declare function stable(value: string): string;\n',
      "utf8"
    );
    await writeFile(
      join(declarationsRoot, "tools.d.ts"),
      "export declare function inspect(): void;\n",
      "utf8"
    );
    const manifestPath = join(consumerRoot, "packages", "library", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "1.3.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const promotion = spawnSync(
      process.execPath,
      [cliPath, "public-api-promote-release", "--consumer", consumerRoot, "--json"],
      { encoding: "utf8" }
    );
    assert.equal(promotion.status, 0, promotion.stderr);
    const baseline = JSON.parse(
      await readFile(
        join(consumerRoot, "architecture", "public-api", "public-api.json"),
        "utf8"
      )
    );
    const namespace = baseline.items.find(({ kind }) => kind === "Namespace");
    assert.equal(namespace.signature, "namespace tools");
  });
});
