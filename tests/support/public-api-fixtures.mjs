import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

export const ROOT_STABLE_ITEM = Object.freeze({
  canonicalReference: "@fixture/public-api!stable:function(1)",
  kind: "Function",
  parentReference: "@fixture/public-api!",
  parentKind: "EntryPoint",
  signature: "export declare function stable(value: string): string;"
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function v2Baseline(localItem = ROOT_STABLE_ITEM) {
  return {
    schemaVersion: 2,
    packageName: "@fixture/public-api",
    packageVersion: "1.2.3",
    extractorVersion: "7.58.12",
    entrypoints: [
      { exportPath: ".", items: [ROOT_STABLE_ITEM] },
      { exportPath: "./local-mode", items: [localItem] }
    ]
  };
}

export async function writeAcceptedDecisionBaseline(consumerRoot, decisions) {
  const baselinePath = join(
    consumerRoot,
    "architecture",
    "decisions",
    "accepted-decisions.json"
  );
  await mkdir(join(consumerRoot, "architecture", "decisions"), { recursive: true });
  await writeFile(
    baselinePath,
    `${JSON.stringify({
      schemaVersion: 1,
      algorithm: "sha256",
      decisions
    }, null, 2)}\n`,
    "utf8"
  );
}

export async function configureV2PublicApiFixture(consumerRoot) {
  const packageDirectory = join(consumerRoot, "packages", "library");
  const configPath = join(
    consumerRoot,
    "architecture",
    "foundation",
    "public-api-compatibility.yaml"
  );
  await writeFile(
    join(packageDirectory, "dist", "local-mode.d.ts"),
    "export declare function stable(value: string): string;\n",
    "utf8"
  );
  await writeFile(
    join(packageDirectory, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        target: "ES2024"
      },
      include: ["dist/*.d.ts"]
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@fixture/public-api",
      version: "1.2.3",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts" },
        "./local-mode": { types: "./dist/local-mode.d.ts" }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    configPath,
    stringifyYaml({
      schemaVersion: 2,
      acceptedDecisionBaselinePath: "architecture/decisions/accepted-decisions.json",
      changesetDirectory: ".changeset",
      packages: [
        {
          packageName: "@fixture/public-api",
          packageRoot: "packages/library",
          manifestPath: "packages/library/package.json",
          entrypoints: [
            {
              exportPath: "./local-mode",
              declarationEntryPoint: "packages/library/dist/local-mode.d.ts"
            },
            {
              exportPath: ".",
              declarationEntryPoint: "packages/library/dist/index.d.ts"
            }
          ],
          nonTypeExports: [],
          tsconfigPath: "packages/library/tsconfig.json",
          releasedBaselinePath: "architecture/public-api/public-api.json",
          approvedBreakingChanges: []
        }
      ]
    }, { lineWidth: 0 }),
    "utf8"
  );
  await writeFile(
    join(consumerRoot, "architecture", "public-api", "public-api.json"),
    `${JSON.stringify(v2Baseline(), null, 2)}\n`,
    "utf8"
  );
  return configPath;
}
