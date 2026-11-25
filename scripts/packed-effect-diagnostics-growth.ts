import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { generateGrowthSource } from "../tests/fixtures/effect-diagnostics/growth/generate.ts";
import { runCommand } from "./pack-test-support.mjs";
import {
  effectFixturePlugin,
  strictEffectCompilerOptions,
} from "./packed-effect-diagnostics-fixtures.ts";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const portable = (path: string) => path.split(sep).join("/");

async function sourceInventory(directory: string, base = directory): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceInventory(path, base)));
    else {
      assert.ok(
        entry.isFile() && entry.name.endsWith(".ts"),
        "Growth input must be ordinary TS source",
      );
      files.push(portable(relative(base, path)));
    }
  }
  return files.toSorted();
}

async function sourcesDigest(root: string, files: readonly string[]): Promise<string> {
  const observations = [];
  for (const file of files) observations.push([file, digest(await readFile(join(root, file)))]);
  return digest(JSON.stringify(observations));
}

async function admittedStockExecutable(consumerRoot: string): Promise<string> {
  const installed = createRequire(join(consumerRoot, "package.json"));
  const wrapperManifestPath = installed.resolve("typescript/package.json");
  const wrapper = JSON.parse(await readFile(wrapperManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(wrapper["name"], "typescript");
  assert.equal(wrapper["version"], "7.0.2");
  const nativeName = "@typescript/typescript-linux-x64";
  const nativeManifestPath = createRequire(wrapperManifestPath).resolve(
    `${nativeName}/package.json`,
  );
  const metadata = JSON.parse(await readFile(nativeManifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(metadata["name"], nativeName);
  assert.equal(metadata["version"], "7.0.2");
  const modules = await realpath(join(consumerRoot, "node_modules"));
  const executable = await realpath(join(dirname(nativeManifestPath), "lib/tsc"));
  assert.ok(executable.startsWith(`${modules}${sep}`), "Stock native compiler must be installed");
  return executable;
}

/** One raw compiler pair, separate from public-command latency and runtime scale. */
export async function measureInstalledEffectGrowth(consumerRoot: string, root: string) {
  const growth = join(root, "growth");
  await mkdir(growth);
  const retained = await readFile(
    new URL("../tests/fixtures/effect-diagnostics/growth/generate.ts", import.meta.url),
  );
  assert.equal(
    createHash("sha1").update(`blob ${retained.length}\0`).update(retained).digest("hex"),
    "fd53a3e60ff7215e1d3b99bc3597375874b01fba",
  );
  await generateGrowthSource(growth, 100);
  const files = (await sourceInventory(join(growth, "src"))).map((file) => `src/${file}`);
  assert.equal(files.length, 703);
  const project = join(growth, "tsconfig.json");
  await writeFile(
    project,
    JSON.stringify(
      {
        files,
        compilerOptions: {
          ...strictEffectCompilerOptions,
          plugins: [effectFixturePlugin()],
        },
      },
      null,
      2,
    ),
  );
  const before = await sourcesDigest(growth, files);
  const configHash = digest(await readFile(project));
  const stock = await admittedStockExecutable(consumerRoot);
  const native = await realpath(join(consumerRoot, "node_modules/@effect/tsgo-linux-x64/lib/tsc"));
  assert.equal(
    digest(await readFile(native)),
    "18b0b3fdac7d76b8c9b97e64c185ce8d92f2e13ab2307ae18a27fb11a62c045c",
  );
  const observations = [];
  for (const [kind, executable, expectedVersion] of [
    ["stock", stock, "Version 7.0.2"],
    ["effect", native, "Version 7.0.2+effect-tsgo.0.73.4"],
  ] as const) {
    const version = await runCommand(executable, ["--version"], growth);
    assert.equal(version.stdout.trim(), expectedVersion);
    assert.equal(version.stderr, "");
    const inventory = await runCommand(
      executable,
      ["--project", project, "--listFilesOnly", "--pretty", "false"],
      growth,
    );
    assert.equal(inventory.stderr, "");
    const absoluteSources = inventory.stdout
      .trim()
      .split(/\r?\n/u)
      .map((file: string) => file.trim());
    const listed = absoluteSources
      .filter((file: string) => file.startsWith(`${growth}${sep}src${sep}`))
      .map((file: string) => portable(relative(growth, file)))
      .toSorted();
    assert.deepEqual(listed, files);
    const started = performance.now();
    const result = await runCommand(
      executable,
      [
        "--project",
        project,
        "--noEmit",
        "--pretty",
        "false",
        "--incremental",
        "true",
        "--tsBuildInfoFile",
        devNull,
      ],
      growth,
    );
    const wallTimeMs = performance.now() - started;
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    observations.push({
      kind,
      version: version.stdout.trim(),
      executableSha256: digest(await readFile(executable)),
      wallTimeMs,
      completeInputCount: absoluteSources.length,
      consumerSourceCount: listed.length,
      inputInventorySha256: digest(
        JSON.stringify(absoluteSources.map((file: string) => portable(relative(growth, file)))),
      ),
      memory: "not-collected",
    });
  }
  assert.equal(await sourcesDigest(growth, files), before);
  assert.equal(digest(await readFile(project)), configHash);
  const receipt = {
    schemaVersion: 1,
    scope: "raw-compiler-cost-on-promise-based-GM-graph",
    modules: 100,
    sourceCount: 703,
    sourceSha256: before,
    configSha256: configHash,
    observations,
    enforcementCanary:
      "separate installed corpus actual-unstable invocation; excluded from 703 inputs",
    runtimeScale: "not-measured",
    productionSlo: "not-claimed",
  };
  await writeFile(join(root, "growth-observation.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
