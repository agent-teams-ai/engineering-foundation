import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
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
  const pins = { oxlint: "1.77.0", "oxlint-tsgolint": "7.0.2001", typescript: "7.0.2" };
  for (const name of Object.keys(pins)) { await copy(name, resolveFromTest); }
  return pins;
}
