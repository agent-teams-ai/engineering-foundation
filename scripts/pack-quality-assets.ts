import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

interface PackedQualityReport {
  readonly outcome: string;
  readonly capabilities: readonly {
    readonly diagnostics: readonly { readonly ruleId: string; readonly location: { readonly path: string } }[];
  }[];
}

/** Extends the existing archive-owned consumer; never substitutes checkout code. */
export async function qualifyPackedQualityAssets(input: {
  readonly root: string;
  readonly sourceRoot: string;
  readonly boundaryId: string;
  readonly put: (path: string, value: unknown) => Promise<void>;
  readonly invoke: (args: readonly string[], code?: number) => Promise<PackedQualityReport>;
}): Promise<void> {
  const { root, sourceRoot, boundaryId, put, invoke } = input;
  const originalProfile = await readFile(join(root, "quality.yaml"), "utf8");
  const originalManifest = await readFile(join(root, "package.json"), "utf8");
  const profile = JSON.parse(originalProfile);
  const manifest = JSON.parse(originalManifest);
  const protobuf = `${sourceRoot}/contracts/asset.proto`;
  const migration = `${sourceRoot}/adapters/migrations/0001-asset.sql`;
  const undeclared = `${sourceRoot}/adapters/migrations/undeclared.sql`;
  const validators = ["scripts/asset-protobuf.ts", "scripts/asset-migration.ts"];
  const scripts = { ...manifest.scripts,
    check: `${manifest.scripts.check} && pnpm asset:protobuf:check && pnpm asset:migration:check`,
    "asset:protobuf:check": `node ${validators[0]}`,
    "asset:migration:check": `node ${validators[1]}`
  };
  try {
    await put(protobuf, 'syntax = "proto3"; message Asset {}\n');
    await put(migration, "CREATE TABLE asset (id integer PRIMARY KEY);\n");
    for (const validator of validators) {
      await put(validator, "throw new Error('static wiring must never execute this checker');\n");
    }
    await put("package.json", { ...manifest, scripts });
    await put("quality.yaml", { ...profile, schemaVersion: 3, assets: [
      { path: protobuf, kind: "protobuf", boundaryId, script: "asset:protobuf:check" },
      { path: migration, kind: "sql-migration", boundaryId, script: "asset:migration:check" }
    ] });
    for (const args of [["check", "quality.source-coverage"], ["quality", "check", "--scope-only"], ["quality", "check"]]) {
      assert.equal((await invoke(args)).outcome, "passed");
    }
    await put("package.json", { ...manifest, scripts: { ...scripts, "asset:migration:check": "true" } });
    const noOp = await invoke(["check", "quality.source-coverage"], 1);
    assert.ok(noOp.capabilities.some(({ diagnostics }) => diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.asset-route" && location.path === migration)));
    await put("package.json", { ...manifest, scripts });
    await put(undeclared, "export const executable = true;\n");
    const hidden = await invoke(["check", "quality.source-coverage"], 1);
    assert.ok(hidden.capabilities.some(({ diagnostics }) => diagnostics.some(({ ruleId, location }) =>
      ruleId === "quality.source-coverage.source-language" && location.path === undeclared)));
  } finally {
    await put("quality.yaml", originalProfile);
    await put("package.json", originalManifest);
    for (const path of [protobuf, migration, undeclared, ...validators]) {
      await rm(join(root, path), { force: true });
    }
  }
}
