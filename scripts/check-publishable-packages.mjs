import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runCommand } from "./pack-test-support.mjs";
import { PUBLISHABLE_PACKAGES } from "./publishable-packages.mjs";

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromRepository = createRequire(import.meta.url);

function packageBinary(packageName, binaryName) {
  const manifestPath = requireFromRepository.resolve.paths(packageName)
    ?.map((searchRoot) => join(searchRoot, ...packageName.split("/"), "package.json"))
    .find((candidate) => {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")).name === packageName;
      } catch {
        return false;
      }
    });
  if (manifestPath === undefined) {
    throw new Error(`Cannot resolve the installed ${packageName} manifest.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const relativeBinary = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binaryName];
  if (typeof relativeBinary !== "string" || relativeBinary === "") {
    throw new Error(`${packageName} does not expose the required ${binaryName} executable.`);
  }
  return resolvePath(dirname(manifestPath), relativeBinary);
}

export function publishablePackageCheckPlan(packages = PUBLISHABLE_PACKAGES) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("Publishable package checks require a non-empty projected inventory.");
  }
  return Object.freeze(packages.flatMap(({ root }) => [
    Object.freeze({ arguments: Object.freeze([root]), tool: "publint" }),
    Object.freeze({
      arguments: Object.freeze(["--pack", "--profile", "esm-only", root]),
      tool: "attw",
    }),
  ]));
}

export async function runPublishablePackageChecks({
  execute = runCommand,
  toolPaths = {
    attw: packageBinary("@arethetypeswrong/cli", "attw"),
    publint: packageBinary("publint", "publint"),
  },
} = {}) {
  for (const step of publishablePackageCheckPlan()) {
    const toolPath = toolPaths[step.tool];
    if (typeof toolPath !== "string" || toolPath === "") {
      throw new Error(`Publishable package check tool is unavailable: ${step.tool}.`);
    }
    await execute(process.execPath, [toolPath, ...step.arguments], repositoryRoot);
  }
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolvePath(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await runPublishablePackageChecks();
}
