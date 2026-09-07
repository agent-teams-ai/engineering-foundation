import test from "node:test";

async function namespaceFixture(workspaceSurface, t, consumer) {
  const f = await workspaceSurface(t, consumer ??
    'import { api } from "@fixture/other"; export const execute = () => api.compare("a", "b");',
    'export * as api from "./public.js";');
  const publicPath = "packages/other/src/public.ts";
  f.module.publicEntrypoints.push(publicPath);
  f.module.moduleAssembly.push(publicPath);
  f.otherAssembly.roots.push(publicPath);
  f.otherAssembly.entrypoints.push(publicPath);
  await f.write(publicPath, 'export { compare, type Token } from "./features/storage/domain/index.js";');
  const manifest = { name: "@fixture/other", version: "1.0.0", type: "module",
    exports: { ".": "./src/index.ts", "./public": "./src/public.ts" } };
  await f.write("packages/other/package.json", JSON.stringify(manifest));
  return { ...f, publicPath, manifest };
}

export function registerNamespaceSurfaceCases(workspaceSurface, expectPass, rejects) {
  for (const mode of ["published target", "unpublished target", "aggregate as unpublished target"]) {
    test(`curated non-manifest aggregate preserves publication boundary: ${mode}`, async (t) => {
      const f = await namespaceFixture(workspaceSurface, t,
        'import { compare } from "@fixture/other"; export const execute = () => compare("a", "b");');
      const aggregate = "packages/other/src/aggregate.ts";
      f.module.publicEntrypoints.push(aggregate);
      f.module.moduleAssembly.push(aggregate);
      f.otherAssembly.roots.push(aggregate);
      f.otherAssembly.entrypoints.push(aggregate);
      const root = 'export { compare } from "./features/storage/domain/index.js";';
      await f.write("packages/other/src/index.ts", root);
      await f.write(aggregate, 'export * as api from "./public.js";');
      if (mode === "unpublished target") {
        delete f.manifest.exports["./public"];
        await f.write("packages/other/package.json", JSON.stringify(f.manifest));
      } else if (mode === "aggregate as unpublished target") {
        await f.write("packages/other/src/index.ts", root + ' export * as aggregate from "./aggregate.js";');
      }
      if (mode === "published target") { await expectPass(f); }
      else { await rejects(f, "uncurated-entrypoint"); }
    });
  }

  for (const consumer of [
    'import { api } from "@fixture/other"; export const execute = () => api.compare("a", "b");',
    'import type { api } from "@fixture/other"; export type Token = api.Token;'
  ]) {
    test(`curated namespace preserves semantic ownership: ${consumer}`, async (t) => {
      await expectPass(await namespaceFixture(workspaceSurface, t, consumer));
    });
  }
  test("curated namespace does not hide infrastructure members from application", async (t) => {
    const f = await namespaceFixture(workspaceSurface, t);
    await f.write(f.publicPath, 'export { compare } from "./features/storage/domain/index.js"; export { read } from "./features/storage/adapters/index.js";');
    await rejects(f, "layer-direction");
  });
  for (const [name, edit] of [
    ["unexported target", (f) => { delete f.manifest.exports["./public"]; }],
    ["blocked target", (f) => { f.manifest.exports["./public"] = null; }],
    ["different exported file", (f) => { f.manifest.exports["./public"] = "./src/features/storage/domain/index.ts"; }],
    ["unclassified conditional target", (f) => { f.manifest.exports["./public"] = {
      types: "./src/features/storage/domain/index.ts", import: "./src/public.ts" }; }]
  ]) {
    test(`curated namespace rejects ${name}`, async (t) => {
      const f = await namespaceFixture(workspaceSurface, t);
      edit(f);
      await f.write("packages/other/package.json", JSON.stringify(f.manifest));
      await rejects(f, "uncurated-entrypoint");
    });
  }
  test("curated namespace requires explicit architecture entrypoint ownership", async (t) => {
    const f = await namespaceFixture(workspaceSurface, t);
    f.module.publicEntrypoints = f.module.publicEntrypoints.filter((path) => path !== f.publicPath);
    await rejects(f, "uncurated-entrypoint");
  });
  test("curated namespace rejects a wildcard behind the public target", async (t) => {
    const f = await namespaceFixture(workspaceSurface, t);
    await f.write(f.publicPath, 'export * from "./features/storage/domain/index.js";');
    await rejects(f, "uncurated-entrypoint");
  });
  test("curated namespace rejects a public namespace cycle", async (t) => {
    const f = await namespaceFixture(workspaceSurface, t);
    await f.write(f.publicPath, 'export * as root from "./index.js";');
    await rejects(f, "uncurated-entrypoint");
  });
  test("curated namespace accepts a finite chain of published explicit APIs", async (t) => {
    const f = await namespaceFixture(workspaceSurface, t,
      'import { api } from "@fixture/other"; export const execute = () => api.nested.compare("a", "b");');
    const nested = "packages/other/src/nested.ts";
    f.module.publicEntrypoints.push(nested);
    f.module.moduleAssembly.push(nested);
    f.otherAssembly.roots.push(nested);
    f.otherAssembly.entrypoints.push(nested);
    f.manifest.exports["./nested"] = "./src/nested.ts";
    await f.write("packages/other/package.json", JSON.stringify(f.manifest));
    await f.write(f.publicPath, 'export * as nested from "./nested.js";');
    await f.write(nested, 'export { compare } from "./features/storage/domain/index.js";');
    await expectPass(f);
  });
}
