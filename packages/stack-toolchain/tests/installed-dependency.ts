import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
function contained(root: string, filename: string): boolean {
  const suffix = path.relative(root, filename);
  return suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix);
}

/** Resolve a fixture dependency from the producer's actual installed graph. */
export function installedDependency(name: string): string {
  for (const modules of requireFromPackage.resolve.paths(name) ?? []) {
    if (!contained(repositoryRoot, modules)) {
      continue;
    }
    const candidate = path.join(modules, name);
    let physical: string;
    try {
      physical = fs.realpathSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    if (!contained(path.join(repositoryRoot, "node_modules"), physical)) {
      throw new Error(`Fixture dependency escapes installed graph: ${name}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(physical, "package.json"), "utf8")) as {
      name?: string;
    };
    if (manifest.name !== name) {
      throw new Error(`Fixture dependency identity differs: ${name}`);
    }
    return physical;
  }
  throw new Error(`Fixture installed dependency is missing: ${name}`);
}
