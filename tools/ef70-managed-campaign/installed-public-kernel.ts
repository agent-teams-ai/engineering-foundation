import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@agent-teams/repository-mutation";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve only the declared public ESM entry of the selected installed kernel. */
export function resolveInstalledPublicKernel(installation: string) {
  const root = realpathSync(installation);
  const manifestPath = realpathSync(
    createRequire(join(root, "package.json")).resolve(`${packageName}/package.json`),
  );
  assert.equal(
    manifestPath,
    realpathSync(join(root, "node_modules", packageName, "package.json")),
    "Kernel manifest must belong to the selected installation",
  );
  const metadata: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(record(metadata), "Installed kernel manifest must be an object");
  assert.equal(metadata["name"], packageName, "Installed kernel package identity");
  assert.equal(metadata["type"], "module", "Installed kernel must declare ESM");
  const exports = metadata["exports"];
  assert(record(exports), "Installed kernel must declare public exports");
  const publicRoot = exports["."];
  assert(record(publicRoot), "Installed kernel must declare its public root");
  assert.deepEqual(
    Object.keys(publicRoot).toSorted(),
    ["import", "types"],
    "Unsupported installed kernel public export conditions",
  );
  const target = publicRoot["import"];
  assert(typeof target === "string" && target.startsWith("./"), "Public ESM target required");
  const segments = target.slice(2).split("/");
  assert(
    segments.every(
      (part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && part.toLowerCase() !== "node_modules",
    ),
    "Public ESM target must be a literal package-relative path",
  );
  const kernelRoot = dirname(manifestPath);
  const entry = realpathSync(join(kernelRoot, target));
  const within = relative(kernelRoot, entry);
  assert(
    within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within),
    "Public ESM entry must remain inside the selected physical kernel",
  );
  assert(lstatSync(entry).isFile(), "Public ESM entry must be a regular file");
  return { kernelRoot, entrypointURL: pathToFileURL(entry).href };
}
