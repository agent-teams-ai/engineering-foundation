import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStrictYamlFileLoader } from "../../../packages/engineering-foundation/dist/features/configuration-input/node.js";
import { resolveQualityJsonConfig } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/quality-config-resolution.js";
import { createQualityInputWitness } from "../../../packages/engineering-foundation/dist/features/quality-coverage/adapters/quality-input-witness.js";
import { readContainedRegularFile } from "../../../packages/engineering-foundation/dist/source-inventory/node.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quality-resolution-")));
  const packageRoot = join(root, "node_modules", "lint-preset");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"consumer"}');
  for (const name of ["first", "second"]) {
    await writeFile(join(packageRoot, `${name}.json`), JSON.stringify({ version: name }));
  }
  const manifest = (exports?: unknown) =>
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "lint-preset", ...(exports === undefined ? {} : { exports }) }),
    );
  await manifest({ "./config.json": "./first.json" });
  const observe = async (issuer = join(root, "package.json")) => {
    const witness = createQualityInputWitness(root, readContainedRegularFile);
    const readYaml = createStrictYamlFileLoader({ read: witness.read });
    await witness.capture({
      async read() {
        return { filePaths: ["package.json"], sourcePaths: [], manifestPaths: ["package.json"] };
      },
    });
    const resolve = (request = "lint-preset/config.json") =>
      resolveQualityJsonConfig({
        root,
        issuer,
        request,
        read: (directory, path) => readYaml(directory, path, "resolution-test"),
        observeBinding: (binding) => witness.bindResolution(binding),
      });
    return { witness, resolve };
  };
  return {
    root,
    packageRoot,
    manifest,
    observe,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

void test("fresh exact exports derive from observed manifest even after an earlier Node resolution", async () => {
  const temporary = await fixture();
  try {
    const request = "lint-preset/config.json";
    const cached = createRequire(join(temporary.root, "package.json"));
    assert.equal(cached.resolve(request), join(temporary.packageRoot, "first.json"));
    await temporary.manifest({ "./config.json": "./second.json" });
    const observed = await temporary.observe();
    assert.equal(await observed.resolve(), join(temporary.packageRoot, "second.json"));
    await observed.witness.verify();
  } finally {
    await temporary.dispose();
  }
});

void test("package export remapping and exported target symlink retargeting cannot pass final verification", async () => {
  for (const mutation of ["manifest", "target"] as const) {
    const temporary = await fixture();
    try {
      if (mutation === "target") {
        await symlink("first.json", join(temporary.packageRoot, "alias.json"));
        await temporary.manifest({ "./config.json": "./alias.json" });
      }
      const observed = await temporary.observe();
      assert.equal(await observed.resolve(), join(temporary.packageRoot, "first.json"));
      if (mutation === "manifest") {
        await temporary.manifest({ "./config.json": "./second.json" });
      } else {
        await rm(join(temporary.packageRoot, "alias.json"));
        await symlink("second.json", join(temporary.packageRoot, "alias.json"));
      }
      await assert.rejects(observed.witness.verify(), /changed/u);
    } finally {
      await temporary.dispose();
    }
  }
});

void test("new closer package candidates cannot silently replace a witnessed installed preset", async () => {
  const temporary = await fixture();
  try {
    const nested = join(temporary.root, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "package.json"), '{"name":"nested-consumer"}');
    const observed = await temporary.observe(join(nested, "package.json"));
    await observed.resolve();
    await mkdir(join(nested, "node_modules", "lint-preset"), { recursive: true });
    await assert.rejects(observed.witness.verify(), /aliases changed/u);
  } finally {
    await temporary.dispose();
  }
});

void test("package alias changes during initial manifest observation reject before a binding is admitted", async () => {
  const temporary = await fixture();
  try {
    const original = join(temporary.root, "original");
    const replacement = join(temporary.root, "replacement");
    await rename(temporary.packageRoot, original);
    await mkdir(replacement);
    await writeFile(join(replacement, "first.json"), "{}");
    await symlink(original, temporary.packageRoot, "junction");
    const witness = createQualityInputWitness(temporary.root, readContainedRegularFile);
    const readYaml = createStrictYamlFileLoader({ read: witness.read });
    await assert.rejects(
      resolveQualityJsonConfig({
        root: temporary.root,
        issuer: join(temporary.root, "package.json"),
        request: "lint-preset/config.json",
        async read(root, path) {
          const value = await readYaml(root, path, "initial-alias-test");
          if (root === original) {
            await rm(temporary.packageRoot);
            await symlink(replacement, temporary.packageRoot, "junction");
          }
          return value;
        },
        observeBinding: (binding) => witness.bindResolution(binding),
      }),
      /aliases changed during initial/u,
    );
  } finally {
    await temporary.dispose();
  }
});

void test("qualified exact and absent exports work; conditional, wildcard, imports and missing manifests reject", async () => {
  const temporary = await fixture();
  try {
    await temporary.manifest();
    const direct = await temporary.observe();
    assert.equal(
      await direct.resolve("lint-preset/first.json"),
      join(temporary.packageRoot, "first.json"),
    );
    assert.equal(
      await direct.resolve("./node_modules/lint-preset/first.json"),
      join(temporary.packageRoot, "first.json"),
    );
    for (const exports of [
      { "./config.json": { require: "./first.json", default: "./second.json" } },
      { "./*.json": "./first.json" },
      { "./config.json": "../outside.json" },
    ]) {
      await temporary.manifest(exports);
      const observed = await temporary.observe();
      await assert.rejects(observed.resolve(), /exact string-valued subpath/u);
    }
    const unsupported = await temporary.observe();
    await assert.rejects(unsupported.resolve("#config.json"), /exact contained JSON/u);
    await assert.rejects(unsupported.resolve(".foo.json"), /canonical JSON subpath/u);
    await rm(join(temporary.packageRoot, "package.json"));
    const missing = await temporary.observe();
    await assert.rejects(missing.resolve(), /missing|unreadable/u);
  } finally {
    await temporary.dispose();
  }
});
