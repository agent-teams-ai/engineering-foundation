import { access, copyFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourcePathForArtifact(path, sourceRoot, distributionRoot) {
  const relativePath = relative(distributionRoot, path);
  for (const suffix of [".d.ts.map", ".js.map", ".d.ts", ".js"]) {
    if (relativePath.endsWith(suffix)) {
      return join(sourceRoot, `${relativePath.slice(0, -suffix.length)}.ts`);
    }
  }
  return null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pruneStaleDistribution(root, sourceRoot, distributionRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await pruneStaleDistribution(path, sourceRoot, distributionRoot);
      if ((await readdir(path)).length === 0) {
        await rm(path, { recursive: true });
      }
      continue;
    }
    const sourcePath = sourcePathForArtifact(path, sourceRoot, distributionRoot);
    if (sourcePath !== null && !(await exists(sourcePath))) {
      await rm(path);
    }
  }
}

export async function preparePackages() {
  for (const releasePackage of PUBLISHABLE_PACKAGES) {
    const packageRoot = join(repositoryRoot, releasePackage.root);
    const sourceRoot = join(packageRoot, "src");
    const distributionRoot = join(packageRoot, "dist");
    if (await exists(distributionRoot)) {
      await pruneStaleDistribution(distributionRoot, sourceRoot, distributionRoot);
    }
    if (await exists(packageRoot)) {
      await copyFile(join(repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"));
    }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await preparePackages();
}
