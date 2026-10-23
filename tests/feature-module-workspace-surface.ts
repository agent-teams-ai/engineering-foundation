import type { TestContext } from "node:test";
import type { FeatureFixture, ModuleFixture, Boundary } from "./feature-module-fixture-contract.ts";
export async function workspaceSurface(
  fixture: (t: TestContext) => Promise<FeatureFixture>,
  boundary: (id: string, roots: string[], entrypoints: string[]) => Boundary,
  t: TestContext,
  consumer: string,
  publicSource?: string,
) {
  const f = await fixture(t),
    root = "packages/other",
    src = `${root}/src`;
  const module: ModuleFixture = {
    id: "other",
    packageName: "@fixture/other",
    root,
    sourceRoot: src,
    role: "platform",
    preferredFeatureRoot: `${src}/features`,
    publicEntrypoints: [`${src}/index.ts`],
    moduleAssembly: [`${src}/index.ts`],
    generatedRoots: [],
    exceptions: [],
    features: [{ id: "storage", role: "platform", testRoots: ["tests"], layers: [] }],
  };
  f.profile.modules.push(module);
  const otherAssembly = boundary("other-assembly", [`${src}/index.ts`], [`${src}/index.ts`]);
  f.sourcePolicy.boundaries.push(otherAssembly);
  f.sourcePolicy.governedRoots.push(src);
  const declarations = {
    domain:
      "export const compare = (a:string,b:string) => a < b ? -1 : a > b ? 1 : 0; export interface Token { readonly value: string }",
    application: "export const inspect = (value:string) => value.length;",
    adapters:
      'import {readFileSync} from "node:fs"; export const read = (path:string) => readFileSync(path,"utf8"); export interface ReadAdapter { read: typeof read }',
    contracts: "export interface Transport { payload: string }",
  };
  for (const [role, source] of Object.entries(declarations)) {
    const layerRoot = `${src}/features/storage/${role}`,
      path = `${layerRoot}/index.ts`;
    module.features[0].layers.push({ role, roots: [layerRoot] });
    const entry = boundary(`other-${role}`, [layerRoot], [path]);
    if (role === "adapters") {
      entry.allow.builtins.push("node:fs");
    }
    f.sourcePolicy.boundaries.push(entry);
    otherAssembly.allow.boundaries.push(entry.id);
    await f.write(path, source);
  }
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
  await f.write(
    `${src}/index.ts`,
    publicSource ??
      'export {compare, type Token} from "./features/storage/domain/index.js"; export {read, type ReadAdapter} from "./features/storage/adapters/index.js"; export {inspect} from "./features/storage/application/index.js"; export type {Transport} from "./features/storage/contracts/index.js";',
  );
  await f.write(`${f.sourceRoot}/features/alpha/application/index.ts`, consumer);
  f.sourcePolicy.boundaries[0].allow.packages.push("@fixture/other");
  return {
    ...f,
    module,
    otherAssembly,
    check: () =>
      f.check([
        { name: "@fixture/example", root: "packages/example" },
        { name: "@fixture/other", root },
      ]),
  };
}

export async function generatedFixture(
  fixture: (t: TestContext) => Promise<FeatureFixture>,
  boundary: (id: string, roots: string[], entrypoints: string[]) => Boundary,
  t: TestContext,
) {
  const f = await fixture(t),
    root = `${f.sourceRoot}/features/alpha/generated`,
    path = `${root}/data.ts`;
  f.profile.modules[0].features[0].layers[0].roots.push(root);
  f.profile.modules[0].generatedRoots.push({
    root,
    generator: "generate.mjs",
    sources: ["input.json"],
  });
  await f.write("generate.mjs", "// Fixture generator identity");
  await f.write("input.json", '{"value":1}');
  await f.write(path, "export const value = 1;");
  const entry = boundary("generated", [root], [path]);
  f.sourcePolicy.boundaries.push(entry);
  return { ...f, generatedPath: path, generatedBoundary: entry };
}

export const boundary = (id: string, roots: string[], entrypoints: string[]): Boundary => ({
  id,
  roots,
  entrypoints,
  allow: { boundaries: [], packages: [], builtins: [], runtimeReferences: [] },
});
