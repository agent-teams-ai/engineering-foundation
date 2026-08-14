import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

export const DOCS_PROTOCOL_PACKAGE_NAME = "@agent-teams/docs-protocol";

export function registryQualificationPackages(publishablePackages) {
  const names = publishablePackages.map((releasePackage) => releasePackage.name);
  if (new Set(names).size !== names.length) {
    throw new Error("Registry qualification requires unique publishable package names.");
  }
  const docsPackages = publishablePackages.filter(
    (releasePackage) => releasePackage.name === DOCS_PROTOCOL_PACKAGE_NAME,
  );
  if (docsPackages.length === 1) {
    if (
      docsPackages[0].root !== "packages/docs-protocol" ||
      docsPackages[0].qualificationOnly === true
    ) {
      throw new Error("Public Docs Protocol registry qualification entry is malformed.");
    }
    return Object.freeze([...publishablePackages]);
  }
  return Object.freeze([
    ...publishablePackages,
    Object.freeze({
      name: DOCS_PROTOCOL_PACKAGE_NAME,
      root: "packages/docs-protocol",
      qualificationOnly: true,
    }),
  ]);
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8"));
}

async function resolveCatalogDependencies(manifest, sourceRoot) {
  const requireFromSource = createRequire(join(sourceRoot, "package.json"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version !== "catalog:") {
        continue;
      }
      const dependencyManifest = JSON.parse(
        await readFile(requireFromSource.resolve(`${name}/package.json`), "utf8"),
      );
      manifest[section][name] = dependencyManifest.version;
    }
  }
}

export async function stageQualificationPackage(input) {
  const sourceRoot = join(input.repositoryRoot, input.releasePackage.root);
  if (input.releasePackage.qualificationOnly !== true) {
    return sourceRoot;
  }
  const stagedRoot = join(input.destination, "disposable-package");
  await cp(sourceRoot, stagedRoot, { recursive: true });
  await copyFile(
    join(input.repositoryRoot, "LICENSE"),
    join(stagedRoot, "LICENSE"),
  );
  const stagedManifest = await readManifest(stagedRoot);
  if (
    stagedManifest.name !== DOCS_PROTOCOL_PACKAGE_NAME ||
    stagedManifest.version !== "0.0.0" ||
    stagedManifest.private !== true
  ) {
    throw new Error(
      "Docs Protocol registry qualification requires the exact private 0.0.0 production manifest.",
    );
  }
  const foundationManifest = await readManifest(
    join(input.repositoryRoot, "packages", "engineering-foundation"),
  );
  stagedManifest.private = false;
  delete stagedManifest.publishConfig;
  stagedManifest.dependencies[input.foundationPackageName] = foundationManifest.version;
  await resolveCatalogDependencies(stagedManifest, sourceRoot);
  await writeFile(
    join(stagedRoot, "package.json"),
    `${JSON.stringify(stagedManifest, null, 2)}\n`,
    "utf8",
  );
  return stagedRoot;
}
