import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  admitEffectCompiler,
  effectHash,
  effectInside,
  effectLocalPath,
  effectSourceInventory,
  parseEffectJson,
  readEffectFile,
  type EffectNativeManifest,
  type EffectNativeTool,
} from "../dist/features/toolchain-execution/adapters/effect-files.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "stack-effect-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
const live = (): void => {};

test("JSONC preserves explicit policy while duplicate decoded keys and invalid bytes reject", () => {
  const parsed = parseEffectJson(Buffer.from('{/* comment */"value": [1,],}'));
  assert.deepEqual(parsed, Object.assign(Object.create(null), { value: [1] }));
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":{"diagnostics":true,"\\u0064iagnostics":false}}',
    '{"a":',
    "{}{}",
    "[".repeat(70) + "0" + "]".repeat(70),
  ]) {
    assert.throws(() => parseEffectJson(Buffer.from(source)), /EFFECT_CONFIG_/u);
  }
  assert.throws(() => parseEffectJson(Uint8Array.from([0xff])), /EFFECT_CONFIG_UTF8/u);
});

test("bounded regular-file reading refuses oversized and non-file inputs", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "value.ts");
  await fs.writeFile(file, "abc");
  assert.equal((await readEffectFile(file, 3, live)).toString(), "abc");
  await assert.rejects(readEffectFile(file, 2, live), /EFFECT_FILE_BOUND/u);
  await assert.rejects(readEffectFile(root, 10, live));
  assert.equal(effectInside(root, path.join(root, "value.ts")), true);
  assert.equal(effectInside(root, `${root}-sibling/file.ts`), false);
  assert.equal(effectInside(root, root), false);
});

async function nativeFixture(
  t: TestContext,
): Promise<{ root: string; directory: string; manifest: EffectNativeManifest }> {
  const root = await temporary(t);
  const directory = path.join(root, "node_modules", "@effect", "tsgo-linux-x64");
  await fs.mkdir(path.join(directory, "lib"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{}");
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@effect/tsgo-linux-x64", version: "0.73.4" }),
  );
  const executable = Buffer.from("Synthetic admission bytes; this file is never executed.");
  const declaration = Buffer.from("export interface Paired {}\n");
  const libraries: Record<string, string> = {};
  await fs.writeFile(path.join(directory, "lib", "tsc"), executable);
  for (let index = 0; index < 108; index++) {
    const name = index === 0 ? "lib.d.ts" : `lib.fixture${index}.d.ts`;
    libraries[name] = effectHash(declaration);
    await fs.writeFile(path.join(directory, "lib", name), declaration);
  }
  return {
    root,
    directory,
    manifest: {
      package: "@effect/tsgo-linux-x64",
      version: "0.73.4",
      typescript: "7.0.2",
      binary: "lib/tsc",
      binarySha256: effectHash(executable),
      reportedVersion: "Version 7.0.2+effect-tsgo.0.73.4",
      libraries,
    },
  };
}

test("native admission binds exact identity, binary and every paired declaration before execution", async (t) => {
  const { root, directory, manifest } = await nativeFixture(t);
  const tool = await admitEffectCompiler(root, live, manifest);
  assert.equal(tool.libraries.size, 108);
  assert.equal(tool.versions.libraryCount, 108);
  await assert.rejects(admitEffectCompiler(root, live), /EFFECT_NATIVE_HASH/u);
  await fs.writeFile(
    path.join(directory, "lib", "unused-other-variant"),
    "unqualified unrelated payload",
  );
  assert.equal((await admitEffectCompiler(root, live, manifest)).libraries.size, 108);
  const lastLibrary = path.join(directory, "lib", "lib.fixture107.d.ts");
  await fs.writeFile(lastLibrary, "changed");
  await assert.rejects(admitEffectCompiler(root, live, manifest), /EFFECT_NATIVE_LIBRARY_HASH/u);
  await fs.unlink(lastLibrary);
  await assert.rejects(admitEffectCompiler(root, live, manifest));
  await fs.writeFile(path.join(directory, "lib", "tsc"), "changed native payload");
  await assert.rejects(admitEffectCompiler(root, live, manifest), /EFFECT_NATIVE_HASH/u);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@effect/tsgo-linux-x64", version: "0.73.5" }),
  );
  await assert.rejects(admitEffectCompiler(root, live, manifest), /EFFECT_NATIVE_VERSION/u);
  await assert.rejects(
    admitEffectCompiler(path.join(root, "missing"), live, manifest),
    /EFFECT_NATIVE_MISSING/u,
  );
});

