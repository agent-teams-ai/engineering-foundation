import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceConfigPath } from "../helpers/source-dependency-v2-fixture.mjs";
interface BoundaryOptions {
  allowedPackages?: string[];
  claims?: string[];
  dependencyMode?: string;
  entrypoint: string;
  id: string;
  root: string;
}
interface MixedOptions {
  appSpecifier?: string;
  appFile?: string;
  appSource?: string;
  exports?: unknown;
  appAllowedPackages?: string[];
  appDependencyMode?: string;
  developmentOnly?: boolean;
  runtimeClaims?: string[];
  developmentClaims?: string[];
}
function boundaryYaml({
  allowedPackages = [],
  claims = [],
  dependencyMode = "runtime",
  entrypoint,
  id,
  root,
}: BoundaryOptions) {
  const packageExports =
    claims.length === 0
      ? ""
      : `    packageExports:\n${claims.map((claim) => `      - ${JSON.stringify(claim)}`).join("\n")}\n`;
  const packages =
    allowedPackages.length === 0
      ? "[]"
      : `\n${allowedPackages.map((packageName) => `        - ${JSON.stringify(packageName)}`).join("\n")}`;
  return `  - id: ${id}\n    dependencyMode: ${dependencyMode}\n${packageExports}    roots:\n      - ${root}\n    entrypoints:\n      - ${entrypoint}\n    allow:\n      boundaries: []\n      packages: ${packages}\n      builtins: []\n      runtimeReferences: []\n`;
}

export async function nativeNodeExportResolution(exports: unknown, condition: string) {
  const consumerRoot = await mkdtemp(join(tmpdir(), "foundation-node-export-oracle-"));
  try {
    const packageRoot = join(consumerRoot, "node_modules", "@fixture", "oracle");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify({ name: "@fixture/oracle", exports })}\n`,
        "utf8",
      ),
      writeFile(join(packageRoot, "dist", "index.cjs"), "module.exports = 1;\n", "utf8"),
    ]);
    return spawnSync(
      process.execPath,
      [
        ...(condition === "import" ? ["--input-type=module"] : []),
        "--eval",
        condition === "import" ? 'await import("@fixture/oracle");' : 'require("@fixture/oracle");',
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    );
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}

export async function configureMixedPackage(consumerRoot: string, options: MixedOptions = {}) {
  const appSpecifier = options.appSpecifier ?? "@fixture/core";
  const appFile = options.appFile ?? "index.ts";
  const coreRoot = join(consumerRoot, "packages", "core");
  const developmentRoot = join(coreRoot, "src", "development");
  await mkdir(developmentRoot, { recursive: true });
  if (appFile !== "index.ts") {
    await rm(join(consumerRoot, "packages", "app", "src", "index.ts"));
  }
  await Promise.all([
    writeFile(
      join(consumerRoot, "packages", "app", "src", appFile),
      options.appSource ??
        `import value from ${JSON.stringify(appSpecifier)};\nexport { value };\n`,
      "utf8",
    ),
    writeFile(join(coreRoot, "src", "index.ts"), "export default 1;\n", "utf8"),
    writeFile(join(developmentRoot, "index.ts"), "export default 2;\n", "utf8"),
    writeFile(
      join(coreRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@fixture/core",
          version: "0.0.0",
          private: true,
          type: "module",
          exports: options.exports ?? { ".": "./dist/index.js" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
  const boundaries = [
    boundaryYaml({
      allowedPackages: options.appAllowedPackages ?? ["@fixture/core"],
      dependencyMode: options.appDependencyMode,
      entrypoint: `packages/app/src/${appFile}`,
      id: "app.surface",
      root: "packages/app/src",
    }),
    ...(options.developmentOnly
      ? []
      : [
          boundaryYaml({
            claims: options.runtimeClaims,
            entrypoint: "packages/core/src/index.ts",
            id: "core.runtime",
            root: "packages/core/src/index.ts",
          }),
        ]),
    boundaryYaml({
      claims: options.developmentClaims,
      dependencyMode: "development",
      entrypoint: options.developmentOnly
        ? "packages/core/src/index.ts"
        : "packages/core/src/development/index.ts",
      id: "core.development",
      root: options.developmentOnly ? "packages/core/src" : "packages/core/src/development",
    }),
  ].join("");
  await writeFile(
    sourceConfigPath(consumerRoot),
    `schemaVersion: 2\nworkspace:\n  kind: pnpm\n  manifest: pnpm-workspace.yaml\npackageRoots:\n  - packages\ngovernedRoots:\n  - packages/app/src\n  - packages/core/src\nboundaries:\n${boundaries}`,
    "utf8",
  );
}
