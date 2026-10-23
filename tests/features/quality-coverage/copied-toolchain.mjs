import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
function contained(root, filename) {
  const suffix = relative(root, filename);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

// Package manifests are filesystem metadata, not necessarily public exports.
// Follow only the issuer's Node lookup paths inside this installed repository.
async function installedManifest(name, resolveFrom) {
  for (const modules of resolveFrom.resolve.paths(name) ?? []) {
    if (!contained(repositoryRoot, modules)) {
      continue;
    }
    const candidate = join(modules, name, "package.json");
    let manifest;
    try {
      manifest = await realpath(candidate);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    if (!contained(join(repositoryRoot, "node_modules"), manifest)) {
      throw new Error(`Fixture dependency escapes installed graph: ${name}`);
    }
    const identity = JSON.parse(await readFile(manifest, "utf8"));
    if (identity.name !== name) {
      throw new Error(`Fixture dependency identity differs: ${name}`);
    }
    return manifest;
  }
  throw Object.assign(new Error(`Fixture installed dependency is missing: ${name}`), {
    code: "MODULE_NOT_FOUND",
  });
}

/** Disposable real tool inputs; no links to the source installation survive copying. */
export async function copyPinnedToolchain(consumerRoot) {
  const resolveFromTest = createRequire(import.meta.url);
  const copied = new Set();
  async function copy(name, resolveFrom) {
    if (copied.has(name)) {
      return;
    }
    const manifest = await installedManifest(name, resolveFrom);
    const data = JSON.parse(await readFile(manifest, "utf8"));
    copied.add(name);
    const destination = join(consumerRoot, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(dirname(manifest), destination, { recursive: true, dereference: true });
    const local = createRequire(manifest);
    for (const dependency of Object.keys(data.dependencies ?? {})) {
      await copy(dependency, local);
    }
    for (const dependency of Object.keys(data.optionalDependencies ?? {})) {
      try {
        await installedManifest(dependency, local);
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND") {
          continue;
        }
        throw error;
      }
      await copy(dependency, local);
    }
  }
  const { installed } = await installedToolchain();
  await copy("stack-toolchain", resolveFromTest);
  return { "stack-toolchain": installed.version };
}

async function installedToolchain() {
  const resolveFromTest = createRequire(import.meta.url);
  const manifestPath = await installedManifest("stack-toolchain", resolveFromTest);
  const installed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (installed.name !== "stack-toolchain" || !/^\d+\.\d+\.\d+$/u.test(installed.version)) {
    throw new Error("Fixture requires an installed released Stack Toolchain identity");
  }
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
