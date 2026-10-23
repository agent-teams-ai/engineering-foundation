import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath,
  cp,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyPinnedToolchain } from "./copied-toolchain.mjs";
import { qualifyMissingInstalledOxlint } from "../../../scripts/packed-quality-lint-protections.ts";
import { inspectConsumerToolchain } from "../../../packages/engineering-foundation/dist/features/quality-coverage/node.js";

test("installed exact toolchain owns versions and rejects workspace or manifest drift", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-toolchain-resolution-")));
  try {
    const source = join(root, "node_modules/stack-toolchain");
    await mkdir(source, { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    const pins = { oxlint: "1.83.0", "oxlint-tsgolint": "7.0.2001", typescript: "7.0.2" };
    await writeFile(
      join(source, "toolchain-manifest.json"),
      JSON.stringify({ schemaVersion: 1, ...pins }),
    );
    for (const [name, version] of Object.entries(pins)) {
      const directory = join(root, "node_modules", name);
      await mkdir(directory, { recursive: true });
      const bin = name === "typescript" ? "tsc" : name === "oxlint" ? "oxlint" : "tsgolint";
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, version, bin: { [bin]: "entry.js" } }),
      );
      await writeFile(join(directory, "entry.js"), "// executable fixture\n");
    }
    const nativeName = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
    const nativeRoot = join(root, "node_modules", nativeName);
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(
      join(nativeRoot, "package.json"),
      JSON.stringify({ name: nativeName, version: pins["oxlint-tsgolint"] }),
    );
    await writeFile(
      join(nativeRoot, process.platform === "win32" ? "tsgolint.exe" : "tsgolint"),
      "fixture",
    );
    const entry = {
      dependencyName: "stack-toolchain",
      targetPackageName: "stack-toolchain",
      specifier: "0.1.0",
      effectiveVersionSpecifier: "0.1.0",
      section: "devDependencies",
    };
    const input = {
      consumerRoot: root,
      dependencies: [entry],
      read: ({ candidate }) => readFile(candidate),
    };
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "stack-toolchain", version: "0.1.0", dependencies: pins }),
    );
    const tools = await inspectConsumerToolchain(input);
    assert.equal(tools.compilerEntrypoint, join(root, "node_modules/typescript/entry.js"));
    await assert.rejects(
      inspectConsumerToolchain({
        ...input,
        dependencies: [
          { ...entry, specifier: "workspace:*", effectiveVersionSpecifier: "workspace:*" },
        ],
      }),
      /exact consumer/u,
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "stack-toolchain",
        version: "0.1.0",
        dependencies: { ...pins, typescript: "catalog:" },
      }),
    );
    await assert.rejects(inspectConsumerToolchain(input), /dependency graph/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing-tool qualification follows installed Stack authority inside its copied closure", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "TEST-installed-tool-authority-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependencies = await copyPinnedToolchain(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: dependencies }));
  const nested = join(root, "node_modules/stack-toolchain/node_modules/oxlint");
  await mkdir(join(nested, ".."), { recursive: true });
  await cp(join(root, "node_modules/oxlint"), nested, { recursive: true });
  const packageBytes = await readFile(join(nested, "package.json"));
  const input = {
    consumerRoot: root,
    dependencies: [
      {
        dependencyName: "stack-toolchain",
        targetPackageName: "stack-toolchain",
        specifier: dependencies["stack-toolchain"],
        effectiveVersionSpecifier: dependencies["stack-toolchain"],
        section: "devDependencies",
      },
    ],
    read: ({ candidate }) => readFile(candidate),
  };
  const observed = [];
  const invoke = async (_args, code = 0) => {
    try {
      const tools = await inspectConsumerToolchain(input);
      assert.equal(code, 0);
      assert.ok(tools.oxlintEntrypoint.startsWith(nested));
      observed.push("passed");
      return { outcome: "passed", capabilities: [{ diagnostics: [] }] };
    } catch (error) {
      assert.equal(code, 2);
      assert.equal(error.problem?.code, "QUALITY_TOOLCHAIN_INVALID");
      assert.match(error.problem.message, /oxlint: is not installed/u);
      observed.push("missing-owned-tool");
      return {
        outcome: "invalid-input",
        capabilities: [{ diagnostics: [], problem: error.problem }],
      };
    }
  };
  await qualifyMissingInstalledOxlint({ root, invoke });
  assert.deepEqual(observed, ["passed", "missing-owned-tool", "passed"]);
  assert.deepEqual(await readFile(join(nested, "package.json")), packageBytes);
  assert.ok((await lstat(join(root, "node_modules/oxlint"))).isDirectory());
  const interrupted = new Error("injected missing-tool callback interruption");
  await assert.rejects(
    qualifyMissingInstalledOxlint({
      root,
      invoke: async (args, code) => {
        if (code === 2) {
          throw interrupted;
        }
        return invoke(args, code);
      },
    }),
    interrupted,
  );
  assert.deepEqual(await readFile(join(nested, "package.json")), packageBytes);
  assert.ok((await lstat(join(root, "node_modules/oxlint"))).isDirectory());
  const escaped = join(root, "escape-consumer");
  await mkdir(join(escaped, "node_modules"), { recursive: true });
  for (const name of ["stack-toolchain", "oxlint"]) {
    await symlink(
      join(root, "node_modules", name),
      join(escaped, "node_modules", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await assert.rejects(
    qualifyMissingInstalledOxlint({ root: escaped, invoke }),
    /strictly inside copied consumer/u,
  );
  assert.deepEqual(await readFile(join(nested, "package.json")), packageBytes);
});
