import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FeatureFixture, Boundary } from "./feature-module-fixture-contract.ts";
export function registerFeatureLayerCases({
  fixture,
  expectPass,
  rejects,
  primitiveFixture,
  boundary,
}: {
  fixture: (t: TestContext, role?: string) => Promise<FeatureFixture>;
  expectPass: (f: FeatureFixture) => Promise<void>;
  rejects: (f: FeatureFixture, code: string) => Promise<void>;
  primitiveFixture: (t: TestContext) => Promise<FeatureFixture>;
  boundary: (id: string, roots: string[], entrypoints: string[]) => Boundary;
}): void {
  for (const role of ["domain", "platform", "integration", "sdk", "testing"]) {
    void test(`CONTROL valid ${role} feature`, async (t) => expectPass(await fixture(t, role)));
  }
  for (const ext of ["mts", "cts"]) {
    void test(`CONTROL unowned .${ext} source is discovered`, async (t) => {
      const f = await fixture(t);
      await f.write(`${f.sourceRoot}/orphan.${ext}`, "export const behavior = () => 1;\n");
      await rejects(f, "unowned-source");
    });
  }
  void test("FN assembly inline call must not conceal behavior", async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/index.ts`,
      'export const execute = (value: number) => (() => { if(value < 0) throw new Error("invalid"); return value * 2; })();\n',
    );
    await rejects(f, "assembly-behavior");
  });
  void test("FN assembly delegated argument must not contain policy", async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/index.ts`,
      'import {execute as run} from "./features/alpha/application/index.js";\nexport const execute = (value: number) => run(value < 0 ? 0 : value * 2);\n',
    );
    await rejects(f, "assembly-behavior");
  });
  void test("FP composition type declaration is not behavior", async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/index.ts`,
      'import {execute as run} from "./features/alpha/application/index.js";\ntype Execute = typeof run;\nexport const execute: Execute = run;\n',
    );
    await expectPass(f);
  });
  void test("FP feature-owned domain declaration is allowed", async (t) => {
    const f = await fixture(t, "domain");
    const d = `${f.sourceRoot}/features/alpha/domain`;
    f.profile.modules[0].features[0].layers.push({ role: "domain", roots: [d] });
    f.sourcePolicy.boundaries.push(boundary("alpha-domain", [d], [`${d}/index.ts`]));
    await f.write(`${d}/index.ts`, "export interface Quantity { readonly value: number }\n");
    await expectPass(f);
  });
  void test("FN export-star-as namespace is not a curated surface", async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'export * as all from "./private.js";\n',
    );
    await f.write(
      `${f.sourceRoot}/features/alpha/application/private.ts`,
      "export const execute = () => 1;\n",
    );
    await rejects(f, "uncurated-entrypoint");
  });
  for (const ext of ["mts", "cts"]) {
    void test(`FN private .${ext} manifest wildcard must be closed`, async (t) => {
      const f = await fixture(t);
      await f.write(
        `${f.sourceRoot}/features/beta/application/private.${ext}`,
        "export const hidden = () => 1;\n",
      );
      await f.write(
        "packages/example/package.json",
        JSON.stringify({
          name: "@fixture/example",
          version: "1.0.0",
          type: "module",
          exports: {
            ".": "./src/index.ts",
            "./hidden/*": `./src/features/beta/application/*.${ext}`,
          },
        }),
      );
      await rejects(f, "wildcard-export");
    });
  }
  void test("FN nested empty module is a ceremonial layer", async (t) => {
    const f = await fixture(t);
    await f.write(`${f.sourceRoot}/features/alpha/application/empty/index.ts`, "export {};\n");
    await rejects(f, "empty-layer");
  });
  void test("FP approved pure primitive is usable by the application", async (t) => {
    await expectPass(await primitiveFixture(t));
  });
  void test("FN echo guard name is not guard execution", async (t) => {
    const f = await fixture(t);
    await f.write(
      "package.json",
      JSON.stringify({
        name: "fixture-root",
        private: true,
        scripts: {
          "check:fast": "pnpm architecture:features:check",
          check: "pnpm architecture:features:check",
          "architecture:features:check": "echo check-feature-modules.mjs",
        },
      }),
    );
    await rejects(f, "enforcement-command");
  });

  // Promoted independent edge review regressions and controls.
  void test("FN application can consume a workspace concrete filesystem adapter", async (t) => {
    const f = await fixture(t);
    const root = "packages/other",
      src = `${root}/src`;
    f.profile.modules.push({
      id: "other",
      packageName: "@fixture/other",
      root,
      sourceRoot: src,
      role: "platform",
      preferredFeatureRoot: `${src}/features`,
      testRoots: ["tests"],
      publicEntrypoints: [`${src}/index.ts`],
      moduleAssembly: [`${src}/index.ts`],
      generatedRoots: [],
      exceptions: [],
      features: [
        {
          id: "storage",
          role: "platform",
          testRoots: ["tests"],
          layers: [{ role: "adapters", roots: [`${src}/features/storage/adapters`] }],
        },
      ],
    });
    await f.write(
      `${root}/package.json`,
      JSON.stringify({
        name: "@fixture/other",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
    );
    await f.write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@fixture/example",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
        dependencies: { "@fixture/other": "workspace:*" },
      }),
    );
    await f.write(`${src}/index.ts`, 'export {read} from "./features/storage/adapters/read.js";\n');
    await f.write(
      `${src}/features/storage/adapters/read.ts`,
      'import {readFileSync} from "node:fs";\nexport const read = (path:string) => readFileSync(path,"utf8");\n',
    );
    f.sourcePolicy.governedRoots.push(src);
    f.sourcePolicy.boundaries.push(
      {
        ...boundary("other-assembly", [`${src}/index.ts`], [`${src}/index.ts`]),
        allow: { boundaries: ["storage"], packages: [], builtins: [], runtimeReferences: [] },
      },
      {
        ...boundary(
          "storage",
          [`${src}/features/storage/adapters`],
          [`${src}/features/storage/adapters/read.ts`],
        ),
        allow: { boundaries: [], packages: [], builtins: ["node:fs"], runtimeReferences: [] },
      },
    );
    f.sourcePolicy.boundaries[0].allow.packages.push("@fixture/other");
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'import {read} from "@fixture/other";\nexport const execute = () => read("secret.txt");\n',
    );
    const result = await f.check([
      { name: "@fixture/example", root: "packages/example" },
      { name: "@fixture/other", root: "packages/other" },
    ]);
    assert.ok(
      result.problems.some(
        (p) => p.code === "inner-infrastructure" || p.code === "layer-direction",
      ),
      JSON.stringify(result),
    );
  });
  registerAdditionalFeatureLayerCases({ fixture, expectPass, rejects, primitiveFixture, boundary });
}
function registerAdditionalFeatureLayerCases({
  fixture,
  expectPass,
  rejects,
  boundary,
}: Parameters<typeof registerFeatureLayerCases>[0]): void {
  void test("FP pure generated feature data may feed its owning application", async (t) => {
    const f = await fixture(t);
    const p = `${f.sourceRoot}/features/alpha/generated/canonical.ts`;
    f.profile.modules[0].generatedRoots.push({
      root: `${f.sourceRoot}/features/alpha/generated`,
      generator: "generator.mjs",
      sources: ["input.txt"],
    });
    f.profile.modules[0].features[0].layers[0].roots.push(
      `${f.sourceRoot}/features/alpha/generated`,
    );
    await f.write("generator.mjs", "// fixture generator identity\n");
    await f.write("input.txt", "exact-canonical-bytes");
    await f.write(p, 'export const canonical = "exact-canonical-bytes";\n');
    f.sourcePolicy.boundaries.push(boundary("generated", [p], [p]));
    f.sourcePolicy.boundaries[0].allow.boundaries.push("generated");
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'import {canonical} from "../generated/canonical.js";\nexport const execute = () => canonical.length;\n',
    );
    await expectPass(f);
  });
  void test("FP deterministic hash is not ambient randomness or IO", async (t) => {
    const f = await fixture(t);
    f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'import {createHash} from "node:crypto";\nexport const execute = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");\n',
    );
    await expectPass(f);
  });
  void test("CONTROL random crypto operation in application remains forbidden", async (t) => {
    const f = await fixture(t);
    f.sourcePolicy.boundaries[0].allow.builtins.push("node:crypto");
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      'import {randomUUID} from "node:crypto";\nexport const execute = () => randomUUID();\n',
    );
    await rejects(f, "inner-infrastructure");
  });
  void test("CONTROL metadata reader belongs to an adapter", async (t) => {
    const f = await fixture(t);
    const p = `${f.sourceRoot}/features/alpha/adapters/version.ts`;
    f.profile.modules[0].features[0].layers.push({ role: "adapters", roots: [p] });
    f.sourcePolicy.boundaries.push({
      ...boundary("metadata", [p], [p]),
      allow: { boundaries: [], packages: [], builtins: ["node:fs"], runtimeReferences: [] },
    });
    await f.write(
      p,
      'import {readFileSync} from "node:fs";\nexport const version = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version;\n',
    );
    await expectPass(f);
  });
  void test("unresolved JSON module loading remains visible to the feature guard", async (t) => {
    const f = await fixture(t);
    const p = `${f.sourceRoot}/features/alpha/adapters/version.ts`;
    f.profile.modules[0].features[0].layers.push({ role: "adapters", roots: [p] });
    f.sourcePolicy.boundaries.push({
      ...boundary("metadata", [p], [p]),
      allow: { boundaries: [], packages: [], builtins: ["node:module"], runtimeReferences: [] },
    });
    // The previous control passed only because this nested loader was invisible.
    // Data observation above is supported; this non-source module has no graph target.
    await f.write(
      p,
      'import {createRequire} from "node:module";\nexport const version = createRequire(import.meta.url)("../../../../../package.json").version;\n',
    );
    const result = await f.check();
    assert.ok(
      result.problems.some(
        ({ code, message }) =>
          code === "source-policy" &&
          message.includes("unresolved-local-import") &&
          message.includes("package.json"),
      ),
    );
  });

  // Promoted independent executable review regressions and controls.
  void test("FP thin executable invokes feature entrypoint", async (t) => {
    const f = await fixture(t);
    const cli = `${f.sourceRoot}/cli.ts`;
    f.profile.modules[0].moduleAssembly.push(cli);
    f.sourcePolicy.boundaries.push({
      ...boundary("cli", [cli], [cli]),
      allow: { boundaries: ["alpha"], packages: [], builtins: [], runtimeReferences: [] },
    });
    await f.write(
      "packages/example/package.json",
      JSON.stringify({
        name: "@fixture/example",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
        bin: { example: "./src/cli.ts" },
      }),
    );
    await f.write(
      cli,
      'import { execute } from "./features/alpha/application/index.js";\nvoid execute();\n',
    );
    await expectPass(f);
  });

  // Promoted independent gate review regressions and controls.
  void test("FN successful short circuit must not bypass guard", async (t) => {
    const f = await fixture(t);
    await f.write(
      "package.json",
      JSON.stringify({
        name: "fixture-root",
        private: true,
        scripts: {
          "check:fast": "pnpm architecture:features:check",
          check: "true || pnpm architecture:features:check",
          "architecture:features:check": "node scripts/check-feature-modules.mjs",
        },
      }),
    );
    await rejects(f, "enforcement-command");
  });
  void test("CONTROL failing prerequisite cannot establish successful enforcement", async (t) => {
    const f = await fixture(t);
    const command = "false && pnpm architecture:features:check";
    const processResult = spawnSync(command, [], {
      cwd: f.repositoryRoot,
      encoding: "utf8",
      shell: true,
    });
    assert.equal(processResult.status, 1);
    const pkg = JSON.parse(await readFile(join(f.repositoryRoot, "package.json"), "utf8"));
    pkg.scripts.check = `false && ${pkg.scripts.check}`;
    await f.write("package.json", JSON.stringify(pkg));
    await rejects(f, "enforcement-command");
  });

  // Promoted independent transport review regressions and controls.
  for (const layer of ["adapters", "application"]) {
    void test(`CONTROL transport SDK types in ${layer}`, async (t) => {
      const f = await fixture(t);
      const dir = `${f.sourceRoot}/features/alpha/${layer}`;
      if (layer === "adapters") {
        f.profile.modules[0].features[0].layers.push({ role: "adapters", roots: [dir] });
        f.sourcePolicy.boundaries.push(boundary("adapter", [dir], [`${dir}/index.ts`]));
      }
      const b = f.sourcePolicy.boundaries.find((x) => x.roots.includes(dir));
      assert.ok(b);
      b.allow.packages.push("@modelcontextprotocol/server");
      await f.write(
        "packages/example/package.json",
        JSON.stringify({
          name: "@fixture/example",
          version: "1.0.0",
          type: "module",
          exports: { ".": "./src/index.ts" },
          dependencies: { "@modelcontextprotocol/server": "1.0.0" },
        }),
      );
      await f.write(
        `${dir}/index.ts`,
        'import type { CallToolResult } from "@modelcontextprotocol/server";\nexport const execute = (value:CallToolResult) => value;\n',
      );
      if (layer === "adapters") {
        await expectPass(f);
      } else {
        await rejects(f, "inner-infrastructure");
      }
    });
  }

  // Promoted independent typed-assembly review regressions and controls.
  void test("FN typed-compatible delegated argument still conceals assembly policy", async (t) => {
    const f = await fixture(t);
    await f.write(
      `${f.sourceRoot}/features/alpha/application/index.ts`,
      "export const execute = (value:number):number => value;\n",
    );
    await f.write(
      `${f.sourceRoot}/index.ts`,
      'import {execute as run} from "./features/alpha/application/index.js";\nexport const execute = (value: number):number => run(value < 0 ? 0 : value * 2);\n',
    );
    await f.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: [],
        },
        include: ["packages/example/src/**/*.ts"],
      }),
    );
    const compiled = spawnSync(
      "node",
      [
        join(import.meta.dirname, "../node_modules/typescript/bin/tsc"),
        "-p",
        join(f.repositoryRoot, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { cwd: f.repositoryRoot, encoding: "utf8" },
    );
    await f.write(
      "typecheck-result.json",
      JSON.stringify(
        { status: compiled.status, stdout: compiled.stdout, stderr: compiled.stderr },
        null,
        2,
      ),
    );
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    await rejects(f, "assembly-behavior");
  });
}
