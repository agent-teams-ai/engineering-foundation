import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Disposable real tool inputs; no links to the source installation survive copying. */
export async function copyPinnedToolchain(consumerRoot) {
  const resolveFromTest = createRequire(import.meta.url);
  const copied = new Set();
  async function copy(name, resolveFrom) {
    if (copied.has(name)) { return; }
    const manifest = await realpath(resolveFrom.resolve(`${name}/package.json`));
    const data = JSON.parse(await readFile(manifest, "utf8"));
    copied.add(name);
    const destination = join(consumerRoot, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(dirname(manifest), destination, { recursive: true, dereference: true });
    const local = createRequire(manifest);
    for (const dependency of Object.keys(data.dependencies ?? {})) { await copy(dependency, local); }
    for (const dependency of Object.keys(data.optionalDependencies ?? {})) {
      try { local.resolve(`${dependency}/package.json`); }
      catch (error) { if (error.code === "MODULE_NOT_FOUND") { continue; } throw error; }
      await copy(dependency, local);
    }
  }
  const { installed } = await installedToolchain();
  await copy("stack-toolchain", resolveFromTest);
  return { "stack-toolchain": installed.version };
}

async function installedToolchain() {
  const resolveFromTest = createRequire(import.meta.url);
  const manifestPath = await realpath(resolveFromTest.resolve("stack-toolchain/package.json"));
  const installed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (installed.name !== "stack-toolchain" || !/^\d+\.\d+\.\d+$/u.test(installed.version)) {
    throw new Error("Fixture requires an installed released Stack Toolchain identity");
  }
  const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const sourceRoot = await realpath(join(repositoryRoot, "packages/stack-toolchain"));
  if (dirname(manifestPath) === sourceRoot) {
    throw new Error("Fixture refuses producer workspace Stack Toolchain source");
  }
  return { manifestPath, installed };
}

/** Static protected-config fixtures need presets, not compiler executables. */
export async function copyInstalledToolchainPresets(consumerRoot) {
  const { manifestPath } = await installedToolchain();
  const source = dirname(manifestPath);
  const destination = join(consumerRoot, "node_modules/stack-toolchain");
  await mkdir(destination, { recursive: true });
  for (const entry of ["package.json", "toolchain-manifest.json", "presets"]) {
    await cp(join(source, entry), join(destination, entry), { recursive: true, dereference: true });
  }
}
