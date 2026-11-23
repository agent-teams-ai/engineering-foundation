import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { projectProducerSourceDependencies } from "../tools/producer-source-dependencies.ts";

for (const variant of ["valid", "missing", "mismatch", "escape", "foreign"] as const) {
  test(`shadowed producer projection: ${variant}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "producer-source-TEST-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (path: string, value: unknown): Promise<void> => {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, "package.json"), JSON.stringify(value));
    };
    await put("", {
      name: "owner",
      version: "1.0.0",
      devDependencies: { "stack-toolchain": "0.1.0" },
    });
    await put("packages/stack-toolchain", {
      name: "stack-toolchain",
      version: "0.1.0",
      dependencies: { parser: "catalog:" },
    });
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\ncatalog:\n  parser: 1.0.0\n",
    );
    const registry = "node_modules/.bun/stack/node_modules/stack-toolchain";
    await put(registry, { name: "stack-toolchain", version: "0.1.0" });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(join(root, registry), join(root, "node_modules/stack-toolchain"), "junction");
    const consumerBefore = await readlink(join(root, "node_modules/stack-toolchain"));
    if (variant !== "missing") {
      await put(`${registry}/node_modules/parser`, {
        name: "parser",
        version: variant === "mismatch" ? "2.0.0" : "1.0.0",
      });
    }
    if (variant === "escape") {
      await rm(join(root, registry, "node_modules/parser"), { recursive: true });
      await symlink(tmpdir(), join(root, registry, "node_modules/parser"), "junction");
    }
    if (variant === "foreign") {
      await put("packages/stack-toolchain/node_modules/parser", {
        name: "parser",
        version: "1.0.0",
      });
    }
    if (variant === "valid") {
      await projectProducerSourceDependencies(root);
      await projectProducerSourceDependencies(root);
      assert.equal(
        await realpath(join(root, "packages/stack-toolchain/node_modules/parser")),
        await realpath(join(root, registry, "node_modules/parser")),
      );
    } else {
      await assert.rejects(
        projectProducerSourceDependencies(root),
        /unavailable|mismatch|escapes/u,
      );
    }
    assert.equal(await readlink(join(root, "node_modules/stack-toolchain")), consumerBefore);
  });
}

type BootstrapVariant =
  | "valid"
  | "source-precedence"
  | "registry-precedence"
  | "root-declaration-mismatch"
  | "host-mismatch"
  | "core-mismatch"
  | "core-missing"
  | "core-owner-missing"
  | "core-escape"
  | "metadata-substitution";

async function putMetadata(path: string, value: unknown): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), JSON.stringify(value));
}

async function bootstrapFixture(root: string, variant: BootstrapVariant) {
  const source = join(root, "packages/stack-toolchain");
  const registry = join(root, "node_modules/.bun/stack/node_modules/stack-toolchain");
  await putMetadata(root, {
    name: "bootstrap-owner",
    version: "1.0.0",
    devDependencies: {
      "stack-toolchain": "0.1.0",
      "@typescript-eslint/scope-manager": "catalog:",
      "eslint-parser-oxc": "catalog:",
      eslint: variant === "root-declaration-mismatch" ? "10.4.0" : "catalog:",
    },
  });
  await putMetadata(source, {
    name: "stack-toolchain",
    version: "0.2.0",
    dependencies: {
      "fixture-parser": "catalog:",
      "@eslint/core": "catalog:",
      "@typescript-eslint/scope-manager": "catalog:",
      "eslint-parser-oxc": "catalog:",
    },
    devDependencies: { eslint: "catalog:" },
  });
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'packages:\n  - packages/*\ncatalog:\n  fixture-parser: 1.0.0\n  "@eslint/core": 1.2.1\n  "@typescript-eslint/scope-manager": 8.73.0\n  eslint-parser-oxc: 0.1.1\n  eslint: 10.3.0\n',
  );
  await putMetadata(registry, { name: "stack-toolchain", version: "0.1.0" });
  await symlink(registry, join(root, "node_modules/stack-toolchain"), "junction");
  const fixtureParser = join(registry, "node_modules/fixture-parser");
  await putMetadata(fixtureParser, { name: "fixture-parser", version: "1.0.0" });
  for (const [name, version] of [
    ["@typescript-eslint/scope-manager", "8.73.0"],
    ["eslint-parser-oxc", "0.1.1"],
    ["eslint", "10.3.0"],
  ] as const) {
    const path = join(root, "node_modules", name);
    await putMetadata(path, {
      name,
      version:
        name === "eslint" && variant === "host-mismatch"
          ? "10.4.0"
          : name === "@typescript-eslint/scope-manager" && variant === "source-precedence"
            ? "8.74.0"
            : version,
      exports: {
        ".": "./index.js",
        "./package.json":
          name === "@typescript-eslint/scope-manager" && variant === "metadata-substitution"
            ? "./other.json"
            : "./package.json",
      },
      dependencies:
        name === "eslint" && variant !== "core-owner-missing" ? { "@eslint/core": "^1.2.1" } : {},
    });
    await writeFile(
      join(path, "index.js"),
      'throw new Error("BOOTSTRAP_IMPLEMENTATION_EXECUTED");\n',
    );
    await writeFile(join(path, "other.json"), "{}\n");
  }
  const core = join(root, "node_modules/eslint/node_modules/@eslint/core");
  if (variant !== "core-missing") {
    await putMetadata(core, {
      name: "@eslint/core",
      version: variant === "core-mismatch" || variant === "registry-precedence" ? "1.2.2" : "1.2.1",
      exports: { types: "./types.d.ts" },
    });
  }
  if (variant === "core-escape") {
    await rm(core, { recursive: true });
    await symlink(tmpdir(), core, "junction");
  }
  if (variant === "source-precedence") {
    const ownedScope = join(root, "node_modules/source-scope");
    await putMetadata(ownedScope, { name: "@typescript-eslint/scope-manager", version: "8.73.0" });
    await mkdir(join(source, "node_modules/@typescript-eslint"), { recursive: true });
    await symlink(
      ownedScope,
      join(source, "node_modules/@typescript-eslint/scope-manager"),
      "junction",
    );
  }
  const registryCore = join(registry, "node_modules/@eslint/core");
  if (variant === "registry-precedence") {
    await putMetadata(registryCore, { name: "@eslint/core", version: "1.2.1" });
  }
  return {
    source,
    registry,
    fixtureParser,
    core: variant === "registry-precedence" ? registryCore : core,
  };
}

for (const variant of [
  "valid",
  "source-precedence",
  "registry-precedence",
  "root-declaration-mismatch",
  "host-mismatch",
  "core-mismatch",
  "core-missing",
  "core-owner-missing",
  "core-escape",
  "metadata-substitution",
] as const) {
  test(`producer bootstrap metadata and host type graph: ${variant}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "producer-bootstrap-TEST-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await bootstrapFixture(root, variant);
    const consumerBefore = await readlink(join(root, "node_modules/stack-toolchain"));
    if (
      variant === "valid" ||
      variant === "source-precedence" ||
      variant === "registry-precedence"
    ) {
      await projectProducerSourceDependencies(root);
      await projectProducerSourceDependencies(root);
      assert.equal(
        await realpath(join(fixture.source, "node_modules/@eslint/core")),
        await realpath(fixture.core),
      );
      assert.equal(
        await realpath(join(fixture.source, "node_modules/fixture-parser")),
        await realpath(fixture.fixtureParser),
      );
    } else {
      await assert.rejects(
        projectProducerSourceDependencies(root),
        /unavailable|mismatch|escapes|exact declared ESLint host/u,
      );
      for (const name of ["fixture-parser", "@eslint/core"]) {
        assert.equal(
          await lstat(join(fixture.source, "node_modules", name)).catch(() => null),
          null,
          "No planned producer link may be created before all dependency metadata is admitted.",
        );
      }
    }
    assert.equal(await readlink(join(root, "node_modules/stack-toolchain")), consumerBefore);
  });
}