test("whole installation links are admitted; package and executable escapes are not", async (t) => {
  const { root, directory, manifest } = await nativeFixture(t);
  const consumer = path.join(root, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(path.join(consumer, "package.json"), "{}");
  await fs.symlink(
    path.join(root, "node_modules"),
    path.join(consumer, "node_modules"),
    "junction",
  );
  assert.equal(
    (await admitEffectCompiler(consumer, live, manifest)).installation,
    path.join(root, "node_modules"),
  );
  const escaped = path.join(root, "escaped-package");
  await fs.rename(directory, escaped);
  await fs.symlink(escaped, directory, "junction");
  await assert.rejects(
    admitEffectCompiler(root, live, manifest),
    /EFFECT_NATIVE_OUTSIDE_INSTALLATION/u,
  );
  await fs.unlink(directory);
  await fs.rename(escaped, directory);
  const outsideLib = path.join(root, "outside-lib");
  await fs.rename(path.join(directory, "lib"), outsideLib);
  await fs.symlink(outsideLib, path.join(directory, "lib"), "junction");
  await assert.rejects(admitEffectCompiler(root, live, manifest), /EFFECT_NATIVE_OUTSIDE_PACKAGE/u);
});

test("the complete inventory checks imported local sources and keeps dependency boundaries distinct", async (t) => {
  const root = await temporary(t);
  const entry = path.join(root, "main.ts");
  const imported = path.join(root, "imported.ts");
  const installation = path.join(root, "node_modules");
  await fs.mkdir(installation);
  const dependency = path.join(installation, "third-party.d.ts");
  await fs.writeFile(entry, 'export * from "./imported.js";');
  await fs.writeFile(imported, "export const value = 42;");
  await fs.writeFile(
    dependency,
    "// @effect-diagnostics *:skip-file\nexport interface ThirdParty {}",
  );
  const tool: EffectNativeTool = {
    executable: "/never-executed",
    installation,
    libraries: new Set(),
    reportedVersion: "test",
    versions: {
      package: "@effect/tsgo-linux-x64",
      version: "0.73.4",
      typescript: "7.0.2",
      binarySha256: "test",
      libraryCount: 108,
    },
  };
  const output = [entry, imported, dependency].join("\n") + "\n";
  const inventory = await effectSourceInventory(output, root, [entry], tool, live);
  assert.deepEqual(inventory.sourceFiles, ["imported.ts", "main.ts"]);
  for (const extension of ["d.ts", "d.mts", "d.cts"]) {
    const declaration = path.join(root, `local.${extension}`);
    await fs.writeFile(declaration, "export interface LocalDeclaration {}\n");
    // Native Effect rules skip declaration files; neither a declaration-only
    // project nor an imported local declaration may imply Effect coverage.
    for (const [files, selected] of [
      [[declaration], [declaration]],
      [[entry, imported, declaration, dependency], [entry]],
    ]) {
      assert.ok(files && selected);
      await assert.rejects(
        effectSourceInventory(files.join("\n"), root, selected, tool, live),
        /EFFECT_DECLARATION_SOURCE_UNSUPPORTED/u,
      );
    }
  }
  await fs.writeFile(imported, Uint8Array.from([0xff]));
  await assert.rejects(
    effectSourceInventory(output, root, [entry], tool, live),
    /EFFECT_SOURCE_UTF8/u,
  );
  await fs.writeFile(imported, "export const value = 42;");
  for (const source of [
    "// @effect-diagnostics-next-line unstableApiUsage:off\nexport const value = 1;",
    "// @effect-diagnostics *:skip-file\nexport const value = 1;",
    'export const value = "@effect-diagnostics";',
  ]) {
    await fs.writeFile(imported, source);
    await assert.rejects(
      effectSourceInventory(output, root, [entry], tool, live),
      /EFFECT_SOURCE_DIRECTIVE/u,
    );
  }
  await fs.writeFile(imported, "export const value = 42;");
  for (const malformed of ["", "main.ts\n", "error TS2322: not an inventory\n"])
    await assert.rejects(
      effectSourceInventory(malformed, root, [entry], tool, live),
      /EFFECT_SOURCE_INVENTORY/u,
    );
  await assert.rejects(
    effectSourceInventory(entry + "\n" + entry, root, [entry], tool, live),
    /EFFECT_SOURCE_DUPLICATE/u,
  );
  await assert.rejects(
    effectSourceInventory(imported, root, [entry], tool, live),
    /EFFECT_SOURCE_ROOTS_MISSING/u,
  );
  await assert.rejects(effectLocalPath(root, dependency), /EFFECT_SOURCE_OUTSIDE_ROOT/u);
  const outside = await temporary(t);
  const foreign = path.join(outside, "foreign.ts");
  await fs.writeFile(foreign, "export {};");
  await assert.rejects(
    effectSourceInventory(entry + "\n" + foreign, root, [entry], tool, live),
    /EFFECT_SOURCE_OUTSIDE_ROOT/u,
  );
  const unchecked = path.join(installation, "unchecked.ts");
  await fs.writeFile(unchecked, "export {};");
  await assert.rejects(
    effectSourceInventory(entry + "\n" + unchecked, root, [entry], tool, live),
    /EFFECT_DEPENDENCY_SOURCE/u,
  );
});
