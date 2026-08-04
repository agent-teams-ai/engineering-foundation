import { access, copyFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages", "engineering-foundation");
const sourceRoot = join(packageRoot, "src");
const distributionRoot = join(packageRoot, "dist");

function sourcePathForArtifact(path) {
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

async function pruneStaleDistribution(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await pruneStaleDistribution(path);
      if ((await readdir(path)).length === 0) {
        await rm(path, { recursive: true });
      }
      continue;
    }
    const sourcePath = sourcePathForArtifact(path);
    if (sourcePath !== null && !(await exists(sourcePath))) {
      await rm(path);
    }
  }
}

await pruneStaleDistribution(distributionRoot);

await copyFile(
  join(repositoryRoot, "LICENSE"),
  join(packageRoot, "LICENSE")
);