function runProjection(root: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../tools/producer-source-dependencies.ts", import.meta.url)), ...args],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 10_000, shell: false },
  );
}

test("producer projection CLI uses a fresh runtime and preserves metadata-only admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "producer-cli-TEST # "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await bootstrapFixture(root, "valid");
  const registryBefore = await readlink(join(root, "node_modules/stack-toolchain"));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = runProjection(root, [root]);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await realpath(join(fixture.source, "node_modules/@eslint/core")),
      await realpath(fixture.core),
    );
    assert.equal(
      await realpath(join(fixture.source, "node_modules/fixture-parser")),
      await realpath(fixture.fixtureParser),
    );
  }
  assert.equal(await readlink(join(root, "node_modules/stack-toolchain")), registryBefore);
});

for (const variant of ["core-mismatch", "metadata-substitution"] as const) {
  test(`producer projection CLI propagates real child rejection: ${variant}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "producer-cli-reject-TEST-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await bootstrapFixture(root, variant);
    const result = runProjection(root, [root]);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(typeof result.status, "number");
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Producer (?:bootstrap metadata )?(?:dependency )?identity mismatch/u,
    );
    if (variant === "metadata-substitution") {
      const scope = await realpath(join(root, "node_modules/@typescript-eslint/scope-manager"));
      assert.ok(result.stderr.includes(`expected ${join(scope, "package.json")}`));
      assert.ok(result.stderr.includes(`resolved ${join(scope, "other.json")}`));
    }
    for (const name of ["fixture-parser", "@eslint/core"]) {
      assert.equal(await lstat(join(fixture.source, "node_modules", name)).catch(() => null), null);
    }
    assert.doesNotMatch(result.stderr, /BOOTSTRAP_IMPLEMENTATION_EXECUTED/u);
  });
}

for (const variant of ["missing", "empty", "relative", "extra"] as const) {
  test(`producer projection CLI rejects malformed arguments: ${variant}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "producer-cli-args-TEST-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const args = { missing: [], empty: [""], relative: ["."], extra: [root, "extra"] }[variant];
    const result = runProjection(root, args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(typeof result.status, "number");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: producer-source-dependencies\.ts <absolute-profile-root>/u);
  });
}
