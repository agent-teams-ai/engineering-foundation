import test from "node:test";
import {
  withV3Fixture,
  writeV3File,
  saveV3Policy,
  checkV3,
  assertV3Rule,
  assertV3Problem,
} from "./helpers/source-dependency-v3-fixture.mjs";
interface RootPolicy {
  packageRoots: string[];
  governedRoots: string[];
  boundaries: { roots: string[]; dependencyMode?: string; allow: { packages: string[] } }[];
}
export function registerRootExportConditionTests(): void {
  for (const rootOnly of [true, false]) {
    void test(`v3 public CLI admits ${rootOnly ? "root-only" : "mixed nested"} source ownership`, async () => {
      await withV3Fixture(
        (root: string) => {
          checkV3(root);
        },
        { rootOnly },
      );
    });
  }

  void test("v3 nearest pure marker controls static TypeScript export conditions", async () => {
    await withV3Fixture(async (root: string, policy: RootPolicy) => {
      const importer = "tooling/task/src/scoped/index.ts";
      policy.boundaries.at(-1)!.allow.packages = ["@fixture/domain"];
      await saveV3Policy(root, policy);
      await writeV3File(root, "packages/domain/package.json", {
        name: "@fixture/domain",
        type: "module",
        exports: { ".": { import: null, require: "./dist/index.cjs" } },
      });
      await writeV3File(
        root,
        importer,
        'import value from "@fixture/domain";\nexport { value };\n',
      );
      await writeV3File(root, "tooling/task/src/scoped/package.json", { type: "commonjs" });
      checkV3(root);
      await writeV3File(root, "tooling/task/src/scoped/package.json", { type: "module" });
      assertV3Rule(root, "package-subpath-not-exported", importer);
    });
  });

  const overlapMutations: readonly [string, (policy: RootPolicy) => void][] = [
    [
      "case-equivalent selectors",
      (policy) => {
        policy.packageRoots.push("Packages");
      },
    ],
    [
      "overlapping governed roots",
      (policy) => {
        policy.governedRoots.push("tooling/task");
      },
    ],
    [
      "overlapping boundary roots",
      (policy) => {
        policy.boundaries.at(-1)!.roots.push("tooling/task/src/nested");
      },
    ],
  ];
  for (const [name, mutate] of overlapMutations) {
    void test(`v3 selection overlap does not authorize ${name}`, async () => {
      await withV3Fixture(async (root: string, policy: RootPolicy) => {
        checkV3(root);
        mutate(policy);
        await saveV3Policy(root, policy);
        assertV3Problem(
          root,
          name === "overlapping boundary roots"
            ? "SOURCE_BOUNDARY_AMBIGUOUS"
            : "SOURCE_ARCHITECTURE_CONFIG_INVALID",
        );
      });
    });
  }

  for (const specifier of [
    "../../../dist/con.js",
    "../../../dist/index.js:payload",
    "../../../dist/../secret.js",
    "../../../dist/%69ndex.js",
    "../../../dist/cafe\u0301.js",
    "../../../dist//index.js",
  ]) {
    void test(`v3 root development output refuses noncanonical ${specifier}`, async () => {
      await withV3Fixture(async (root: string, policy: RootPolicy) => {
        const importer = "tooling/task/src/index.ts";
        policy.boundaries.at(-1)!.dependencyMode = "development";
        await saveV3Policy(root, policy);
        await writeV3File(root, importer, 'import "../../../dist/index.js";\n');
        checkV3(root);
        await writeV3File(root, importer, `import ${JSON.stringify(specifier)};\n`);
        assertV3Rule(root, "unresolved-local-import", importer);
      });
    });
  }
}
